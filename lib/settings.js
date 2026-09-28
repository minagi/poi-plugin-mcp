const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_SETTINGS = Object.freeze({
  port: 17777,
  enabled: true,
  inputEnabled: false,
  recordingEnabled: false,
  debugEvalEnabled: false,
  // 2026-09-12 Phase C: when true, INPUT endpoints (/input, /input/lease*,
  // /debug/evaluate) require a registered X-Writer-Token in addition to the
  // static bearer. Observation mode (false) serves legacy static-bearer
  // requests but counts them — the daemon registers tokens and sends them
  // either way, so flipping this only rejects leftovers.
  writerTokenEnforced: false,
})

const DEFAULT_SETTINGS_FILE = path.join(os.homedir(), '.poi-mcp', 'settings.json')

function normalizeSettings(input = {}) {
  const port = normalizePort(input.port)
  return {
    port: port == null ? DEFAULT_SETTINGS.port : port,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_SETTINGS.enabled,
    inputEnabled: typeof input.inputEnabled === 'boolean'
      ? input.inputEnabled
      : DEFAULT_SETTINGS.inputEnabled,
    recordingEnabled: typeof input.recordingEnabled === 'boolean'
      ? input.recordingEnabled
      : DEFAULT_SETTINGS.recordingEnabled,
    debugEvalEnabled: typeof input.debugEvalEnabled === 'boolean'
      ? input.debugEvalEnabled
      : DEFAULT_SETTINGS.debugEvalEnabled,
    writerTokenEnforced: typeof input.writerTokenEnforced === 'boolean'
      ? input.writerTokenEnforced
      : DEFAULT_SETTINGS.writerTokenEnforced,
  }
}

function normalizePort(value) {
  if (value == null || value === '') return null

  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

function loadSettings(settingsPath = DEFAULT_SETTINGS_FILE) {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8')
    return normalizeSettings(JSON.parse(raw))
  } catch (_) {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(settings, settingsPath = DEFAULT_SETTINGS_FILE) {
  const normalized = normalizeSettings(settings)
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_SETTINGS_FILE,
  loadSettings,
  normalizePort,
  normalizeSettings,
  saveSettings,
}
