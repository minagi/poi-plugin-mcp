'use strict'

/**
 * Per-click PIXI hit ledger (0913 admiral ruling: every dispatched click must
 * name the control it landed on).
 *
 * Evidence contract — this ledger is a WITNESS, never a judge:
 *   - The snapshot is read immediately BEFORE the synthetic input event is
 *     queued, so a tree mutation inside the dispatch window can still make
 *     it stale. The authoritative "did the click take effect" signal stays
 *     the matching API event plus the final-state audit.
 *   - `eventHit` comes from the game's own hit resolution (EventSystem /
 *     InteractionManager hitTest) when available; `containment` is a
 *     world-AABB approximation whose stack makes occlusion visible.
 *   - Failure is fail-soft: an unavailable probe records why and never
 *     blocks the dispatch.
 */
const fs = require('node:fs')
const path = require('node:path')

// Live 0913 title page: leaf sprites with the atlas identity sit at depth 8+;
// a cap of 8 truncated before them, leaving container-only stacks.
const MAX_STACK = 16
const MAX_VISIT = 4000
const MAX_DEPTH = 40
// Wall-clock bound for the whole snapshot. The page-side script has its own
// 1500ms timeout, but a throttled renderer can stall the IPC channel until
// the runtime's 10s inspection bound — a witness must never gate dispatch.
const CAPTURE_WALL_MS = 1800

function buildHitTestScript(x, y) {
  return `(() => {
  const px = ${JSON.stringify(x)}, py = ${JSON.stringify(y)};
  const shared = globalThis.PIXI && globalThis.PIXI.ticker && globalThis.PIXI.ticker.shared;
  const head = shared && shared._head;
  const renderers = [];
  let node = head ? head.next : null;
  let guard = 0;
  while (node && guard < 64) {
    if (node.context && node.context.renderer) renderers.push(node.context.renderer);
    node = node.next;
    guard += 1;
  }
  const renderer = renderers.find(
    (r) => r && r.view && r.view.isConnected === true && r._lastObjectRendered,
  );
  if (!renderer) return { available: false, reason: 'stale_renderer' };
  const describe = (o) => {
    const record = {};
    try { record.cls = (o.constructor && o.constructor.name) || null; } catch (_) { record.cls = null; }
    try { record.name = typeof o.name === 'string' && o.name ? o.name : null; } catch (_) { record.name = null; }
    try {
      const tex = o.texture;
      record.texture = tex && typeof tex.url === 'string' ? tex.url : null;
      // Atlas forensics (0913 admiral request): the sprite's frame inside its
      // source atlas sheet + the sheet URL let a hit record be mapped back to
      // the exact rectangle of the ORIGINAL art for offline cropping/filter.
      try {
        const base = tex && tex.baseTexture;
        const frame = tex && tex.frame;
        record.atlas = {
          url: base && typeof base.imageUrl === 'string' ? base.imageUrl : null,
          frame: frame
            ? [
                Math.round(frame.x), Math.round(frame.y),
                Math.round(frame.width), Math.round(frame.height),
              ]
            : null,
          rotate: tex && typeof tex.rotate === 'number' ? tex.rotate : 0,
        };
      } catch (_) { record.atlas = null; }
    } catch (_) { record.texture = null; record.atlas = null; }
    try {
      const b = o.getBounds ? o.getBounds() : null;
      record.bounds = b
        ? [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]
        : null;
    } catch (_) { record.bounds = null; }
    try {
      record.interactive = o.eventMode
        ? o.eventMode !== 'auto' && o.eventMode !== 'none' && o.eventMode !== 'passive'
        : o.interactive === true;
    } catch (_) { record.interactive = null; }
    try { record.visible = o.visible !== false; } catch (_) { record.visible = null; }
    try { record.alpha = typeof o.alpha === 'number' ? Math.round(o.alpha * 100) / 100 : null; } catch (_) { record.alpha = null; }
    return record;
  };
  const chain = (o) => {
    const path = [];
    let cur = o;
    let steps = 0;
    while (cur && steps < 6) {
      path.push((cur.constructor && cur.constructor.name) || 'unknown');
      cur = cur.parent;
      steps += 1;
    }
    return path;
  };
  // 1) The game's own hit resolution — interactive targets only.
  let eventHit = null;
  try {
    const point = { x: px, y: py };
    const events = renderer.events
      || (renderer.plugins && renderer.plugins.event)
      || (renderer.plugins && renderer.plugins.interaction);
    if (events && typeof events.hitTest === 'function') {
      const target = events.hitTest(point);
      if (target) {
        eventHit = describe(target);
        eventHit.path = chain(target);
      }
    }
  } catch (_) { eventHit = null; }
  // 2) World-AABB containment stack — approximate paint order (later entry
  //    ≈ on top within its branch); makes occlusion (family pages over stale
  //    choice pairs) visible in the record itself.
  const stack = [];
  let visited = 0;
  const walk = (o, depth) => {
    if (!o || depth > ${MAX_DEPTH} || visited > ${MAX_VISIT} || stack.length >= ${MAX_STACK}) return;
    visited += 1;
    try {
      if (o.visible !== false && o.renderable !== false) {
        const b = o.getBounds ? o.getBounds() : null;
        if (
          b && px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height
        ) {
          stack.push(describe(o));
        }
      }
    } catch (_) { /* a node that cannot be described is skipped, not fatal */ }
    if (stack.length >= ${MAX_STACK}) return;
    const kids = o.children;
    if (Array.isArray(kids)) {
      for (let i = 0; i < kids.length; i += 1) walk(kids[i], depth + 1);
    }
  };
  try { walk(renderer._lastObjectRendered, 0); } catch (_) { /* partial stack is still evidence */ }
  return {
    available: true,
    point: { x: px, y: py },
    eventHit,
    containmentCount: stack.length,
    topmost: stack.length > 0 ? stack[stack.length - 1] : null,
    stack,
  };
})()`
}

