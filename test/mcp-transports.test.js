const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { after, before, test } = require('node:test')

const { createPoiDataBridge } = require('../lib/poi-http-bridge')
const {
  AKASHIC_RESOURCE_DATA_PATH,
} = require('../lib/integrations/akashic-records')
const {
  createAvailableQuestSnapshotFixture,
  createStoreFixture,
} = require('./fixtures')

const BATTLE_TELEMETRY = {
  available: true,
  generation: 7,
  status: 'in_progress',
  observed: {
    capturedAt: '2026-09-30T00:00:00.000Z',
    path: '/kcsapi/api_req_sortie/battle',
    time: 123,
    phaseStartHp: {
      friendlyMain: [-1, 30],
      friendlyEscort: [],
      enemyMain: [-1, 20],
      enemyEscort: [],
    },
  },
  official: null,
}

const ACTION_EVENTS = [
  { generation: 3, capturedAt: '2026-09-30T00:00:03.000Z', path: '/kcsapi/api_req_quest/start', apiResult: 1, postBody: { api_quest_id: 101 }, responseSummary: {} },
  { generation: 4, capturedAt: '2026-09-30T00:00:04.000Z', path: '/kcsapi/api_req_quest/stop', apiResult: 1, postBody: { api_quest_id: 101 }, responseSummary: {} },
]

const API_RESPONSES = [
  { generation: 8, capturedAt: '2026-09-30T00:00:08.000Z', path: '/kcsapi/api_get_member/questlist', apiResult: 1, postBody: { api_token: '[REDACTED]' }, responseBody: { api_list: [] }, truncated: false },
  { generation: 9, capturedAt: '2026-09-30T00:00:09.000Z', path: '/kcsapi/api_port/port', apiResult: 1, postBody: {}, responseBody: { api_ship: [] }, truncated: false },
]

const AVAILABLE_QUEST_SNAPSHOT = createAvailableQuestSnapshotFixture({ count: 80 })

let bridge
let bridgePort
let temporaryHome
let stdio
let akashicIntegrationEnabled = true

before(async () => {
  temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'poi-mcp-characterization-'))
  const portFile = path.join(temporaryHome, '.poi-mcp', 'port')
  const store = createStoreFixture()
  store.ext = {
    'poi-plugin-prophet': {
      _: { battle: { sortieState: 2, result: { rank: 'A', mvp: [0, null] } } },
    },
  }
  const resourceHistory = [
    resourceHistoryRow('2026-09-02T00:00:00Z', 130),
    resourceHistoryRow('2026-09-01T12:00:00Z', 90),
    resourceHistoryRow('2026-09-01T00:00:00Z', 100),
  ]
  bridge = createPoiDataBridge({
    getStore: (storePath) => {
      if (storePath === 'plugins') {
        return [
          { packageName: 'poi-plugin-mcp', enabled: true, isRead: true },
          {
            packageName: 'poi-plugin-akashic-records',
            enabled: true,
            isRead: true,
          },
        ]
      }
      if (storePath === AKASHIC_RESOURCE_DATA_PATH) return resourceHistory
      return store
    },
    getSettings: () => ({
      integrations: { akashicRecords: { enabled: akashicIntegrationEnabled } },
    }),
    getBattleTelemetry: () => BATTLE_TELEMETRY,
    getAvailableQuestSnapshot: () => AVAILABLE_QUEST_SNAPSHOT,
    getActionEvents: ({ after = 0, limit = 64 } = {}) => ({
      available: true,
      sessionId: 'fixture-action-session',
      earliestGeneration: 3,
      latestGeneration: 4,
      events: ACTION_EVENTS.filter((event) => event.generation > after).slice(0, limit),
    }),
    getApiResponses: ({ after = 0, limit = 64, path: apiPath } = {}) => ({
      available: true,
      sessionId: 'fixture-api-session',
      earliestGeneration: 8,
      latestGeneration: 9,
      retainedBytes: 100,
      responses: API_RESPONSES
        .filter((response) => response.generation > after && (!apiPath || response.path === apiPath))
        .slice(0, limit),
    }),
    port: 0,
    portFile,
    logger: { log() {}, error() {} },
  })
  await bridge.start()
  bridgePort = bridge.getPort()
  stdio = createStdioClient(temporaryHome)
  await stdio.ready
})

after(async () => {
  if (stdio) await stdio.close()
  if (bridge) await bridge.stop()
  if (temporaryHome) fs.rmSync(temporaryHome, { recursive: true, force: true })
})

