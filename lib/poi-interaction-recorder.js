const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createPoiScreenshotProvider } = require('./poi-screenshot')

const CANONICAL_WIDTH = 1200
const CANONICAL_HEIGHT = 720
const DEFAULT_HOLD_THRESHOLD_MS = 200
const DEFAULT_DRAG_THRESHOLD_PX = 6
const DEFAULT_ATTACH_INTERVAL_MS = 1000
const DEFAULT_MAX_PATH_POINTS = 256
const DEFAULT_MAX_JSON_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_SESSION_BYTES = 8 * 1024 * 1024 * 1024
const DEFAULT_MAX_TIMELINE_EVENTS = 20000
const DEFAULT_MAX_SESSION_DURATION_MS = 4 * 60 * 60 * 1000
const DEFAULT_MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_STORED_SESSIONS = envPositiveInteger(
  'POI_MCP_RECORDING_MAX_SESSIONS',
  200,
)
const DEFAULT_MAX_TOTAL_RECORDING_BYTES = envPositiveInteger(
  'POI_MCP_RECORDING_MAX_TOTAL_BYTES',
  20 * 1024 * 1024 * 1024,
)
// Byte-gate headroom: evict oldest sessions until the root is below this
// fraction of the cap so a fresh session cannot immediately re-trip the gate.
const RECORDING_BYTE_HEADROOM_FRACTION = 0.9
const DEFAULT_FINAL_MANIFEST_RESERVE_BYTES = 64 * 1024
const DEFAULT_CHECKPOINT_DELAYS_MS = Object.freeze([0, 250, 1000])
const DEFAULT_OUTPUT_ROOT = process.platform === 'win32'
  ? (process.env.POI_MCP_RECORDING_DIR || 'E:\\kancolle\\recordings')
  : (process.env.POI_MCP_RECORDING_DIR || path.join(os.homedir(), '.poi-mcp', 'recordings'))
