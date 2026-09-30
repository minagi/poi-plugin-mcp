const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  formatActionEvents,
  formatKcsapiResponses,
  validateActionEventsArgs,
  validateKcsapiResponsesArgs,
} = require('../lib/mcp-tools')
const { createPoiActionEvents } = require('../lib/poi-action-events')
const { createPoiApiResponses } = require('../lib/poi-api-responses')
const { createPoiDataBridge } = require('../lib/poi-http-bridge')
const { createPoiTelemetry } = require('../lib/poi-telemetry')
const { createStoreFixture } = require('./fixtures')

test('battle telemetry retains one in-progress or settled generation without current-state guesses', () => {
  let tick = 0
  const telemetry = createPoiTelemetry({
    now: () => new Date(Date.UTC(2026, 8, 30, 0, 0, tick++)),
  })
  assert.deepEqual(telemetry.getBattleTelemetry(), { available: false, generation: 0 })

  telemetry.handleGameResponse({ detail: {
    path: '/kcsapi/api_req_sortie/battle',
    apiResult: 1,
    time: 10,
    body: {
      api_f_nowhps: [-1, 30],
      api_e_nowhps: [-1, 20],
    },
  } })
  const observed = telemetry.getBattleTelemetry()
  assert.equal(observed.generation, 1)
  assert.equal(observed.status, 'in_progress')
  assert.equal(Object.hasOwn(observed, 'active'), false)
  assert.equal(Object.hasOwn(observed, 'current'), false)
  assert.equal(Object.hasOwn(observed, 'isCurrent'), false)

  telemetry.handleGameResponse({ detail: {
    path: '/kcsapi/api_port/port',
    apiResult: 1,
    body: {},
  } })
  assert.deepEqual(telemetry.getBattleTelemetry(), observed)

  telemetry.handleGameResponse({ detail: {
    path: '/kcsapi/api_req_sortie/battleresult',
    apiResult: 1,
    time: 11,
    body: { api_win_rank: 'S', api_mvp: 1 },
  } })
  const settled = telemetry.getBattleTelemetry()
  assert.equal(settled.generation, 1)
  assert.equal(settled.status, 'settled')
  assert.equal(settled.official.rank, 'S')

  const resultOnly = createPoiTelemetry({ now: () => new Date(0) })
  resultOnly.handleGameResponse({ detail: {
    path: '/kcsapi/api_req_sortie/battleresult',
    apiResult: 1,
    body: { api_win_rank: 'A' },
  } })
  assert.equal(resultOnly.getBattleTelemetry().generation, 1)
  assert.equal(resultOnly.getBattleTelemetry().observed, null)
})

test('get_battle returns a normal unavailable result when telemetry and Prophet are absent', async () => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'poi-mcp-battle-empty-'))
  const bridge = createPoiDataBridge({
    getStore: () => createStoreFixture(),
    port: 0,
    portFile: path.join(temporaryHome, '.poi-mcp', 'port'),
    logger: { log() {}, error() {} },
  })
  await bridge.start()
  try {
    const result = await callHttpTool(bridge.getPort(), 'get_battle', {})
    assert.deepEqual(result, {
      available: false,
      generation: 0,
      status: 'unavailable',
      observed: null,
      predicted: {
        available: false,
        source: 'poi-plugin-prophet',
        engine: 'poi-lib-battle',
        engineVersion: '3.0.5',
      },
      official: null,
    })
  } finally {
    await bridge.stop()
    fs.rmSync(temporaryHome, { recursive: true, force: true })
  }
})

test('action event provider exposes earliest generation and formatter detects paging, sessions, and loss', () => {
  let tick = 0
  const provider = createPoiActionEvents({
    capacity: 2,
    sessionId: 'action-session',
    now: () => new Date(Date.UTC(2026, 8, 30, 0, 0, tick++)),
  })
  for (const pathName of [
    '/kcsapi/api_req_quest/start',
    '/kcsapi/api_req_quest/stop',
    '/kcsapi/api_req_quest/clearitemget',
  ]) {
    provider.capture({ path: pathName, apiResult: 1, postBody: {}, body: {} })
  }
  const retained = provider.read({ after: 0, limit: 3 })
  assert.equal(retained.earliestGeneration, 2)
  assert.equal(retained.latestGeneration, 3)
  assert.deepEqual(retained.events.map((event) => event.generation), [2, 3])

  const lost = formatActionEvents({ after: 0, limit: 1 }, retained)
  assert.equal(lost.returned, 1)
  assert.equal(lost.hasMore, true)
  assert.equal(lost.nextAfter, 2)
  assert.equal(lost.cursorLost, true)
  assert.equal(lost.sessionChanged, false)

  const changed = formatActionEvents(
    { after: 2, sessionId: 'old-session', limit: 2 },
    retained,
  )
  assert.equal(changed.sessionChanged, true)
  assert.equal(changed.cursorLost, true)
  assert.equal(changed.nextAfter, 3)

  const future = formatActionEvents({ after: 99 }, {
    ...retained,
    events: [],
  })
  assert.equal(future.cursorLost, true)
  assert.equal(future.nextAfter, 99)
})