test('HTTP MCP characterizes the published tools', async () => {
  const listed = await callHttpMcp('tools/list')
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
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
    ],
  )

  const resources = await callHttpTool('get_resources')
  assert.deepEqual(resources.raw, [1000, 2000, 3000, 4000, 5, 6, 7, 8])
  assert.deepEqual(resources.fuel, { key: 'fuel', label: '燃料', raw: 1000 })

  const historyTool = listed.tools.find(({ name }) => name === 'get_resource_history')
  assert.equal(historyTool.inputSchema.properties.hours.default, 168)
  assert.equal(historyTool.inputSchema.properties.maxPoints.maximum, 500)

  const ships = await callHttpTool('search_ships', { minLevel: 50 })
  assert.equal(ships.total, 1)
  assert.equal(ships.ships[0].instanceId, 101)
  assert.equal(ships.ships[0].name, 'Fixture Destroyer')

  const equipment = await callHttpTool('search_equipment', { minLevel: 1 })
  assert.equal(equipment.total, 1)
  assert.equal(equipment.equipment[0].instanceId, 201)
  assert.equal(equipment.equipment[0].name, 'Fixture Gun')

  const fleet = await callHttpTool('get_fleet_status', { fleetId: 1 })
  assert.equal(fleet.id, 1)
  assert.equal(fleet.ships[0].id, 101)
  assert.ok(fleet.metrics)

  const all = await callHttpTool('get_all')
  assert.equal(all.basic.api_level, 120)
  assert.equal(all.ships[101].api_ship_id, 501)
  assert.deepEqual(all.resources, [1000, 2000, 3000, 4000, 5, 6, 7, 8])
})

test('stdio MCP characterizes the published tools with the shared resource result', async () => {
  const listed = await stdio.call('tools/list')
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
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
    ],
  )

  const resources = await stdio.callTool('get_resources')
  assert.deepEqual(resources.raw, [1000, 2000, 3000, 4000, 5, 6, 7, 8])
  assert.deepEqual(resources.fuel, { key: 'fuel', label: '燃料', raw: 1000 })

  const ships = await stdio.callTool('search_ships', { minLevel: 50 })
  assert.equal(ships.total, 1)
  assert.equal(ships.ships[0].instanceId, 101)

  const equipment = await stdio.callTool('search_equipment', { minLevel: 1 })
  assert.equal(equipment.total, 1)
  assert.equal(equipment.equipment[0].instanceId, 201)

  const fleet = await stdio.callTool('get_fleet_status', { fleetId: 1 })
  assert.equal(fleet.id, 1)
  assert.equal(fleet.ships[0].id, 101)

  const all = await stdio.callTool('get_all')
  assert.equal(all.basic.api_level, 120)
  assert.equal(all.ships[101].api_ship_id, 501)
})

test('HTTP and stdio MCP publish identical tool definitions', async () => {
  const httpTools = await callHttpMcp('tools/list')
  const stdioTools = await stdio.call('tools/list')
  assert.deepEqual(stdioTools.tools, httpTools.tools)
})

test('HTTP and stdio get_resources results are deeply equal', async () => {
  const httpResources = await callHttpTool('get_resources')
  const stdioResources = await stdio.callTool('get_resources')
  assert.deepEqual(stdioResources, httpResources)
})

test('HTTP and stdio expose identical resource history summaries', async () => {
  const args = {
    start: '2026-09-01T00:00:00Z',
    end: '2026-09-02T00:00:00Z',
    includeSeries: true,
    maxPoints: 2,
  }
  const httpHistory = await callHttpTool('get_resource_history', args)
  const stdioHistory = await stdio.callTool('get_resource_history', args)

  assert.deepEqual(stdioHistory, httpHistory)
  assert.equal(httpHistory.state, 'available')
  assert.equal(httpHistory.sampleCount, 3)
  assert.equal(httpHistory.resources.fuel.delta, 30)
  assert.equal(httpHistory.seriesReturnedCount, 2)
})

test('resource history reads the latest integration setting on every call', async () => {
  const args = {
    start: '2026-09-01T00:00:00Z',
    end: '2026-09-02T00:00:00Z',
  }

  try {
    akashicIntegrationEnabled = false
    assert.equal((await callHttpTool('get_resource_history', args)).state, 'disabled')
    assert.equal((await stdio.callTool('get_resource_history', args)).state, 'disabled')

    akashicIntegrationEnabled = true
    assert.equal((await callHttpTool('get_resource_history', args)).state, 'available')
    assert.equal((await stdio.callTool('get_resource_history', args)).state, 'available')
  } finally {
    akashicIntegrationEnabled = true
  }
})