const SENSITIVE_KEY = /(auth|authorization|cookie|credential|key|login(?:data)?|password|secret|session|sid|ticket|token)/iu
const SENSITIVE_VALUE = /\b(?:basic|bearer|api[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?id)\b/iu
const GAME_BUSINESS_SORT_KEYS = new Set([
  'api_sort_key',
  'shipSortKeyType',
  'sort_key',
  'sortKey',
])
const EQUIPMENT_UI_STORAGE_KEYS = new Set([
  'listMode',
  'slotItemFilter',
  'slotItemFilterDetail',
  'slotItemPage',
])

function createPoiInteractionRecorder(options = {}) {
  const getStore = options.getStore || defaultGetStore
  const captureScreenshot = options.captureScreenshot ||
    createPoiScreenshotProvider({ getStore })
  const captureWebStorage = options.captureWebStorage || defaultCaptureWebStorage
  const captureEquipmentUiState = options.captureEquipmentUiState ||
    defaultCaptureEquipmentUiState
  const eventTarget = options.eventTarget === undefined
    ? defaultEventTarget()
    : options.eventTarget
  const resolveWebContents = options.resolveWebContents || defaultResolveWebContents
  const outputRoot = options.outputRoot || DEFAULT_OUTPUT_ROOT
  const logger = options.logger || console
  const now = options.now || (() => new Date())
  const nowMs = options.nowMs || (() => Date.now())
  const setIntervalFn = options.setInterval || setInterval
  const clearIntervalFn = options.clearInterval || clearInterval
  const setTimeoutFn = options.setTimeout || setTimeout
  const clearTimeoutFn = options.clearTimeout || clearTimeout
  const attachIntervalMs = positiveInteger(
    options.attachIntervalMs,
    DEFAULT_ATTACH_INTERVAL_MS,
    'attachIntervalMs',
  )
  const holdThresholdMs = positiveInteger(
    options.holdThresholdMs,
    DEFAULT_HOLD_THRESHOLD_MS,
    'holdThresholdMs',
  )
  const dragThresholdPx = positiveNumber(
    options.dragThresholdPx,
    DEFAULT_DRAG_THRESHOLD_PX,
    'dragThresholdPx',
  )
  const maxPathPoints = positiveInteger(
    options.maxPathPoints,
    DEFAULT_MAX_PATH_POINTS,
    'maxPathPoints',
  )
  const maxJsonBytes = positiveInteger(
    options.maxJsonBytes,
    DEFAULT_MAX_JSON_BYTES,
    'maxJsonBytes',
  )
  const maxSessionBytes = positiveInteger(
    options.maxSessionBytes,
    DEFAULT_MAX_SESSION_BYTES,
    'maxSessionBytes',
  )
  const maxTimelineEvents = positiveInteger(
    options.maxTimelineEvents,
    DEFAULT_MAX_TIMELINE_EVENTS,
    'maxTimelineEvents',
  )
  const maxSessionDurationMs = positiveInteger(
    options.maxSessionDurationMs,
    DEFAULT_MAX_SESSION_DURATION_MS,
    'maxSessionDurationMs',
  )
  const maxScreenshotBytes = positiveInteger(
    options.maxScreenshotBytes,
    DEFAULT_MAX_SCREENSHOT_BYTES,
    'maxScreenshotBytes',
  )
  const maxStoredSessions = positiveInteger(
    options.maxStoredSessions,
    DEFAULT_MAX_STORED_SESSIONS,
    'maxStoredSessions',
  )
  const maxTotalRecordingBytes = positiveInteger(
    options.maxTotalRecordingBytes,
    DEFAULT_MAX_TOTAL_RECORDING_BYTES,
    'maxTotalRecordingBytes',
  )
  const checkpointDelaysMs = normalizeCheckpointDelays(
    options.checkpointDelaysMs,
  )

  let running = false
  let attachedWebContents = null
  let attachTimer = null
  let sessionDeadlineTimer = null
  let activeGesture = null
  let gestureSequence = 0
  let responseSequence = 0
  let timelineSequence = 0
  let sessionId = null
  let sessionDir = null
  let manifest = null
  let pending = Promise.resolve()
  let lastStorageEntries = new Map()
  let acceptingEvents = false
  let limitReached = null
  let sessionBytes = 0
  let activeSessionByteLimit = maxSessionBytes
  let finalManifestReserveBytes = 0
  let sessionStartedAtMs = 0
  let storageHashKey = null
  let sessionFileSizes = new Map()
  let fileWritePending = Promise.resolve()
  const checkpointTimers = new Map()

  function enqueue(action) {
    const result = pending.then(action, action)
    pending = result.catch((error) => {
      logger.error(`[poi-plugin-mcp] Recorder write failed: ${error.message}`)
    })
    return result
  }

  function withinDurationBudget() {
    if (!acceptingEvents) return false
    if (nowMs() - sessionStartedAtMs <= maxSessionDurationMs) return true
    reachLimit('session-duration-limit')
    return false
  }

  function reachLimit(reason) {
    if (limitReached) return
    limitReached = {
      reason,
      reachedAt: timestamp(now()),
    }
    acceptingEvents = false
    running = false
    clearAttachTimer()
    clearSessionDeadlineTimer()
    cancelCheckpointTimers()
    activeGesture = null
    if (eventTarget && typeof eventTarget.removeEventListener === 'function') {
      eventTarget.removeEventListener('game.response', handleGameResponse)
    }
    detachWebContents()
    logger.error(`[poi-plugin-mcp] Play recording paused: ${reason}`)
    enqueue(finalizeSession)
  }

  function writeSessionFile(filePath, data, options = {}) {
    const operation = fileWritePending.then(
      () => writeSessionFileNow(filePath, data, options),
      () => writeSessionFileNow(filePath, data, options),
    )
    fileWritePending = operation.catch(() => {})
    return operation
  }

  async function writeSessionFileNow(filePath, data, options = {}) {
    if (!acceptingEvents && !options.finalizing) return false
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    const fileKey = path.resolve(filePath)
    const previousSize = sessionFileSizes.get(fileKey) || 0
    const nextSize = options.append
      ? previousSize + buffer.length
      : buffer.length
    const byteDelta = nextSize - previousSize
    const byteLimit = options.finalizing
      ? activeSessionByteLimit
      : activeSessionByteLimit - finalManifestReserveBytes
    if (
      sessionBytes + byteDelta > byteLimit
    ) {
      reachLimit('session-byte-limit')
      return false
    }
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      if (options.append) {
        await fs.promises.appendFile(filePath, buffer)
      } else {
        await fs.promises.writeFile(filePath, buffer)
      }
      sessionFileSizes.set(fileKey, nextSize)
      sessionBytes += byteDelta
      return true
    } catch (error) {
      throw error
    }
  }

  async function writeSessionJson(filePath, value, options = {}) {
    const json = serializeBoundedJson(value, maxJsonBytes)
    return writeSessionFile(filePath, json, options)
  }

  function currentLayout() {
    const layout = getStore('layout.webview')
    if (
      !layout ||
      !Number.isFinite(layout.width) ||
      layout.width <= 0 ||
      !Number.isFinite(layout.height) ||
      layout.height <= 0
    ) {
      return null
    }
    return layout
  }

  function resolveCurrentWebContents() {
    const layout = currentLayout()
    if (!layout || !layout.ref) return null
    if (typeof layout.ref.getWebContents === 'function') {
      return layout.ref.getWebContents()
    }
    if (typeof layout.ref.getWebContentsId === 'function') {
      const id = layout.ref.getWebContentsId()
      if (Number.isInteger(id) && id > 0) return resolveWebContents(id)
    }
    return null
  }

  function tryAttach() {
    if (!running || !acceptingEvents) return false
    let nextWebContents = null
    try {
      nextWebContents = resolveCurrentWebContents()
    } catch (error) {
      logger.error(`[poi-plugin-mcp] Recorder WebView lookup failed: ${error.message}`)
      return false
    }
    if (
      !nextWebContents ||
      typeof nextWebContents.on !== 'function'
    ) {
      interruptActiveGesture()
      detachWebContents()
      return false
    }
    if (nextWebContents === attachedWebContents) return true

    interruptActiveGesture()
    detachWebContents()
    attachedWebContents = nextWebContents
    attachedWebContents.on('before-mouse-event', handleMouseEvent)
    attachedWebContents.on('did-start-navigation', handleWebContentsNavigation)
    if (typeof attachedWebContents.once === 'function') {
      attachedWebContents.once('destroyed', handleWebContentsDestroyed)
    }
    return true
  }

  function handleWebContentsDestroyed() {
    interruptActiveGesture()
    detachWebContents()
  }

  function handleWebContentsNavigation(
    _event,
    _url,
    _isInPlace,
    isMainFrame,
  ) {
    if (isMainFrame === false) return
    interruptActiveGesture()
    detachWebContents()
  }

  function detachWebContents() {
    if (!attachedWebContents) return
    const remove = typeof attachedWebContents.off === 'function'
      ? attachedWebContents.off.bind(attachedWebContents)
      : typeof attachedWebContents.removeListener === 'function'
        ? attachedWebContents.removeListener.bind(attachedWebContents)
        : null
    if (remove) {
      remove('before-mouse-event', handleMouseEvent)
      remove('did-start-navigation', handleWebContentsNavigation)
      remove('destroyed', handleWebContentsDestroyed)
    }
    attachedWebContents = null
  }

  function interruptActiveGesture() {
    if (!activeGesture) return
    finishGesture({
      x: activeGesture.last.webview.x,
      y: activeGesture.last.webview.y,
      button: activeGesture.button,
    }, true)
  }

  function handleMouseEvent(_event, mouse) {
    observeMouseEvent({
      mouse,
      observedAt: timestamp(now()),
      observedAtMs: nowMs(),
      screenshot: null,
    })
  }

  function observeMouseEvent(observation) {
    const mouse = observation && observation.mouse
    if (
      !running ||
      !acceptingEvents ||
      !mouse ||
      typeof mouse !== 'object' ||
      !Number.isFinite(mouse.x) ||
      !Number.isFinite(mouse.y)
    ) {
      return
    }
    if (!withinDurationBudget()) return
    const timing = {
      observedAt: normalizedObservedAt(observation.observedAt, now),
      observedAtMs: Number.isFinite(observation.observedAtMs)
        ? observation.observedAtMs
        : nowMs(),
      screenshot: observation.screenshot || null,
    }

    if (mouse.type === 'mouseDown') {
      beginGesture(mouse, timing)
      return
    }
    if (mouse.type === 'mouseMove' && activeGesture) {
      if (!reportsHeldButton(mouse, activeGesture.button)) {
        interruptActiveGesture()
        return
      }
      updateGesture(mouse, timing)
      return
    }
    if (mouse.type === 'mouseUp' && activeGesture) {
      if (mouse.button === activeGesture.button) finishGesture(mouse, false, timing)
    }
  }

  function beginGesture(mouse, timing) {
    if (activeGesture) finishGesture(mouse, true)
    const layout = currentLayout()
    if (!layout) return

    gestureSequence += 1
    const id = `gesture-${String(gestureSequence).padStart(6, '0')}`
    const startedAtMs = timing.observedAtMs
    const start = pointerPoint(mouse, layout, 0)
    const startRelativePath = `frames/${id}-start.png`
    activeGesture = {
      id,
      button: supportedButton(mouse.button),
      startedAt: timing.observedAt,
      startedAtMs,
      layout: { width: layout.width, height: layout.height },
      start,
      last: start,
      maxDisplacementPx: 0,
      observedMovement: false,
      path: [pathPoint(start)],
      startScreenshot: requestScreenshot(
        startRelativePath,
        'start',
        timing.screenshot,
      ),
    }
  }

  function updateGesture(mouse, timing) {
    const gesture = activeGesture
    gesture.observedMovement = true
    const point = pointerPoint(
      mouse,
      gesture.layout,
      timing.observedAtMs - gesture.startedAtMs,
    )
    gesture.last = point
    gesture.maxDisplacementPx = Math.max(
      gesture.maxDisplacementPx,
      distance(gesture.start.webview, point.webview),
    )
    appendPathPoint(gesture.path, pathPoint(point), maxPathPoints)
  }

  function finishGesture(mouse, interrupted = false, timing = null) {
    const gesture = activeGesture
    if (!gesture) return
    activeGesture = null

    const endedAtMs = timing && Number.isFinite(timing.observedAtMs)
      ? timing.observedAtMs
      : nowMs()
    const endedAt = timing && typeof timing.observedAt === 'string'
      ? timing.observedAt
      : timestamp(now())
    const end = pointerPoint(
      mouse,
      gesture.layout,
      Math.max(0, endedAtMs - gesture.startedAtMs),
    )
    appendPathPoint(gesture.path, pathPoint(end), maxPathPoints)
    const displacementPx = distance(gesture.start.webview, end.webview)
    gesture.maxDisplacementPx = Math.max(
      gesture.maxDisplacementPx,
      displacementPx,
    )
    const durationMs = Math.max(0, Math.round(endedAtMs - gesture.startedAtMs))
    const gestureType = interrupted
      ? 'interrupted'
      : gesture.maxDisplacementPx >= dragThresholdPx
        ? 'drag'
        : durationMs > holdThresholdMs && gesture.observedMovement
          ? 'hold'
          : 'click'
    const screenshots = [gesture.startScreenshot]
    if (gestureType !== 'click') {
      screenshots.push(requestScreenshot(`frames/${gesture.id}-end.png`, 'end'))
    }

    enqueue(async () => {
      const screenshotResults = await Promise.all(screenshots)
      await appendTimeline({
        kind: 'pointer',
        gesture: gestureType,
        gestureId: gesture.id,
        occurredAt: gesture.startedAt,
        endedAt,
        button: gesture.button,
        durationMs,
        displacementPx: round3(displacementPx),
        maxDisplacementPx: round3(gesture.maxDisplacementPx),
        start: stripElapsed(gesture.start),
        end: stripElapsed(end),
        path: gesture.path,
        screenshots: screenshotResults,
      })
    })
    if (!interrupted) scheduleGestureCheckpoints(gesture.id)
  }

  function requestScreenshot(relativePath, phase, prefetchedScreenshot = null) {
    let requested
    if (prefetchedScreenshot) {
      requested = Promise.resolve(prefetchedScreenshot)
    } else {
      try {
        requested = Promise.resolve(captureScreenshot())
      } catch (error) {
        requested = Promise.reject(error)
      }
    }
    return requested.then(async (capture) => {
      if (
        !capture ||
        capture.mimeType !== 'image/png' ||
        typeof capture.dataBase64 !== 'string' ||
        capture.dataBase64.length === 0
      ) {
        throw new Error('Recorder screenshot must be a PNG base64 payload')
      }
      const data = Buffer.from(capture.dataBase64, 'base64')
      if (data.length > maxScreenshotBytes) {
        throw new Error(`Recorder screenshot exceeds ${maxScreenshotBytes} bytes`)
      }
      const absolutePath = path.join(sessionDir, ...relativePath.split('/'))
      const written = await writeSessionFile(absolutePath, data)
      if (!written) throw new Error('Recorder session byte limit reached')
      return {
        phase,
        file: relativePath,
        capturedAt: capture.capturedAt || timestamp(now()),
      }
    }).catch((error) => {
      logger.error(`[poi-plugin-mcp] Recorder screenshot failed: ${error.message}`)
      return {
        phase,
        file: null,
        error: error.message,
      }
    })
  }

  function handleGameResponse(event) {
    observeGameResponse({
      detail: event && event.detail,
      observedAt: timestamp(now()),
    })
  }

  function observeGameResponse(observation) {
    if (!running || !acceptingEvents || !withinDurationBudget()) return
    const detail = observation && observation.detail
    if (!detail || typeof detail.path !== 'string') return

    responseSequence += 1
    const responseId = `response-${String(responseSequence).padStart(6, '0')}`
    const apiPath = safeApiPath(detail.path)
    const leaf = safeFilename(path.posix.basename(apiPath) || 'response')
    const relativePath = `responses/${responseId}-${leaf}.json`
    const capturedAt = normalizedObservedAt(observation.observedAt, now)
    const sanitized = sanitizeDump(detail)
    const responseDocument = {
      schemaVersion: 1,
      responseId,
      capturedAt,
      ...sanitized,
      path: apiPath,
      reportedTimeMs: Number.isFinite(detail.time) ? detail.time : null,
      localState: snapshotInteractionState(getStore()),
    }

    enqueue(async () => {
      await writeSessionJson(
        path.join(sessionDir, ...relativePath.split('/')),
        responseDocument,
      )
      await appendTimeline({
        kind: 'game.response',
        responseId,
        occurredAt: capturedAt,
        path: apiPath,
        reportedTimeMs: responseDocument.reportedTimeMs,
        responseFile: relativePath,
      })
    })
  }

  async function appendTimeline(event) {
    if (!acceptingEvents) return false
    if (timelineSequence >= maxTimelineEvents) {
      reachLimit('timeline-event-limit')
      return false
    }
    timelineSequence += 1
    const line = JSON.stringify({
      sequence: timelineSequence,
      ...event,
    })
    if (Buffer.byteLength(line) > maxJsonBytes) {
      timelineSequence -= 1
      reachLimit('timeline-line-limit')
      return false
    }
    const written = await writeSessionFile(
      path.join(sessionDir, 'events.jsonl'),
      `${line}\n`,
      { append: true },
    )
    if (!written) timelineSequence -= 1
    return written
  }

  async function writeStateSnapshot(filename, capturedAt) {
    const store = getStore()
    const snapshot = {
      schemaVersion: 1,
      capturedAt,
      ...sanitizeDump(selectStoreState(store)),
    }
    await writeSessionJson(
      path.join(sessionDir, 'states', filename),
      snapshot,
    )
  }

  function scheduleGestureCheckpoints(gestureId) {
    for (const delayMs of checkpointDelaysMs) {
      let resolveCompletion
      const completion = new Promise((resolve) => {
        resolveCompletion = resolve
      })
      let timerHandle = null
      const callback = () => {
        checkpointTimers.delete(timerHandle)
        enqueue(() => writeGestureCheckpoint(gestureId, delayMs))
          .finally(resolveCompletion)
      }
      timerHandle = setTimeoutFn(callback, delayMs)
      checkpointTimers.set(timerHandle, { completion, resolveCompletion })
    }
  }

  async function writeGestureCheckpoint(gestureId, delayMs) {
    const delayLabel = String(delayMs).padStart(4, '0')
    const basename = `${gestureId.replace('gesture-', 'gesture-')}-${delayLabel}ms.json`
    const capturedAt = timestamp(now())
    const stateRelativePath = `checkpoints/${basename}`
    const storageRelativePath = `storage/${basename}`
    const equipmentUi = await readEquipmentUiState()
    await writeSessionJson(
      path.join(sessionDir, ...stateRelativePath.split('/')),
      {
        schemaVersion: 1,
        gestureId,
        delayMs,
        capturedAt,
        ...snapshotInteractionState(getStore()),
        equipmentUi,
      },
    )
    await writeStorageSnapshot(storageRelativePath, {
      gestureId,
      delayMs,
      capturedAt,
    })
    await appendTimeline({
      kind: 'checkpoint',
      gestureId,
      delayMs,
      occurredAt: capturedAt,
      stateFile: stateRelativePath,
      storageFile: storageRelativePath,
    })
  }

  async function readEquipmentUiState() {
    const webContents = attachedWebContents || resolveCurrentWebContents()
    try {
      if (!webContents) throw new Error('Poi game WebView is not ready')
      return {
        available: true,
        error: null,
        frames: sanitizeDump(await captureEquipmentUiState(webContents)),
      }
    } catch (error) {
      return {
        available: false,
        error: error.message,
        frames: [],
      }
    }
  }

  async function writeStorageSnapshot(relativePath, metadata = {}) {
    let frames = []
    let available = false
    let error = null
    const webContents = attachedWebContents || resolveCurrentWebContents()
    try {
      if (!webContents) throw new Error('Poi game WebView is not ready')
      const rawFrames = await captureWebStorage(webContents)
      frames = normalizeStorageFrames(rawFrames, storageHashKey)
      available = true
    } catch (captureError) {
      error = captureError.message
    }
    const { entries, changes } = diffStorageFrames(frames, lastStorageEntries)
    lastStorageEntries = entries
    await writeSessionJson(
      path.join(sessionDir, ...relativePath.split('/')),
      {
        schemaVersion: 1,
        available,
        error,
        capturedAt: metadata.capturedAt || timestamp(now()),
        ...metadata,
        frames,
        changes,
      },
    )
  }

  function cancelCheckpointTimers() {
    for (const [timerHandle, item] of checkpointTimers) {
      clearTimeoutFn(timerHandle)
      item.resolveCompletion()
    }
    checkpointTimers.clear()
  }

  function clearAttachTimer() {
    if (attachTimer == null) return
    clearIntervalFn(attachTimer)
    attachTimer = null
  }

  function clearSessionDeadlineTimer() {
    if (sessionDeadlineTimer == null) return
    clearTimeoutFn(sessionDeadlineTimer)
    sessionDeadlineTimer = null
  }

  async function start() {
    if (running) return getStatus()
    try {
    const recordingRoot = await inspectRecordingRoot(outputRoot)
    // Retention: both the session-count and byte gates evict oldest-first
    // instead of refusing to start; the byte gate leaves headroom for the
    // session that is about to begin.
    const evictCount = recordingRetentionEvictionCount({
      sessions: recordingRoot.sessions,
      totalBytes: recordingRoot.byteCount,
      maxStoredSessions,
      maxTotalRecordingBytes,
    })
    if (evictCount > 0) {
      await pruneOldestSessions(recordingRoot.sessionDirectories, evictCount, logger)
    }
    const afterPrune = await inspectRecordingRoot(outputRoot)
    if (afterPrune.byteCount >= maxTotalRecordingBytes) {
      throw new Error(
        `Recorder aggregate recording byte limit reached (${maxTotalRecordingBytes}); archive or remove old recordings before starting`,
      )
    }
    activeSessionByteLimit = Math.min(
      maxSessionBytes,
      maxTotalRecordingBytes - afterPrune.byteCount,
    )
    finalManifestReserveBytes = Math.min(
      DEFAULT_FINAL_MANIFEST_RESERVE_BYTES,
      Math.floor(activeSessionByteLimit / 4),
    )
    const startedAt = timestamp(now())
    sessionId = boundedSessionId(
      typeof options.sessionId === 'string'
        ? options.sessionId
        : crypto.randomUUID(),
    )
    const directoryName = `${compactTimestamp(startedAt)}-${sessionId}`
    sessionDir = path.join(outputRoot, directoryName)
    manifest = {
      schemaVersion: 1,
      sessionId,
      startedAt,
      endedAt: null,
      holdThresholdMs,
      dragThresholdPx,
      canonicalSize: {
        width: CANONICAL_WIDTH,
        height: CANONICAL_HEIGHT,
      },
      privacy: {
        sensitiveKeysRedacted: true,
        localStorageCaptured: true,
        sessionStorageCaptured: true,
        cookiesCaptured: false,
        cacheStorageCaptured: false,
        indexedDbCaptured: false,
        genericStorageValuesPlaintext: false,
        genericStorageHashesSessionScoped: true,
      },
      budgets: {
        maxSessionBytes,
        maxTimelineEvents,
        maxSessionDurationMs,
        maxScreenshotBytes,
        maxStoredSessions,
        maxTotalRecordingBytes,
        activeSessionByteLimit,
        finalManifestReserveBytes,
      },
    }
    gestureSequence = 0
    responseSequence = 0
    timelineSequence = 0
    activeGesture = null
    pending = Promise.resolve()
    lastStorageEntries = new Map()
    acceptingEvents = true
    limitReached = null
    sessionBytes = 0
    sessionFileSizes = new Map()
    fileWritePending = Promise.resolve()
    sessionStartedAtMs = nowMs()
    storageHashKey = crypto.randomBytes(32)
    running = true
    cancelCheckpointTimers()

    await fs.promises.mkdir(path.join(sessionDir, 'frames'), { recursive: true })
    await fs.promises.mkdir(path.join(sessionDir, 'responses'), { recursive: true })
    await fs.promises.mkdir(path.join(sessionDir, 'states'), { recursive: true })
    await fs.promises.mkdir(path.join(sessionDir, 'storage'), { recursive: true })
    await fs.promises.mkdir(path.join(sessionDir, 'checkpoints'), { recursive: true })
    await writeSessionJson(
      path.join(sessionDir, 'manifest.json'),
      manifest,
    )
    await writeStateSnapshot('session-start.json', startedAt)

    await writeSessionJson(
      path.join(sessionDir, 'checkpoints', 'session-start-ui.json'),
      {
        schemaVersion: 1,
        capturedAt: startedAt,
        equipmentUi: await readEquipmentUiState(),
      },
    )
    await writeStorageSnapshot('storage/session-start.json', {
      capturedAt: startedAt,
      phase: 'session-start',
    })
    if (!acceptingEvents) {
      await pending
      return getStatus()
    }
    sessionDeadlineTimer = setTimeoutFn(() => {
      sessionDeadlineTimer = null
      reachLimit('session-duration-limit')
    }, maxSessionDurationMs)
    attachTimer = setIntervalFn(tryAttach, attachIntervalMs)
    if (eventTarget && typeof eventTarget.addEventListener === 'function') {
      eventTarget.addEventListener('game.response', handleGameResponse)
    }
    tryAttach()
    logger.log(`[poi-plugin-mcp] Play recording started: ${sessionDir}`)
    return getStatus()
    } catch (error) {
      running = false
      acceptingEvents = false
      clearAttachTimer()
      clearSessionDeadlineTimer()
      cancelCheckpointTimers()
      activeGesture = null
      if (eventTarget && typeof eventTarget.removeEventListener === 'function') {
        eventTarget.removeEventListener('game.response', handleGameResponse)
      }
      detachWebContents()
      throw error
    }
  }

  async function stop() {
    if (!running) {
      await pending
      return getStatus()
    }
    running = false
    clearAttachTimer()
    clearSessionDeadlineTimer()
    if (eventTarget && typeof eventTarget.removeEventListener === 'function') {
      eventTarget.removeEventListener('game.response', handleGameResponse)
    }
    cancelCheckpointTimers()
    if (activeGesture) {
      finishGesture({
        x: activeGesture.last.webview.x,
        y: activeGesture.last.webview.y,
        button: activeGesture.button,
      }, true)
    }
    await pending

    const endedAt = timestamp(now())
    if (!limitReached) {
      await writeStorageSnapshot('storage/session-stop.json', {
        capturedAt: endedAt,
        phase: 'session-stop',
      })
      await writeStateSnapshot('session-stop.json', endedAt)
    }
    detachWebContents()
    await finalizeSession()
    return getStatus()
  }

  async function finalizeSession() {
    if (!manifest || manifest.endedAt) return
    running = false
    acceptingEvents = false
    clearAttachTimer()
    clearSessionDeadlineTimer()
    detachWebContents()
    manifest = {
      ...manifest,
      endedAt: timestamp(now()),
      pointerGestureCount: gestureSequence,
      gameResponseCount: responseSequence,
      timelineEventCount: timelineSequence,
      sessionBytes,
      limitReached,
    }
    let manifestWritten = false
    for (let attempt = 0; attempt < 4; attempt += 1) {
      manifest.sessionBytes = sessionBytes
      manifestWritten = await writeSessionJson(
        path.join(sessionDir, 'manifest.json'),
        manifest,
        { finalizing: true },
      )
      if (!manifestWritten || manifest.sessionBytes === sessionBytes) break
    }
    if (!manifestWritten) {
      logger.error('[poi-plugin-mcp] Recorder could not write its final manifest within the session byte limit')
    }
    logger.log(`[poi-plugin-mcp] Play recording stopped: ${sessionDir}`)
  }

  async function flush() {
    const scheduled = [...checkpointTimers.values()]
      .map((item) => item.completion)
    if (scheduled.length > 0) await Promise.all(scheduled)
    await pending
  }

  function getStatus() {
    return {
      running: running && acceptingEvents,
      acceptingEvents,
      attached: running && acceptingEvents && attachedWebContents !== null,
      sessionId,
      sessionDir,
      sessionBytes,
      limitReached,
    }
  }

  return Object.freeze({
    flush,
    getStatus,
    observeGameResponse,
    observeMouseEvent,
    start,
    stop,
  })
}

