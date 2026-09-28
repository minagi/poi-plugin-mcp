const CANONICAL_WIDTH = 1200
const CANONICAL_HEIGHT = 720
const DRAG_MOVE_STEPS = 6
const DRAG_RELEASE_DELAY_MS = 120
const HOVER_MOVE_STEPS = 10
const HOVER_MOVE_STEP_DELAY_MS = 45
const HOVER_ENTRY_OFFSET_X = 44
const MAX_TEXT_LENGTH = 256
// One wheel detent (a physical mouse-wheel notch) is WHEEL_DELTA = 120 in
// Win32 terms; Chromium reports ~100-120 px of deltaY per notch on Windows
// default scroll settings. 120 per event is the Puppeteer/Playwright
// convention for "one notch" and matches what a real wheel delivers here.
const SCROLL_NOTCH_DELTA = 120
const DEFAULT_SCROLL_INTERVAL_MS = 40
const MIN_SCROLL_INTERVAL_MS = 20
const MAX_SCROLL_INTERVAL_MS = 200
const MAX_SCROLL_NOTCHES = 50

const SUPPORTED_BUTTONS = new Set(['left', 'middle', 'right'])
const SUPPORTED_KEY_EVENTS = new Set(['keyDown', 'keyUp'])
const SUPPORTED_KEYS = new Set([
  'Backspace',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'PageDown',
  'PageUp',
  'Space',
  'Tab',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
])

function createPoiInputProvider(options = {}) {
  const getStore = options.getStore || defaultGetStore
  const resolveWebContents =
    options.resolveWebContents || defaultResolveWebContents
  const delay = options.delay || defaultDelay

  return async function performPoiInput(operation) {
    validateOperationObject(operation)
    const layout = readLayout(getStore, resolveWebContents)
    // Live 2026-08-24: synthetic clicks reach the game and take effect in a
    // visible, non-focused window; they only stall when the window is
    // minimized/occluded and Chromium throttles the renderer (PIXI ticker
    // frozen). So: un-throttle the webContents, restore a minimized window,
    // and keep the document focused at the webContents level — never steal
    // the user's OS foreground (the Windows foreground lock silently ignored
    // the old win.focus() anyway).
    prepareGameWindowForInput(layout.webContents)

    switch (operation.operation) {
      case 'move':
        validateMove(operation)
        await sendMove(layout, operation, delay)
        return 'move'
      case 'click':
        validateClick(operation)
        sendClick(layout, operation)
        return 'click'
      case 'drag':
        validateDrag(operation)
        await sendDrag(layout, operation, delay)
        return 'drag'
      case 'scroll':
        validateScroll(operation)
        await sendScroll(layout, operation, delay)
        return 'scroll'
      case 'key':
        validateKey(operation)
        await layout.webContents.sendInputEvent({
          type: operation.event,
          keyCode: operation.key,
        })
        return 'key'
      case 'text':
        validateText(operation)
        for (const character of operation.text) {
          await layout.webContents.sendInputEvent({
            type: 'char',
            keyCode: character,
          })
        }
        return 'text'
      default:
        throw new Error(`Unsupported input operation: ${String(operation.operation)}`)
    }
  }
}

function validateOperationObject(operation) {
  if (
    !operation ||
    typeof operation !== 'object' ||
    Array.isArray(operation)
  ) {
    throw new Error('Input must be one operation object')
  }
}

function prepareGameWindowForInput(webContents) {
  try {
    if (typeof webContents.setBackgroundThrottling === 'function') {
      webContents.setBackgroundThrottling(false)
    }
  } catch (_throttleError) {
    // Throttling control is best-effort; input below is still delivered.
  }
  try {
    const { BrowserWindow } = require('electron')
    const win = BrowserWindow.fromWebContents(
      webContents.hostWebContents || webContents,
    )
    if (win && win.isMinimized()) {
      // Restoring resumes the throttled renderer; it does not need the
      // OS foreground for synthetic input to work (verified 2026-08-24).
      win.restore()
    }
  } catch (_windowError) {
    // Fall through to webContents-level focus below.
  }
  try {
    if (typeof webContents.focus === 'function') webContents.focus()
  } catch (_focusError) {
    // Input below is still delivered and may work without focus.
  }
}