test('HTTP and stdio expose identical quest and raw airbase tools', async () => {
  const httpQuests = await callHttpTool('get_quests')
  const stdioQuests = await stdio.callTool('get_quests')
  assert.deepEqual(stdioQuests, httpQuests)
  assert.deepEqual(httpQuests, createStoreFixture().info.quests)

  const httpAirbase = await callHttpTool('get_airbase_status')
  const stdioAirbase = await stdio.callTool('get_airbase_status')
  assert.deepEqual(stdioAirbase, httpAirbase)
  assert.equal(httpAirbase.enriched, false)
  assert.equal(httpAirbase.airbase[0].unknownFixtureField, 'kept')
})

test('HTTP and stdio expose identical available quest filtering and summary', async () => {
  const args = {
    state: 1,
    states: [2],
    types: [1, 2],
    summary: true,
    limit: 5,
  }
  const httpQuests = await callHttpTool('get_available_quests', args)
  const stdioQuests = await stdio.callTool('get_available_quests', args)
  assert.deepEqual(stdioQuests, httpQuests)
  assert.equal(httpQuests.available, true)
  assert.equal(httpQuests.returned, 5)
  assert.ok(httpQuests.summary.total >= httpQuests.returned)
  assert.equal(Object.hasOwn(httpQuests.quests[0], 'api_no'), false)
  assert.equal(JSON.stringify(httpQuests).includes('api_tab_id'), false)
  assert.equal(JSON.stringify(httpQuests).includes('api_verno'), false)
  assert.equal(JSON.stringify(httpQuests).includes('postBody'), false)
})

test('available quests local endpoint is GET-only and exposes the bounded snapshot contract', async () => {
  const getResponse = await requestBridgeJson('/available-quests', 'GET')
  assert.equal(getResponse.statusCode, 200)
  assert.equal(getResponse.body.sourceTabId, 0)
  assert.equal(getResponse.body.quests.length, 80)
  assert.equal(Object.hasOwn(getResponse.body, 'postBody'), false)

  const postResponse = await requestBridgeJson('/available-quests', 'POST')
  assert.equal(postResponse.statusCode, 405)
})

test('HTTP and stdio searches have equivalent extended results', async () => {
  const shipArgs = { stypes: [2], inFleet: true, minMorale: 40, limit: 1 }
  assert.deepEqual(
    await stdio.callTool('search_ships', shipArgs),
    await callHttpTool('search_ships', shipArgs),
  )

  const equipmentArgs = { typeIds: [1, 6], summary: true, limit: 2 }
  assert.deepEqual(
    await stdio.callTool('search_equipment', equipmentArgs),
    await callHttpTool('search_equipment', equipmentArgs),
  )
})

test('HTTP and stdio expose the same retained battle state', async () => {
  const httpBattle = await callHttpTool('get_battle')
  const stdioBattle = await stdio.callTool('get_battle')
  assert.deepEqual(stdioBattle, httpBattle)
  assert.equal(httpBattle.generation, 7)
  assert.equal(httpBattle.status, 'in_progress')
  assert.equal(httpBattle.predicted.available, true)
  assert.equal(Object.hasOwn(httpBattle, 'active'), false)
  assert.equal(Object.hasOwn(httpBattle, 'current'), false)
  assert.equal(Object.hasOwn(httpBattle, 'isCurrent'), false)
})

test('HTTP and stdio action event pagination and session metadata are equal', async () => {
  const args = { after: 2, sessionId: 'previous-session', limit: 1 }
  const httpEvents = await callHttpTool('get_action_events', args)
  const stdioEvents = await stdio.callTool('get_action_events', args)
  assert.deepEqual(stdioEvents, httpEvents)
  assert.equal(httpEvents.returned, 1)
  assert.equal(httpEvents.hasMore, true)
  assert.equal(httpEvents.nextAfter, 3)
  assert.equal(httpEvents.sessionChanged, true)
  assert.equal(httpEvents.cursorLost, true)
})

test('HTTP and stdio KCSAPI responses are equal and never expose postBody', async () => {
  const args = {
    apiPath: '/kcsapi/api_get_member/questlist',
    sessionId: 'fixture-api-session',
  }
  const httpResponses = await callHttpTool('get_kcsapi_responses', args)
  const stdioResponses = await stdio.callTool('get_kcsapi_responses', args)
  assert.deepEqual(stdioResponses, httpResponses)
  assert.equal(httpResponses.returned, 1)
  assert.equal(httpResponses.sessionChanged, false)
  assert.equal(Object.hasOwn(httpResponses.responses[0], 'postBody'), false)
})

