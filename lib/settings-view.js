const ENGLISH_TRANSLATIONS = require('../i18n/en-US.json')
const { getIntegrationStatuses, INTEGRATION_DEFINITIONS } = require('./integrations')

function loadReact() {
  try {
    return require('react')
  } catch (_) {
    if (typeof window !== 'undefined' && window.React) return window.React
    return null
  }
}

function loadI18next() {
  try {
    const loaded = require('views/env-parts/i18next')
    return loaded && loaded.default ? loaded.default : loaded
  } catch (_) {
    if (typeof window !== 'undefined' && window.i18next) return window.i18next
    return null
  }
}

function createTranslator(i18next = loadI18next()) {
  const fixedT = i18next && typeof i18next.getFixedT === 'function'
    ? i18next.getFixedT(null, 'mcp_data_bridge')
    : null

  return (key, values = {}) => {
    const fallback = readTranslation(ENGLISH_TRANSLATIONS, key) || key
    if (fixedT) {
      const translated = fixedT(key, { defaultValue: fallback, ...values })
      if (typeof translated === 'string' && translated !== key) return translated
    }
    return interpolate(fallback, values)
  }
}

function createSettingsClass(controller) {
  return function PoiMcpSettings() {
    const React = loadReact()
    const t = createTranslator()

    if (React && React.useState) {
      return renderStatefulSettings(React, controller, t)
    }

    return renderStaticSettings(createFallbackElement, controller, t)
  }
}

