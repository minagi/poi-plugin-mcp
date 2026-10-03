const {
  INTEGRATION_STATES,
  getIntegrationStatuses,
} = require('../integrations')

const AKASHIC_RESOURCE_DATA_PATH =
  'ext.poi-plugin-akashic-records._.resource.data'

const RESOURCE_HISTORY_STATES = Object.freeze({
  DISABLED: 'disabled',
  PLUGIN_UNAVAILABLE: 'pluginUnavailable',
  PLUGIN_NOT_READY: 'pluginNotReady',
  STATE_UNAVAILABLE: 'stateUnavailable',
  NO_HISTORY: 'noHistory',
  INVALID_DATA: 'invalidData',
  AVAILABLE: 'available',
})

function readAkashicResourceHistory(settings, getStore = defaultGetStore) {
  const integration = getIntegrationStatuses(settings, getStore).akashicRecords

  if (!integration.enabled) {
    return resourceHistoryResult(RESOURCE_HISTORY_STATES.DISABLED)
  }
  if (!integration.canRead) {
    const state = integration.state === INTEGRATION_STATES.LOADING
      ? RESOURCE_HISTORY_STATES.PLUGIN_NOT_READY
      : RESOURCE_HISTORY_STATES.PLUGIN_UNAVAILABLE
    return resourceHistoryResult(state)
  }

  let rows
  try {
    rows = getStore(AKASHIC_RESOURCE_DATA_PATH)
  } catch (_) {
    return resourceHistoryResult(RESOURCE_HISTORY_STATES.STATE_UNAVAILABLE)
  }
  if (!Array.isArray(rows)) {
    return resourceHistoryResult(RESOURCE_HISTORY_STATES.STATE_UNAVAILABLE)
  }

  const history = []
  for (const row of rows) {
    const normalized = normalizeResourceRow(row)
    if (normalized) history.push(normalized)
  }
  if (history.length > 0) {
    return resourceHistoryResult(RESOURCE_HISTORY_STATES.AVAILABLE, history)
  }
  return resourceHistoryResult(
    rows.length === 0
      ? RESOURCE_HISTORY_STATES.NO_HISTORY
      : RESOURCE_HISTORY_STATES.INVALID_DATA,
  )
}

function normalizeResourceRow(row) {
  if (!Array.isArray(row) || row.length < 9) return null

  const values = row.slice(0, 9).map(toFiniteNumber)
  if (values.some((value) => value === null)) return null

  return {
    timestamp: values[0],
    fuel: values[1],
    ammo: values[2],
    steel: values[3],
    bauxite: values[4],
    instantBuild: values[5],
    instantRepair: values[6],
    developmentMaterial: values[7],
    improvementMaterial: values[8],
  }
}

function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string' || value.trim() === '') return null

  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function resourceHistoryResult(state, history = []) {
  return { state, history }
}

function defaultGetStore(path) {
  if (typeof window !== 'undefined' && typeof window.getStore === 'function') {
    return window.getStore(path)
  }
  return undefined
}

module.exports = {
  AKASHIC_RESOURCE_DATA_PATH,
  RESOURCE_HISTORY_STATES,
  readAkashicResourceHistory,
}
