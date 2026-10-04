const fs = require('fs')
const http = require('http')
const crypto = require('crypto')
const os = require('os')
const path = require('path')
const packageJson = require('../package.json')
const {
  MCP_TOOL_DEFINITIONS,
  McpToolInputError,
  decodePoiResources,
  formatActionEvents,
  formatAirbaseStatus,
  formatAvailableQuests,
  formatKcsapiResponses,
  formatQuests,
  formatResourceHistory,
  searchEquipment: searchEquipmentSnapshot,
  searchShips: searchShipsSnapshot,
  validateActionEventsArgs,
  validateAvailableQuestsArgs,
  validateFleetStatusArgs,
  validateGetAllArgs,
  validateKcsapiResponsesArgs,
  validateNoArguments,
  validateResourceHistoryArgs,
} = require('./mcp-tools')
const {
  readAkashicResourceHistory,
} = require('./integrations/akashic-records')
const { loadOrCreateInputToken } = require('./input-token')
const { getWriterTokenRegistry, hasValidWriterToken } = require('./writer-tokens')
const { createPoiInputProvider } = require('./poi-input')
const { createPoiInputLease } = require('./poi-input-lease')
const { createPoiScreenshotProvider } = require('./poi-screenshot')
const {
  MAX_QUERY_BODY_BYTES,
  createPoiDataQuery,
} = require('./poi-data-query')
const {
  collectFleetMetricShips,
  inspectFleetMetrics,
  moraleMeaning,
  speedFromRaw,
  speedMeaning,
} = require('./fleet-metrics')
const {
  createPixiHitLedger,
  defaultLedgerFile,
} = require('./pixi-hit-ledger')

const DEFAULT_PORT = 17777
const DEFAULT_PORT_FILE = path.join(os.homedir(), '.poi-mcp', 'port')
const DEFAULT_PLANNER_FILE = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'poi',
  'poi-plugin-ship-info.json',
)
const DEFAULT_MASTER_FILE = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'poi',
  'navy-album',
  'master.json',
)
const JSONRPC_VERSION = '2.0'

const MCP_PROTOCOL_VERSION = '2024-11-05'
const INPUT_BODY_LIMIT = 64 * 1024
const MASTER_FILE_LIMIT = 16 * 1024 * 1024
const DEFAULT_ACTION_EVENT_LIMIT = 64
const MAX_ACTION_EVENT_LIMIT = 256
const DEFAULT_ACTION_EVENT_WAIT_TIMEOUT_MS = 30_000
const MAX_ACTION_EVENT_WAIT_TIMEOUT_MS = 60_000