test('HTTP and stdio return JSON-RPC errors for parse and invalid params failures', async () => {
  const malformedHttp = await postHttpBody('{')
  assert.equal(malformedHttp.error.code, -32700)

  const malformedStdio = await stdio.rawLine('{')
  assert.equal(malformedStdio.error.code, -32700)

  await assert.rejects(
    callHttpTool('search_ships', { unknown: true }),
    (error) => error.code === -32602,
  )
  await assert.rejects(
    stdio.callTool('search_equipment', { limit: 0 }),
    (error) => error.code === -32602,
  )
  await assert.rejects(
    callHttpTool('does_not_exist'),
    (error) => error.code === -32602,
  )
  await assert.rejects(
    stdio.callTool('does_not_exist'),
    (error) => error.code === -32602,
  )
  await assert.rejects(
    callHttpTool('get_battle', { unexpected: true }),
    (error) => error.code === -32602,
  )
  await assert.rejects(
    stdio.callTool('get_kcsapi_responses', { apiPath: '/not-kcsapi/value' }),
    (error) => error.code === -32602,
  )
})

test('HTTP maps store failures to an internal JSON-RPC error', async () => {
  const failingBridge = createPoiDataBridge({
    getStore() { throw new Error('fixture store failure') },
    port: 0,
    portFile: path.join(temporaryHome, '.poi-mcp', 'failing-port'),
    logger: { log() {}, error() {} },
  })
  await failingBridge.start()
  try {
    const response = await postHttpBody(JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'get_resources', arguments: {} },
    }), failingBridge.getPort())
    assert.equal(response.id, 99)
    assert.equal(response.error.code, -32603)
  } finally {
    await failingBridge.stop()
  }
})

test('stdio maps Poi API failures to an internal JSON-RPC error', async () => {
  const failingApi = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/health') {
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }
    response.statusCode = 500
    response.end(JSON.stringify({ error: 'fixture API failure' }))
  })
  await new Promise((resolve, reject) => {
    failingApi.once('error', reject)
    failingApi.listen(0, '127.0.0.1', resolve)
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'poi-mcp-failing-api-'))
  fs.mkdirSync(path.join(home, '.poi-mcp'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.poi-mcp', 'port'),
    String(failingApi.address().port),
  )
  const client = createStdioClient(home)
  try {
    await client.ready
    await assert.rejects(
      client.callTool('get_resources'),
      (error) => error.code === -32603,
    )
  } finally {
    await client.close()
    await new Promise((resolve) => failingApi.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
})

function callHttpMcp(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  return postHttpBody(body).then((message) => {
    if (message.error) {
      const error = new Error(message.error.message)
      error.code = message.error.code
      throw error
    }
    return message.result
  })
}

function postHttpBody(body, port = bridgePort) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { data += chunk })
      response.on('end', () => {
        try {
          const message = JSON.parse(data)
          resolve(message)
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

function resourceHistoryRow(timestamp, value) {
  return [
    Date.parse(timestamp),
    value,
    value,
    value,
    value,
    value,
    value,
    value,
    value,
  ]
}

function requestBridgeJson(requestPath, method, port = bridgePort) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
    }, (response) => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { data += chunk })
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(data) })
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.end()
  })
}

async function callHttpTool(name, args = {}) {
  const result = await callHttpMcp('tools/call', { name, arguments: args })
  return JSON.parse(result.content[0].text)
}

function createStdioClient(home) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let nextId = 1
  let stdoutBuffer = ''
  let stderrBuffer = ''
  const pending = new Map()
  const unmatched = []
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      const request = pending.get(message.id)
      if (!request) {
        const waiter = unmatched.shift()
        if (waiter) waiter.resolve(message)
        continue
      }
      pending.delete(message.id)
      if (message.error) {
        const error = new Error(message.error.message)
        error.code = message.error.code
        request.reject(error)
      }
      else request.resolve(message.result)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk
    if (stderrBuffer.includes('Connected to POI API')) readyResolve()
  })
  child.once('error', readyReject)
  child.once('exit', (code) => {
    if (code !== 0) readyReject(new Error(`stdio MCP exited with ${code}: ${stderrBuffer}`))
    for (const request of pending.values()) {
      request.reject(new Error(`stdio MCP exited with ${code}`))
    }
    pending.clear()
  })

  function call(method, params) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  return {
    ready,
    call,
    async callTool(name, args = {}) {
      const result = await call('tools/call', { name, arguments: args })
      return JSON.parse(result.content[0].text)
    },
    rawLine(line) {
      return new Promise((resolve, reject) => {
        unmatched.push({ resolve, reject })
        child.stdin.write(`${line}\n`)
      })
    },
    close() {
      child.stdin.end()
      return new Promise((resolve) => child.once('exit', resolve))
    },
  }
}