test('action event validation enforces defaults, maxima, session IDs, and unknown properties', () => {
  assert.deepEqual(validateActionEventsArgs({}), {
    after: 0,
    sessionId: null,
    limit: 20,
  })
  assert.equal(validateActionEventsArgs({ limit: 64 }).limit, 64)
  assert.throws(() => validateActionEventsArgs({ limit: 65 }), /limit must be/u)
  assert.throws(() => validateActionEventsArgs({ after: -1 }), /after must be/u)
  assert.throws(() => validateActionEventsArgs({ sessionId: 1 }), /sessionId must be/u)
  assert.throws(() => validateActionEventsArgs({ sessionId: 'x'.repeat(129) }), /sessionId must be/u)
  assert.throws(() => validateActionEventsArgs({ unknown: true }), /Unknown input property/u)

  const empty = formatActionEvents({}, {
    available: true,
    sessionId: 'session',
    earliestGeneration: 0,
    latestGeneration: 0,
    events: [],
  })
  assert.equal(empty.returned, 0)
  assert.equal(empty.hasMore, false)
  assert.equal(empty.cursorLost, false)

  const events = Array.from({ length: 65 }, (_, index) => ({
    generation: index + 1,
  }))
  const defaultPage = formatActionEvents({}, {
    available: true,
    sessionId: 'session',
    earliestGeneration: 1,
    latestGeneration: 65,
    events,
  })
  assert.equal(defaultPage.returned, 20)
  assert.equal(defaultPage.hasMore, true)
  const maxPage = formatActionEvents({ limit: 64 }, {
    available: true,
    sessionId: 'session',
    earliestGeneration: 1,
    latestGeneration: 65,
    events,
  })
  assert.equal(maxPage.returned, 64)
  assert.equal(maxPage.nextAfter, 64)
})

test('KCSAPI response provider uses exact paths and bounded ring retention', () => {
  const provider = createPoiApiResponses({
    capacity: 2,
    maxTotalBytes: 1024 * 1024,
    sessionId: 'api-session',
    now: () => new Date(0),
  })
  provider.capture({
    path: '/kcsapi/api_get_member/questlist',
    postBody: { api_token: 'secret', api_tab_id: 1 },
    body: { page: 1 },
    apiResult: 1,
  })
  provider.capture({
    path: '/kcsapi/api_get_member/questlist_extra',
    postBody: {},
    body: { page: 2 },
    apiResult: 1,
  })
  provider.capture({
    path: '/kcsapi/api_get_member/questlist',
    postBody: {},
    body: { page: 3 },
    apiResult: 1,
  })
  const exact = provider.read({
    path: '/kcsapi/api_get_member/questlist',
    after: 0,
    limit: 10,
  })
  assert.equal(exact.earliestGeneration, 2)
  assert.deepEqual(exact.responses.map((response) => response.generation), [3])
  assert.equal(exact.responses[0].path, '/kcsapi/api_get_member/questlist')
  const formatted = formatKcsapiResponses({
    apiPath: '/kcsapi/api_get_member/questlist',
    after: 0,
    sessionId: 'api-session',
  }, exact)
  assert.equal(formatted.sessionChanged, false)
  assert.equal(formatted.cursorLost, true)
})

test('KCSAPI validation requires one safe exact path and strict pagination inputs', () => {
  assert.deepEqual(validateKcsapiResponsesArgs({
    apiPath: '/kcsapi/api_port/port',
  }), {
    apiPath: '/kcsapi/api_port/port',
    after: 0,
    sessionId: null,
    limit: 3,
  })
  assert.equal(validateKcsapiResponsesArgs({
    apiPath: '/kcsapi/api_port/port',
    limit: 10,
  }).limit, 10)
  for (const apiPath of [
    undefined,
    '/api_port/port',
    '/kcsapi/api_port/port?x=1',
    '/kcsapi/api_port/port#fragment',
    '/kcsapi/api_port/*',
    '/kcsapi/api_port/.+',
  ]) {
    assert.throws(
      () => validateKcsapiResponsesArgs(apiPath == null ? {} : { apiPath }),
      /apiPath must be/u,
    )
  }
  assert.throws(() => validateKcsapiResponsesArgs({
    apiPath: '/kcsapi/api_port/port',
    limit: 11,
  }), /limit must be/u)
  assert.throws(() => validateKcsapiResponsesArgs({
    apiPath: '/kcsapi/api_port/port',
    after: 1.5,
  }), /after must be/u)
  assert.throws(() => validateKcsapiResponsesArgs({
    apiPath: '/kcsapi/api_port/port',
    sessionId: 1,
  }), /sessionId must be/u)
  assert.throws(() => validateKcsapiResponsesArgs({
    apiPath: '/kcsapi/api_port/port',
    unknown: true,
  }), /Unknown input property/u)
})

