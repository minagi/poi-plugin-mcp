const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createPoiInventoryEvents, defaultGetReduxStore } = require('../lib/poi-inventory-events')
const { createPoiDataBridge } = require('../lib/poi-http-bridge')
const { validateInventoryEventsArgs } = require('../lib/mcp-tools')
const { createStoreFixture } = require('./fixtures')

function fakeStore() {
  let state = createStoreFixture()
  const listeners = new Set()
  return {
    getState: () => state,
    subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback) },
    update: callback => {
      state = structuredClone(state)
      callback(state)
      for (const listener of listeners) listener()
    },
    size: () => listeners.size,
  }
}
function setup(options = {}) {
  const store = fakeStore()
  const observer = createPoiInventoryEvents({ getReduxStore: () => store, ...options })
  const snapshot = observer.snapshot()
  return { store, observer, snapshot }
}

test('initial snapshot has a fence and is not a mass addition event', () => {
  const { observer, snapshot } = setup()
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.revision, 0)
  assert.equal(Object.keys(snapshot.sources.equipment.records).length, 3)
  assert.deepEqual(observer.read().events, [])
  snapshot.sources.equipment.records['201'].api_level = 100
  assert.equal(observer.snapshot().sources.equipment.records['201'].api_level, 6)
  observer.close()
})

test('changes without an action API event include lock, add, remove, and ship slots', () => {
  const { store, observer, snapshot } = setup()
  store.update(state => {
    state.info.equips['201'].api_locked = 0
    delete state.info.equips['203']
    state.info.equips['204'] = { api_id: 204, api_slotitem_id: 301, optional: null }
    state.info.ships['101'].api_slot[0] = 204
  })
  const data = observer.read({ sessionId: snapshot.sessionId, after: 0 })
  assert.equal(data.events.length, 1)
  const changes = Object.fromEntries(data.events[0].changes.map(c => [c.source, c]))
  assert.equal(changes.equipment.upserts['201'].api_locked, 0)
  assert.deepEqual(changes.equipment.removedIds, ['203'])
  assert.equal(changes.ships.upserts['101'].api_slot[0], 204)
  assert.equal(observer.snapshot().revision, data.events[0].revision)
  observer.close()
})

test('snapshot followed by intervening updates can be replayed exactly', () => {
  const { store, observer, snapshot } = setup()
  store.update(s => { s.info.equips['201'].api_level = 7 })
  store.update(s => { delete s.info.equips['202'] })
  const records = snapshot.sources.equipment.records
  for (const e of observer.read({ after: snapshot.revision, sessionId: snapshot.sessionId }).events) {
    for (const c of e.changes.filter(c => c.source === 'equipment')) {
      Object.assign(records, c.upserts)
      c.removedIds.forEach(id => delete records[id])
    }
  }
  assert.deepEqual(records, observer.snapshot().sources.equipment.records)
  observer.close()
})

test('unrelated actions and record reordering do not emit inventory changes', () => {
  const { store, observer } = setup()
  store.update(s => { s.layout = { theme: 'test' }; s.info.fleets.reverse(); s.info.equips = Object.fromEntries(Object.entries(s.info.equips).reverse()) })
  assert.equal(observer.snapshot().revision, 0)
  observer.close()
})

test('missing or malformed source preserves records and emits availability status', () => {
  const { store, observer } = setup()
  store.update(s => { delete s.info.equips })
  let snap = observer.snapshot()
  assert.equal(snap.sources.equipment.available, false)
  assert.equal(Object.keys(snap.sources.equipment.records).length, 3)
  assert.deepEqual(observer.read().events[0].changes[0].removedIds, [])
  store.update(s => { s.info.equips = { 201: { api_id: 201, api_level: 8 } } })
  snap = observer.snapshot()
  assert.equal(snap.sources.equipment.available, true)
  assert.equal(snap.sources.equipment.records['201'].api_level, 8)
  observer.close()
})

test('valid empty inventory emits removals', () => {
  const { store, observer } = setup()
  store.update(s => { s.info.equips = {} })
  const change = observer.read().events[0].changes[0]
  assert.deepEqual(change.removedIds, ['201', '202', '203'])
  observer.close()
})

test('history eviction, wrong session and ahead cursor require explicit resync', () => {
  const { store, observer } = setup({ capacity: 1 })
  store.update(s => { s.info.equips['201'].api_level = 7 })
  store.update(s => { s.info.equips['201'].api_level = 8 })
  assert.equal(observer.read({ after: 0 }).reason, 'history_gap')
  assert.equal(observer.read({ after: 2, sessionId: 'different' }).reason, 'session_changed')
  assert.equal(observer.read({ after: 3 }).reason, 'cursor_ahead')
  assert.equal(observer.read({ after: 1 }).resyncRequired, false)
  observer.close()
})

