const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { createBridgeController } = require('../lib/bridge-controller')
const {
  INTEGRATION_DEFINITIONS,
  INTEGRATION_STATES,
  detectPoiPlugin,
  getIntegrationStatuses,
} = require('../lib/integrations')
const {
  DEFAULT_SETTINGS,
  loadSettings,
  mergeSettings,
  normalizeSettings,
  saveSettings,
} = require('../lib/settings')
const {
  createSettingsClass,
  createTranslator,
  startStatusPolling,
} = require('../lib/settings-view')
const english = require('../i18n/en-US.json')
const japanese = require('../i18n/ja-JP.json')
const partialLocales = [
  require('../i18n/zh-CN.json'),
  require('../i18n/zh-TW.json'),
  require('../i18n/ko-KR.json'),
]

const AKASHIC = INTEGRATION_DEFINITIONS.find(({ key }) => key === 'akashicRecords')
/** @type {any} */
const OWNER = {
  packageName: 'poi-plugin-mcp',
  id: 'mcp_data_bridge',
  enabled: true,
  isRead: true,
}

test('legacy settings gain a disabled nested integration without changing existing values', () => {
  assert.equal(DEFAULT_SETTINGS.integrations.akashicRecords.enabled, false)

  const normalized = normalizeSettings({
    port: 23456,
    enabled: false,
    inputEnabled: true,
    recordingEnabled: true,
    debugEvalEnabled: true,
    writerTokenEnforced: true,
  })

  assert.deepEqual(normalized, {
    port: 23456,
    enabled: false,
    inputEnabled: true,
    recordingEnabled: true,
    debugEvalEnabled: true,
    writerTokenEnforced: true,
    integrations: {
      akashicRecords: { enabled: false },
    },
  })
})

test('loading a legacy settings file does not rewrite it', async (t) => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'poi-mcp-legacy-settings-'))
  const settingsPath = path.join(temporaryHome, 'settings.json')
  t.after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }))

  const legacyContents = `${JSON.stringify({
    port: 23456,
    enabled: true,
    inputEnabled: true,
    recordingEnabled: false,
    debugEvalEnabled: false,
    writerTokenEnforced: false,
  }, null, 2)}\n`
  fs.writeFileSync(settingsPath, legacyContents, 'utf8')

  const controller = createBridgeController({
    settingsPath,
    inputToken: 'test-input-token',
    createBridge: () => ({
      start: async () => {},
      stop: async () => {},
      getPort: () => 23456,
    }),
  })
  await controller.load()
  await controller.unload()

  assert.equal(controller.getSettings().integrations.akashicRecords.enabled, false)
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), legacyContents)
})

test('partial integration updates preserve all unrelated settings', () => {
  const current = normalizeSettings({
    port: 23456,
    inputEnabled: true,
    integrations: { akashicRecords: { enabled: false } },
  })
  const merged = mergeSettings(current, {
    integrations: { akashicRecords: { enabled: true } },
  })

  assert.equal(merged.port, 23456)
  assert.equal(merged.inputEnabled, true)
  assert.equal(merged.integrations.akashicRecords.enabled, true)
})

test('integration settings persist in the existing settings file', (t) => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'poi-mcp-settings-'))
  const settingsPath = path.join(temporaryHome, 'settings.json')
  t.after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }))

  saveSettings({
    ...normalizeSettings(),
    integrations: { akashicRecords: { enabled: true } },
  }, settingsPath)

  assert.equal(loadSettings(settingsPath).integrations.akashicRecords.enabled, true)
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    .integrations.akashicRecords.enabled, true)
})

test('Poi plugin detection distinguishes loading, missing, disabled, detected, and errors', () => {
  assert.equal(detectPoiPlugin(AKASHIC, () => undefined).state, INTEGRATION_STATES.LOADING)
  assert.equal(detectPoiPlugin(AKASHIC, () => []).state, INTEGRATION_STATES.LOADING)
  assert.equal(
    detectPoiPlugin(AKASHIC, () => [OWNER]).state,
    INTEGRATION_STATES.NOT_DETECTED,
  )
  assert.equal(
    detectPoiPlugin(AKASHIC, () => [OWNER, {
      packageName: AKASHIC.packageName,
      enabled: false,
    }]).state,
    INTEGRATION_STATES.DISABLED,
  )
  assert.equal(
    detectPoiPlugin(AKASHIC, () => [OWNER, {
      packageName: AKASHIC.packageName,
      enabled: true,
    }]).state,
    INTEGRATION_STATES.LOADING,
  )
  assert.deepEqual(
    detectPoiPlugin(AKASHIC, () => [OWNER, {
      packageName: AKASHIC.packageName,
      enabled: true,
      isRead: true,
      version: '8.3.2',
    }]),
    {
      packageName: AKASHIC.packageName,
      state: INTEGRATION_STATES.DETECTED,
      version: '8.3.2',
    },
  )
  assert.equal(
    detectPoiPlugin(AKASHIC, () => [OWNER, {
      packageName: AKASHIC.packageName,
      enabled: false,
      isBroken: true,
    }]).state,
    INTEGRATION_STATES.ERROR,
  )
})

