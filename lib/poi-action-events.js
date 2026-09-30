const crypto = require('node:crypto')

const DEFAULT_CAPACITY = 256
const DEFAULT_LIMIT = 64
const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const MAX_CAPACITY = 256
const MAX_WAIT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_WAITERS = 128
const MAX_WAITERS = 256
const MAX_OBJECT_KEYS = 32
const MAX_ARRAY_ITEMS = 16
const MAX_STRING_LENGTH = 256
const MAX_RESPONSE_DEPTH = 4

const EXACT_PATHS = new Set([
  '/kcsapi/api_start2/getData',
  '/kcsapi/api_port/port',
  '/kcsapi/api_get_member/base_air_corps',
  '/kcsapi/api_get_member/chart_additional_info',
  '/kcsapi/api_get_member/deck',
  '/kcsapi/api_get_member/furniture',
  '/kcsapi/api_get_member/kdock',
  '/kcsapi/api_get_member/mapinfo',
  '/kcsapi/api_get_member/material',
  '/kcsapi/api_get_member/mission',
  '/kcsapi/api_get_member/ndock',
  '/kcsapi/api_get_member/practice',
  '/kcsapi/api_get_member/preset_deck',
  '/kcsapi/api_get_member/questlist',
  '/kcsapi/api_get_member/require_info',
  '/kcsapi/api_get_member/ship2',
  '/kcsapi/api_get_member/ship3',
  '/kcsapi/api_get_member/ship_deck',
  '/kcsapi/api_get_member/slot_item',
  '/kcsapi/api_get_member/unsetslot',
  '/kcsapi/api_get_member/useitem',
  '/kcsapi/api_req_air_corps/set_action',
  '/kcsapi/api_req_air_corps/change_deployment_base',
  '/kcsapi/api_req_air_corps/set_plane',
  '/kcsapi/api_req_air_corps/supply',
  '/kcsapi/api_req_battle_midnight/battle',
  '/kcsapi/api_req_battle_midnight/sp_midnight',
  '/kcsapi/api_req_hensei/change',
  '/kcsapi/api_req_hensei/combined',
  '/kcsapi/api_req_hensei/preset_select',
  '/kcsapi/api_req_hokyu/charge',
  '/kcsapi/api_req_kaisou/can_preset_slot_select',
  '/kcsapi/api_req_kaisou/powerup',
  '/kcsapi/api_req_kaisou/slot_select',
  '/kcsapi/api_req_kaisou/slot_deprive',
  '/kcsapi/api_req_kaisou/slotset',
  '/kcsapi/api_req_kaisou/slotset_ex',
  '/kcsapi/api_req_kaisou/unsetslot',
  '/kcsapi/api_req_kaisou/unsetslot_all',
  '/kcsapi/api_req_kousyou/createitem',
  '/kcsapi/api_req_kousyou/createship',
  '/kcsapi/api_req_kousyou/createship_speedchange',
  '/kcsapi/api_req_kousyou/destroyitem2',
  '/kcsapi/api_req_kousyou/destroyship',
  '/kcsapi/api_req_kousyou/getship',
  '/kcsapi/api_req_kousyou/remodel_slot',
  '/kcsapi/api_req_map/next',
  '/kcsapi/api_req_map/select_eventmap_rank',
  '/kcsapi/api_req_map/start',
  '/kcsapi/api_req_map/start_air_base',
  '/kcsapi/api_req_member/get_practice_enemyinfo',
  '/kcsapi/api_req_member/set_oss_condition',
  '/kcsapi/api_req_mission/result',
  '/kcsapi/api_req_mission/start',
  '/kcsapi/api_req_nyukyo/speedchange',
  '/kcsapi/api_req_nyukyo/start',
  '/kcsapi/api_req_practice/battle',
  '/kcsapi/api_req_practice/battle_result',
  '/kcsapi/api_req_practice/midnight_battle',
  '/kcsapi/api_req_quest/clearitemget',
  '/kcsapi/api_req_quest/start',
  '/kcsapi/api_req_quest/stop',
  '/kcsapi/api_req_quest/clearitemget',
])

