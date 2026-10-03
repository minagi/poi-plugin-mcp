const path = require('path')
const { createPoiDataBridge } = require('./poi-http-bridge')
const { loadOrCreateInputToken } = require('./input-token')
const {
  DEFAULT_SETTINGS_FILE,
  loadSettings,
  mergeSettings,
  normalizeSettings,
  saveSettings,
} = require('./settings')

function createBridgeController(options = {}) {
  const settingsPath = options.settingsPath || DEFAULT_SETTINGS_FILE
  const logger = options.logger || console
  let createBridge = options.createBridge || createPoiDataBridge

  let settings = loadSettings(settingsPath)
  let bridge = null
  let recorder = null
  let inputToken = options.inputToken || null
  let pending = Promise.resolve()
  let reloading = false

  function enqueue(action) {
    pending = pending.then(action, action)
    return pending
  }

  function createCurrentBridge() {
    if (!inputToken) {
      inputToken = loadOrCreateInputToken(options.inputTokenFile)
    }
    return createBridge({
      getStore: options.getStore,
      captureScreenshot: options.captureScreenshot,
      performInput: options.performInput,
      getQuestList: options.getQuestList,
      getAvailableQuestSnapshot: options.getAvailableQuestSnapshot,
      getMissionBoard: options.getMissionBoard,
      getQuestAction: options.getQuestAction,
      getEquipmentAction: options.getEquipmentAction,
      getEquipmentSelection: options.getEquipmentSelection,
      getUnsetSlot: options.getUnsetSlot,
      getFleetAction: options.getFleetAction,
      getActionEvents: options.getActionEvents,
      getActionEventsWait: options.getActionEventsWait,
      getApiResponses: options.getApiResponses,
      getBattleTelemetry: options.getBattleTelemetry,
      inputEnabled: settings.inputEnabled,
      debugEvalEnabled: settings.debugEvalEnabled,
      inputToken,
      port: settings.port,
      portFile: options.portFile,
      logger,
      isWriterTokenEnforced: () => settings.writerTokenEnforced === true,
      reloadModules: hotReloadModules,
    })
  }

  function createCurrentRecorder() {
    if (options.createRecorder) {
      return options.createRecorder({
        getStore: options.getStore,
        captureScreenshot: options.captureScreenshot,
        logger,
      })
    }
    const {
      createPoiAutoInteractionRecorder,
    } = require('./poi-auto-interaction-recorder')
    const { createPoiInteractionRecorder } = require('./poi-interaction-recorder')
    return createPoiAutoInteractionRecorder({
      getStore: options.getStore,
      logger,
      createSessionRecorder: () => createPoiInteractionRecorder({
        getStore: options.getStore,
        captureScreenshot: options.captureScreenshot,
        logger,
      }),
    })
  }

  async function ensureStarted() {
    if (!bridge) {
      bridge = createCurrentBridge()
    }
    await bridge.start()
  }

  async function ensureRecorderStarted() {
    if (!recorder) recorder = createCurrentRecorder()
    await recorder.start()
  }

  async function stopCurrentRecorder() {
    if (!recorder) return
    await recorder.stop()
  }

  async function stopCurrentBridge() {
    if (!bridge) return

    const runningBridge = bridge
    bridge = null
    await runningBridge.stop()
  }

  /**
   * Hot reload (2026-09-12): purge this plugin's lib/ require cache and
   * rebuild the bridge from the on-disk code. Live instances (this
   * controller, the telemetry object wired in index.js, the recorder) keep
   * their closures and state; only the module table refreshes. Returns after
   * validation — the swap is scheduled so the HTTP response can flush first.
   */
  function hotReloadModules() {
    if (reloading) {
      return Promise.reject(new Error('a reload is already in progress'))
    }
    return enqueue(async () => {
      reloading = true
      try {
        const libRoot = __dirname
        for (const key of Object.keys(require.cache)) {
          if (key.startsWith(libRoot + path.sep) || key === libRoot) {
            delete require.cache[key]
          }
        }
        // Fresh require throws on a broken build → old bridge untouched.
        const fresh = require('./poi-http-bridge')
        const freshFactory = fresh.createPoiDataBridge
        if (typeof freshFactory !== 'function') {
          throw new Error('fresh poi-http-bridge does not export createPoiDataBridge')
        }
        // Re-read settings: the fresh settings module may normalize new keys.
        const freshSettings = require('./settings')
        settings = freshSettings.normalizeSettings(
          freshSettings.loadSettings(settingsPath),
        )
        createBridge = freshFactory
        const wasEnabled = settings.enabled
        // Let the /admin/reload response flush on the old connection before
        // it drops; the swap then runs on the controller's serial queue.
        setTimeout(() => {
          enqueue(async () => {
            try {
              await stopCurrentBridge()
              if (wasEnabled) await ensureStarted()
              logger.log('[poi-plugin-mcp] hot reload complete')
            } catch (error) {
              logger.error(`[poi-plugin-mcp] hot reload swap failed: ${error.message}`)
              // Best effort: the factory is already fresh; the next
              // ensureStarted (any settings apply or manual start) recovers.
              try {
                if (wasEnabled) await ensureStarted()
              } catch (_) { /* surfaced by the next status poll */ }
            }
          })
        }, 250)
        return { port: settings.port, deferredSwap: true }
      } finally {
        reloading = false
      }
    })
  }

  function persist(nextSettings) {
    settings = saveSettings(normalizeSettings(nextSettings), settingsPath)
    return settings
  }

  return {
    load() {
      return enqueue(async () => {
        settings = loadSettings(settingsPath)
        if (settings.enabled) await ensureStarted()
        if (settings.recordingEnabled) await ensureRecorderStarted()
      })
    },

    unload() {
      return enqueue(async () => {
        await stopCurrentRecorder()
        await stopCurrentBridge()
      })
    },

    startBridge() {
      return enqueue(async () => {
        persist({ ...settings, enabled: true })
        await ensureStarted()
      })
    },

    stopBridge() {
      return enqueue(async () => {
        persist({ ...settings, enabled: false })
        await stopCurrentBridge()
      })
    },

    applySettings(nextSettings) {
      return enqueue(async () => {
        const normalized = mergeSettings(settings, nextSettings)
        const portChanged = normalized.port !== settings.port
        const enabledChanged = normalized.enabled !== settings.enabled
        const inputEnabledChanged = normalized.inputEnabled !== settings.inputEnabled
        const debugEvalEnabledChanged =
          normalized.debugEvalEnabled !== settings.debugEvalEnabled
        const recordingEnabledChanged =
          normalized.recordingEnabled !== settings.recordingEnabled

        persist(normalized)

        if (settings.recordingEnabled) {
          await ensureRecorderStarted()
        } else if (recordingEnabledChanged) {
          await stopCurrentRecorder()
        }

        if (!settings.enabled) {
          await stopCurrentBridge()
          return
        }

        if (
          portChanged ||
          enabledChanged ||
          inputEnabledChanged ||
          debugEvalEnabledChanged ||
          !bridge
        ) {
          await stopCurrentBridge()
          await ensureStarted()
        }
      })
    },

    getSettings() {
      return { ...settings }
    },

    /**
     * 2026-09-12 hot reload: rebuild the HTTP/input layer from the on-disk
     * lib/ code without restarting poi. Telemetry getters are re-injected
     * (event generations survive); the recorder session is untouched.
     *
     * Ordering: the fresh modules are required BEFORE anything stops — a bad
     * build throws here, the old bridge keeps serving, and the caller gets a
     * 500 with the require error. The swap itself is deferred so the
     * /admin/reload response flushes on the old connection before it drops.
     */
    reloadModules: hotReloadModules,

    getStatus() {
      const actualPort = bridge ? bridge.getPort() : 0
      const recorderStatus = recorder && typeof recorder.getStatus === 'function'
        ? recorder.getStatus()
        : {}
      return {
        enabled: settings.enabled,
        running: actualPort > 0,
        port: settings.port,
        actualPort,
        inputEnabled: settings.inputEnabled,
        debugEvalEnabled: settings.debugEvalEnabled,
        recordingEnabled: settings.recordingEnabled,
        recordingArmed: recorderStatus.armed === true,
        recordingStarting: recorderStatus.starting === true,
        recording: recorderStatus.running === true,
        recordingAttached: recorderStatus.attached === true,
        recordingSessionId: recorderStatus.sessionId || null,
        recordingSessionDir: recorderStatus.sessionDir || null,
        recordingSessionBytes: Number.isFinite(recorderStatus.sessionBytes)
          ? recorderStatus.sessionBytes
          : 0,
        recordingLimitReached: recorderStatus.limitReached || null,
        recordingIdleSessionMs: Number.isFinite(recorderStatus.idleSessionMs)
          ? recorderStatus.idleSessionMs
          : 0,
      }
    },
  }
}

module.exports = {
  createBridgeController,
}
