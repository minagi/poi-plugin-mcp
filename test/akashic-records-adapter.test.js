const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  AKASHIC_RESOURCE_DATA_PATH,
  RESOURCE_HISTORY_STATES,
  readAkashicResourceHistory,
} = require('../lib/integrations/akashic-records')
const { MCP_TOOL_DEFINITIONS } = require('../lib/mcp-tools')

const OWNER = {
  packageName: 'poi-plugin-mcp',
  id: 'mcp_data_bridge',
  enabled: true,
  isRead: true,
}
const AKASHIC = {
  packageName: 'poi-plugin-akashic-records',
  enabled: true,
  isRead: true,
  isBroken: false,
  needRollback: false,
}

function integrationSettings(enabled = true) {
  return { integrations: { akashicRecords: { enabled } } }
}

function createStoreReader(plugins, resourceData) {
  const calls = []
  return {
    calls,
    getStore(path) {
      calls.push(path)
      if (path === 'plugins') return plugins
      if (path === AKASHIC_RESOURCE_DATA_PATH) return resourceData
      throw new Error(`Unexpected store path: ${path}`)
    },
  }
}

test('integration off reads plugin metadata but not Akashic extension state', () => {
  const store = createStoreReader([OWNER, AKASHIC], [validRow()])

  const result = readAkashicResourceHistory(
    integrationSettings(false),
    store.getStore,
  )

  assert.deepEqual(result, {
    state: RESOURCE_HISTORY_STATES.DISABLED,
    history: [],
  })
  assert.deepEqual(store.calls, ['plugins'])
})

test('unavailable plugin states do not read Akashic extension state', () => {
  const cases = [
    { name: 'not detected', plugin: null },
    { name: 'disabled', plugin: { ...AKASHIC, enabled: false } },
    { name: 'broken', plugin: { ...AKASHIC, isBroken: true } },
    { name: 'rollback required', plugin: { ...AKASHIC, needRollback: true } },
  ]

  for (const testCase of cases) {
    const plugins = testCase.plugin ? [OWNER, testCase.plugin] : [OWNER]
    const store = createStoreReader(plugins, [validRow()])
    const result = readAkashicResourceHistory(
      integrationSettings(),
      store.getStore,
    )

    assert.equal(
      result.state,
      RESOURCE_HISTORY_STATES.PLUGIN_UNAVAILABLE,
      testCase.name,
    )
    assert.deepEqual(result.history, [], testCase.name)
    assert.deepEqual(store.calls, ['plugins'], testCase.name)
  }
})

test('loading plugin is reported as not ready without reading extension state', () => {
  const store = createStoreReader([OWNER, {
    ...AKASHIC,
    isRead: false,
  }], [validRow()])

  const result = readAkashicResourceHistory(
    integrationSettings(),
    store.getStore,
  )

  assert.equal(result.state, RESOURCE_HISTORY_STATES.PLUGIN_NOT_READY)
  assert.deepEqual(store.calls, ['plugins'])
})

test('missing extension state or resource data is unavailable', () => {
  for (const resourceData of [undefined, null, {}]) {
    const store = createStoreReader([OWNER, AKASHIC], resourceData)
    const result = readAkashicResourceHistory(
      integrationSettings(),
      store.getStore,
    )

    assert.equal(result.state, RESOURCE_HISTORY_STATES.STATE_UNAVAILABLE)
    assert.deepEqual(result.history, [])
    assert.deepEqual(store.calls, ['plugins', AKASHIC_RESOURCE_DATA_PATH])
  }
})

test('store read failures are reported as unavailable', () => {
  const calls = []
  const result = readAkashicResourceHistory(integrationSettings(), (path) => {
    calls.push(path)
    if (path === 'plugins') return [OWNER, AKASHIC]
    throw new Error('state not registered')
  })

  assert.equal(result.state, RESOURCE_HISTORY_STATES.STATE_UNAVAILABLE)
  assert.deepEqual(result.history, [])
  assert.deepEqual(calls, ['plugins', AKASHIC_RESOURCE_DATA_PATH])
})

test('empty resource data is distinct from unavailable state', () => {
  const store = createStoreReader([OWNER, AKASHIC], [])
  const result = readAkashicResourceHistory(
    integrationSettings(),
    store.getStore,
  )

  assert.deepEqual(result, {
    state: RESOURCE_HISTORY_STATES.NO_HISTORY,
    history: [],
  })
})

test('non-empty resource data with no valid rows is invalid data', () => {
  const store = createStoreReader([OWNER, AKASHIC], [
    null,
    [1, 2, 3],
    ['bad', 2, 3, 4, 5, 6, 7, 8, 9],
  ])
  const result = readAkashicResourceHistory(
    integrationSettings(),
    store.getStore,
  )

  assert.deepEqual(result, {
    state: RESOURCE_HISTORY_STATES.INVALID_DATA,
    history: [],
  })
})