const ALLOWED_PREFIXES = [
  '/kcsapi/api_req_sortie/',
  '/kcsapi/api_req_combined_battle/',
]

const SHARED_TELEMETRY_TIMESTAMP_PATHS = new Set([
  '/kcsapi/api_get_member/mission',
  '/kcsapi/api_get_member/questlist',
  '/kcsapi/api_get_member/unsetslot',
  '/kcsapi/api_req_quest/start',
  '/kcsapi/api_req_quest/stop',
  '/kcsapi/api_req_quest/clearitemget',
  '/kcsapi/api_req_kaisou/slotset',
  '/kcsapi/api_req_kaisou/slotset_ex',
  '/kcsapi/api_req_kaisou/slot_deprive',
  '/kcsapi/api_req_kaisou/unsetslot_all',
  '/kcsapi/api_req_hensei/change',
])

function createPoiActionEvents(options = {}) {
  const now = options.now || (() => new Date())
  const inferredNow = options.inferredNow || (() => new Date())
  const sessionId = boundedId(options.sessionId || crypto.randomUUID(), 'sessionId')
  const capacity = boundedInteger(
    options.capacity == null ? DEFAULT_CAPACITY : options.capacity,
    1,
    MAX_CAPACITY,
    'capacity',
  )
  const maxWaiters = boundedInteger(
    options.maxWaiters == null ? DEFAULT_MAX_WAITERS : options.maxWaiters,
    1,
    MAX_WAITERS,
    'maxWaiters',
  )
  const events = []
  const waiters = new Set()
  let latestGeneration = 0

  function capture(detail) {
    if (!isCapturableDetail(detail)) return null
    const explicitApiResult = readApiResult(detail)
    const apiResult = explicitApiResult == null && hasUnwrappedResponseBody(detail)
      ? 1
      : explicitApiResult
    if (apiResult !== 1) return null

    latestGeneration += 1
    const eventNow = explicitApiResult != null ||
      SHARED_TELEMETRY_TIMESTAMP_PATHS.has(detail.path)
      ? now
      : inferredNow
    const event = Object.freeze({
      generation: latestGeneration,
      capturedAt: timestamp(eventNow()),
      path: detail.path,
      apiResult,
      postBody: sanitizePostBody(detail.postBody),
      responseSummary: sanitizeResponse(detail.body),
    })
    events.push(event)
    if (events.length > capacity) events.splice(0, events.length - capacity)
    notifyWaiters()
    return event
  }

  function read(options = {}) {
    const after = boundedInteger(
      options.after == null ? 0 : options.after,
      0,
      Number.MAX_SAFE_INTEGER,
      'after',
    )
    const limit = boundedInteger(
      options.limit == null ? DEFAULT_LIMIT : options.limit,
      1,
      MAX_CAPACITY,
      'limit',
    )
    return {
      available: true,
      sessionId,
      earliestGeneration: events.length === 0 ? 0 : events[0].generation,
      latestGeneration,
      events: events
        .filter((event) => event.generation > after)
        .slice(0, limit),
    }
  }

  function wait(options = {}) {
    const after = boundedInteger(
      options.after == null ? 0 : options.after,
      0,
      Number.MAX_SAFE_INTEGER,
      'after',
    )
    const limit = boundedInteger(
      options.limit == null ? DEFAULT_LIMIT : options.limit,
      1,
      MAX_CAPACITY,
      'limit',
    )
    const timeoutMs = boundedInteger(
      options.timeoutMs == null ? DEFAULT_WAIT_TIMEOUT_MS : options.timeoutMs,
      1,
      MAX_WAIT_TIMEOUT_MS,
      'timeoutMs',
    )
    const signal = options.signal
    if (
      signal != null &&
      (
        typeof signal !== 'object' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function'
      )
    ) {
      throw new Error('signal must be an AbortSignal')
    }

    const immediate = read({ after, limit })
    if (immediate.events.length > 0) {
      return Promise.resolve({ ...immediate, timedOut: false })
    }
    if (signal && signal.aborted) return Promise.reject(createAbortError())
    if (waiters.size >= maxWaiters) {
      const error = new Error('Too many action event waiters.')
      error.code = 'ACTION_EVENT_WAITERS_LIMIT'
      return Promise.reject(error)
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        after,
        limit,
        resolve,
        reject,
        signal,
        onAbort: null,
        timer: null,
      }

      const settle = (settlement) => {
        if (!waiters.delete(waiter)) return
        if (waiter.timer != null) clearTimeout(waiter.timer)
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener('abort', waiter.onAbort)
        }
        settlement()
      }

      waiter.resolveWait = (result) => settle(() => resolve(result))
      waiter.rejectWait = (error) => settle(() => reject(error))
      waiter.timer = setTimeout(() => {
        waiter.resolveWait({ ...read({ after, limit }), timedOut: true })
      }, timeoutMs)
      if (signal) {
        waiter.onAbort = () => waiter.rejectWait(createAbortError())
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      waiters.add(waiter)
    })
  }

  function notifyWaiters() {
    if (waiters.size === 0) return
    for (const waiter of Array.from(waiters)) {
      if (latestGeneration <= waiter.after) continue
      waiter.resolveWait({
        ...read({ after: waiter.after, limit: waiter.limit }),
        timedOut: false,
      })
    }
  }

  function close(reason = createAbortError('Action event provider closed.')) {
    for (const waiter of Array.from(waiters)) waiter.rejectWait(reason)
  }

  return Object.freeze({ capture, read, wait, close })
}