function createPoiDataBridge(options = {}) {
  const getStore = options.getStore || defaultGetStore
  const getSettings = options.getSettings || (() => ({}))
  const configuredPort = options.port == null ? DEFAULT_PORT : options.port
  const portFile = options.portFile || DEFAULT_PORT_FILE
  const plannerFile = options.plannerFile || DEFAULT_PLANNER_FILE
  const masterFile = options.masterFile || DEFAULT_MASTER_FILE
  const logger = options.logger || console
  const getQuestList = options.getQuestList || (() => ({ available: false, generation: 0 }))
  const getAvailableQuestSnapshot = options.getAvailableQuestSnapshot ||
    (() => ({
      available: false,
      complete: false,
      stale: false,
      staleReason: 'not_loaded',
      sessionId: null,
      generation: 0,
      quests: [],
    }))
  const getMissionBoard = options.getMissionBoard ||
    (() => ({ available: false, generation: 0 }))
  const getQuestAction = options.getQuestAction || (() => ({ available: false, generation: 0 }))
  const getEquipmentAction = options.getEquipmentAction ||
    (() => ({ available: false, generation: 0 }))
  const getEquipmentSelection = options.getEquipmentSelection ||
    (() => ({ available: false, generation: 0 }))
  const getUnsetSlot = options.getUnsetSlot ||
    (() => ({ available: false, generation: 0 }))
  const getFleetAction = options.getFleetAction ||
    (() => ({ available: false, generation: 0 }))
  const getActionEvents = options.getActionEvents ||
    (() => ({
      available: false,
      sessionId: null,
      latestGeneration: 0,
      events: [],
    }))
  const getActionEventsWait = options.getActionEventsWait ||
    (typeof getActionEvents.wait === 'function'
      ? getActionEvents.wait.bind(getActionEvents)
      : null)
  const getApiResponses = options.getApiResponses ||
    (() => ({
      available: false,
      latestGeneration: 0,
      responses: [],
    }))
  const getBattleTelemetry = options.getBattleTelemetry ||
    (() => ({ available: false, generation: 0 }))
  const inputEnabled = options.inputEnabled === true
  const debugEvalEnabled = options.debugEvalEnabled === true
  const inputToken = options.inputToken || (
    inputEnabled ? loadOrCreateInputToken(options.inputTokenFile) : null
  )
  const inputLease = options.inputLease || createPoiInputLease(options.inputLeaseOptions)
  // 2026-09-12 Phase C: daemon-delegated writer tokens gate the INPUT
  // surface (clicks, lease takes, debug-eval). Module-level singleton so
  // settings-triggered bridge re-creation keeps the registered set; a hot
  // reload purges the module, and the daemon's periodic re-registration
  // self-heals within one idle cycle.
  const writerTokens = options.writerTokens || getWriterTokenRegistry()
  const isWriterTokenEnforced = options.isWriterTokenEnforced ||
    (() => options.writerTokenEnforced === true)
  let captureScreenshot = options.captureScreenshot || null
  let performInput = options.performInput || null
  let dataQuery = options.dataQuery || null

  let server = null
  let actualPort = 0
  let inputPending = Promise.resolve()
  const pendingActionEventWaits = new Set()

  /**
   * Writer-token gate for input-capable endpoints. Callers have already
   * validated the static bearer (transport auth). Three outcomes:
   * registered token -> pass; missing/rejected token + enforcement -> 403
   * with a reason a stale process can act on; missing token in observation
   * mode -> pass and count (legacyAuth), which is the bridge-side
   * foreign-writer signal.
   */
  function authorizeWriterInput(req) {
    const headerValue = req.headers['x-writer-token']
    if (hasValidWriterToken(headerValue, writerTokens)) {
      return { ok: true }
    }
    if (isWriterTokenEnforced()) {
      return {
        ok: false,
        status: 403,
        error:
          'Writer token rejected: no registered X-Writer-Token matches. ' +
          'Stale process from a previous daemon generation? Re-submit the work ' +
          'through the daemon (kc daemon submit) or renew the token.',
      }
    }
    writerTokens.noteLegacyAuth(Date.now(), `${req.method} ${req.url}`)
    return { ok: true, legacy: true }
  }

  function readStore() {
    const store = getStore()
    if (!store || !store.info) {
      throw new Error('POI store not ready. Enter the game first.')
    }
    return store
  }

  function sendJson(res, statusCode, data, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
    }
    if (options.allowCors !== false) {
      headers['Access-Control-Allow-Origin'] = '*'
    }
    if (options.noStore) {
      headers['Cache-Control'] = 'no-store'
    }
    Object.assign(headers, options.headers)
    res.writeHead(statusCode, headers)
    res.end(JSON.stringify(data))
  }

  function sendInputJson(res, statusCode, data, options = {}) {
    sendJson(res, statusCode, data, {
      allowCors: false,
      noStore: true,
      ...options,
    })
  }

  function currentDataQuery() {
    if (!dataQuery) {
      dataQuery = createPoiDataQuery({
        getStore,
        getApiResponses,
        resolveWebContents: options.resolveWebContents,
        cacheRoot: options.cacheRoot,
        logger,
      })
    }
    return dataQuery
  }

  let hitLedger = null
  function currentHitLedger() {
    if (!hitLedger) {
      hitLedger = createPixiHitLedger({
        evaluate: (request) => currentDataQuery().runtime.evaluate(request),
        listFrames: () => currentDataQuery().runtime.listFrames(),
        ledgerFile: defaultLedgerFile(portFile),
        logger,
      })
    }
    return hitLedger
  }

  async function handleDataRequest(req, res, endpoint) {
    if (req.method !== 'POST') {
      drainRequest(req)
      sendInputJson(res, 405, { error: `${endpoint} only accepts POST requests.` })
      return
    }
    if (!hasValidBearerToken(req.headers.authorization, inputToken)) {
      drainRequest(req)
      sendInputJson(
        res,
        401,
        { error: 'A valid Bearer token is required.' },
        { headers: { 'WWW-Authenticate': 'Bearer' } },
      )
      return
    }
    // /debug/evaluate executes arbitrary JS in the game WebView — it is a
    // write-capable channel and takes the writer-token gate. /query is a
    // read and stays static-bearer (diagnostics keep working).
    if (endpoint === '/debug/evaluate') {
      const writer = authorizeWriterInput(req)
      if (!writer.ok) {
        drainRequest(req)
        sendInputJson(res, writer.status, { error: writer.error })
        return
      }
    }
    try {
      const body = await readRequestBody(
        req,
        MAX_QUERY_BODY_BYTES,
        'Data request body exceeds 64KB.',
      )
      const request = JSON.parse(body || '{}')
      if (endpoint === '/query') {
        sendInputJson(res, 200, await currentDataQuery().query(request))
        return
      }
      if (!debugEvalEnabled) {
        sendInputJson(res, 403, {
          code: 'DEBUG_EVAL_DISABLED',
          error: 'Dangerous WebView debug evaluation is disabled in Poi settings.',
        })
        return
      }
      sendInputJson(
        res,
        200,
        await currentDataQuery().runtime.evaluate(request),
      )
    } catch (error) {
      sendInputJson(
        res,
        error.statusCode || (error.code === 'BODY_TOO_LARGE' ? 413 : 400),
        {
          ...(error.code ? { code: error.code } : {}),
          ...(error.details ? { details: error.details } : {}),
          error: error.message,
        },
      )
    }
  }

  function enqueueInput(operation, claim) {
    const execute = async () => {
      inputLease.assertClaimActive(claim)
      if (!performInput) {
        performInput = createPoiInputProvider({ getStore })
      }
      // 0913 per-click hit ledger (admiral ruling): snapshot what the live
      // PIXI tree shows at the pointer before dispatch, gated by the same
      // debugEvalEnabled setting that owns WebView evaluation. Evidence
      // only — the response field and ~/.poi-mcp/hit-ledger.jsonl never
      // gate the dispatch itself (capture is fail-soft and wall-bounded).
      let hit
      if (
        debugEvalEnabled === true &&
        (operation.operation === 'click' ||
          operation.operation === 'drag' ||
          operation.operation === 'scroll')
      ) {
        hit = await currentHitLedger().capture(operation, {
          leaseId: claim.leaseId,
          ownerSessionId: claim.ownerSessionId,
          runId: claim.runId,
          action: claim.action,
        })
      }
      const operationName = await performInput(operation)
      return {
        ok: true,
        operation: operationName,
        ...(hit === undefined ? {} : { hit }),
        sequence: claim.sequence,
        leaseId: claim.leaseId,
        ownerSessionId: claim.ownerSessionId,
        runId: claim.runId,
        action: claim.action,
        acceptedAt: claim.acceptedAt,
      }
    }
    const result = inputPending.then(execute, execute)
    inputPending = result.catch(() => {})
    return result
  }

  async function handleInputRequest(req, res) {
    if (req.method !== 'POST') {
      drainRequest(req)
      sendInputJson(res, 405, { error: 'Input endpoint only accepts POST requests.' })
      return
    }
    if (!hasValidBearerToken(req.headers.authorization, inputToken)) {
      drainRequest(req)
      sendInputJson(
        res,
        401,
        { error: 'A valid Bearer token is required.' },
        { headers: { 'WWW-Authenticate': 'Bearer' } },
      )
      return
    }
    if (requestContentLength(req) > INPUT_BODY_LIMIT) {
      drainRequest(req)
      sendInputJson(res, 413, { error: 'Input request body exceeds 64KB.' })
      return
    }
    if (!inputEnabled) {
      drainRequest(req)
      sendInputJson(res, 403, { error: 'WebView input is disabled.' })
      return
    }
    const writer = authorizeWriterInput(req)
    if (!writer.ok) {
      drainRequest(req)
      sendInputJson(res, writer.status, { error: writer.error })
      return
    }

    try {
      const body = await readRequestBody(
        req,
        INPUT_BODY_LIMIT,
        'Input request body exceeds 64KB.',
      )
      const operation = JSON.parse(body || '{}')
      const { input, claim } = claimInputOperation(inputLease, operation)
      sendInputJson(res, 200, await enqueueInput(input, claim))
    } catch (error) {
      const statusCode = error.statusCode || (error.code === 'BODY_TOO_LARGE'
        ? 413
        : /WebView|dimensions/.test(error.message)
          ? 503
          : 400)
      sendInputJson(res, statusCode, {
        ...(error.code ? { code: error.code } : {}),
        error: error.message,
      })
    }
  }

  async function handleInputLeaseRequest(req, res, endpoint) {
    if (!hasValidBearerToken(req.headers.authorization, inputToken)) {
      drainRequest(req)
      sendInputJson(
        res,
        401,
        { error: 'A valid Bearer token is required.' },
        { headers: { 'WWW-Authenticate': 'Bearer' } },
      )
      return
    }
    // Lease MUTATIONS (acquire/renew/release/revoke) are input-adjacent —
    // they gate who may click — so the writer-token applies. The plain
    // GET /input/lease status read stays static-bearer (live 0912: the
    // dashboard's takeover-button poll flooded the legacy counter and would
    // 403 under enforcement; reads must not take the writer gate).
    const leaseMutation =
      endpoint === '/input/lease/acquire' ||
      endpoint === '/input/lease/renew' ||
      endpoint === '/input/lease/release' ||
      endpoint === '/input/lease/revoke'
    if (leaseMutation) {
      const leaseWriter = authorizeWriterInput(req)
      if (!leaseWriter.ok) {
        drainRequest(req)
        sendInputJson(res, leaseWriter.status, { error: leaseWriter.error })
        return
      }
    }
    if (endpoint === '/input/lease') {
      if (req.method !== 'GET') {
        drainRequest(req)
        sendInputJson(res, 405, { error: 'Input lease status only accepts GET requests.' })
        return
      }
      const lease = inputLease.status()
      sendInputJson(res, 200, { active: lease !== null, lease })
      return
    }
    if (req.method !== 'POST') {
      drainRequest(req)
      sendInputJson(res, 405, { error: 'Input lease changes only accept POST requests.' })
      return
    }
    if (!inputEnabled) {
      drainRequest(req)
      sendInputJson(res, 403, { error: 'WebView input is disabled.' })
      return
    }
    if (requestContentLength(req) > INPUT_BODY_LIMIT) {
      drainRequest(req)
      sendInputJson(res, 413, { error: 'Input request body exceeds 64KB.' })
      return
    }

    try {
      const body = await readRequestBody(
        req,
        INPUT_BODY_LIMIT,
        'Input request body exceeds 64KB.',
      )
      const request = JSON.parse(body || '{}')
      if (endpoint === '/input/lease/acquire') {
        const lease = inputLease.acquire(request)
        sendInputJson(res, 200, { active: true, lease })
        return
      }
      if (endpoint === '/input/lease/renew') {
        const lease = inputLease.renew(request)
        sendInputJson(res, 200, { active: true, lease })
        return
      }
      if (endpoint === '/input/lease/release') {
        inputLease.release(request)
        sendInputJson(res, 200, { active: false, released: true })
        return
      }
      if (endpoint === '/input/lease/revoke') {
        inputLease.revoke(request)
        sendInputJson(res, 200, { active: false, revoked: true })
        return
      }
      sendInputJson(res, 404, { error: `Unknown input lease endpoint: ${endpoint}` })
    } catch (error) {
      const statusCode = error.statusCode || (error.code === 'BODY_TOO_LARGE' ? 413 : 400)
      sendInputJson(res, statusCode, {
        ...(error.code ? { code: error.code } : {}),
        error: error.message,
      })
    }
  }

  async function handleActionEventsWait(req, res, requestUrl) {
    if (req.method !== 'GET') {
      drainRequest(req)
      sendJson(res, 405, {
        error: 'Action events wait endpoint only accepts GET requests.',
      })
      return
    }

    const controller = new AbortController()
    let responded = false
    const abort = () => {
      if (!responded) controller.abort()
    }
    const cleanup = () => {
      req.removeListener('aborted', abort)
      res.removeListener('close', abort)
      pendingActionEventWaits.delete(controller)
    }
    req.once('aborted', abort)
    res.once('close', abort)
    pendingActionEventWaits.add(controller)

    const options = {
      after: clampedQueryInteger(
        requestUrl.searchParams.get('after'),
        0,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      limit: clampedQueryInteger(
        requestUrl.searchParams.get('limit'),
        DEFAULT_ACTION_EVENT_LIMIT,
        1,
        MAX_ACTION_EVENT_LIMIT,
      ),
      timeoutMs: clampedQueryInteger(
        requestUrl.searchParams.get('timeoutMs'),
        DEFAULT_ACTION_EVENT_WAIT_TIMEOUT_MS,
        1,
        MAX_ACTION_EVENT_WAIT_TIMEOUT_MS,
      ),
      signal: controller.signal,
    }

    try {
      const result = await awaitActionEventsWait(options)
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return
      responded = true
      sendJson(res, 200, {
        ...result,
        timedOut: result && typeof result.timedOut === 'boolean'
          ? result.timedOut
          : false,
      })
    } catch (error) {
      if (controller.signal.aborted && (res.destroyed || res.writableEnded)) return
      if (res.destroyed || res.writableEnded) return
      responded = true
      sendJson(res, error.statusCode || 503, {
        ...(error.code ? { code: error.code } : {}),
        error: error.message,
      }, controller.signal.aborted ? { headers: { Connection: 'close' } } : {})
    } finally {
      cleanup()
    }
  }

  function awaitActionEventsWait(options) {
    const operation = () => getActionEventsWait
      ? getActionEventsWait(options)
      : { ...getActionEvents(options), timedOut: true }
    if (!options.signal) return Promise.resolve().then(operation)
    if (options.signal.aborted) return Promise.reject(createActionEventAbortError())

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (settlement, value) => {
        if (settled) return
        settled = true
        options.signal.removeEventListener('abort', onAbort)
        settlement(value)
      }
      const onAbort = () => finish(reject, createActionEventAbortError())
      options.signal.addEventListener('abort', onAbort, { once: true })
      let pending
      try {
        pending = operation()
      } catch (error) {
        finish(reject, error)
        return
      }
      Promise.resolve(pending).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      )
    })
  }

  function handleMcpRequest(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'MCP endpoint only accepts POST requests.' })
      return
    }

    readRequestBody(req)
      .then((body) => {
        let message
        try {
          message = JSON.parse(body || '{}')
        } catch (error) {
          sendJson(res, 200, jsonRpcError(null, -32700, error.message))
          return
        }
        let response
        try {
          response = handleMcpMessage(message, readStore, plannerFile, {
            getAvailableQuestSnapshot,
            getActionEvents,
            getApiResponses,
            getResourceHistory: () => readAkashicResourceHistory(
              getSettings(),
              getStore,
            ),
            getBattle: () => combineBattleTelemetry(
              getBattleTelemetry(),
              extractProphetBattle(readStore()),
            ),
          })
        } catch (error) {
          const code = error instanceof McpToolInputError ? -32602 : -32603
          sendJson(res, 200, jsonRpcError(message.id ?? null, code, error.message))
          return
        }

        if (response == null) {
          res.writeHead(202, {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json',
          })
          res.end('')
          return
        }

        sendJson(res, 200, response)
      })
      .catch((error) => {
        sendJson(res, 200, jsonRpcError(null, -32700, error.message))
      })
  }

  async function handleRequest(req, res) {
    try {
      if (req.url === '/shutdown') {
        sendJson(res, 200, { status: 'shutting down' })
        stop()
        return
      }

      const requestUrl = new URL(
        req.url,
        `http://127.0.0.1:${actualPort || configuredPort}`,
      )
      const endpoint = requestUrl.pathname

      if (endpoint === '/health') {
        sendJson(res, 200, { status: 'ok' })
        return
      }

      if (endpoint === '/mcp') {
        handleMcpRequest(req, res)
        return
      }

      if (endpoint === '/query' || endpoint === '/debug/evaluate') {
        await handleDataRequest(req, res, endpoint)
        return
      }

      if (endpoint === '/debug/status') {
        if (!hasValidBearerToken(req.headers.authorization, inputToken)) {
          drainRequest(req)
          sendInputJson(res, 401, { error: 'A valid Bearer token is required.' })
          return
        }
        sendInputJson(res, 200, {
          enabled: debugEvalEnabled,
          endpoint: '/debug/evaluate',
          warning: 'Arbitrary JavaScript can read or modify the signed-in game WebView.',
        })
        return
      }

      // 2026-09-12 Phase C: writer-token administration. The static bearer is
      // the ADMIN credential here — exactly one caller (the daemon) uses it
      // to delegate; input endpoints no longer accept it as a writer.
      if (endpoint === '/writer-tokens') {
        if (!hasValidBearerToken(req.headers.authorization, inputToken)) {
          drainRequest(req)
          sendInputJson(res, 401, { error: 'A valid Bearer token is required.' })
          return
        }
        if (req.method === 'GET') {
          sendInputJson(res, 200, {
            enforced: isWriterTokenEnforced(),
            ...writerTokens.status(),
          })
          return
        }
        if (req.method !== 'PUT') {
          drainRequest(req)
          sendInputJson(res, 405, { error: '/writer-tokens accepts GET or PUT.' })
          return
        }
        try {
          const body = await readRequestBody(
            req,
            MAX_QUERY_BODY_BYTES,
            'Writer token request body exceeds 64KB.',
          )
          const payload = JSON.parse(body || '{}')
          const outcome = writerTokens.register(payload)
          sendInputJson(res, 200, { ok: true, ...outcome, ...writerTokens.status() })
        } catch (error) {
          sendInputJson(res, 400, { error: error.message })
        }
        return
      }

      // 2026-09-12 hot reload: rebuild the HTTP/input layer from the on-disk
      // lib/ code without restarting poi. Telemetry state and the recorder
      // session survive (the controller re-injects the same getters); open
      // connections drop and clients reconnect.
      if (endpoint === '/admin/reload') {
        if (!hasValidBearerToken(req.headers.authorization, inputToken)) {
          drainRequest(req)
          sendInputJson(res, 401, { error: 'A valid Bearer token is required.' })
          return
        }
        if (req.method !== 'POST') {
          drainRequest(req)
          sendInputJson(res, 405, { error: '/admin/reload only accepts POST.' })
          return
        }
        drainRequest(req)
        if (typeof options.reloadModules !== 'function') {
          sendInputJson(res, 501, { error: 'reloadModules is not wired by this controller build' })
          return
        }
        try {
          const outcome = await options.reloadModules()
          // After a successful reload THIS bridge instance is stopped and the
          // fresh one owns the port — report the outcome's port, not the
          // stale local getPort().
          sendInputJson(res, 200, {
            ok: true,
            reloaded: true,
            port: (outcome && outcome.port) || getPort(),
            ...(outcome || {}),
          })
        } catch (error) {
          sendInputJson(res, 500, { ok: false, error: error.message })
        }
        return
      }

      if (endpoint === '/screenshot') {
        if (req.method !== 'GET') {
          sendJson(
            res,
            405,
            { error: 'Screenshot endpoint only accepts GET requests.' },
            { allowCors: false, noStore: true },
          )
          return
        }
        try {
          if (!captureScreenshot) {
            captureScreenshot = createPoiScreenshotProvider()
          }
          sendJson(
            res,
            200,
            await captureScreenshot(),
            { allowCors: false, noStore: true },
          )
        } catch (error) {
          sendJson(
            res,
            503,
            { error: error.message },
            { allowCors: false, noStore: true },
          )
        }
        return
      }

      if (endpoint === '/input/status') {
        if (req.method !== 'GET') {
          drainRequest(req)
          sendInputJson(
            res,
            405,
            { error: 'Input status endpoint only accepts GET requests.' },
          )
          return
        }
        sendInputJson(res, 200, { enabled: inputEnabled })
        return
      }

      if (
        endpoint === '/input/lease' ||
        endpoint === '/input/lease/acquire' ||
        endpoint === '/input/lease/renew' ||
        endpoint === '/input/lease/release' ||
        endpoint === '/input/lease/revoke'
      ) {
        await handleInputLeaseRequest(req, res, endpoint)
        return
      }

      if (endpoint === '/input') {
        await handleInputRequest(req, res)
        return
      }

      if (endpoint === '/quest-list') {
        sendJson(res, 200, getQuestList())
        return
      }

      if (endpoint === '/available-quests') {
        if (req.method !== 'GET') {
          drainRequest(req)
          sendJson(res, 405, {
            error: 'Available quests endpoint only accepts GET requests.',
          })
          return
        }
        sendJson(res, 200, getAvailableQuestSnapshot())
        return
      }

      if (endpoint === '/mission-board') {
        sendJson(res, 200, getMissionBoard())
        return
      }

      if (endpoint === '/quest-action') {
        sendJson(res, 200, getQuestAction())
        return
      }

      if (endpoint === '/equipment-action') {
        sendJson(res, 200, getEquipmentAction())
        return
      }

      if (endpoint === '/equipment-selection') {
        sendJson(res, 200, getEquipmentSelection())
        return
      }

      if (endpoint === '/unsetslot') {
        sendJson(res, 200, getUnsetSlot())
        return
      }

      if (endpoint === '/fleet-action') {
        sendJson(res, 200, getFleetAction())
        return
      }

      if (endpoint === '/action-events/wait') {
        await handleActionEventsWait(req, res, requestUrl)
        return
      }

      if (endpoint === '/action-events') {
        if (req.method !== 'GET') {
          drainRequest(req)
          sendJson(res, 405, {
            error: 'Action events endpoint only accepts GET requests.',
          })
          return
        }
        sendJson(res, 200, getActionEvents({
          after: clampedQueryInteger(
            requestUrl.searchParams.get('after'),
            0,
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          limit: clampedQueryInteger(
            requestUrl.searchParams.get('limit'),
            DEFAULT_ACTION_EVENT_LIMIT,
            1,
            MAX_ACTION_EVENT_LIMIT,
          ),
        }))
        return
      }

      if (endpoint === '/api-responses') {
        if (req.method !== 'GET') {
          drainRequest(req)
          sendJson(res, 405, {
            error: 'API responses endpoint only accepts GET requests.',
          })
          return
        }
        const pathFilter = requestUrl.searchParams.get('path')
        sendJson(res, 200, getApiResponses({
          after: clampedQueryInteger(
            requestUrl.searchParams.get('after'),
            0,
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          limit: clampedQueryInteger(
            requestUrl.searchParams.get('limit'),
            DEFAULT_ACTION_EVENT_LIMIT,
            1,
            MAX_ACTION_EVENT_LIMIT,
          ),
          ...(pathFilter === null ? {} : { path: pathFilter }),
        }))
        return
      }

      const store = readStore()
      const info = store.info

      switch (endpoint) {
        case '/basic':
          sendJson(res, 200, info.basic || {})
          break
        case '/fleets':
          sendJson(res, 200, info.fleets || [])
          break
        case '/ships':
          sendJson(res, 200, info.ships || {})
          break
        case '/equipment':
          sendJson(res, 200, info.equips || {})
          break
        case '/resources':
          sendJson(res, 200, info.resources || [])
          break
        case '/quests':
          sendJson(res, 200, {
            activeQuests: (info.quests && info.quests.activeQuests) || {},
            records: (info.quests && info.quests.records) || {},
          })
          break
        case '/airbase':
          sendJson(res, 200, info.airbase || [])
          break
        case '/names':
          sendJson(res, 200, extractNames(store))
          break
        case '/master':
          sendJson(res, 200, extractMasterData(store, masterFile))
          break
        case '/event':
          sendJson(res, 200, extractEventData(store))
          break
        case '/planner':
          sendJson(res, 200, extractPlannerData(store, plannerFile))
          break
        case '/battle':
          sendJson(res, 200, combineBattleTelemetry(
            getBattleTelemetry(),
            extractProphetBattle(store),
          ))
          break
        case '/all':
          sendJson(res, 200, {
            basic: info.basic || {},
            fleets: info.fleets || [],
            ships: info.ships || {},
            equipment: info.equips || {},
            resources: info.resources || [],
            quests: {
              activeQuests: (info.quests && info.quests.activeQuests) || {},
              records: (info.quests && info.quests.records) || {},
            },
            airbase: info.airbase || [],
            repairs: info.repairs || [],
            constructions: info.constructions || [],
            maps: info.maps || {},
            useitems: info.useitems || {},
            sortie: store.sortie || {},
            names: extractNames(store),
          })
          break
        default:
          sendJson(res, 404, { error: `Unknown endpoint: ${endpoint}` })
      }
    } catch (error) {
      sendJson(res, 503, { error: error.message })
    }
  }

  function start() {
    if (server) return Promise.resolve()

    fs.mkdirSync(path.dirname(portFile), { recursive: true })
    server = http.createServer(handleRequest)

    return new Promise((resolve, reject) => {
      const onError = (error) => {
        cleanupPortFile(portFile)
        server = null
        reject(error)
      }

      server.once('error', onError)
      server.listen(configuredPort, '127.0.0.1', () => {
        server.removeListener('error', onError)
        actualPort = server.address().port
        fs.writeFileSync(portFile, String(actualPort), 'utf8')
        logger.log(`[poi-plugin-mcp] HTTP API started on http://127.0.0.1:${actualPort}`)
        resolve()
      })
    })
  }

  function stop() {
    for (const controller of Array.from(pendingActionEventWaits)) controller.abort()

    if (!server) {
      cleanupPortFile(portFile)
      actualPort = 0
      return Promise.resolve()
    }

    const closingServer = server
    server = null

    return new Promise((resolve) => {
      closingServer.close(() => {
        cleanupPortFile(portFile)
        actualPort = 0
        resolve()
      })
      // Keep-alive clients (the daemon holds persistent connections) never
      // let close() finish on their own — reap them, but only after the
      // aborted long-poll responses had a turn to flush (live 0912: an
      // immediate reap raced the wait-abort writes into ECONNRESET).
      setImmediate(() => {
        if (typeof closingServer.closeAllConnections === 'function') {
          closingServer.closeAllConnections()
        }
      })
    })
  }

  return {
    start,
    stop,
    getPort() {
      return actualPort
    },
  }
}

function clampedQueryInteger(value, fallback, minimum, maximum) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
}