test('KCSAPI MCP formatter omits postBody, distinguishes truncation, and reports sessions and loss', () => {
  const result = formatKcsapiResponses({
    apiPath: '/kcsapi/api_get_member/questlist',
    after: 1,
    sessionId: 'old-session',
    limit: 3,
  }, {
    available: true,
    sessionId: 'new-session',
    earliestGeneration: 3,
    latestGeneration: 5,
    responses: [
      {
        generation: 3,
        capturedAt: '2026-09-30T00:00:03.000Z',
        path: '/kcsapi/api_get_member/questlist',
        apiResult: 1,
        postBody: { api_token: 'must-not-escape' },
        responseBody: null,
        truncated: true,
      },
      {
        generation: 4,
        capturedAt: '2026-09-30T00:00:04.000Z',
        path: '/kcsapi/api_get_member/questlist',
        apiResult: 1,
        postBody: { api_tab_id: 1 },
        responseBody: { payload: 'x'.repeat(270 * 1024) },
        truncated: false,
      },
      {
        generation: 5,
        capturedAt: '2026-09-30T00:00:05.000Z',
        path: '/kcsapi/api_get_member/questlist',
        apiResult: 1,
        postBody: {},
        responseBody: { page: 1 },
        truncated: false,
      },
    ],
  })
  assert.equal(result.sessionChanged, true)
  assert.equal(result.cursorLost, true)
  assert.equal(result.returned, 3)
  assert.equal(result.hasMore, false)
  assert.equal(result.nextAfter, 5)
  assert.equal(result.responses[0].storageTruncated, true)
  assert.equal(result.responses[0].bodyOmitted, false)
  assert.equal(result.responses[0].bodyBytes, null)
  assert.equal(result.responses[1].storageTruncated, false)
  assert.equal(result.responses[1].bodyOmitted, true)
  assert.equal(result.responses[2].bodyOmitted, false)
  assert.equal(result.bodyOmittedCount, 1)
  assert.ok(result.responses[2].bodyBytes > 0)
  for (const response of result.responses) {
    assert.equal(Object.hasOwn(response, 'postBody'), false)
  }

  const empty = formatKcsapiResponses({
    apiPath: '/kcsapi/api_get_member/questlist',
  }, {
    available: true,
    sessionId: 'new-session',
    earliestGeneration: 0,
    latestGeneration: 0,
    responses: [],
  })
  assert.equal(empty.returned, 0)
  assert.equal(empty.bodyOmittedCount, 0)
  assert.equal(empty.cursorLost, false)
})

test('KCSAPI MCP formatter keeps every entry metadata while enforcing the one MiB result budget', () => {
  const responses = Array.from({ length: 5 }, (_, index) => ({
    generation: index + 1,
    capturedAt: `2026-09-30T00:00:0${index}.000Z`,
    path: '/kcsapi/api_port/port',
    apiResult: 1,
    postBody: { api_token: 'must-not-escape' },
    responseBody: { payload: String(index).repeat(240 * 1024) },
    truncated: false,
  }))
  const result = formatKcsapiResponses({
    apiPath: '/kcsapi/api_port/port',
    limit: 5,
  }, {
    available: true,
    sessionId: 'api-session',
    earliestGeneration: 1,
    latestGeneration: 5,
    responses,
  })
  assert.equal(result.returned, 5)
  assert.equal(result.responses.length, 5)
  assert.ok(result.bodyOmittedCount > 0)
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') <= 1024 * 1024)
  assert.deepEqual(
    result.responses.map((response) => response.generation),
    [1, 2, 3, 4, 5],
  )
  for (const response of result.responses) {
    assert.equal(typeof response.capturedAt, 'string')
    assert.equal(Object.hasOwn(response, 'postBody'), false)
  }

  const page = formatKcsapiResponses({
    apiPath: '/kcsapi/api_port/port',
    limit: 3,
  }, {
    available: true,
    sessionId: 'api-session',
    earliestGeneration: 1,
    latestGeneration: 5,
    responses,
  })
  assert.equal(page.returned, 3)
  assert.equal(page.hasMore, true)
  assert.equal(page.nextAfter, 3)
})

function callHttpTool(port, name, args) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })
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
          if (message.error) throw new Error(message.error.message)
          resolve(JSON.parse(message.result.content[0].text))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}
