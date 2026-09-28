function loadReact() {
  try {
    return require('react')
  } catch (_) {
    if (typeof window !== 'undefined' && window.React) return window.React
    return null
  }
}

function createSettingsClass(controller) {
  return function PoiMcpSettings() {
    const React = loadReact()

    if (React && React.useState) {
      return renderStatefulSettings(React, controller)
    }

    return renderStaticSettings(createFallbackElement, controller)
  }
}

function renderStatefulSettings(React, controller) {
  const e = React.createElement
  const [status, setStatus] = React.useState(() => controller.getStatus())
  const [portText, setPortText] = React.useState(() => String(status.port))
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')

  React.useEffect(() => startStatusPolling(controller, setStatus), [controller])

  async function run(action, successMessage) {
    setBusy(true)
    setMessage('')
    try {
      await action()
      const nextStatus = controller.getStatus()
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
      'Port saved',
    ),
    onInputToggle: (event) => {
      const inputEnabled = event.target.checked
      return run(
        () => controller.applySettings({ inputEnabled }),
        inputEnabled ? 'WebView input enabled' : 'WebView input disabled',
      )
    },
    onRecordingToggle: (event) => {
      const recordingEnabled = event.target.checked
      return run(
        () => controller.applySettings({ recordingEnabled }),
        recordingEnabled ? 'Play recording enabled' : 'Play recording disabled',
      )
    },
    onDebugEvalToggle: (event) => {
      const debugEvalEnabled = event.target.checked
      return run(
        () => controller.applySettings({ debugEvalEnabled }),
        debugEvalEnabled
          ? 'Dangerous WebView eval enabled'
          : 'Dangerous WebView eval disabled',
      )
    },
    onToggle: () => run(
      () => (status.running ? controller.stopBridge() : controller.startBridge()),
      status.running ? 'Stopped' : 'Started',
    ),
  })
}

function startStatusPolling(controller, setStatus, options = {}) {
  const setIntervalFn = options.setInterval || setInterval
  const clearIntervalFn = options.clearInterval || clearInterval
  const timer = setIntervalFn(() => {
    setStatus(controller.getStatus())
  }, 1000)
  return () => clearIntervalFn(timer)
}

function renderStaticSettings(e, controller) {
  const status = controller.getStatus()
  const port = status.port

  return renderSettings(e, {
    busy: false,
    message: '',
    port,
    portText: String(port),
    status,
    validPort: true,
    onPortChange: null,
    onApply: async () => {
      const input = typeof document !== 'undefined' ? document.getElementById('poi-mcp-port') : null
      const nextPort = input ? Number(input.value) : port
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
    onToggle: () => (status.running ? controller.stopBridge() : controller.startBridge()),
  })
}

function renderSettings(e, props) {
  const statusText = props.status.running
    ? `Running on 127.0.0.1:${props.status.actualPort}`
    : 'Stopped'

  return e('div', { style: styles.root },
    e('div', { style: styles.row },
      e('label', { style: styles.label, htmlFor: 'poi-mcp-port' }, 'Port'),
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
      }, 'Apply'),
    ),
    e('div', { style: styles.row },
      e('span', { style: styles.label }, 'Service'),
      e('button', {
        type: 'button',
        disabled: props.busy,
        style: styles.button,
        onClick: props.onToggle,
      }, props.status.running ? 'Stop' : 'Start'),
      e('span', { style: styles.status }, statusText),
    ),
    e('div', { style: styles.row },
      e('label', { style: styles.label, htmlFor: 'poi-mcp-input-enabled' }, 'WebView input'),
      e('input', {
        id: 'poi-mcp-input-enabled',
        type: 'checkbox',
        checked: props.onPortChange ? props.status.inputEnabled : undefined,
        defaultChecked: props.onPortChange ? undefined : props.status.inputEnabled,
        disabled: props.busy,
        onChange: props.onInputToggle,
      }),
      e('span', { style: styles.status },
        props.status.inputEnabled ? 'Enabled' : 'Disabled',
      ),
    ),
    e('div', { style: styles.row },
      e('label', { style: styles.label, htmlFor: 'poi-mcp-recording-enabled' }, 'Record play'),
      e('input', {
        id: 'poi-mcp-recording-enabled',
        type: 'checkbox',
        checked: props.onPortChange ? props.status.recordingEnabled : undefined,
        defaultChecked: props.onPortChange ? undefined : props.status.recordingEnabled,
        disabled: props.busy,
        onChange: props.onRecordingToggle,
      }),
      e('span', { style: styles.status },
        props.status.recordingLimitReached
          ? `Paused: ${
            props.status.recordingLimitReached.message ||
            props.status.recordingLimitReached.reason
          }`
          : props.status.recording
            ? 'Recording - splits after 5 min idle'
            : props.status.recordingStarting
              ? 'Starting recording session'
              : props.status.recordingArmed
                ? props.status.recordingAttached
                  ? 'Armed - starts on game mouse activity'
                  : 'Armed - waiting for game WebView'
                : 'Disabled',
      ),
    ),
    props.status.recordingSessionDir
      ? e('div', { style: styles.note }, `Recording: ${props.status.recordingSessionDir}`)
      : null,
    e('div', { style: styles.warningRow },
      e('label', {
        style: styles.label,
        htmlFor: 'poi-mcp-debug-eval-enabled',
      }, 'Debug eval'),
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
      e('span', { style: styles.warning },
        props.status.debugEvalEnabled
          ? 'DANGEROUS: authenticated arbitrary code can run in the game WebView'
          : 'Disabled (recommended)',
      ),
    ),
    e('div', { style: styles.note },
      'Pi extension defaults to 127.0.0.1:17777; keep this port unless you also update Pi.',
    ),
    props.message ? e('div', { style: styles.message }, props.message) : null,
  )
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
    gap: 12,
    maxWidth: 560,
  },
  row: {
    alignItems: 'center',
    display: 'flex',
    gap: 8,
  },
  warningRow: {
    alignItems: 'center',
    display: 'flex',
    gap: 8,
    padding: 8,
    border: '1px solid #cf222e',
    borderRadius: 4,
  },
  label: {
    flex: '0 0 80px',
    fontWeight: 600,
  },
  input: {
    width: 120,
  },
  button: {
    minWidth: 72,
  },
  status: {
    color: '#59636e',
  },
  warning: {
    color: '#cf222e',
    fontSize: 12,
    fontWeight: 600,
  },
  note: {
    color: '#59636e',
    fontSize: 12,
    lineHeight: 1.4,
  },
  message: {
    color: '#1f6feb',
    fontSize: 12,
  },
}

module.exports = {
  createSettingsClass,
  startStatusPolling,
}
