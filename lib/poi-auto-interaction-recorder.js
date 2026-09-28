const { createPoiScreenshotProvider } = require('./poi-screenshot')

const DEFAULT_ATTACH_INTERVAL_MS = 1000
const DEFAULT_IDLE_SESSION_MS = 5 * 60 * 1000
const MAX_BUFFERED_MOUSE_EVENTS = 256
const MAX_BUFFERED_RESPONSES = 128

function createPoiAutoInteractionRecorder(options = {}) {
  const getStore = options.getStore || defaultGetStore
  const loadElectronRemote = options.loadElectronRemote ||
    (() => require('@electron/remote'))
  const resolveWebContents = options.resolveWebContents || ((webContentsId) => {
    const remote = loadElectronRemote()
    return remote.webContents.fromId(webContentsId)
  })
  // Remote-proxy memoization (0909 leak fix): every getWebContents() across
  // @electron/remote registers fresh objects in poi's main-process
  // ObjectsRegistry; at ~1 call/sec the per-context Map hits V8's size cap
  // (RangeError: Map maximum size exceeded) and ALL game writes die until
  // poi restarts. Resolve by integer id (no registration) and cache the
  // proxy — Electron ids are monotonic, never reused after destroy.
  const webContentsProxyCache = new Map()
  let captureScreenshot = options.captureScreenshot || null
  const createSessionRecorder = options.createSessionRecorder
  const eventTarget = options.eventTarget === undefined
    ? defaultEventTarget()
    : options.eventTarget
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
  const idleSessionMs = positiveInteger(
    options.idleSessionMs,
    DEFAULT_IDLE_SESSION_MS,
    'idleSessionMs',
  )

  let armed = false
  let attachedWebContents = null
  let attachTimer = null
  let idleTimer = null
  let sessionRecorder = null
  let starting = false
  let pending = Promise.resolve()
  let lastSessionStatus = null
  let limitReached = null
  let closing = false
  let startAfterClose = false
  let bufferedGesture = false
  let bufferedMouseEvents = []
  let bufferedResponses = []
  let sessionStopError = null

  function enqueue(action) {
    const result = pending.then(action, action)
    pending = result.catch((error) => {
      logger.error(`[poi-plugin-mcp] Automatic recorder transition failed: ${error.message}`)
    })
    return result
  }

  function currentWebContents() {
    const layout = getStore('layout.webview')
    if (!layout || !layout.ref) return null
    if (typeof layout.ref.getWebContentsId === 'function') {
      const id = layout.ref.getWebContentsId()
      if (Number.isInteger(id) && id > 0) {
        const hit = webContentsProxyCache.get(id)
        if (hit) return hit
        const resolved = resolveWebContents(id)
        if (resolved) {
          webContentsProxyCache.set(id, resolved)
          return resolved
        }
      }
    }
    if (typeof layout.ref.getWebContents === 'function') {
      const webContents = layout.ref.getWebContents()
      if (webContents) {
        webContentsProxyCache.set('ref', webContents)
        return webContents
      }
    }
    return null
  }

  function tryAttach() {
    if (!armed) return false
    let nextWebContents = null
    try {
      nextWebContents = currentWebContents()
    } catch (error) {
      logger.error(`[poi-plugin-mcp] Automatic recorder WebView lookup failed: ${error.message}`)
      return false
    }
    if (!nextWebContents || typeof nextWebContents.on !== 'function') {
      detachWebContents()
      return false
    }
    if (nextWebContents === attachedWebContents) return true
    detachWebContents()
    attachedWebContents = nextWebContents
    attachedWebContents.on('before-mouse-event', handleMouseEvent)
    return true
  }

  function handleMouseEvent(_event, mouse) {
    if (
      !armed ||
      !mouse ||
      typeof mouse !== 'object' ||
      !['mouseMove', 'mouseDown', 'mouseUp'].includes(mouse.type) ||
      !Number.isFinite(mouse.x) ||
      !Number.isFinite(mouse.y)
    ) {
      return
    }
    if (limitReached) return
    if (closing) {
      startAfterClose = true
      bufferMouseEvent(mouse)
      return
    }
    if (!sessionRecorder && !starting) beginSession()
    if (starting) bufferMouseEvent(mouse)
    if (sessionRecorder) scheduleIdleStop()
  }

  function handleGameResponse(event) {
    if (
      !armed ||
      limitReached ||
      (!starting && !(closing && startAfterClose))
    ) {
      return
    }
    if (bufferedResponses.length >= MAX_BUFFERED_RESPONSES) return
    bufferedResponses.push({
      detail: event && event.detail,
      observedAt: now().toISOString(),
    })
  }

  function bufferMouseEvent(mouse) {
    if (mouse.type === 'mouseDown') bufferedGesture = true
    if (!bufferedGesture && mouse.type !== 'mouseDown') return
    if (bufferedMouseEvents.length >= MAX_BUFFERED_MOUSE_EVENTS) return
    const observation = {
      mouse: { ...mouse },
      observedAt: now().toISOString(),
      observedAtMs: nowMs(),
      screenshot: null,
    }
    if (mouse.type === 'mouseDown') {
      try {
        if (!captureScreenshot) {
          captureScreenshot = createPoiScreenshotProvider({ getStore })
        }
        observation.screenshot = Promise.resolve(captureScreenshot())
      } catch (error) {
        observation.screenshot = Promise.reject(error)
      }
    }
    bufferedMouseEvents.push(observation)
    if (mouse.type === 'mouseUp') bufferedGesture = false
  }

  function beginSession() {
    if (!armed || sessionRecorder || starting) return
    starting = true
    enqueue(async () => {
      try {
        if (!armed) return
        const nextRecorder = createSessionRecorder()
        sessionRecorder = nextRecorder
        await nextRecorder.start()
        lastSessionStatus = nextRecorder.getStatus()
        limitReached = lastSessionStatus.limitReached || null
        if (typeof nextRecorder.observeMouseEvent === 'function') {
          for (const observation of bufferedMouseEvents) {
            nextRecorder.observeMouseEvent(observation)
          }
        }
        if (typeof nextRecorder.observeGameResponse === 'function') {
          for (const event of bufferedResponses) {
            nextRecorder.observeGameResponse(event)
          }
        }
        bufferedMouseEvents = []
        bufferedResponses = []
        bufferedGesture = false
        if (armed && lastSessionStatus.running) scheduleIdleStop()
      } catch (error) {
        sessionRecorder = null
        bufferedMouseEvents = []
        bufferedResponses = []
        bufferedGesture = false
        limitReached = {
          reason: 'session-start-failed',
          message: error.message,
        }
        throw error
      } finally {
        starting = false
      }
    })
  }

  function scheduleIdleStop() {
    if (idleTimer != null) clearTimeoutFn(idleTimer)
    idleTimer = setTimeoutFn(() => {
      idleTimer = null
      endCurrentSession()
    }, idleSessionMs)
  }

  function endCurrentSession() {
    if (closing) return
    closing = true
    enqueue(async () => {
      let stopFailed = false
      try {
        if (!sessionRecorder) return
        const endingRecorder = sessionRecorder
        try {
          await endingRecorder.stop()
          lastSessionStatus = endingRecorder.getStatus()
          limitReached = lastSessionStatus.limitReached || limitReached
        } catch (error) {
          stopFailed = true
          sessionStopError = error
          try {
            lastSessionStatus = endingRecorder.getStatus()
          } catch (_statusError) {
            // Preserve the original stop failure.
          }
          limitReached = {
            reason: 'session-stop-failed',
            message: error.message,
          }
          startAfterClose = false
          bufferedMouseEvents = []
          bufferedResponses = []
          bufferedGesture = false
          throw error
        } finally {
          if (sessionRecorder === endingRecorder) sessionRecorder = null
        }
      } finally {
        closing = false
        if (armed && startAfterClose && !stopFailed && !limitReached) {
          startAfterClose = false
          beginSession()
        }
      }
    })
  }

  function clearIdleTimer() {
    if (idleTimer == null) return
    clearTimeoutFn(idleTimer)
    idleTimer = null
  }

  function detachWebContents() {
    if (!attachedWebContents) return
    if (typeof attachedWebContents.off === 'function') {
      attachedWebContents.off('before-mouse-event', handleMouseEvent)
    } else if (typeof attachedWebContents.removeListener === 'function') {
      attachedWebContents.removeListener('before-mouse-event', handleMouseEvent)
    }
    attachedWebContents = null
  }

  async function start() {
    if (armed) return getStatus()
    limitReached = null
    sessionStopError = null
    armed = true
    try {
      if (eventTarget && typeof eventTarget.addEventListener === 'function') {
        eventTarget.addEventListener('game.response', handleGameResponse)
      }
      tryAttach()
      attachTimer = setIntervalFn(tryAttach, attachIntervalMs)
      return getStatus()
    } catch (error) {
      armed = false
      if (attachTimer != null) {
        clearIntervalFn(attachTimer)
        attachTimer = null
      }
      if (eventTarget && typeof eventTarget.removeEventListener === 'function') {
        eventTarget.removeEventListener('game.response', handleGameResponse)
      }
      detachWebContents()
      throw error
    }
  }

  async function stop() {
    armed = false
    startAfterClose = false
    bufferedMouseEvents = []
    bufferedResponses = []
    bufferedGesture = false
    clearIdleTimer()
    if (attachTimer != null) {
      clearIntervalFn(attachTimer)
      attachTimer = null
    }
    if (eventTarget && typeof eventTarget.removeEventListener === 'function') {
      eventTarget.removeEventListener('game.response', handleGameResponse)
    }
    detachWebContents()
    let stopError = null
    try {
      await pending
      if (sessionRecorder) {
        const endingRecorder = sessionRecorder
        try {
          await endingRecorder.stop()
        } catch (error) {
          stopError = error
        } finally {
          try {
            lastSessionStatus = endingRecorder.getStatus()
          } catch (error) {
            if (!stopError) stopError = error
          }
          if (sessionRecorder === endingRecorder) sessionRecorder = null
        }
      }
      if (!stopError && sessionStopError) stopError = sessionStopError
    } finally {
      detachWebContents()
    }
    if (stopError) throw stopError
    return getStatus()
  }

  function getStatus() {
    const sessionStatus = sessionRecorder
      ? sessionRecorder.getStatus()
      : lastSessionStatus || {}
    return {
      armed,
      starting,
      running: sessionStatus.running === true,
      acceptingEvents: sessionStatus.acceptingEvents === true,
      attached: armed && (
        sessionStatus.attached === true ||
        attachedWebContents !== null
      ),
      sessionId: sessionStatus.sessionId || null,
      sessionDir: sessionStatus.sessionDir || null,
      sessionBytes: Number.isFinite(sessionStatus.sessionBytes)
        ? sessionStatus.sessionBytes
        : 0,
      limitReached: sessionStatus.limitReached || limitReached,
      idleSessionMs,
    }
  }

  async function flush() {
    while (true) {
      const currentPending = pending
      await currentPending
      if (currentPending === pending) break
    }
    if (sessionRecorder && typeof sessionRecorder.flush === 'function') {
      await sessionRecorder.flush()
    }
  }

  if (typeof createSessionRecorder !== 'function') {
    throw new TypeError('createSessionRecorder must be a function')
  }

  return Object.freeze({
    flush,
    getStatus,
    start,
    stop,
  })
}

function positiveInteger(value, fallback, field) {
  const next = value === undefined ? fallback : value
  if (!Number.isSafeInteger(next) || next <= 0) {
    throw new TypeError(`${field} must be a positive integer`)
  }
  return next
}

function defaultEventTarget() {
  return typeof window !== 'undefined' ? window : null
}

function defaultGetStore(path) {
  if (typeof window !== 'undefined' && typeof window.getStore === 'function') {
    return window.getStore(path)
  }
  return undefined
}

module.exports = {
  DEFAULT_IDLE_SESSION_MS,
  createPoiAutoInteractionRecorder,
}