function claimInputOperation(inputLease, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw inputBridgeError('INPUT_LEASE_REQUIRED', 'Input lease fields are required.', 409)
  }
  const {
    leaseId,
    ownerSessionId,
    runId,
    action,
    sequence,
    ...input
  } = request
  if (
    typeof leaseId !== 'string' ||
    typeof ownerSessionId !== 'string' ||
    typeof runId !== 'string' ||
    typeof action !== 'string' ||
    !Number.isSafeInteger(sequence)
  ) {
    throw inputBridgeError('INPUT_LEASE_REQUIRED', 'Input lease fields are required.', 409)
  }
  return {
    input,
    claim: inputLease.consumeInput({
      leaseId,
      ownerSessionId,
      runId,
      action,
      sequence,
    }),
  }
}

function inputBridgeError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function createActionEventAbortError() {
  const error = new Error('Action event wait aborted.')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function readRequestBody(
  req,
  maxBytes = 1024 * 1024,
  tooLargeMessage = 'MCP request body is too large.',
) {
  return new Promise((resolve, reject) => {
    let body = ''
    let bodyBytes = 0
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (tooLarge) return
      bodyBytes += Buffer.byteLength(chunk)
      if (bodyBytes > maxBytes) {
        tooLarge = true
        body = ''
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error(tooLargeMessage)
        error.code = 'BODY_TOO_LARGE'
        reject(error)
      } else {
        resolve(body)
      }
    })
    req.on('error', reject)
  })
}

