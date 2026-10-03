const INTEGRATION_STATES = Object.freeze({
  DETECTED: 'detected',
  NOT_DETECTED: 'notDetected',
  DISABLED: 'disabled',
  LOADING: 'loading',
  ERROR: 'error',
})

const INTEGRATION_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: 'akashicRecords',
    packageName: 'poi-plugin-akashic-records',
    translationKey: 'integrations.akashicRecords',
  }),
])

const OWNER_PLUGIN_IDS = new Set(['poi-plugin-mcp', 'mcp_data_bridge'])

function createDefaultIntegrationSettings() {
  return Object.fromEntries(INTEGRATION_DEFINITIONS.map(({ key }) => [key, { enabled: false }]))
}

function normalizeIntegrationSettings(input = {}) {
  const source = isRecord(input) ? input : {}
  return Object.fromEntries(INTEGRATION_DEFINITIONS.map(({ key }) => {
    const integration = isRecord(source[key]) ? source[key] : {}
    return [key, { enabled: integration.enabled === true }]
  }))
}

function mergeIntegrationSettings(current, update) {
  const currentSettings = normalizeIntegrationSettings(current)
  if (!isRecord(update)) return currentSettings

  const merged = {}
  for (const { key } of INTEGRATION_DEFINITIONS) {
    const nextValue = isRecord(update[key]) ? update[key] : {}
    merged[key] = {
      ...currentSettings[key],
      ...nextValue,
    }
  }
  return normalizeIntegrationSettings(merged)
}

function getIntegrationStatuses(settings, getStore = defaultGetStore) {
  const integrationSettings = normalizeIntegrationSettings(
    isRecord(settings) ? settings.integrations : {},
  )

  return Object.fromEntries(INTEGRATION_DEFINITIONS.map((definition) => {
    const detection = detectPoiPlugin(definition, getStore)
    const enabled = integrationSettings[definition.key].enabled
    return [definition.key, {
      ...detection,
      enabled,
      canRead: enabled && detection.state === INTEGRATION_STATES.DETECTED,
    }]
  }))
}

function detectPoiPlugin(definition, getStore = defaultGetStore) {
  let plugins
  try {
    plugins = getStore('plugins')
  } catch (_) {
    return detectionResult(definition, INTEGRATION_STATES.LOADING)
  }

  if (!Array.isArray(plugins)) {
    return detectionResult(definition, INTEGRATION_STATES.LOADING)
  }

  const plugin = plugins.find((candidate) => pluginMatches(candidate, definition.packageName))
  if (plugin) {
    if (plugin.isBroken === true || plugin.needRollback === true) {
      return detectionResult(definition, INTEGRATION_STATES.ERROR, plugin)
    }
    if (plugin.enabled === false) {
      return detectionResult(definition, INTEGRATION_STATES.DISABLED, plugin)
    }
    if (plugin.enabled === true && plugin.isRead === true) {
      return detectionResult(definition, INTEGRATION_STATES.DETECTED, plugin)
    }
    return detectionResult(definition, INTEGRATION_STATES.LOADING, plugin)
  }

  // Poi's plugins reducer starts as an empty array and is replaced only after
  // the plugin scan and load pass completes. The current plugin appearing in
  // that list is therefore a stable readiness marker for an absent optional
  // integration; until then, absence means "loading", not "not installed".
  const pluginListReady = plugins.some((candidate) => (
    candidate && (
      OWNER_PLUGIN_IDS.has(candidate.packageName) ||
      OWNER_PLUGIN_IDS.has(candidate.id)
    )
  ))
  return detectionResult(
    definition,
    pluginListReady ? INTEGRATION_STATES.NOT_DETECTED : INTEGRATION_STATES.LOADING,
  )
}

function detectionResult(definition, state, plugin) {
  return {
    packageName: definition.packageName,
    state,
    version: plugin && typeof plugin.version === 'string' ? plugin.version : null,
  }
}

function pluginMatches(plugin, packageName) {
  return Boolean(plugin) && (
    plugin.packageName === packageName ||
    plugin.id === packageName
  )
}

function defaultGetStore(path) {
  if (typeof window !== 'undefined' && typeof window.getStore === 'function') {
    return window.getStore(path)
  }
  return undefined
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

module.exports = {
  INTEGRATION_DEFINITIONS,
  INTEGRATION_STATES,
  createDefaultIntegrationSettings,
  detectPoiPlugin,
  getIntegrationStatuses,
  mergeIntegrationSettings,
  normalizeIntegrationSettings,
}