function renderStatefulSettings(React, controller, t) {
  const e = React.createElement
  const [status, setStatus] = React.useState(() => getSettingsStatus(controller))
  const [portText, setPortText] = React.useState(() => String(status.port))
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')

  React.useEffect(() => startStatusPolling(controller, setStatus), [controller])

  async function run(action, successMessage) {
    setBusy(true)
    setMessage('')
    try {
      await action()
      const nextStatus = getSettingsStatus(controller)
      setStatus(nextStatus)
      setPortText(String(nextStatus.port))
      setMessage(successMessage)
    } catch (error) {
      setMessage(error && error.message ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const port = Number(portText)
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535

  return renderSettings(e, {
    busy,
    message,
    port,
    portText,
    status,
    t,
    validPort,
    onPortChange: (event) => setPortText(event.target.value),
    onApply: () => run(
      () => controller.applySettings({
        port,
        enabled: status.enabled,
        inputEnabled: status.inputEnabled,
        recordingEnabled: status.recordingEnabled,
        debugEvalEnabled: status.debugEvalEnabled,
      }),
      t('settings.port.saved'),
    ),
    onInputToggle: (event) => {
      const inputEnabled = event.target.checked
      return run(
        () => controller.applySettings({ inputEnabled }),
        t(inputEnabled ? 'settings.input.enabledMessage' : 'settings.input.disabledMessage'),
      )
    },
    onRecordingToggle: (event) => {
      const recordingEnabled = event.target.checked
      return run(
        () => controller.applySettings({ recordingEnabled }),
        t(
          recordingEnabled
            ? 'settings.recording.enabledMessage'
            : 'settings.recording.disabledMessage',
        ),
      )
    },
    onDebugEvalToggle: (event) => {
      const debugEvalEnabled = event.target.checked
      return run(
        () => controller.applySettings({ debugEvalEnabled }),
        t(
          debugEvalEnabled
            ? 'settings.debugEval.enabledMessage'
            : 'settings.debugEval.disabledMessage',
        ),
      )
    },
    onIntegrationToggle: (key, event) => {
      const enabled = event.target.checked
      const definition = INTEGRATION_DEFINITIONS.find((entry) => entry.key === key)
      const name = definition ? t(`${definition.translationKey}.name`) : key
      return run(
        () => controller.applySettings({
          integrations: { [key]: { enabled } },
        }),
        t(enabled ? 'integrations.enabledMessage' : 'integrations.disabledMessage', { name }),
      )
    },
    onToggle: () => run(
      () => (status.running ? controller.stopBridge() : controller.startBridge()),
      t(status.running ? 'settings.service.stopped' : 'settings.service.started'),
    ),
  })
}

function startStatusPolling(controller, setStatus, options = {}) {
  const setIntervalFn = options.setInterval || setInterval
  const clearIntervalFn = options.clearInterval || clearInterval
  const timer = setIntervalFn(() => {
    setStatus(getSettingsStatus(controller))
  }, 1000)
  return () => clearIntervalFn(timer)
}

function renderStaticSettings(e, controller, t) {
  const status = getSettingsStatus(controller)
  const port = status.port

  return renderSettings(e, {
    busy: false,
    message: '',
    port,
    portText: String(port),
    status,
    t,
    validPort: true,
    onPortChange: null,
    onApply: async () => {
      const input = typeof document !== 'undefined' ? document.getElementById('poi-mcp-port') : null
      const nextPort = input && 'value' in input ? Number(input.value) : port
      await controller.applySettings({
        port: nextPort,
        enabled: status.enabled,
        inputEnabled: status.inputEnabled,
        recordingEnabled: status.recordingEnabled,
        debugEvalEnabled: status.debugEvalEnabled,
      })
    },
    onInputToggle: (event) => controller.applySettings({
      port,
      enabled: status.enabled,
      inputEnabled: event.target.checked,
      recordingEnabled: status.recordingEnabled,
      debugEvalEnabled: status.debugEvalEnabled,
    }),
    onRecordingToggle: (event) => controller.applySettings({
      port,
      enabled: status.enabled,
      inputEnabled: status.inputEnabled,
      recordingEnabled: event.target.checked,
      debugEvalEnabled: status.debugEvalEnabled,
    }),
    onDebugEvalToggle: (event) => controller.applySettings({
      port,
      enabled: status.enabled,
      inputEnabled: status.inputEnabled,
      recordingEnabled: status.recordingEnabled,
      debugEvalEnabled: event.target.checked,
    }),
    onIntegrationToggle: (key, event) => controller.applySettings({
      integrations: { [key]: { enabled: event.target.checked } },
    }),
    onToggle: () => (status.running ? controller.stopBridge() : controller.startBridge()),
  })
}

function getSettingsStatus(controller) {
  return {
    ...controller.getStatus(),
    integrations: getIntegrationStatuses(controller.getSettings()),
  }
}

function renderSettings(e, props) {
  const t = props.t
  const statusText = props.status.running
    ? t('settings.service.running', { port: props.status.actualPort })
    : t('settings.service.notRunning')

  return e('div', { style: styles.root },
    e('h4', { style: styles.sectionTitle }, t('settings.sections.service')),
    e('div', { style: styles.row },
      e('label', { style: styles.label, htmlFor: 'poi-mcp-port' }, t('settings.port.label')),
      e('input', {
        id: 'poi-mcp-port',
        type: 'number',
        min: 1,
        max: 65535,
        value: props.onPortChange ? props.portText : undefined,
        defaultValue: props.onPortChange ? undefined : props.portText,
        disabled: props.busy,
        style: styles.input,
        onChange: props.onPortChange,
      }),
      e('button', {
        type: 'button',
        disabled: props.busy || !props.validPort,
        style: styles.button,
        onClick: props.onApply,
      }, t('settings.port.apply')),
      e('span', { style: styles.description }, t('settings.port.description')),
    ),
    e('div', { style: styles.row },
      e('span', { style: styles.label }, t('settings.service.label')),
      e('button', {
        type: 'button',
        disabled: props.busy,
        style: styles.button,
        onClick: props.onToggle,
      }, t(props.status.running ? 'settings.service.stop' : 'settings.service.start')),
      e('span', { style: styles.status }, statusText),
      e('span', { style: styles.description }, t('settings.service.description')),
    ),
    e('h4', { style: styles.sectionTitle }, t('settings.sections.input')),
    e('div', { style: styles.inputRow },
      e('label', { style: styles.label, htmlFor: 'poi-mcp-input-enabled' },
        t('settings.input.label')),
      e('input', {
        id: 'poi-mcp-input-enabled',
        type: 'checkbox',
        checked: props.onPortChange ? props.status.inputEnabled : undefined,
        defaultChecked: props.onPortChange ? undefined : props.status.inputEnabled,
        disabled: props.busy,
        onChange: props.onInputToggle,
      }),
      e('span', { style: styles.status },
        t(props.status.inputEnabled ? 'settings.input.enabled' : 'settings.input.disabled'),
      ),
      e('span', { style: styles.description }, t('settings.input.description')),
    ),
    e('div', { style: styles.inputRow },
      e('label', { style: styles.label, htmlFor: 'poi-mcp-recording-enabled' },
        t('settings.recording.label')),
      e('input', {
        id: 'poi-mcp-recording-enabled',
        type: 'checkbox',
        checked: props.onPortChange ? props.status.recordingEnabled : undefined,
        defaultChecked: props.onPortChange ? undefined : props.status.recordingEnabled,
        disabled: props.busy,
        onChange: props.onRecordingToggle,
      }),
      e('span', { style: styles.status }, recordingStatusText(props.status, t)),
      e('span', { style: styles.description }, t('settings.recording.description')),
    ),
    props.status.recordingSessionDir
      ? e('div', { style: styles.note }, t('settings.recording.path', {
        path: props.status.recordingSessionDir,
      }))
      : null,
    e('div', { style: styles.warningRow },
      e('label', {
        style: styles.label,
        htmlFor: 'poi-mcp-debug-eval-enabled',
      }, t('settings.debugEval.label')),
      e('input', {
        id: 'poi-mcp-debug-eval-enabled',
        type: 'checkbox',
        checked: props.onPortChange ? props.status.debugEvalEnabled : undefined,
        defaultChecked: props.onPortChange
          ? undefined
          : props.status.debugEvalEnabled,
        disabled: props.busy,
        onChange: props.onDebugEvalToggle,
      }),
      e('span', { style: props.status.debugEvalEnabled ? styles.warning : styles.status },
        t(
          props.status.debugEvalEnabled
            ? 'settings.debugEval.enabled'
            : 'settings.debugEval.disabled',
        ),
      ),
      e('span', { style: styles.description }, t('settings.debugEval.description')),
    ),
    e('h4', { style: styles.sectionTitle }, t('settings.sections.integrations')),
    ...INTEGRATION_DEFINITIONS.flatMap((definition) => renderIntegration(e, props, definition)),
    props.message ? e('div', { style: styles.message }, props.message) : null,
  )
}

function renderIntegration(e, props, definition) {
  const t = props.t
  const status = props.status.integrations && props.status.integrations[definition.key]
    ? props.status.integrations[definition.key]
    : { enabled: false, state: 'loading', version: null }
  const stateText = t(`integrations.status.${status.state}`)
  const version = status.version ? ` (${status.version})` : ''

  return [
    e('div', { key: `${definition.key}-row`, style: styles.row },
      e('label', {
        style: styles.integrationLabel,
        htmlFor: `poi-mcp-integration-${definition.key}`,
      }, t(`${definition.translationKey}.name`)),
      e('label', { style: styles.toggleLabel },
        e('input', {
          id: `poi-mcp-integration-${definition.key}`,
          type: 'checkbox',
          checked: props.onPortChange ? status.enabled : undefined,
          defaultChecked: props.onPortChange ? undefined : status.enabled,
          disabled: props.busy,
          onChange: (event) => props.onIntegrationToggle(definition.key, event),
        }),
        e('span', null, t('integrations.use')),
      ),
      e('span', { style: integrationStatusStyle(status.state) }, `${stateText}${version}`),
      e('span', { style: styles.description },
        t(`${definition.translationKey}.description`)),
    ),
  ]
}

function recordingStatusText(status, t) {
  if (status.recordingLimitReached) {
    return t('settings.recording.paused', {
      reason: status.recordingLimitReached.message || status.recordingLimitReached.reason,
    })
  }
  if (status.recording) return t('settings.recording.recording')
  if (status.recordingStarting) return t('settings.recording.starting')
  if (status.recordingArmed) {
    return t(status.recordingAttached ? 'settings.recording.armed' : 'settings.recording.waiting')
  }
  return t('settings.recording.disabled')
}

function integrationStatusStyle(state) {
  if (state === 'detected') return { ...styles.integrationStatus, color: '#238636' }
  if (state === 'error') return { ...styles.integrationStatus, color: '#cf222e' }
  if (state === 'notDetected') return { ...styles.integrationStatus, color: '#9a6700' }
  return styles.integrationStatus
}

function readTranslation(resources, key) {
  let value = resources
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object') return undefined
    value = value[part]
  }
  return typeof value === 'string' ? value : undefined
}

function interpolate(template, values) {
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/gu, (_match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : ''
  ))
}

function createFallbackElement(type, props, ...children) {
  const nextProps = { ...(props || {}) }
  if (children.length === 1) nextProps.children = children[0]
  if (children.length > 1) nextProps.children = children

  return {
    $$typeof: Symbol.for('react.element'),
    type,
    key: nextProps.key == null ? null : String(nextProps.key),
    ref: nextProps.ref == null ? null : nextProps.ref,
    props: nextProps,
    _owner: null,
  }
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    maxWidth: 960,
    width: '100%',
  },
  sectionTitle: {
    borderTop: '1px solid rgba(127, 127, 127, 0.28)',
    fontSize: 14,
    margin: '4px 0 0',
    paddingTop: 6,
  },
  row: {
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 10px',
    minHeight: 24,
  },
  inputRow: {
    alignItems: 'center',
    columnGap: 10,
    display: 'grid',
    gridTemplateColumns: '110px 20px minmax(150px, 220px) minmax(0, 1fr)',
    minHeight: 24,
    rowGap: 4,
  },
  warningRow: {
    alignItems: 'center',
    borderRadius: 4,
    boxShadow: '0 0 0 1px #cf222e',
    columnGap: 10,
    display: 'grid',
    gridTemplateColumns: '110px 20px minmax(150px, 220px) minmax(0, 1fr)',
    minHeight: 24,
    padding: '5px 0',
    rowGap: 4,
  },
  label: {
    flex: '0 0 110px',
    fontWeight: 600,
  },
  integrationLabel: {
    flex: '0 1 210px',
    fontWeight: 600,
  },
  toggleLabel: {
    alignItems: 'center',
    display: 'inline-flex',
    gap: 5,
    whiteSpace: 'nowrap',
  },
  input: {
    width: 120,
  },
  button: {
    minWidth: 72,
  },
  status: {
    color: '#59636e',
    fontSize: 12,
    whiteSpace: 'nowrap',
  },
  integrationStatus: {
    color: '#59636e',
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  warning: {
    color: '#cf222e',
    fontSize: 12,
    fontWeight: 600,
  },
  description: {
    color: '#59636e',
    flex: '1 1 280px',
    fontSize: 12,
    lineHeight: 1.4,
  },
  note: {
    color: '#59636e',
    fontSize: 12,
    lineHeight: 1.4,
    overflowWrap: 'anywhere',
  },
  message: {
    color: '#1f6feb',
    fontSize: 12,
  },
}

module.exports = {
  createSettingsClass,
  createTranslator,
  startStatusPolling,
}