function requestContentLength(req) {
  const value = req.headers['content-length']
  if (value == null) return 0
  const length = Number(value)
  return Number.isSafeInteger(length) && length >= 0 ? length : Infinity
}

function drainRequest(req) {
  req.resume()
}

function hasValidBearerToken(authorization, expectedToken) {
  if (
    typeof authorization !== 'string' ||
    typeof expectedToken !== 'string' ||
    !authorization.startsWith('Bearer ')
  ) {
    return false
  }

  const supplied = Buffer.from(authorization.slice('Bearer '.length), 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)
}

function handleMcpMessage(message, readStore, plannerFile, toolDataSources = {}) {
  const { id, method, params } = message || {}

  switch (method) {
    case 'initialize':
      return jsonRpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          resources: { subscribe: false },
          tools: {},
        },
        serverInfo: { name: 'poi-plugin-mcp', version: packageJson.version },
      })

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'ping':
      return jsonRpcResult(id, {})

    case 'resources/list':
      return jsonRpcResult(id, {
        resources: MCP_RESOURCE_ENDPOINTS.map(({ uri }) => ({
          uri,
          name: uri.replace('poi://', ''),
          mimeType: 'application/json',
        })),
      })

    case 'resources/read': {
      const uri = params && params.uri
      const endpoint = MCP_RESOURCE_ENDPOINTS.find((item) => item.uri === uri)
      if (!endpoint) return jsonRpcError(id, -32602, `Unknown resource: ${uri}`)
      const data = readBridgeData(endpoint.path, readStore, plannerFile)
      return jsonRpcResult(id, {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        }],
      })
    }

    case 'tools/list':
      return jsonRpcResult(id, { tools: MCP_TOOL_DEFINITIONS })

    case 'tools/call': {
      const toolName = params && params.name
      const toolArgs = (params && params.arguments) || {}
      const result = callMcpTool(
        toolName,
        toolArgs,
        readStore,
        plannerFile,
        toolDataSources,
      )
      if (result.error) return jsonRpcError(id, -32602, result.error)
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      })
    }

    default:
      return jsonRpcError(id, -32601, `Unknown method: ${method}`)
  }
}