test('one resource row is normalized to stable named fields', () => {
  const row = validRow()
  const store = createStoreReader([OWNER, AKASHIC], [row])
  const result = readAkashicResourceHistory(
    integrationSettings(),
    store.getStore,
  )

  assert.deepEqual(result, {
    state: RESOURCE_HISTORY_STATES.AVAILABLE,
    history: [{
      timestamp: 1_791_047_745_961,
      fuel: 207_429,
      ammo: 194_131,
      steel: 239_947,
      bauxite: 149_324,
      instantBuild: 2_044,
      instantRepair: 1_986,
      developmentMaterial: 1_890,
      improvementMaterial: 207,
    }],
  })
})

test('default reader uses Poi renderer window.getStore', (t) => {
  const previousWindow = global.window
  const store = createStoreReader([OWNER, AKASHIC], [validRow()])
  global.window = { getStore: store.getStore }
  t.after(() => {
    global.window = previousWindow
  })

  const result = readAkashicResourceHistory(integrationSettings())

  assert.equal(result.state, RESOURCE_HISTORY_STATES.AVAILABLE)
  assert.deepEqual(store.calls, ['plugins', AKASHIC_RESOURCE_DATA_PATH])
})

test('injected getter is used consistently without window fallback', (t) => {
  const previousWindow = global.window
  let fallbackCalls = 0
  global.window = {
    getStore() {
      fallbackCalls += 1
      throw new Error('window.getStore must not be used')
    },
  }
  t.after(() => {
    global.window = previousWindow
  })
  const store = createStoreReader([OWNER, AKASHIC], [validRow()])

  const result = readAkashicResourceHistory(
    integrationSettings(),
    store.getStore,
  )

  assert.equal(result.state, RESOURCE_HISTORY_STATES.AVAILABLE)
  assert.deepEqual(store.calls, ['plugins', AKASHIC_RESOURCE_DATA_PATH])
  assert.equal(fallbackCalls, 0)
})

test('multiple rows preserve Akashic newest-first order and convert numeric strings', () => {
  const newest = validRow()
  const older = [
    '1791047000000',
    '200000',
    '190000',
    '230000',
    '140000',
    '2000',
    '1900',
    '1800',
    '200',
  ]
  const store = createStoreReader([OWNER, AKASHIC], [newest, older])
  const result = readAkashicResourceHistory(
    integrationSettings(),
    store.getStore,
  )

  assert.equal(result.state, RESOURCE_HISTORY_STATES.AVAILABLE)
  assert.deepEqual(result.history.map(({ timestamp }) => timestamp), [
    1_791_047_745_961,
    1_791_047_000_000,
  ])
  assert.equal(result.history[1].fuel, 200_000)
  assert.equal(result.history[1].improvementMaterial, 200)
})

test('malformed rows are skipped without losing valid rows', () => {
  const rows = [
    null,
    {},
    [1, 2, 3],
    ['bad', 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 5, 6, 7, 8, Number.NaN],
    [1, 2, 3, 4, 5, 6, 7, Number.POSITIVE_INFINITY, 9],
    [1, 2, 3, 4, '', 6, 7, 8, 9],
    validRow(),
  ]
  const store = createStoreReader([OWNER, AKASHIC], rows)
  const result = readAkashicResourceHistory(
    integrationSettings(),
    store.getStore,
  )

  assert.equal(result.state, RESOURCE_HISTORY_STATES.AVAILABLE)
  assert.equal(result.history.length, 1)
  assert.equal(result.history[0].timestamp, validRow()[0])
})

test('normalization does not mutate source data and ignores trailing columns', () => {
  const row = [...validRow(), 'future-column']
  const source = [row]
  const snapshot = source.map((sourceRow) => [...sourceRow])
  const store = createStoreReader([OWNER, AKASHIC], source)
  const result = readAkashicResourceHistory(
    integrationSettings(),
    store.getStore,
  )

  assert.equal(result.state, RESOURCE_HISTORY_STATES.AVAILABLE)
  assert.deepEqual(source, snapshot)
  assert.equal(Object.keys(result.history[0]).length, 9)
})

test('row normalization rejects coercive non-number values', () => {
  const store = createStoreReader([OWNER, AKASHIC], [[
    1,
    2,
    3,
    4,
    true,
    6,
    7,
    8,
    9,
  ]])
  const result = readAkashicResourceHistory(
    integrationSettings(),
    store.getStore,
  )

  assert.equal(result.state, RESOURCE_HISTORY_STATES.INVALID_DATA)
  assert.deepEqual(result.history, [])
})

test('3C adds resource history as the twelfth MCP tool', () => {
  assert.deepEqual(MCP_TOOL_DEFINITIONS.map(({ name }) => name), [
    'get_fleet_status',
    'search_ships',
    'search_equipment',
    'get_resources',
    'get_resource_history',
    'get_quests',
    'get_available_quests',
    'get_airbase_status',
    'get_all',
    'get_battle',
    'get_action_events',
    'get_kcsapi_responses',
  ])
})

function validRow() {
  return [
    1_791_047_745_961,
    207_429,
    194_131,
    239_947,
    149_324,
    2_044,
    1_986,
    1_890,
    207,
  ]
}
