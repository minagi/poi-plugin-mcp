const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { createPoiDataBridge } = require('../lib/poi-http-bridge')
const { createPoiInputProvider } = require('../lib/poi-input')

const ADDED_ACTION_PATHS = [
  '/kcsapi/api_get_member/chart_additional_info',
  '/kcsapi/api_get_member/furniture',
  '/kcsapi/api_get_member/mission',
  '/kcsapi/api_get_member/preset_deck',
  '/kcsapi/api_get_member/ship_deck',
  '/kcsapi/api_req_kaisou/can_preset_slot_select',
  '/kcsapi/api_req_kaisou/unsetslot',
  '/kcsapi/api_req_member/set_oss_condition',
]

test('upstream 0.2.29 /api-responses route forwards after, limit, and path', async () => {
  const calls = []
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'poi-mcp-upstream-029-'))
  const bridge = createPoiDataBridge({
    getStore: () => ({ info: {}, sortie: {} }),
    getApiResponses(options) {
      calls.push(options)
      return { available: true, latestGeneration: 12, responses: [] }
    },
    port: 0,
    portFile: path.join(temporaryHome, '.poi-mcp', 'port'),
    logger: { log() {}, error() {} },
  })
  await bridge.start()
  try {
    const result = await getJson(
      bridge.getPort(),
      '/api-responses?after=7&limit=3&path=%2Fkcsapi%2Fapi_port%2Fport',
    )
    assert.deepEqual(result, {
      available: true,
      latestGeneration: 12,
      responses: [],
    })
    assert.deepEqual(calls, [{
      after: 7,
      limit: 3,
      path: '/kcsapi/api_port/port',
    }])
  } finally {
    await bridge.stop()
    fs.rmSync(temporaryHome, { recursive: true, force: true })
  }
})

test('upstream 0.2.29 input, PIXI, hit-ledger, and action-event features remain present', () => {
  const inputSource = readLibrary('poi-input.js')
  assert.match(inputSource, /case 'scroll':/u)
  assert.match(inputSource, /function validateScroll\(operation\)/u)
  assert.match(inputSource, /async function sendScroll\(layout, operation, delay\)/u)
  assert.match(inputSource, /operation\.fromX/u)
  assert.match(inputSource, /operation\.fromY/u)
  assert.match(inputSource, /HOVER_MOVE_STEPS/u)
  assert.match(inputSource, /for \(let step = 1; step <= HOVER_MOVE_STEPS; step \+= 1\)/u)

  const hitLedgerSource = readLibrary('pixi-hit-ledger.js')
  assert.match(hitLedgerSource, /operation\.operation === 'scroll'/u)

  const runtimeSource = readLibrary('poi-webview-runtime.js')
  assert.match(runtimeSource, /request\.includeHidden === true/u)
  assert.match(runtimeSource, /prunedSubtrees/u)
  assert.match(runtimeSource, /!nodeShown && !includeHidden/u)

  const actionEventsSource = readLibrary('poi-action-events.js')
  for (const apiPath of ADDED_ACTION_PATHS) {
    assert.ok(actionEventsSource.includes(`'${apiPath}'`), `missing ${apiPath}`)
  }
})

test('upstream 0.2.29 move glides from an origin and scroll emits discrete wheel events', async () => {
  const events = []
  const webContents = {
    focus() {},
    setBackgroundThrottling() {},
    async sendInputEvent(event) { events.push(event) },
  }
  const performInput = createPoiInputProvider({
    getStore: () => ({
      width: 1200,
      height: 720,
      ref: { getWebContents: () => webContents },
    }),
    delay: async () => {},
  })

  assert.equal(await performInput({
    operation: 'move',
    fromX: 100,
    fromY: 200,
    x: 200,
    y: 300,
  }), 'move')
  assert.equal(events[0].type, 'mouseEnter')
  assert.deepEqual({ x: events[0].x, y: events[0].y }, { x: 100, y: 200 })
  assert.equal(events.filter((event) => event.type === 'mouseMove').length, 10)
  assert.deepEqual(
    { x: events.at(-1).x, y: events.at(-1).y },
    { x: 200, y: 300 },
  )

  events.length = 0
  assert.equal(await performInput({
    operation: 'scroll',
    x: 400,
    y: 300,
    notches: -2,
    intervalMs: 20,
  }), 'scroll')
  const wheelEvents = events.filter((event) => event.type === 'mouseWheel')
  assert.equal(wheelEvents.length, 2)
  assert.deepEqual(wheelEvents.map((event) => event.deltaY), [-120, -120])
  await assert.rejects(
    performInput({ operation: 'scroll', x: 1, y: 1, notches: 0 }),
    /non-zero integer/u,
  )
})

function readLibrary(filename) {
  return fs.readFileSync(path.join(__dirname, '..', 'lib', filename), 'utf8')
}

function getJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: requestPath }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try {
          assert.equal(response.statusCode, 200)
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}