function readLayout(getStore, resolveWebContents) {
  const layout = getStore('layout.webview')
  if (!layout || !layout.ref) {
    throw new Error('Poi game WebView is not ready')
  }
  if (
    !Number.isFinite(layout.width) ||
    layout.width <= 0 ||
    !Number.isFinite(layout.height) ||
    layout.height <= 0
  ) {
    throw new Error('Poi game WebView dimensions must be positive finite numbers')
  }
  let webContents
  if (typeof layout.ref.getWebContents === 'function') {
    webContents = layout.ref.getWebContents()
  } else if (typeof layout.ref.getWebContentsId === 'function') {
    const webContentsId = layout.ref.getWebContentsId()
    if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
      throw new Error('Poi game WebContents id is invalid')
    }
    webContents = resolveWebContents(webContentsId)
  } else {
    throw new Error('Poi game WebView is not ready')
  }
  if (!webContents || typeof webContents.sendInputEvent !== 'function') {
    throw new Error('Poi game WebContents is not ready')
  }
  return { ...layout, webContents }
}

function validateClick(operation) {
  assertExactFields(operation, ['operation', 'x', 'y', 'button'])
  if (!Number.isFinite(operation.x) || !Number.isFinite(operation.y)) {
    throw new Error('Click coordinates must be finite numbers')
  }
  if (
    operation.x < 0 ||
    operation.x >= CANONICAL_WIDTH ||
    operation.y < 0 ||
    operation.y >= CANONICAL_HEIGHT
  ) {
    throw new Error('Click coordinates must be within canonical bounds')
  }
  if (!SUPPORTED_BUTTONS.has(operation.button)) {
    throw new Error(`Unsupported mouse button: ${String(operation.button)}`)
  }
}

function validateMove(operation) {
  const hasOriginX = operation.fromX !== undefined
  const hasOriginY = operation.fromY !== undefined
  if (hasOriginX !== hasOriginY) {
    throw new Error('Move origin coordinates must be provided together')
  }
  assertExactFields(
    operation,
    hasOriginX
      ? ['operation', 'x', 'y', 'fromX', 'fromY']
      : ['operation', 'x', 'y'],
  )
  const xCoordinates = hasOriginX
    ? [operation.x, operation.fromX]
    : [operation.x]
  const yCoordinates = hasOriginY
    ? [operation.y, operation.fromY]
    : [operation.y]
  if (
    xCoordinates
      .concat(yCoordinates)
      .some((coordinate) => !Number.isFinite(coordinate))
  ) {
    throw new Error('Move coordinates must be finite numbers')
  }
  if (
    xCoordinates.some(
      (coordinate) => coordinate < 0 || coordinate >= CANONICAL_WIDTH,
    ) ||
    yCoordinates.some(
      (coordinate) => coordinate < 0 || coordinate >= CANONICAL_HEIGHT,
    )
  ) {
    throw new Error('Move coordinates must be within canonical bounds')
  }
}

function validateDrag(operation) {
  assertExactFields(operation, [
    'operation',
    'fromX',
    'fromY',
    'toX',
    'toY',
    'durationMs',
    'button',
  ])
  const coordinates = [
    operation.fromX,
    operation.fromY,
    operation.toX,
    operation.toY,
  ]
  if (coordinates.some((coordinate) => !Number.isFinite(coordinate))) {
    throw new Error('Drag coordinates must be finite numbers')
  }
  if (
    operation.fromX < 0 ||
    operation.fromX >= CANONICAL_WIDTH ||
    operation.toX < 0 ||
    operation.toX >= CANONICAL_WIDTH ||
    operation.fromY < 0 ||
    operation.fromY >= CANONICAL_HEIGHT ||
    operation.toY < 0 ||
    operation.toY >= CANONICAL_HEIGHT
  ) {
    throw new Error('Drag coordinates must be within canonical bounds')
  }
  if (!Number.isInteger(operation.durationMs)) {
    throw new Error('Drag durationMs must be an integer')
  }
  if (operation.durationMs < 50 || operation.durationMs > 2000) {
    throw new Error('Drag durationMs must be from 50 to 2000')
  }
  if (!SUPPORTED_BUTTONS.has(operation.button)) {
    throw new Error(`Unsupported mouse button: ${String(operation.button)}`)
  }
}