const MCP_RESOURCE_ENDPOINTS = [
  { uri: 'poi://basic', path: '/basic' },
  { uri: 'poi://fleets', path: '/fleets' },
  { uri: 'poi://ships', path: '/ships' },
  { uri: 'poi://equipment', path: '/equipment' },
  { uri: 'poi://resources', path: '/resources' },
  { uri: 'poi://quests', path: '/quests' },
  { uri: 'poi://airbase', path: '/airbase' },
  { uri: 'poi://names', path: '/names' },
  { uri: 'poi://master', path: '/master' },
  { uri: 'poi://event', path: '/event' },
  { uri: 'poi://planner', path: '/planner' },
  { uri: 'poi://all', path: '/all' },
]

function callMcpTool(toolName, args, readStore, plannerFile, toolDataSources = {}) {
  switch (toolName) {
    case 'get_fleet_status':
      validateFleetStatusArgs(args || {})
      return { value: buildFleetStatus(args || {}, readStore) }
    case 'search_ships':
      return { value: searchShips(args || {}, readStore) }
    case 'search_equipment':
      return { value: searchEquipment(args || {}, readStore) }
    case 'get_resources':
      validateNoArguments(args || {})
      return { value: decodePoiResources(readBridgeData('/resources', readStore, plannerFile)) }
    case 'get_resource_history': {
      const input = validateResourceHistoryArgs(args || {})
      const raw = requiredToolDataSource(toolDataSources, 'getResourceHistory')()
      return { value: formatResourceHistory(input, raw) }
    }
    case 'get_quests':
      validateNoArguments(args || {})
      return { value: formatQuests(readBridgeData('/quests', readStore, plannerFile)) }
    case 'get_available_quests': {
      validateAvailableQuestsArgs(args || {})
      const raw = requiredToolDataSource(
        toolDataSources,
        'getAvailableQuestSnapshot',
      )()
      return { value: formatAvailableQuests(args || {}, raw) }
    }
    case 'get_airbase_status':
      validateNoArguments(args || {})
      return { value: formatAirbaseStatus(readBridgeData('/airbase', readStore, plannerFile)) }
    case 'get_all':
      validateGetAllArgs(args || {})
      return { value: buildAllPayload(args || {}, readStore, plannerFile) }
    case 'get_battle':
      validateNoArguments(args || {})
      return { value: requiredToolDataSource(toolDataSources, 'getBattle')() }
    case 'get_action_events': {
      const input = validateActionEventsArgs(args || {})
      const raw = requiredToolDataSource(toolDataSources, 'getActionEvents')({
        after: input.after,
        limit: input.limit + 1,
      })
      return { value: formatActionEvents(args || {}, raw) }
    }
    case 'get_kcsapi_responses': {
      const input = validateKcsapiResponsesArgs(args || {})
      const raw = requiredToolDataSource(toolDataSources, 'getApiResponses')({
        after: input.after,
        limit: input.limit + 1,
        path: input.apiPath,
      })
      return { value: formatKcsapiResponses(args || {}, raw) }
    }
    default:
      return { error: `Unknown tool: ${toolName}` }
  }
}