test('limited pages retain unconsumed events and oversized deltas invalidate', () => {
  const { store, observer } = setup()
  store.update(s => { s.info.equips['201'].api_level = 7 })
  store.update(s => { s.info.equips['201'].api_level = 8 })
  const first = observer.read({ after: 0, limit: 1 })
  assert.equal(first.latestRevision, 2)
  assert.equal(first.events[0].revision, 1)
  assert.equal(observer.read({ after: 1 }).events[0].revision, 2)
  observer.close()
  const large = setup({ maxEventBytes: 150 })
  large.store.update(s => { s.info.equips['201'].api_level = 7 })
  assert.equal(large.observer.read().events[0].resyncRequired, true)
  assert.equal(large.observer.snapshot().sources.equipment.records['201'].api_level, 7)
  large.observer.close()
})

test('long polling waits, times out, cancels and unregisters on unload', async () => {
  const { store, observer } = setup()
  const pending = observer.wait({ after: 0, timeoutMs: 500 })
  store.update(s => { s.info.equips['201'].api_level = 7 })
  assert.equal((await pending).timedOut, false)
  assert.equal((await observer.wait({ after: 1, timeoutMs: 5 })).timedOut, true)
  const abort = new AbortController()
  const canceled = observer.wait({ after: 1, signal: abort.signal })
  abort.abort()
  await assert.rejects(canceled, { name: 'AbortError' })
  const unload = observer.wait({ after: 1 })
  observer.close()
  await assert.rejects(unload, { name: 'AbortError' })
  assert.equal(store.size(), 0)
})

test('unsupported store is explicitly unavailable; no invented empty stock', async () => {
  const observer = createPoiInventoryEvents()
  assert.equal(observer.snapshot().available, false)
  assert.equal((await observer.wait()).available, false)
  observer.close()
})

test('source not loaded at initial capture becomes a baseline', () => {
  const store = fakeStore()
  store.update(s => { delete s.info.equips })
  const observer = createPoiInventoryEvents({ getReduxStore: () => store })
  observer.snapshot()
  store.update(s => { s.info.equips = { 1: { api_id: 1 } } })
  assert.equal(observer.read().events[0].changes[0].baseline, true)
  observer.close()
})

test('MCP inventory arguments reject unknown properties and unsafe cursors', () => {
  assert.equal(validateInventoryEventsArgs({ limit: 256 }).limit, 256)
  for (const args of [{ after: -1 }, { limit: 257 }, { after: 2.3 }, { input: 'click' }, null]) {
    assert.throws(() => validateInventoryEventsArgs(args))
  }
})

test('observer failures cannot escape into dispatch and later updates recover', () => {
  const { store, observer } = setup()
  const original = store.getState
  store.getState = () => { throw new Error('synthetic broken getter') }
  assert.doesNotThrow(() => store.update(() => {}))
  assert.equal(observer.snapshot().available, false)
  store.getState = original
  store.update(s => { s.info.equips['201'].api_locked = 0 })
  assert.equal(observer.snapshot().available, true)
  assert.equal(observer.snapshot().sources.equipment.records['201'].api_locked, 0)
  observer.close()
})

test('legacy cached store resolution verifies the live info identity', () => {
  const store = fakeStore(), filename = '/synthetic/poi/views/redux/create-store.ts'
  const previous = global.window
  require.cache[filename] = { exports: { store } }
  global.window = { getStore: () => store.getState() }
  try {
    assert.equal(defaultGetReduxStore(), store)
    global.window = { getStore: () => ({ info: {} }) }
    assert.equal(defaultGetReduxStore(), null)
  } finally { delete require.cache[filename]; global.window = previous }
})

test('HTTP inventory snapshot/events/wait and MCP tools share the same fence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poi-inventory-'))
  const store = fakeStore()
  const bridge = createPoiDataBridge({ getStore: store.getState, getReduxStore: () => store,
    port: 0, portFile: path.join(dir, 'port'), logger: { log() {}, error() {} } })
  await bridge.start()
  const url = `http://127.0.0.1:${bridge.getPort()}`
  try {
    const snap = await (await fetch(url + '/inventory/snapshot')).json()
    assert.equal(snap.available, true)
    const pending = fetch(url + `/inventory/events/wait?after=0&timeoutMs=1000&sessionId=${snap.sessionId}`)
    store.update(s => { s.info.equips['201'].api_level = 7 })
    const event = await (await pending).json()
    assert.equal(event.events[0].revision, 1)
    const mcp = await (await fetch(url + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_inventory_snapshot', arguments: {} } }) })).json()
    assert.equal(JSON.parse(mcp.result.content[0].text).revision, 1)
    assert.equal((await fetch(url + '/inventory/snapshot', { method: 'POST' })).status, 405)
  } finally { await bridge.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})