function validateScroll(operation) {
  const hasInterval = operation.intervalMs !== undefined
  assertExactFields(
    operation,
    hasInterval
      ? ['operation', 'x', 'y', 'notches', 'intervalMs']
      : ['operation', 'x', 'y', 'notches'],
  )
  if (!Number.isFinite(operation.x) || !Number.isFinite(operation.y)) {
    throw new Error('Scroll coordinates must be finite numbers')
  }
  if (
    operation.x < 0 ||
    operation.x >= CANONICAL_WIDTH ||
    operation.y < 0 ||
    operation.y >= CANONICAL_HEIGHT
  ) {
    throw new Error('Scroll coordinates must be within canonical bounds')
  }
  if (!Number.isInteger(operation.notches) || operation.notches === 0) {
    throw new Error('Scroll notches must be a non-zero integer')
  }
  if (Math.abs(operation.notches) > MAX_SCROLL_NOTCHES) {
    throw new Error(
      `Scroll notches must be from -${MAX_SCROLL_NOTCHES} to ${MAX_SCROLL_NOTCHES}`,
    )
  }
  if (
    hasInterval &&
    (!Number.isInteger(operation.intervalMs) ||
      operation.intervalMs < MIN_SCROLL_INTERVAL_MS ||
      operation.intervalMs > MAX_SCROLL_INTERVAL_MS)
  ) {
    throw new Error(
      `Scroll intervalMs must be an integer from ${MIN_SCROLL_INTERVAL_MS} to ${MAX_SCROLL_INTERVAL_MS}`,
    )
  }
}

function validateKey(operation) {
  assertExactFields(operation, ['operation', 'event', 'key'])
  if (!SUPPORTED_KEY_EVENTS.has(operation.event)) {
    throw new Error(`Unsupported key event: ${String(operation.event)}`)
  }
  if (!SUPPORTED_KEYS.has(operation.key)) {
    throw new Error(`Unsupported key: ${String(operation.key)}`)
  }
}

function validateText(operation) {
  assertExactFields(operation, ['operation', 'text'])
  if (
    typeof operation.text !== 'string' ||
    operation.text.length === 0 ||
    operation.text.length > MAX_TEXT_LENGTH
  ) {
    throw new Error('Literal text must contain 1 to 256 characters')
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(operation.text)) {
    throw new Error('Literal text must contain printable characters only')
  }
}

function assertExactFields(operation, allowedFields) {
  const allowed = new Set(allowedFields)
  const unexpected = Object.keys(operation).find((field) => !allowed.has(field))
  if (unexpected) {
    throw new Error(`Unexpected field for ${operation.operation}: ${unexpected}`)
  }
  const missing = allowedFields.find((field) => !Object.hasOwn(operation, field))
  if (missing) {
    throw new Error(`Missing field for ${operation.operation}: ${missing}`)
  }
}

async function sendMove(layout, operation, delay) {
  const destination = {
    x: Math.floor((operation.x * layout.width) / CANONICAL_WIDTH),
    y: Math.floor((operation.y * layout.height) / CANONICAL_HEIGHT),
  }
  // poi-plugin-kancolle-assistant's sendFocusedMouseMove (poi mode) feeds
  // PIXI's interaction state machine a pointermove sequence arriving across
  // frames; a single mouseEnter + mouseMove teleport never promotes hover
  // (the 0921 equipment-filter calibration hit exactly that). Glide in from
  // an explicit origin — or ~44 px left of the target — then park on it: a
  // hover must persist, so no (0, 0) reset afterwards.
  const originX =
    operation.fromX !== undefined
      ? operation.fromX
      : Math.max(0, operation.x - HOVER_ENTRY_OFFSET_X)
  const originY = operation.fromY !== undefined ? operation.fromY : operation.y
  const start = {
    x: Math.floor((originX * layout.width) / CANONICAL_WIDTH),
    y: Math.floor((originY * layout.height) / CANONICAL_HEIGHT),
  }
  layout.webContents.sendInputEvent({ type: 'mouseEnter', x: start.x, y: start.y })
  let previousX = start.x
  let previousY = start.y
  for (let step = 1; step <= HOVER_MOVE_STEPS; step += 1) {
    await delay(HOVER_MOVE_STEP_DELAY_MS)
    const x = Math.round(
      start.x + ((destination.x - start.x) * step) / HOVER_MOVE_STEPS,
    )
    const y = Math.round(
      start.y + ((destination.y - start.y) * step) / HOVER_MOVE_STEPS,
    )
    await layout.webContents.sendInputEvent({
      type: 'mouseMove',
      x,
      y,
      movementX: x - previousX,
      movementY: y - previousY,
    })
    previousX = x
    previousY = y
  }
}