function normalizedObservedAt(value, now) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString()
  }
  return timestamp(now())
}

const SESSION_DIRECTORY_PATTERN = /^\d{8}-\d{9}Z-/u

async function inspectRecordingRoot(outputRoot) {
  let entries
  try {
    entries = await fs.promises.readdir(outputRoot, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { sessionCount: 0, byteCount: 0, sessionDirectories: [], sessions: [] }
    }
    throw error
  }
  let byteCount = 0
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(outputRoot, entry.name))
    .sort()
  const files = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => path.join(outputRoot, entry.name))
  for (const filePath of files) {
    try {
      byteCount += (await fs.promises.stat(filePath)).size
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
  }
  // Attribute every byte to its top-level directory so retention can rank
  // sessions by size as well as age.
  const rootBytes = new Map(directories.map((directory) => [directory, 0]))
  const stack = directories.map((directory) => ({ directory, root: directory }))
  while (stack.length > 0) {
    const { directory, root } = stack.pop()
    let children
    try {
      children = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      throw error
    }
    for (const child of children) {
      if (child.isSymbolicLink()) continue
      const childPath = path.join(directory, child.name)
      if (child.isDirectory()) {
        stack.push({ directory: childPath, root })
      } else if (child.isFile()) {
        try {
          const size = (await fs.promises.stat(childPath)).size
          byteCount += size
          rootBytes.set(root, (rootBytes.get(root) || 0) + size)
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error
        }
      }
    }
  }
  const sessionDirectories = directories.filter((directory) =>
    SESSION_DIRECTORY_PATTERN.test(path.basename(directory)),
  )
  const sessions = sessionDirectories.map((directory) => ({
    directory,
    bytes: rootBytes.get(directory) || 0,
  }))
  return {
    sessionCount: sessionDirectories.length,
    byteCount,
    sessionDirectories,
    sessions,
  }
}