function requiredToolDataSource(toolDataSources, name) {
  const source = toolDataSources && toolDataSources[name]
  if (typeof source !== 'function') {
    throw new Error(`MCP tool data source is unavailable: ${name}`)
  }
  return source
}

function readBridgeData(endpoint, readStore, plannerFile) {
  const store = readStore()
  const info = store.info

  switch (endpoint) {
    case '/basic':
      return info.basic || {}
    case '/fleets':
      return info.fleets || []
    case '/ships':
      return info.ships || {}
    case '/equipment':
      return info.equips || {}
    case '/resources':
      return info.resources || []
    case '/quests':
      return {
        activeQuests: (info.quests && info.quests.activeQuests) || {},
        records: (info.quests && info.quests.records) || {},
      }
    case '/airbase':
      return info.airbase || []
    case '/names':
      return extractNames(store)
    case '/master':
      return extractMasterData(store)
    case '/event':
      return extractEventData(store)
    case '/planner':
      return extractPlannerData(store, plannerFile)
    case '/all':
      return {
        basic: info.basic || {},
        fleets: info.fleets || [],
        ships: info.ships || {},
        equipment: info.equips || {},
        resources: info.resources || [],
        quests: {
          activeQuests: (info.quests && info.quests.activeQuests) || {},
          records: (info.quests && info.quests.records) || {},
        },
        airbase: info.airbase || [],
        repairs: info.repairs || [],
        constructions: info.constructions || [],
        maps: info.maps || {},
        useitems: info.useitems || {},
        sortie: store.sortie || {},
        names: extractNames(store),
      }
    default:
      throw new Error(`Unknown endpoint: ${endpoint}`)
  }
}

function buildFleetStatus(args, readStore) {
  const fleetId = Number(args.fleetId)
  const store = readStore()
  const info = store.info || {}
  const fleets = Array.isArray(info.fleets) ? info.fleets : []
  const fleet = fleets[fleetId - 1]
  if (!fleet) return { error: `Fleet #${args.fleetId} not found` }

  const ships = info.ships || {}
  const equips = info.equips || {}
  const names = extractNames(store)
  const master = extractMasterData(store)
  const hqLevel = Number(info.basic && info.basic.api_level)
  const metricShips = collectFleetMetricShips(fleet, ships, equips, master)
  const metrics = Number.isInteger(hqLevel) && hqLevel >= 1
    ? inspectFleetMetrics(metricShips, hqLevel)
    : null

  return {
    id: fleet.api_id,
    name: fleet.api_name,
    mission: fleet.api_mission,
    metrics,
    ships: (fleet.api_ship || []).filter((id) => id > 0).map((shipId, index) =>
      projectFleetShip(ships[shipId], shipId, index + 1, equips, names, master),
    ),
  }
}

function projectFleetShip(ship, shipId, position, equips, names, master) {
  if (!ship) return { id: shipId, position }

  const masterShip = master.ships && master.ships[ship.api_ship_id]
  const shipType = masterShip && master.shipTypes && master.shipTypes[masterShip.api_stype]
  const maxHp = Number(ship.api_maxhp) || 0
  const speedRaw = Number(ship.api_soku ?? (masterShip && masterShip.api_soku) ?? 0)
  const speedKind = speedFromRaw(speedRaw)

  return {
    position,
    id: ship.api_id,
    shipId: ship.api_ship_id,
    masterId: ship.api_ship_id,
    name:
      (names.ships && names.ships[ship.api_ship_id]) ||
      (masterShip && masterShip.api_name) ||
      '',
    typeName: (shipType && shipType.api_name) || '',
    stype: (masterShip && masterShip.api_stype) || null,
    level: ship.api_lv,
    hp: `${ship.api_nowhp}/${ship.api_maxhp}`,
    hpMod4: maxHp % 4,
    morale: ship.api_cond,
    moraleMeaning: moraleMeaning(ship.api_cond || 0),
    speed: speedRaw,
    speedMeaning: speedMeaning(speedKind),
    fuel: ship.api_fuel,
    ammo: ship.api_bull,
    locked: ship.api_locked,
    slotnum: ship.api_slotnum || (ship.api_slot || []).filter((id) => id !== -1).length,
    onslot: Array.isArray(ship.api_onslot) ? ship.api_onslot : [],
    sallyArea: ship.api_sally_area || 0,
    fire: ship.api_karyoku || null,
    torp: ship.api_raisou || null,
    aa: ship.api_taiku || null,
    armor: ship.api_soukou || null,
    luck: ship.api_lucky || null,
    los: ship.api_sakuteki || null,
    asw: ship.api_taisen || null,
    slotItems: (ship.api_slot || [])
      .filter((equipId) => equipId > 0)
      .map((equipId) => describeEquip(equipId, equips, names, master))
      .filter(Boolean),
    expansion: describeExpansion(ship.api_slot_ex, equips, names, master),
  }
}