function sendClick(layout, operation) {
  const point = {
    x: Math.floor((operation.x * layout.width) / CANONICAL_WIDTH),
    y: Math.floor((operation.y * layout.height) / CANONICAL_HEIGHT),
    button: operation.button,
  }

  // Match poi-plugin-kancolle-assistant's long-running browser click sequence.
  layout.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  layout.webContents.sendInputEvent({
    type: 'mouseDown',
    ...point,
    clickCount: 3,
  })
  layout.webContents.sendInputEvent({ type: 'mouseUp', ...point, clickCount: 3 })
  layout.webContents.sendInputEvent({
    type: 'mouseMove',
    x: 0,
    y: 0,
    button: operation.button,
  })
}

async function sendDrag(layout, operation, delay) {
  const start = {
    x: Math.floor((operation.fromX * layout.width) / CANONICAL_WIDTH),
    y: Math.floor((operation.fromY * layout.height) / CANONICAL_HEIGHT),
  }
  const destination = {
    x: Math.floor((operation.toX * layout.width) / CANONICAL_WIDTH),
    y: Math.floor((operation.toY * layout.height) / CANONICAL_HEIGHT),
  }
  const mouseButton = { button: operation.button }

  sendPointerEnterAndMove(layout.webContents, start)
  try {
    await layout.webContents.sendInputEvent({
      type: 'mouseDown',
      ...start,
      ...mouseButton,
      clickCount: 1,
    })
    let previousX = start.x
    let previousY = start.y
    for (let step = 1; step <= DRAG_MOVE_STEPS; step += 1) {
      const elapsed = Math.round((operation.durationMs * step) / DRAG_MOVE_STEPS)
      const previousElapsed = Math.round(
        (operation.durationMs * (step - 1)) / DRAG_MOVE_STEPS,
      )
      await delay(elapsed - previousElapsed)
      const x = Math.round(
        start.x + ((destination.x - start.x) * step) / DRAG_MOVE_STEPS,
      )
      const y = Math.round(
        start.y + ((destination.y - start.y) * step) / DRAG_MOVE_STEPS,
      )
      await layout.webContents.sendInputEvent({
        type: 'mouseMove',
        x,
        y,
        movementX: x - previousX,
        movementY: y - previousY,
        ...mouseButton,
      })
      previousX = x
      previousY = y
    }
    // The game's drag targets (e.g. the organization fleet tab combine drag)
    // require a short hold at the destination before the release; releasing
    // in the same tick as the last move drops the gesture (verified against
    // poi-plugin-kancolle-assistant's mouseMove drag implementation).
    await delay(DRAG_RELEASE_DELAY_MS)
  } finally {
    await layout.webContents.sendInputEvent({
      type: 'mouseUp',
      ...destination,
      ...mouseButton,
      clickCount: 1,
    })
  }
}

function sendPointerEnterAndMove(webContents, point) {
  webContents.sendInputEvent({ type: 'mouseEnter', x: point.x, y: point.y })
  webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
}

async function sendScroll(layout, operation, delay) {
  const point = {
    x: Math.floor((operation.x * layout.width) / CANONICAL_WIDTH),
    y: Math.floor((operation.y * layout.height) / CANONICAL_HEIGHT),
  }
  const direction = operation.notches > 0 ? 1 : -1
  const intervalMs =
    operation.intervalMs === undefined
      ? DEFAULT_SCROLL_INTERVAL_MS
      : operation.intervalMs
  // Wheel targets hit-test at the pointer, so park the cursor on the point
  // first (the same enter+move the drag gesture uses); one mouseWheel event
  // per notch keeps each detent a discrete event for handlers that quantize
  // per event — a single notches*120 mega-delta can be clamped or swallowed.
  sendPointerEnterAndMove(layout.webContents, point)
  for (let index = 0; index < Math.abs(operation.notches); index += 1) {
    if (index > 0) {
      await delay(intervalMs)
    }
    await layout.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: direction * SCROLL_NOTCH_DELTA,
    })
  }
}

function defaultDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function defaultGetStore(path) {
  if (typeof window !== 'undefined' && typeof window.getStore === 'function') {
    return window.getStore(path)
  }
  return null
}

function defaultResolveWebContents(webContentsId) {
  const { webContents } = require('@electron/remote')
  return webContents.fromId(webContentsId)
}

module.exports = {
  CANONICAL_HEIGHT,
  CANONICAL_WIDTH,
  MAX_TEXT_LENGTH,
  createPoiInputProvider,
}