test('read access requires opt-in and every healthy loaded-plugin condition', () => {
  const cases = [
    {
      name: 'integration off',
      optIn: false,
      plugin: { enabled: true, isRead: true },
      state: INTEGRATION_STATES.DETECTED,
    },
    { name: 'plugin absent', optIn: true, plugin: null, state: INTEGRATION_STATES.NOT_DETECTED },
    {
      name: 'plugin disabled',
      optIn: true,
      plugin: { enabled: false, isRead: true },
      state: INTEGRATION_STATES.DISABLED,
    },
    {
      name: 'plugin not read',
      optIn: true,
      plugin: { enabled: true, isRead: false },
      state: INTEGRATION_STATES.LOADING,
    },
    {
      name: 'plugin enabled is not strictly true',
      optIn: true,
      plugin: { enabled: 1, isRead: true },
      state: INTEGRATION_STATES.LOADING,
    },
    {
      name: 'plugin isRead is not strictly true',
      optIn: true,
      plugin: { enabled: true, isRead: 1 },
      state: INTEGRATION_STATES.LOADING,
    },
    {
      name: 'plugin broken',
      optIn: true,
      plugin: { enabled: true, isRead: true, isBroken: true },
      state: INTEGRATION_STATES.ERROR,
    },
    {
      name: 'plugin needs rollback',
      optIn: true,
      plugin: { enabled: true, isRead: true, needRollback: true },
      state: INTEGRATION_STATES.ERROR,
    },
    {
      name: 'all conditions met',
      optIn: true,
      plugin: {
        enabled: true,
        isRead: true,
        isBroken: false,
        needRollback: false,
      },
      state: INTEGRATION_STATES.DETECTED,
      canRead: true,
    },
  ]

  for (const testCase of cases) {
    const plugins = testCase.plugin
      ? [OWNER, { packageName: AKASHIC.packageName, ...testCase.plugin }]
      : [OWNER]
    const statuses = getIntegrationStatuses(normalizeSettings({
      integrations: { akashicRecords: { enabled: testCase.optIn } },
    }), (storePath) => {
      assert.equal(storePath, 'plugins', testCase.name)
      return plugins
    })

    assert.equal(statuses.akashicRecords.state, testCase.state, testCase.name)
    assert.equal(statuses.akashicRecords.canRead, testCase.canRead === true, testCase.name)
  }
})

test('controller saves integration opt-in without restarting the existing service', async (t) => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'poi-mcp-controller-'))
  const settingsPath = path.join(temporaryHome, 'settings.json')
  t.after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }))

  let starts = 0
  let stops = 0
  let runningPort = 0
  let getBridgeSettings = null
  const controller = createBridgeController({
    settingsPath,
    inputToken: 'test-input-token',
    getStore: () => [OWNER, {
      packageName: AKASHIC.packageName,
      enabled: true,
      isRead: true,
      version: '8.3.2',
    }],
    createBridge: ({ port, getSettings }) => {
      getBridgeSettings = getSettings
      return {
        async start() {
          starts += 1
          runningPort = port
        },
        async stop() {
          stops += 1
          runningPort = 0
        },
        getPort() {
          return runningPort
        },
      }
    },
  })
  t.after(() => controller.unload())

  await controller.load()
  await controller.applySettings({
    integrations: { akashicRecords: { enabled: true } },
  })

  assert.equal(starts, 1)
  assert.equal(stops, 0)
  assert.equal(getBridgeSettings().integrations.akashicRecords.enabled, true)
  assert.equal(getIntegrationStatuses(controller.getSettings(), () => [OWNER, {
    packageName: AKASHIC.packageName,
    enabled: true,
    isRead: true,
  }]).akashicRecords.canRead, true)

  await controller.applySettings({
    integrations: { akashicRecords: { enabled: false } },
  })
  assert.equal(starts, 1)
  assert.equal(stops, 0)
  assert.equal(getBridgeSettings().integrations.akashicRecords.enabled, false)

  await controller.applySettings({
    integrations: { akashicRecords: { enabled: true } },
  })
  assert.equal(starts, 1)
  assert.equal(stops, 0)
  assert.equal(getBridgeSettings().integrations.akashicRecords.enabled, true)
  assert.equal(loadSettings(settingsPath).integrations.akashicRecords.enabled, true)
})