function isCapturableDetail(detail) {
  return Boolean(
    detail &&
    typeof detail === 'object' &&
    !Array.isArray(detail) &&
    typeof detail.path === 'string' &&
    (
      EXACT_PATHS.has(detail.path) ||
      ALLOWED_PREFIXES.some((prefix) => detail.path.startsWith(prefix))
    ),
  )
}

function readApiResult(detail) {
  const candidates = [
    detail.apiResult,
    detail.api_result,
    detail.result,
    detail.body && detail.body.api_result,
  ]
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue
    const parsed = Number(candidate)
    return Number.isInteger(parsed) ? parsed : null
  }
  return null
}

function hasUnwrappedResponseBody(detail) {
  if (!Object.prototype.hasOwnProperty.call(detail, 'body')) return false
  const body = detail.body
  if (!isPlainObject(body) && !Array.isArray(body)) return false
  return !(
    isPlainObject(body) &&
    (
      Object.prototype.hasOwnProperty.call(body, 'api_result') ||
      Object.prototype.hasOwnProperty.call(body, 'api_data')
    )
  )
}

function sanitizePostBody(value) {
  if (!isPlainObject(value)) return {}
  const output = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (!safeKey(key)) continue
    const scalar = sanitizeScalar(item)
    if (scalar !== undefined) {
      output[key] = scalar
      continue
    }
    if (
      Array.isArray(item) &&
      item.length <= MAX_ARRAY_ITEMS
    ) {
      const array = item.map(sanitizeScalar)
      if (array.every((entry) => entry !== undefined)) output[key] = array
    }
  }
  return output
}

function sanitizeResponse(value) {
  const sanitized = sanitizeNested(value, 0)
  return isPlainObject(sanitized) ? sanitized : {}
}

function sanitizeNested(value, depth) {
  const scalar = sanitizeScalar(value)
  if (scalar !== undefined) return scalar
  if (depth >= MAX_RESPONSE_DEPTH) return undefined
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeNested(item, depth + 1))
      .filter((item) => item !== undefined)
  }
  if (!isPlainObject(value)) return undefined
  const output = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (!safeKey(key)) continue
    const sanitized = sanitizeNested(item, depth + 1)
    if (sanitized !== undefined) output[key] = sanitized
  }
  return output
}

function sanitizeScalar(value) {
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value
  }
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH)
  return undefined
}

function safeKey(key) {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= 64 &&
    !/(authorization|cookie|header|password|secret|token)/i.test(key)
  )
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('now must return a valid date')
  return date.toISOString()
}

function boundedId(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error(`${name} must be a non-empty bounded string`)
  }
  return value
}

function boundedInteger(value, minimum, maximum, name) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    )
  }
  return value
}

function createAbortError(message = 'Action event wait aborted.') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value),
  )
}

module.exports = {
  createPoiActionEvents,
}