// Oldest-first eviction count for the two retention gates. `sessions` must be
// sorted oldest-first (inspectRecordingRoot guarantees this via name sort).
function recordingRetentionEvictionCount({
  sessions,
  totalBytes,
  maxStoredSessions,
  maxTotalRecordingBytes,
}) {
  if (!Array.isArray(sessions)) return 0
  const countOverflow = sessions.length >= maxStoredSessions
    ? sessions.length - maxStoredSessions + 1
    : 0
  const byteTarget = Math.floor(maxTotalRecordingBytes * RECORDING_BYTE_HEADROOM_FRACTION)
  let byteEvictions = 0
  let recovered = 0
  for (const session of sessions) {
    if (totalBytes - recovered <= byteTarget) break
    recovered += Number.isFinite(session.bytes) ? session.bytes : 0
    byteEvictions += 1
  }
  return Math.max(countOverflow, byteEvictions)
}

async function pruneOldestSessions(sessionDirectories, count, logger) {
  if (count <= 0) return
  for (const directory of sessionDirectories.slice(0, count)) {
    await fs.promises.rm(directory, { recursive: true, force: true })
    logger.log(
      `[poi-plugin-mcp] Pruned oldest recording session: ${path.basename(directory)}`,
    )
  }
}

function pointerPoint(mouse, layout, elapsedMs) {
  const webview = {
    x: round3(mouse.x),
    y: round3(mouse.y),
  }
  return {
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    webview,
    canonical: {
      x: round3((webview.x * CANONICAL_WIDTH) / layout.width),
      y: round3((webview.y * CANONICAL_HEIGHT) / layout.height),
    },
    normalized: {
      x: round6(webview.x / layout.width),
      y: round6(webview.y / layout.height),
    },
  }
}