test('settings UI keeps English fallback text and exposes the integration while absent', (t) => {
  const previousWindow = global.window
  global.window = { getStore: () => [OWNER] }
  t.after(() => {
    global.window = previousWindow
  })

  const Settings = createSettingsClass({
    getStatus: () => ({
      running: false,
      port: 17777,
      actualPort: 0,
      inputEnabled: false,
      recordingEnabled: false,
      debugEvalEnabled: false,
      recordingArmed: false,
      recordingStarting: false,
      recording: false,
      recordingAttached: false,
      recordingSessionDir: null,
      recordingLimitReached: null,
    }),
    getSettings: () => normalizeSettings(),
    applySettings: async () => {},
    startBridge: async () => {},
    stopBridge: async () => {},
  })

  const text = collectText(Settings())
  assert.match(text, /MCP service/u)
  assert.match(text, /It is not needed for read-only use/u)
  assert.match(text, /does not replay input/u)
  assert.match(text, /Logbook \(Akashic Records\)/u)
  assert.match(text, /Not detected/u)
  assert.match(text, /Uses Logbook data in read-only mode/u)
})

test('the existing status poll reevaluates plugin metadata once per tick', (t) => {
  const previousWindow = global.window
  let plugins = [OWNER]
  global.window = { getStore: () => plugins }
  t.after(() => {
    global.window = previousWindow
  })

  let callback = () => {}
  let clearedTimer = null
  const statuses = []
  const stop = startStatusPolling({
    getStatus: () => ({ port: 17777 }),
    getSettings: () => normalizeSettings({
      integrations: { akashicRecords: { enabled: true } },
    }),
  }, (status) => statuses.push(status), {
    setInterval(fn, interval) {
      callback = fn
      assert.equal(interval, 1000)
      return 42
    },
    clearInterval(timer) {
      clearedTimer = timer
    },
  })

  callback()
  assert.equal(statuses[0].integrations.akashicRecords.state,
    INTEGRATION_STATES.NOT_DETECTED)

  plugins = [OWNER, {
    packageName: AKASHIC.packageName,
    enabled: true,
    isRead: true,
  }]
  callback()
  assert.equal(statuses[1].integrations.akashicRecords.state, INTEGRATION_STATES.DETECTED)
  assert.equal(statuses[1].integrations.akashicRecords.canRead, true)

  stop()
  assert.equal(clearedTimer, 42)
})

test('settings translator uses the Poi namespace and Japanese resources', () => {
  const calls = []
  const translator = createTranslator({
    getFixedT(language, namespace) {
      calls.push({ language, namespace })
      return (key, options) => interpolate(readPath(japanese, key) || options.defaultValue, options)
    },
  })

  assert.equal(translator('settings.sections.integrations'), '外部プラグイン連携')
  assert.equal(
    translator('settings.service.running', { port: 17777 }),
    '127.0.0.1:17777 で稼働中',
  )
  assert.deepEqual(calls, [{ language: null, namespace: 'mcp_data_bridge' }])
})

test('partial Poi locales fall back to English settings text instead of keys', () => {
  for (const resources of partialLocales) {
    const translator = createTranslator({
      getFixedT() {
        return (key, options) => {
          const value = readPath(resources, key)
          return value == null ? key : interpolate(value, options)
        }
      },
    })

    assert.equal(translator('settings.sections.service'), 'MCP service')
    assert.equal(
      translator('settings.service.running', { port: 17777 }),
      'Running on 127.0.0.1:17777',
    )
    assert.notEqual(translator('integrations.akashicRecords.name'),
      'integrations.akashicRecords.name')
  }
})

test('Japanese UI covers every English metadata and settings key', () => {
  assert.deepEqual(flattenKeys(japanese), flattenKeys(english))
  assert.equal(japanese.meta.name, 'MCP連携')
  assert.match(japanese.meta.description, /MCP経由/u)
})

function collectText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  if (node.props) return collectText(node.props.children)
  return ''
}

function readPath(source, key) {
  return key.split('.').reduce((value, part) => (
    value && typeof value === 'object' ? value[part] : undefined
  ), source)
}

function interpolate(value, options) {
  return String(value).replace(/\{\{\s*([^}\s]+)\s*\}\}/gu, (_match, key) => (
    Object.prototype.hasOwnProperty.call(options, key) ? String(options[key]) : ''
  ))
}

function flattenKeys(source, prefix = '') {
  const keys = []
  for (const [key, value] of Object.entries(source)) {
    const pathKey = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object') {
      keys.push(...flattenKeys(value, pathKey))
    } else {
      keys.push(pathKey)
    }
  }
  return keys.sort()
}
