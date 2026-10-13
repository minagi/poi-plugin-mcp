// Observe committed Redux cache values. Never replay API rules or dispatch actions.
const crypto = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')

const RESOURCE_NAMES = ['燃料', '弹药', '钢材', '铝土', '高速建造材', '高速修复材', '开发资材', '改修资材']
const SOURCES = {
  ships: ['ships', 'map'], equipment: ['equips', 'map'],
  active_quests: ['quests.activeQuests', 'map'], quest_records: ['quests.records', 'map'],
  fleets: ['fleets', 'list'], resources: ['resources', 'resources'],
  repairs: ['repairs', 'list'], constructions: ['constructions', 'list'],
  airbase: ['airbase', 'airbase'], useitems: ['useitems', 'map'],
  basic: ['basic', 'basic'], maps: ['maps', 'map'],
}
const clone = value => JSON.parse(JSON.stringify(value))
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function normalize(value, kind) {
  if (kind === 'map' || kind === 'basic') {
    if (!object(value) || (kind === 'map' && Object.values(value).some(v => !object(v)))) throw new Error('invalid_source_shape')
    return clone(kind === 'basic' ? { basic: value } : value)
  }
  if (!Array.isArray(value)) throw new Error('invalid_source_shape')
  if (kind === 'resources') {
    if (value.length !== 8 || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('invalid_source_shape')
    return Object.fromEntries(value.map((v, i) => [String(i + 1), { name: RESOURCE_NAMES[i], value: v }]))
  }
  const entries = value.map(row => {
    if (!object(row) || (kind === 'airbase' ? row.api_area_id == null || row.api_rid == null : row.api_id == null)) throw new Error('invalid_record_id')
    return [kind === 'airbase' ? `${row.api_area_id}:${row.api_rid}` : String(row.api_id), clone(row)]
  })
  if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error('duplicate_record_id')
  return Object.fromEntries(entries)
}

function createPoiInventoryEvents(options = {}) {
  const clock = options.now || (() => new Date().toISOString())
  const capacity = options.capacity || 256
  const maxBytes = options.maxTotalBytes || 32 * 1024 * 1024
  const maxEventBytes = options.maxEventBytes || 8 * 1024 * 1024
  const getReduxStore = options.getReduxStore || (() => null)
  let sessionId = crypto.randomUUID(), revision = 0, totalBytes = 0
  let redux = null, unsubscribe = null, closed = false, observerError = null
  const inputs = new Map(), sources = {}, events = [], waiters = new Set()

  function observe(initial = false) {
    try {
      const info = redux.getState().info
      if (!object(info)) throw new Error('store_info_unavailable')
      const at = clock(), changes = []
      for (const [source, [path, kind]] of Object.entries(SOURCES)) {
        const raw = path.split('.').reduce((v, key) => v && v[key], info)
        // Redux values are immutable; unchanged references need no serialization.
        if (inputs.has(source) && inputs.get(source) === raw) continue
        const previous = sources[source]
        let records, error = null
        try { records = normalize(raw, kind) } catch (e) { error = e.message }
        const available = error === null
        if (previous && previous.available === available && previous.error === error &&
            (!available || isDeepStrictEqual(previous.records, records))) {
          inputs.set(source, raw)
          continue
        }
        const before = previous?.records || {}
        const baseline = !previous || previous.records === null
        const upserts = available ? Object.fromEntries(Object.entries(records).filter(([id, row]) => !isDeepStrictEqual(before[id], row))) : {}
        const removedIds = available ? Object.keys(before).filter(id => !Object.hasOwn(records, id)) : []
        const sourceRevision = initial ? 0 : (previous?.revision || 0) + 1
        sources[source] = { available, revision: sourceRevision, error,
          lastChangedAt: initial ? null : at, records: available ? records : previous?.records || null }
        inputs.set(source, raw)
        changes.push({ source, sourceRevision, available, error, baseline, upserts, removedIds })
      }
      observerError = null
      if (!initial && changes.length) {
        revision += 1
        let event = { revision, capturedAt: at, changes }
        if (Buffer.byteLength(JSON.stringify(event)) > maxEventBytes) {
          event = { revision, capturedAt: at, resyncRequired: true, reason: 'delta_too_large', changes: [] }
        }
        const bytes = Buffer.byteLength(JSON.stringify(event))
        events.push({ event, bytes }); totalBytes += bytes
        while (events.length > capacity || totalBytes > maxBytes) totalBytes -= events.shift().bytes
        notify()
      }
    } catch (_) {
      // Observer errors must never escape into a game dispatch.
      observerError = 'store_observation_failed'
      notify()
    }
  }

  function attach() {
    if (closed) return false
    if (redux) return true
    try {
      const candidate = getReduxStore()
      if (!candidate || typeof candidate.getState !== 'function' || typeof candidate.subscribe !== 'function') return false
      redux = candidate
      // Same JS turn: initial observation and subscription cannot be interleaved.
      observe(true)
      unsubscribe = redux.subscribe(() => observe())
      return true
    } catch (_) { redux = null; return false }
  }

  function snapshot() {
    const available = attach() && observerError === null
    return clone({ schemaVersion: 1, available, sessionId, revision,
      capturedAt: clock(), error: available ? null : observerError || 'store_subscription_unavailable', sources })
  }

  function read({ after = 0, limit = 256, sessionId: expected } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('invalid_inventory_cursor')
    if (expected !== undefined && (typeof expected !== 'string' || !expected || expected.length > 128)) throw new Error('invalid_inventory_session')
    const available = attach() && observerError === null
    const earliestRevision = events.length ? events[0].event.revision : revision + 1
    const reason = expected && expected !== sessionId ? 'session_changed'
      : after > revision ? 'cursor_ahead' : after < earliestRevision - 1 ? 'history_gap' : null
    return clone({ schemaVersion: 1, available, sessionId, earliestRevision, latestRevision: revision,
      error: available ? null : observerError || 'store_subscription_unavailable',
      resyncRequired: reason !== null, reason,
      events: reason ? [] : events.filter(({ event }) => event.revision > after).slice(0, limit).map(({ event }) => event) })
  }

  function wait(options = {}) {
    const immediate = read(options), timeoutMs = options.timeoutMs == null ? 30000 : options.timeoutMs
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('invalid_inventory_timeout')
    if (immediate.events.length || immediate.resyncRequired || !immediate.available) return Promise.resolve({ ...immediate, timedOut: false })
    if (waiters.size >= 128) throw new Error('inventory_waiters_limit')
    if (options.signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const waiter = { options, timer: null, settle: null }
      const onAbort = () => waiter.settle(null, abortError())
      waiter.settle = (value, error) => {
        if (!waiters.delete(waiter)) return
        clearTimeout(waiter.timer)
        options.signal?.removeEventListener('abort', onAbort)
        error ? reject(error) : resolve(value)
      }
      waiter.timer = setTimeout(() => waiter.settle({ ...read(options), timedOut: true }), timeoutMs)
      waiters.add(waiter)
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  function notify() {
    for (const waiter of Array.from(waiters)) {
      const result = read(waiter.options)
      if (result.events.length || result.resyncRequired || !result.available) waiter.settle({ ...result, timedOut: false })
    }
  }

  function close() {
    closed = true
    if (unsubscribe) unsubscribe()
    unsubscribe = null
    for (const waiter of Array.from(waiters)) waiter.settle(null, abortError())
  }
  return { attach, snapshot, read, wait, close }
}

function abortError() { const e = new Error('Inventory event wait aborted'); e.name = 'AbortError'; return e }

function defaultGetReduxStore() {
  if (typeof window === 'undefined') return null
  try {
    const candidate = require('views/create-store').store
    if (candidate && typeof candidate.subscribe === 'function') return candidate
  } catch (_) { /* Older poi loaders expose only an already-loaded module. */ }
  for (const [filename, module] of Object.entries(require.cache)) {
    if (!/[/\\]views[/\\](?:redux[/\\])?create-store\.(?:[cm]?js|jsx|tsx?)$/i.test(filename)) continue
    const candidate = module.exports?.store
    if (candidate && typeof candidate.subscribe === 'function' && typeof window.getStore === 'function' &&
        candidate.getState()?.info === window.getStore()?.info) return candidate
  }
  return null
}

module.exports = { createPoiInventoryEvents, defaultGetReduxStore }