function pathPoint(point) {
  return {
    elapsedMs: point.elapsedMs,
    webview: point.webview,
    canonical: point.canonical,
  }
}

function stripElapsed(point) {
  const { elapsedMs: _elapsedMs, ...rest } = point
  return rest
}

function appendPathPoint(points, point, maximum) {
  const previous = points[points.length - 1]
  if (
    previous &&
    previous.webview.x === point.webview.x &&
    previous.webview.y === point.webview.y &&
    previous.elapsedMs === point.elapsedMs
  ) {
    return
  }
  if (points.length < maximum) {
    points.push(point)
  } else {
    points[points.length - 1] = point
  }
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function selectStoreState(store) {
  if (!store || typeof store !== 'object') {
    return {
      info: null,
      sortie: null,
      equipmentSortReference: {},
    }
  }
  return {
    info: store.info == null ? null : store.info,
    sortie: store.sortie == null ? null : store.sortie,
    equipmentSortReference: selectEquipmentSortReference(store),
  }
}

function selectEquipmentSortReference(store) {
  const masters = store && store.const && store.const.$equips
  if (!masters || typeof masters !== 'object') return {}
  const reference = {}
  for (const [key, item] of Object.entries(masters).slice(0, 5000)) {
    if (!item || typeof item !== 'object') continue
    const keyId = Number(key)
    const masterId = Number.isInteger(item.api_id)
      ? item.api_id
      : Number.isInteger(keyId)
        ? keyId
        : null
    if (masterId == null) continue
    reference[masterId] = {
      masterId,
      name: typeof item.api_name === 'string'
        ? item.api_name.slice(0, 256)
        : '',
      type: Array.isArray(item.api_type)
        ? item.api_type.slice(0, 16).filter(Number.isFinite)
        : [],
      sortNo: Number.isFinite(item.api_sortno) ? item.api_sortno : null,
    }
  }
  return reference
}

function snapshotInteractionState(store) {
  const info = store && typeof store === 'object' && store.info
    ? store.info
    : {}
  const equipment = info.equips && typeof info.equips === 'object'
    ? info.equips
    : {}
  const ships = info.ships && typeof info.ships === 'object'
    ? info.ships
    : {}
  const fleets = Array.isArray(info.fleets) ? info.fleets : []
  const shipSlotOrder = {}
  for (const [shipId, ship] of Object.entries(ships)) {
    if (ship && Array.isArray(ship.api_slot)) {
      shipSlotOrder[shipId] = ship.api_slot.slice()
    }
  }
  return {
    equipmentMembershipIds: Object.keys(equipment),
    shipSlotOrder,
    fleetShipOrder: fleets.map((fleet) => (
      fleet && Array.isArray(fleet.api_ship) ? fleet.api_ship.slice() : []
    )),
  }
}

function normalizeStorageFrames(rawFrames, hashKey) {
  if (!Array.isArray(rawFrames)) return []
  return rawFrames.slice(0, 64).map((frame, frameIndex) => {
    const source = frame && typeof frame === 'object' ? frame : {}
    return {
      frameIndex,
      origin: boundedStorageText(source.origin, 2048),
      pathname: boundedStorageText(source.pathname, 4096),
      ...(source.error ? { error: boundedStorageText(source.error, 4096) } : {}),
      localStorage: normalizeStorageEntries(source.localStorage, hashKey),
      sessionStorage: normalizeStorageEntries(source.sessionStorage, hashKey),
    }
  })
}

function normalizeStorageEntries(rawEntries, hashKey) {
  if (!Array.isArray(rawEntries)) return []
  return rawEntries.slice(0, 10000).flatMap((item) => {
    const key = Array.isArray(item) ? item[0] : item && item.key
    const value = Array.isArray(item) ? item[1] : item && item.value
    if (typeof key !== 'string') return []
    const rawValue = value == null ? '' : String(value)
    if (isSensitiveKey(key)) {
      return [{
        key: '[REDACTED]',
        sensitive: true,
      }]
    }
    const boundedKey = key.slice(0, 4096)
    const sensitiveValue = storageValueContainsSensitiveData(rawValue)
    if (EQUIPMENT_UI_STORAGE_KEYS.has(key)) {
      if (sensitiveValue) {
        return [{
          key: '[REDACTED]',
          sensitive: true,
        }]
      }
      return [{
        key: boundedKey,
        hash: hashText(rawValue, hashKey),
        value: boundedStorageText(rawValue, 1024),
      }]
    }
    const selected = selectEquipmentUiStorageFields(rawValue)
    if (selected && Object.keys(selected).length > 0) {
      const selectedText = JSON.stringify(selected)
      return [{
        key: boundedKey,
        hash: hashText(selectedText, hashKey),
        selected,
      }]
    }
    if (sensitiveValue) {
      return [{
        key: '[REDACTED]',
        sensitive: true,
      }]
    }
    return [{
      key: boundedKey,
      hash: hashText(rawValue, hashKey),
    }]
  })
}

function storageValueContainsSensitiveData(rawValue) {
  if (
    SENSITIVE_VALUE.test(rawValue) ||
    looksLikeSensitiveHeaderLine(rawValue) ||
    /(?:^|[?&;\s])(?:api[_-]?key|auth|authorization|cookie|credential|key|login(?:data)?|password|secret|session|sid|ticket|token)=[^&;\s]+/iu.test(rawValue) ||
    looksLikeOpaqueCredential(rawValue)
  ) {
    return true
  }
  let parsed
  try {
    parsed = JSON.parse(rawValue)
  } catch (_) {
    return false
  }
  const queue = [{ value: parsed, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 10000) {
    const { value, depth } = queue.shift()
    visited += 1
    if (typeof value === 'string') {
      if (
        SENSITIVE_VALUE.test(value) ||
        looksLikeSensitiveHeaderLine(value) ||
        looksLikeOpaqueCredential(value)
      ) {
        return true
      }
      continue
    }
    if (!value || typeof value !== 'object' || depth >= 8) continue
    for (const [key, item] of Object.entries(value).slice(0, 1000)) {
      if (isSensitiveKey(key)) return true
      queue.push({ value: item, depth: depth + 1 })
    }
  }
  return false
}

function diffStorageFrames(frames, previousEntries) {
  const entries = new Map()
  const changes = []
  for (const frame of frames) {
    for (const storageName of ['localStorage', 'sessionStorage']) {
      for (const entry of frame[storageName]) {
        if (entry.sensitive) continue
        const identity = [
          frame.frameIndex,
          frame.origin,
          frame.pathname,
          storageName,
          entry.key,
        ].join('\u0000')
        const next = {
          origin: frame.origin,
          pathname: frame.pathname,
          frameIndex: frame.frameIndex,
          storage: storageName,
          ...entry,
        }
        entries.set(identity, next)
        const previous = previousEntries.get(identity)
        if (!previous) {
          changes.push({
            type: 'added',
            ...next,
          })
        } else if (previous.hash !== next.hash) {
          changes.push({
            type: 'updated',
            origin: next.origin,
            pathname: next.pathname,
            frameIndex: next.frameIndex,
            storage: next.storage,
            key: next.key,
            oldHash: previous.hash,
            newHash: next.hash,
            oldValue: previous.value,
            newValue: next.value,
            oldSelected: previous.selected,
            newSelected: next.selected,
          })
        }
      }
    }
  }
  for (const [identity, previous] of previousEntries) {
    if (!entries.has(identity)) {
      changes.push({
        type: 'removed',
        ...previous,
      })
    }
  }
  return { entries, changes }
}

function selectEquipmentUiStorageFields(rawValue) {
  if (
    typeof rawValue !== 'string' ||
    rawValue.length === 0 ||
    rawValue.length > 1024 * 1024
  ) {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(rawValue)
  } catch (_) {
    return null
  }
  const output = {}
  const queue = [{ value: parsed, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 1000) {
    const { value, depth } = queue.shift()
    visited += 1
    if (!value || typeof value !== 'object' || depth > 6) continue
    for (const [key, item] of Object.entries(value).slice(0, 256)) {
      if (
        EQUIPMENT_UI_STORAGE_KEYS.has(key) &&
        (
          typeof item === 'string' ||
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item))
        )
      ) {
        output[key] = item
      } else if (item && typeof item === 'object') {
        queue.push({ value: item, depth: depth + 1 })
      }
    }
  }
  return output
}

function hashText(value, hashKey) {
  if (!Buffer.isBuffer(hashKey) || hashKey.length < 16) {
    throw new Error('Recorder storage hash key is unavailable')
  }
  return crypto.createHmac('sha256', hashKey).update(value, 'utf8').digest('hex')
}

function boundedStorageText(value, maximum) {
  if (typeof value !== 'string') return ''
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}[TRUNCATED]`
}

function sanitizeDump(value) {
  const state = {
    seen: new WeakSet(),
    nodes: 0,
    maxNodes: 200000,
    maxDepth: 12,
    maxArrayItems: 10000,
    maxObjectKeys: 10000,
    maxStringLength: 65536,
  }
  return sanitizeValue(value, state, 0)
}

function sanitizeValue(value, state, depth) {
  state.nodes += 1
  if (state.nodes > state.maxNodes) return '[TRUNCATED: node limit]'
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') {
    return sanitizeString(value, state.maxStringLength)
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return undefined
  if (depth >= state.maxDepth) return '[TRUNCATED: depth limit]'
  if (state.seen.has(value)) return '[CIRCULAR]'
  state.seen.add(value)

  if (value instanceof Date) return timestamp(value)
  if (Buffer.isBuffer(value)) return `[BINARY: ${value.length} bytes]`
  if (Array.isArray(value)) {
    if (
      value.length === 2 &&
      typeof value[0] === 'string' &&
      isSensitiveKey(value[0])
    ) {
      return [
        sanitizeString(value[0], state.maxStringLength),
        '[REDACTED]',
      ]
    }
    const limited = value.slice(0, state.maxArrayItems)
    const result = []
    for (let index = 0; index < limited.length; index += 1) {
      const previous = limited[index - 1]
      const item = (
        index % 2 === 1 &&
        typeof previous === 'string' &&
        isSensitiveKey(previous)
      )
        ? '[REDACTED]'
        : sanitizeValue(limited[index], state, depth + 1)
      if (item !== undefined) result.push(item)
    }
    if (value.length > state.maxArrayItems) {
      result.push(`[TRUNCATED: ${value.length - state.maxArrayItems} items]`)
    }
    return result
  }

  const output = {}
  const entries = Object.entries(value)
  for (const [key, item] of entries.slice(0, state.maxObjectKeys)) {
    if (isSensitiveKey(key)) {
      output[key] = '[REDACTED]'
      continue
    }
    const sanitized = sanitizeValue(item, state, depth + 1)
    if (sanitized !== undefined) output[key] = sanitized
  }
  if (entries.length > state.maxObjectKeys) {
    output.__truncatedKeys = entries.length - state.maxObjectKeys
  }
  return output
}

function sanitizeString(value, maximum) {
  if (looksLikeSensitiveHeaderLine(value)) return '[REDACTED]'
  const withoutQuery = stripUrlQuery(value)
  if (
    SENSITIVE_VALUE.test(withoutQuery) ||
    /(?:^|[?&;\s])(?:api[_-]?key|auth|authorization|cookie|credential|key|login(?:data)?|password|secret|session|sid|ticket|token)=[^&;\s]+/iu.test(withoutQuery) ||
    looksLikeOpaqueCredential(withoutQuery)
  ) {
    return '[REDACTED]'
  }
  return withoutQuery.length <= maximum
    ? withoutQuery
    : `${withoutQuery.slice(0, maximum)}[TRUNCATED]`
}

function isSensitiveKey(value) {
  return (
    typeof value === 'string' &&
    !GAME_BUSINESS_SORT_KEYS.has(value) &&
    SENSITIVE_KEY.test(value)
  )
}

function looksLikeSensitiveHeaderLine(value) {
  return /(?:^|[\r\n])\s*(?:authorization|proxy-authorization|cookie|set-cookie|credential|login(?:data)?|password|secret|session|sid|ticket|token|x-api-key)\s*:/iu.test(value)
}

function stripUrlQuery(value) {
  if (
    !/^(?:https?:\/\/|\/)/iu.test(value) ||
    (!value.includes('?') && !value.includes('#'))
  ) {
    return value
  }
  const queryIndex = value.indexOf('?')
  const fragmentIndex = value.indexOf('#')
  const indexes = [queryIndex, fragmentIndex].filter((index) => index >= 0)
  return indexes.length === 0 ? value : value.slice(0, Math.min(...indexes))
}

function looksLikeOpaqueCredential(value) {
  const trimmed = value.trim()
  if (
    trimmed.length < 32 ||
    trimmed.length > 4096 ||
    !/^[A-Za-z0-9+/_=-]+$/u.test(trimmed)
  ) {
    return false
  }
  return /[A-Za-z]/u.test(trimmed) && /\d/u.test(trimmed)
}

function serializeBoundedJson(value, maxBytes) {
  const json = `${JSON.stringify(value, null, 2)}\n`
  const bytes = Buffer.byteLength(json)
  if (bytes > maxBytes) {
    const fallback = {
      schemaVersion: 1,
      truncated: true,
      originalBytes: bytes,
      maxBytes,
      path: value && value.path,
      capturedAt: value && value.capturedAt,
    }
    return `${JSON.stringify(fallback, null, 2)}\n`
  }
  return json
}

function supportedButton(value) {
  return ['left', 'middle', 'right'].includes(value) ? value : 'left'
}

function reportsHeldButton(mouse, button) {
  if (typeof mouse.button === 'string') return mouse.button === button
  if (!Array.isArray(mouse.modifiers)) return false
  const expected = `${button}buttondown`
  return mouse.modifiers.some((modifier) => (
    typeof modifier === 'string' && modifier.toLowerCase() === expected
  ))
}

function safeFilename(value) {
  const sanitized = String(value).replace(/[^A-Za-z0-9._-]+/gu, '-')
  return sanitized.slice(0, 80) || 'response'
}

function safeApiPath(value) {
  const source = String(value)
  try {
    return new URL(source, 'http://127.0.0.1').pathname
  } catch (_) {
    return source.split(/[?#]/u, 1)[0]
  }
}

function compactTimestamp(value) {
  return value.replace(/[-:.]/gu, '').replace('T', '-').replace('Z', 'Z')
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('now must return a valid date')
  return date.toISOString()
}

function boundedSessionId(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    throw new Error('sessionId must contain only letters, numbers, dot, underscore, or dash')
  }
  return value
}

function positiveInteger(value, fallback, name) {
  const selected = value == null ? fallback : value
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return selected
}

function envPositiveInteger(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

function positiveNumber(value, fallback, name) {
  const selected = value == null ? fallback : value
  if (!Number.isFinite(selected) || selected <= 0) {
    throw new Error(`${name} must be a positive finite number`)
  }
  return selected
}

function normalizeCheckpointDelays(value) {
  const selected = value == null ? DEFAULT_CHECKPOINT_DELAYS_MS : value
  if (
    !Array.isArray(selected) ||
    selected.length === 0 ||
    selected.length > 10 ||
    selected.some((item) => (
      !Number.isInteger(item) ||
      item < 0 ||
      item > 60000
    ))
  ) {
    throw new Error('checkpointDelaysMs must contain 1 to 10 integers from 0 to 60000')
  }
  return [...new Set(selected)].sort((a, b) => a - b)
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

function round6(value) {
  return Math.round(value * 1000000) / 1000000
}

function defaultGetStore(storePath) {
  if (typeof window !== 'undefined' && typeof window.getStore === 'function') {
    return window.getStore(storePath)
  }
  return null
}

function defaultEventTarget() {
  return typeof window !== 'undefined' ? window : null
}

function defaultResolveWebContents(webContentsId) {
  const { webContents } = require('@electron/remote')
  return webContents.fromId(webContentsId)
}

async function defaultCaptureWebStorage(webContents) {
  const mainFrame = webContents && webContents.mainFrame
  const frames = mainFrame && Array.isArray(mainFrame.framesInSubtree)
    ? mainFrame.framesInSubtree
    : mainFrame
      ? [mainFrame]
      : []
  if (frames.length === 0) {
    throw new Error('Poi game WebView frames are not ready')
  }
  const script = `(() => {
    const readStorage = (storage) => {
      const entries = []
      const limit = Math.min(storage.length, 512)
      for (let index = 0; index < limit; index += 1) {
        const key = storage.key(index)
        if (typeof key === 'string') {
          const value = storage.getItem(key)
          entries.push([
            key.slice(0, 4096),
            typeof value === 'string' ? value.slice(0, 65536) : value,
          ])
        }
      }
      return entries
    }
    try {
      return {
        origin: location.origin,
        pathname: location.pathname,
        localStorage: readStorage(window.localStorage),
        sessionStorage: readStorage(window.sessionStorage),
      }
    } catch (error) {
      return {
        origin: location.origin,
        pathname: location.pathname,
        localStorage: [],
        sessionStorage: [],
        error: error && error.message ? error.message : String(error),
      }
    }
  })()`
  const captured = await Promise.all(frames.slice(0, 64).map(async (frame) => {
    try {
      return await frame.executeJavaScript(script)
    } catch (error) {
      return {
        origin: '',
        pathname: '',
        localStorage: [],
        sessionStorage: [],
        error: error.message,
      }
    }
  }))
  return captured.filter((frame) => isKanColleGameOrigin(frame && frame.origin))
}

function isKanColleGameOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      (
        url.hostname === 'kancolle-server.com' ||
        url.hostname.endsWith('.kancolle-server.com')
      )
    )
  } catch (_) {
    return false
  }
}

async function defaultCaptureEquipmentUiState(_webContents) {
  throw new Error(
    'Equipment UI sort probe unavailable: a direct runtime target is not configured',
  )
}

module.exports = {
  CANONICAL_HEIGHT,
  CANONICAL_WIDTH,
  DEFAULT_MAX_SESSION_BYTES,
  DEFAULT_MAX_STORED_SESSIONS,
  DEFAULT_MAX_TOTAL_RECORDING_BYTES,
  DEFAULT_OUTPUT_ROOT,
  RECORDING_BYTE_HEADROOM_FRACTION,
  captureEquipmentUiStateFromWebContents: defaultCaptureEquipmentUiState,
  captureWebStorageFromWebContents: defaultCaptureWebStorage,
  createPoiInteractionRecorder,
  inspectRecordingRoot,
  pruneOldestSessions,
  recordingRetentionEvictionCount,
}