function createPixiHitLedger(options = {}) {
  const evaluate = options.evaluate
  const listFrames = options.listFrames
  const logger = options.logger || console
  const now = options.now || (() => new Date())
  const captureWallMs = options.captureWallMs || CAPTURE_WALL_MS
  const appendFile = options.appendFile
    || ((file, line) => fs.promises.appendFile(file, line, 'utf8'))
  const ledgerFile = options.ledgerFile || null
  let lastFrameId = null
  let lastFrameLookupAt = 0
  let ledgerWrite = Promise.resolve()

  if (typeof evaluate !== 'function' || typeof listFrames !== 'function') {
    return Object.freeze({
      async capture() { return Object.freeze({ available: false, reason: 'runtime_unavailable' }) },
    })
  }

  async function resolveGameFrameId() {
    const at = Date.now()
    if (lastFrameId && at - lastFrameLookupAt < 2000) return lastFrameId
    const frames = await listFrames()
    const game = frames.find((f) => /kcs2/i.test(f.url || '')) || frames[0]
    if (!game) return null
    lastFrameId = game.id
    lastFrameLookupAt = at
    return game.id
  }

  function appendToLedger(line) {
    if (!ledgerFile) return
    ledgerWrite = ledgerWrite
      .then(() => appendFile(ledgerFile, line))
      .catch((error) => {
        logger.error(`[poi-plugin-mcp] hit ledger append failed: ${error.message}`)
      })
  }

  /**
   * Snapshot what the live PIXI tree shows at the operation's canonical
   * point. Never throws: an unavailable probe is a recorded outcome.
   */
  async function capture(operation, context = {}) {
    const capturedAt = now().toISOString()
    const isClick = operation.operation === 'click'
    const point = isClick
      ? { x: operation.x, y: operation.y }
      : operation.operation === 'drag'
        ? { x: operation.fromX, y: operation.fromY }
        : operation.operation === 'scroll'
          ? { x: operation.x, y: operation.y }
          : null
    if (point === null) return Object.freeze({ available: false, reason: 'not_pointer' })
    const record = {
      at: capturedAt,
      operation: operation.operation,
      point,
      ...(context.leaseId === undefined ? {} : { leaseId: context.leaseId }),
      ...(context.ownerSessionId === undefined ? {} : { ownerSessionId: context.ownerSessionId }),
      ...(context.runId === undefined ? {} : { runId: context.runId }),
      ...(context.action === undefined ? {} : { action: context.action }),
    }
    try {
      const frameId = await resolveGameFrameId()
      if (frameId === null) {
        return Object.freeze({ ...record, available: false, reason: 'game_frame_not_found' })
      }
      const response = await Promise.race([
        evaluate({
          frameId,
          script: buildHitTestScript(point.x, point.y),
          timeoutMs: 1500,
        }),
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error('capture_wall_timeout')),
            captureWallMs,
          )
        }),
      ])
      const value = response && response.value
      // Every outcome is appended — a witness with gaps is worse than a
      // witness with anomalies (a probe that ran but returned nothing
      // non-object is itself diagnostic evidence).
      const hit = value === null || typeof value !== 'object'
        ? { ...record, available: false, reason: 'probe_empty' }
        : { ...record, ...value }
      appendToLedger(`${JSON.stringify(hit)}\n`)
      return Object.freeze(hit)
    } catch (error) {
      const hit = { ...record, available: false, reason: `probe_failed:${error.message}` }
      appendToLedger(`${JSON.stringify(hit)}\n`)
      return Object.freeze(hit)
    }
  }

  return Object.freeze({ capture })
}

function defaultLedgerFile(portFile) {
  if (!portFile || typeof portFile !== 'string') return null
  try {
    return path.join(path.dirname(portFile), 'hit-ledger.jsonl')
  } catch (_) {
    return null
  }
}

module.exports = {
  buildHitTestScript,
  createPixiHitLedger,
  defaultLedgerFile,
}