function describeEquip(equipId, equips, names, master) {
  if (!equipId || equipId <= 0) return null
  const equip = equips[equipId]
  if (!equip) return { id: equipId, missing: true }
  const masterId = equip.api_slotitem_id
  const masterEquip = master.equipment && master.equipment[masterId]
  const typeIds = masterEquip && Array.isArray(masterEquip.api_type) ? masterEquip.api_type : []
  const typeId = typeIds[2] || typeIds[1] || typeIds[0]
  const equipType = typeId && master.equipmentTypes && master.equipmentTypes[typeId]
  return {
    id: equip.api_id,
    equipId: masterId,
    name:
      (names.equipment && names.equipment[masterId]) ||
      (masterEquip && masterEquip.api_name) ||
      '',
    typeName: (equipType && equipType.api_name) || '',
    level: equip.api_level || 0,
    prof: equip.api_alv || 0,
  }
}

function describeExpansion(rawEx, equips, names, master) {
  const raw = Number(rawEx)
  if (!Number.isFinite(raw) || raw === 0) {
    return { raw: Number.isFinite(raw) ? raw : 0, state: 'closed', meaning: '未开孔', item: null }
  }
  if (raw < 0) {
    return { raw, state: 'open_empty', meaning: '已开孔但为空', item: null }
  }
  return {
    raw,
    state: 'equipped',
    meaning: '已装备',
    item: describeEquip(raw, equips, names, master),
  }
}

function searchShips(args, readStore) {
  const store = readStore()
  return searchShipsSnapshot(args, {
    ships: (store.info && store.info.ships) || {},
    fleets: (store.info && store.info.fleets) || [],
    master: extractMasterData(store),
  })
}

function searchEquipment(args, readStore) {
  const store = readStore()
  return searchEquipmentSnapshot(args, {
    equipment: (store.info && store.info.equips) || {},
    ships: (store.info && store.info.ships) || {},
    master: extractMasterData(store),
  })
}

function buildAllPayload(args, readStore, plannerFile) {
  const payload = readBridgeData('/all', readStore, plannerFile)
  const include = Array.isArray(args.include) ? new Set(args.include) : new Set()

  if (include.has('master')) payload.master = readBridgeData('/master', readStore, plannerFile)
  if (include.has('event')) payload.event = readBridgeData('/event', readStore, plannerFile)
  if (include.has('planner')) payload.planner = readBridgeData('/planner', readStore, plannerFile)

  return payload
}

function jsonRpcResult(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result }
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } }
}

function defaultGetStore(storePath) {
  if (typeof window !== 'undefined' && typeof window.getStore === 'function') {
    return window.getStore(storePath)
  }
  return null
}

function extractProphetBattle(store) {
  const battle = store &&
    store.ext &&
    store.ext['poi-plugin-prophet'] &&
    store.ext['poi-plugin-prophet']._ &&
    store.ext['poi-plugin-prophet']._.battle
  if (!battle || typeof battle !== 'object') {
    return {
      available: false,
      source: 'poi-plugin-prophet',
      engine: 'poi-lib-battle',
      engineVersion: '3.0.5',
    }
  }

  const fleets = {
    main: compactBattleFleet(battle.mainFleet),
    escort: compactBattleFleet(battle.escortFleet),
    enemy: compactBattleFleet(battle.enemyFleet),
    enemyEscort: compactBattleFleet(battle.enemyEscort),
  }
  const result = compactBattleResult(battle.result)
  return {
    available: true,
    source: 'poi-plugin-prophet',
    engine: 'poi-lib-battle',
    engineVersion: '3.0.5',
    sortieState: finiteNumber(battle.sortieState, 0),
    sortieStateName: sortieStateName(battle.sortieState),
    mapAreaId: finiteNumber(battle.mapAreaId, 0),
    eventId: finiteNumber(battle.eventId, 0),
    eventKind: finiteNumber(battle.eventKind, 0),
    isBaseDefense: battle.isBaseDefense === true,
    isHeavyBomberDefense: battle.isHeavyBomberDefense === true,
    smokeType: finiteNumber(battle.smokeType, 0),
    airControl: stringValue(battle.airControl),
    battleForm: stringValue(battle.battleForm),
    enemyFormation: stringValue(battle.eFormation),
    rank: typeof result.rank === 'string' ? result.rank : null,
    mvpIndex0Based: compactMvp(result.mvp),
    heavilyDamaged: findHeavilyDamaged(fleets),
    fleets,
  }
}

function combineBattleTelemetry(telemetry, predicted) {
  const current = telemetry && typeof telemetry === 'object'
    ? telemetry
    : { available: false, generation: 0 }
  return {
    available: current.available === true || predicted.available === true,
    generation: finiteNumber(current.generation, 0),
    status: typeof current.status === 'string' ? current.status : 'unavailable',
    observed: current.observed || null,
    predicted,
    official: current.official || null,
  }
}

function compactBattleResult(result) {
  if (!result || typeof result !== 'object') return {}
  return Object.fromEntries(
    ['rank', 'mvp', 'getShip', 'getItem']
      .filter((key) => result[key] !== undefined)
      .map((key) => [key, result[key]]),
  )
}

function compactMvp(value) {
  const values = Array.isArray(value) ? value : [value, null]
  return {
    main: Number.isInteger(values[0]) && values[0] >= 0 ? values[0] : null,
    escort: Number.isInteger(values[1]) && values[1] >= 0 ? values[1] : null,
  }
}

function findHeavilyDamaged(fleets) {
  return ['main', 'escort'].flatMap((fleetName) =>
    fleets[fleetName].flatMap((ship) => {
      if (
        !Number.isFinite(ship.currentHp) ||
        !Number.isFinite(ship.maxHp) ||
        ship.maxHp <= 0 ||
        ship.currentHp > ship.maxHp * 0.25
      ) {
        return []
      }
      return [{
        fleet: fleetName,
        position: ship.position,
        instanceId: ship.instanceId,
        currentHp: ship.currentHp,
        maxHp: ship.maxHp,
      }]
    }),
  )
}

function compactBattleFleet(fleet) {
  if (!Array.isArray(fleet)) return []
  return fleet.flatMap((ship) => {
    if (!ship || typeof ship !== 'object') return []
    const raw = ship.raw && typeof ship.raw === 'object' ? ship.raw : {}
    return [{
      id: nullableNumber(ship.id),
      owner: nullableNumber(ship.owner),
      position: nullableNumber(ship.pos),
      maxHp: nullableNumber(ship.maxHP),
      initialHp: nullableNumber(ship.initHP),
      currentHp: nullableNumber(ship.nowHP),
      lostHp: nullableNumber(ship.lostHP),
      damage: nullableNumber(ship.damage),
      items: Array.isArray(ship.items) ? [...ship.items] : [],
      useItem: ship.useItem == null ? null : ship.useItem,
      instanceId: Number.isInteger(raw.api_id) ? raw.api_id : null,
      masterId: Number.isInteger(raw.api_ship_id) ? raw.api_ship_id : null,
    }]
  })
}

