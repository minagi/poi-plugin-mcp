const DEFAULT_MAX_BASE64_LENGTH = 16 * 1024 * 1024

function createPoiScreenshotProvider(options = {}) {
  const getStore = options.getStore || defaultGetStore
  const ipcRenderer = options.ipcRenderer || require('electron').ipcRenderer
  const devicePixelRatio = options.devicePixelRatio == null
    ? defaultDevicePixelRatio()
    : options.devicePixelRatio
  const now = options.now || (() => new Date())
  const maxBase64Length = options.maxBase64Length == null
    ? DEFAULT_MAX_BASE64_LENGTH
    : options.maxBase64Length

  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new Error('devicePixelRatio must be a positive finite number')
  }
  if (!Number.isInteger(maxBase64Length) || maxBase64Length <= 0) {
    throw new Error('maxBase64Length must be a positive integer')
  }

  return async function capturePoiScreenshot() {
    const layout = getStore('layout.webview')
    if (
      !layout ||
      !layout.ref ||
      typeof layout.ref.getWebContentsId !== 'function'
    ) {
      throw new Error('Poi game WebView is not ready')
    }
    if (
      !Number.isInteger(layout.width) ||
      layout.width <= 0 ||
      !Number.isInteger(layout.height) ||
      layout.height <= 0
    ) {
      throw new Error('Poi game WebView dimensions must be positive integers')
    }

    const webContentsId = layout.ref.getWebContentsId()
    if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
      throw new Error('Poi game WebContents id is invalid')
    }

    const rect = {
      x: 0,
      y: 0,
      width: Math.floor(layout.width * devicePixelRatio),
      height: Math.floor(layout.height * devicePixelRatio),
    }
    const actualSize = {
      width: layout.width,
      height: layout.height,
    }
    const dataUrl = await ipcRenderer.invoke(
      'screenshot::get',
      webContentsId,
      rect,
      actualSize,
    )
    const prefix = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
      throw new Error('Poi screenshot did not return a PNG data URL')
    }

    const dataBase64 = dataUrl.slice(prefix.length)
    if (
      dataBase64.length === 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
    ) {
      throw new Error('Poi screenshot returned invalid base64 data')
    }
    if (dataBase64.length > maxBase64Length) {
      throw new Error(`Poi screenshot exceeds ${maxBase64Length} base64 characters`)
    }

    return {
      capturedAt: now().toISOString(),
      mimeType: 'image/png',
      dataBase64,
    }
  }
}

function defaultGetStore(path) {
  if (typeof window !== 'undefined' && typeof window.getStore === 'function') {
    return window.getStore(path)
  }
  return null
}

function defaultDevicePixelRatio() {
  if (
    typeof window !== 'undefined' &&
    Number.isFinite(window.devicePixelRatio) &&
    window.devicePixelRatio > 0
  ) {
    return window.devicePixelRatio
  }
  return 1
}

module.exports = {
  createPoiScreenshotProvider,
}