function sortieStateName(value) {
  return ['in_port', 'navigation', 'battle', 'practice'][value] || 'unknown'
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function nullableNumber(value) {
  return Number.isFinite(value) ? value : null
}

function stringValue(value) {
  return typeof value === 'string' ? value : ''
}

function cleanupPortFile(portFile) {
  try {
    fs.unlinkSync(portFile)
  } catch (_) {}
}

function extractNames(store) {
  const result = { ships: {}, equipment: {}, missions: {} }
  const constants = store.const || {}

  collectApiNames(constants.$ships, result.ships)
  collectApiNames(constants.$equips, result.equipment)
  collectApiNames(constants.$missions, result.missions)

  const wctf = store.wctf || {}
  if (Object.keys(result.ships).length === 0) collectSimpleNames(wctf.ships, result.ships)
  if (Object.keys(result.equipment).length === 0) collectSimpleNames(wctf.items, result.equipment)

  return result
}

function collectApiNames(source, target) {
  if (!source || typeof source !== 'object') return

  for (const [id, value] of Object.entries(source)) {
    if (value && value.api_name) target[id] = value.api_name
  }
}

function collectItemBonuses(wctf) {
  if (!wctf || typeof wctf !== 'object') return undefined
  const items = wctf.items
  if (!items || typeof items !== 'object') return undefined
  const byMasterId = {}
  for (const [id, item] of Object.entries(items)) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.bonus)) continue
    byMasterId[id] = item.bonus
  }
  return Object.keys(byMasterId).length > 0
    ? {
        available: true,
        source: 'wctf',
        version: wctf.version || null,
        lastModified: wctf.lastModified || null,
        byMasterId,
      }
    : undefined
}

function collectSimpleNames(source, target) {
  if (!source || typeof source !== 'object') return

  for (const [id, value] of Object.entries(source)) {
    if (value && value.name) target[id] = value.name
  }
}

function extractMasterData(store, masterFile = DEFAULT_MASTER_FILE) {
  const constants = store.const || {}

  return {
    ships: constants.$ships || {},
    equipment: constants.$equips || {},
    shipTypes: constants.$shipTypes || {},
    equipmentTypes:
      constants.$equipTypes ||
      constants.$equipmentTypes ||
      constants.$slotitemTypes ||
      constants.$slotItemTypes ||
      {},
    missions: constants.$missions || {},
    equipmentRules: readEquipmentRules(masterFile),
    itemBonuses: collectItemBonuses(store.wctf),
  }
}

function readEquipmentRules(masterFile) {
  try {
    const stat = fs.statSync(masterFile)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MASTER_FILE_LIMIT) {
      return { available: false, source: 'navy-album-master-cache' }
    }
    const master = JSON.parse(fs.readFileSync(masterFile, 'utf8'))
    const equipmentShip = objectOrEmpty(master.api_mst_equip_ship)
    const equipmentExslotTypes = Array.isArray(master.api_mst_equip_exslot)
      ? master.api_mst_equip_exslot.filter(Number.isInteger)
      : []
    const equipmentExslotShip = objectOrEmpty(
      master.api_mst_equip_exslot_ship,
    )
    const equipmentLimitExslot = objectOrEmpty(
      master.api_mst_equip_limit_exslot,
    )
    if (
      Object.keys(equipmentShip).length === 0 ||
      equipmentExslotTypes.length === 0
    ) {
      return { available: false, source: 'navy-album-master-cache' }
    }
    return {
      available: true,
      source: 'navy-album-master-cache',
      equipmentShip,
      equipmentExslotTypes,
      equipmentExslotShip,
      equipmentLimitExslot,
    }
  } catch (_) {
    return { available: false, source: 'navy-album-master-cache' }
  }
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
}

function extractEventData(store) {
  const tags = extractShipTags(store)
  const ships = {}

  for (const ship of Object.values((store.info && store.info.ships) || {})) {
    if (!ship || typeof ship !== 'object') continue
    const area = ship.api_sally_area || 0
    const tag = tags[area - 1] || emptyTag(area)

    ships[ship.api_id] = {
      instanceId: ship.api_id,
      masterId: ship.api_ship_id,
      shipId: ship.api_id,
      modelId: ship.api_ship_id,
      area,
      mapName: tag.mapName,
      fleetName: tag.fleetName,
      color: tag.color,
    }
  }

  return {
    tags,
    ships,
  }
}

function extractPlannerData(store, plannerFile = DEFAULT_PLANNER_FILE) {
  const tags = extractShipTags(store)
  const current = readPlannerCurrent(plannerFile)
  const length = Math.max(tags.length, current.length)
  const areas = []
  const shipMap = {}

  for (let index = 0; index < length; index += 1) {
    const area = index + 1
    const tag = tags[index] || emptyTag(area)
    const shipIds = Array.isArray(current[index]) ? current[index] : []

    areas.push({
      area,
      mapName: tag.mapName,
      fleetName: tag.fleetName,
      color: tag.color,
      shipIds,
    })

    for (const shipId of shipIds) {
      shipMap[shipId] = {
        area,
        mapName: tag.mapName,
        fleetName: tag.fleetName,
        color: tag.color,
      }
    }
  }

  return {
    areas,
    shipMap,
  }
}

function readPlannerCurrent(plannerFile) {
  try {
    const data = JSON.parse(fs.readFileSync(plannerFile, 'utf8'))
    if (Array.isArray(data.planner)) return data.planner
    if (data.planner && Array.isArray(data.planner.current)) {
      return data.planner.current
    }
  } catch (_) {}

  return []
}

function extractShipTags(store) {
  const shiptag = (store.fcd && store.fcd.shiptag) || {}
  const mapNames = Array.isArray(shiptag.mapname) ? shiptag.mapname : []
  const fleetNames = selectFleetNames(shiptag.fleetname)
  const colors = Array.isArray(shiptag.color) ? shiptag.color : []

  return mapNames.map((mapName, index) => ({
    area: index + 1,
    mapName,
    fleetName: fleetNames[index] || mapName,
    color: colors[index] || '',
  }))
}

function selectFleetNames(fleetname) {
  if (Array.isArray(fleetname)) return fleetname
  if (!fleetname || typeof fleetname !== 'object') return []

  const language = getWindowLanguage()
  return (
    fleetname[language] ||
    fleetname['zh-CN'] ||
    fleetname['zh-TW'] ||
    fleetname.ja ||
    fleetname['ja-JP'] ||
    fleetname['en-US'] ||
    Object.values(fleetname).find(Array.isArray) ||
    []
  )
}

function getWindowLanguage() {
  if (typeof window !== 'undefined' && window.language) {
    return window.language
  }
  return 'zh-CN'
}

function emptyTag(area) {
  return {
    area,
    mapName: '',
    fleetName: '',
    color: '',
  }
}

module.exports = {
  createPoiDataBridge,
  DEFAULT_PORT,
  DEFAULT_PORT_FILE,
  DEFAULT_PLANNER_FILE,
  INPUT_BODY_LIMIT,
  extractEventData,
  extractMasterData,
  extractPlannerData,
  extractNames,
}
