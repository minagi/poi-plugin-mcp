const crypto = require('node:crypto')

const MAX_DEBUG_SCRIPT_LENGTH = 32 * 1024
const MAX_RESULT_BYTES = 2 * 1024 * 1024
const MAX_PATH_SEGMENTS = 64
const MAX_TEXTURE_RECTANGLE_VALUE = 1_000_000
const MAX_TEXTURE_URL_LENGTH = 2048
const SENSITIVE_KEY = /^(?:api_token|authorization|cookies?|credentials?|loginData|password|secret|ticket|accessToken|refreshToken)$/iu
const WEBVIEW_ROOTS = Object.freeze(['globalThis', 'pixi.last-rendered'])
const WEBVIEW_FIND_PROJECTIONS = Object.freeze(['pixi.interactive'])
// Injected into every WebView inspection expression that needs the
// pixi.last-rendered root. Long-running game pages can leave a replaced
// renderer first in the shared-ticker listener chain; its _lastObjectRendered
// then walks a detached scene graph that disagrees with the live picture
// while the screen keeps rendering normally. Trust only renderers whose
// canvas is still connected to the frame document, in ticker-listener order,
// and fail closed with a distinct reason when none qualifies.
const PIXI_ROOT_RESOLVER_SNIPPET = `
    const resolvePixiLastRendered = () => {
      const ticker = globalThis.PIXI && globalThis.PIXI.ticker;
      const head = ticker && ticker.shared && ticker.shared._head;
      if (!head) return { available: false, reason: 'root_unavailable' };
      const candidates = [];
      let node = head.next;
      let guard = 0;
      while (node && guard < 64) {
        const context = node.context;
        if (context && context.renderer) candidates.push(context.renderer);
        node = node.next;
        guard += 1;
      }
      if (candidates.length === 0) return { available: false, reason: 'root_unavailable' };
      let sawConnected = false;
      for (const renderer of candidates) {
        const view = renderer.view;
        if (!view || view.isConnected !== true) continue;
        sawConnected = true;
        if (renderer._lastObjectRendered) {
          return { available: true, value: renderer._lastObjectRendered };
        }
      }
      return {
        available: false,
        reason: sawConnected ? 'root_unavailable' : 'stale_renderer',
      };
    };`

function createPoiWebviewRuntime(options = {}) {
  const getStore = options.getStore || defaultGetStore
  const resolveWebContents = options.resolveWebContents || defaultResolveWebContents
  // Remote-proxy memoization (0909 leak fix): every getWebContents() across
  // @electron/remote registers fresh objects in poi's main-process
  // ObjectsRegistry; at ~1 call/sec the per-context Map hits V8's size cap
  // (RangeError: Map maximum size exceeded) and ALL game writes die until
  // poi restarts. Resolve by integer id (no registration) and cache the
  // proxy — Electron ids are monotonic, never reused after destroy.
  const webContentsProxyCache = new Map()
  const logger = options.logger || console
  const now = options.now || (() => new Date())

  function currentWebContents() {
    const layout = getStore('layout.webview')
    if (!layout || !layout.ref) {
      throw new Error('Poi game WebView is not ready')
    }
    if (typeof layout.ref.getWebContentsId === 'function') {
      const id = layout.ref.getWebContentsId()
      if (Number.isInteger(id) && id > 0) {
        const hit = webContentsProxyCache.get(id)
        if (hit) return hit
        const webContents = resolveWebContents(id)
        if (webContents) {
          webContentsProxyCache.set(id, webContents)
          return webContents
        }
      }
    }
    if (typeof layout.ref.getWebContents === 'function') {
      const webContents = layout.ref.getWebContents()
      if (webContents) {
        webContentsProxyCache.set('ref', webContents)
        return webContents
      }
    }
    throw new Error('Poi game WebView webContents is unavailable')
  }

  function frames() {
    const webContents = currentWebContents()
    const mainFrame = webContents.mainFrame
    if (!mainFrame) {
      return [{
        id: 'main',
        name: '',
        url: typeof webContents.getURL === 'function' ? webContents.getURL() : '',
        frame: null,
        webContents,
      }]
    }
    const candidates = Array.isArray(mainFrame.framesInSubtree)
      ? mainFrame.framesInSubtree
      : [mainFrame]
    const unique = candidates.includes(mainFrame)
      ? candidates
      : [mainFrame, ...candidates]
    return unique
      .map((frame, index) => ({
        id: frameId(frame, index),
        name: typeof frame.name === 'string' ? frame.name : '',
        url: typeof frame.url === 'string' ? frame.url : '',
        frame,
        webContents,
      }))
      .filter((candidate) => isKanColleGameUrl(candidate.url))
  }

  function selectFrame(requestedId) {
    const available = frames()
    if (available.length === 0) {
      throw new Error('KanColle game frame is not ready')
    }
    if (requestedId == null || requestedId === '') {
      throw new Error('frameId is required for WebView inspection')
    }
    const selected = available.find((candidate) => candidate.id === requestedId)
    if (!selected) throw new Error(`Unknown WebView frame: ${requestedId}`)
    return selected
  }

  // Read-only inspection scripts are synchronous IIFEs; a hang can only come
  // from executeJavaScript's IPC never settling (e.g. after frame navigation).
  // Bound it so the bridge fails fast instead of holding the request forever.
  const EXECUTE_INSPECTION_TIMEOUT_MS = 10000

  async function execute(frameInfo, expression) {
    const run = () => {
      if (frameInfo.frame && typeof frameInfo.frame.executeJavaScript === 'function') {
        return frameInfo.frame.executeJavaScript(expression, false)
      }
      if (typeof frameInfo.webContents.executeJavaScript === 'function') {
        return frameInfo.webContents.executeJavaScript(expression, false)
      }
      return Promise.reject(new Error('Poi game WebView does not support JavaScript inspection'))
    }
    let timer
    try {
      return await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('WebView inspection timed out')),
            EXECUTE_INSPECTION_TIMEOUT_MS,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async function listFrames() {
    return frames().map(({ id, name, url }) => ({
      id,
      name,
      url: publicFrameUrl(url),
    }))
  }

  async function readStorage(request = {}) {
    const storage = request.storage === 'session' ? 'sessionStorage' : 'localStorage'
    const frameInfo = selectFrame(request.frameId)
    const key = request.key == null ? null : boundedString(request.key, 256, 'key')
    const expression = `(() => {
      const storage = globalThis[${JSON.stringify(storage)}];
      if (!storage) return { available: false, values: {} };
      const requestedKey = ${JSON.stringify(key)};
      if (requestedKey !== null) {
        return {
          available: true,
          values: Object.prototype.hasOwnProperty.call(storage, requestedKey) ||
            storage.getItem(requestedKey) !== null
            ? { [requestedKey]: storage.getItem(requestedKey) }
            : {},
        };
      }
      const values = {};
      for (let index = 0; index < Math.min(storage.length, 4096); index += 1) {
        const itemKey = storage.key(index);
        if (typeof itemKey === 'string' && itemKey.length <= 256) {
          values[itemKey] = storage.getItem(itemKey);
        }
      }
      return { available: true, values };
    })()`
    return boundedResult(await execute(frameInfo, expression))
  }

  async function readPath(request = {}) {
    const path = validatePath(request.path)
    const root = validateInspectionRoot(request.root)
    const frameInfo = selectFrame(request.frameId)
    const expression = `(() => {
      const path = ${JSON.stringify(path)};
      const root = ${JSON.stringify(root)};
      let value;
      if (root === 'globalThis') {
        value = globalThis;
      } else {
${PIXI_ROOT_RESOLVER_SNIPPET}
        const resolved = resolvePixiLastRendered();
        if (!resolved.available) return { available: false, reason: resolved.reason };
        value = resolved.value;
      }
      for (const segment of path) {
        if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
          return { available: false, reason: 'non_object_parent' };
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, segment);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          return { available: false, reason: 'missing_or_accessor_property' };
        }
        value = descriptor.value;
      }
      const seen = new WeakSet();
      const copy = (item, depth) => {
        if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
        if (typeof item === 'string') return item.slice(0, 65536);
        if (typeof item === 'bigint') return String(item);
        if (typeof item === 'function') return { type: 'function', name: item.name || '' };
        if (typeof item !== 'object') return String(item);
        if (seen.has(item)) return '[Circular]';
        if (depth >= 8) return '[MaxDepth]';
        seen.add(item);
        if (Array.isArray(item)) return item.slice(0, 2048).map((entry) => copy(entry, depth + 1));
        const output = {};
        for (const key of Object.getOwnPropertyNames(item).slice(0, 512)) {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            output[key] = copy(descriptor.value, depth + 1);
          }
        }
        return output;
      };
      return { available: true, value: copy(value, 0) };
    })()`
    return boundedResult(await execute(frameInfo, expression))
  }

  async function findObjects(request = {}) {
    const rootName = validateInspectionRoot(request.root)
    const projection = validateFindProjection(request.projection)
    if (projection !== 'pixi.interactive' && request.anyRequiredKeys != null) {
      throw new Error('anyRequiredKeys is only supported by the pixi.interactive projection')
    }
    const frameInfo = selectFrame(request.frameId)
    const rootPath = validatePath(request.rootPath == null ? [] : request.rootPath)
    const anyRequiredKeys = request.anyRequiredKeys == null
      ? []
      : validateKeyList(request.anyRequiredKeys, 1, 64, 'anyRequiredKeys')
    const requiredKeys = projection === 'pixi.interactive' && request.requiredKeys == null
      ? []
      : validateKeyList(
        request.requiredKeys,
        projection === 'pixi.interactive' ? 0 : 1,
        16,
        'requiredKeys',
      )
    const selectKeys = request.selectKeys == null
      ? requiredKeys
      : validateKeyList(
        request.selectKeys,
        projection === 'pixi.interactive' ? 0 : 1,
        64,
        'selectKeys',
      )
    const maxDepth = boundedInteger(request.maxDepth, 6, 0, 12, 'maxDepth')
    const maxNodes = boundedInteger(request.maxNodes, 20_000, 1, 50_000, 'maxNodes')
    const maxMatches = boundedInteger(request.maxMatches, 16, 1, 256, 'maxMatches')
    // Visibility pruning by default: a node that fails visible/renderable/
    // worldAlpha also stops the descent into its subtree — a hidden parent
    // leaves children with stale own flags (worldAlpha 1, on-screen transform),
    // so per-node checks alone let dismissed-dialog ghosts leak into matches.
    // includeHidden restores the raw walk for forensics only.
    const includeHidden = request.includeHidden === true
    if (projection === 'pixi.interactive') {
      const capturedAt = timestamp(now())
      const expression = pixiInteractiveExpression({
        anyRequiredKeys,
        includeHidden,
        maxDepth,
        maxMatches,
        maxNodes,
        requiredKeys,
        rootName,
        rootPath,
        selectKeys,
      })
      const projected = boundedResult(await execute(frameInfo, expression))
      return boundedResult(finalizePixiInteractiveProjection(projected, {
        capturedAt,
        frameId: frameInfo.id,
        frameUrl: publicFrameUrl(frameInfo.url),
        maxMatches,
        rootName,
        rootPath,
      }))
    }
    const expression = `(() => {
      const rootName = ${JSON.stringify(rootName)};
      const rootPath = ${JSON.stringify(rootPath)};
      const requiredKeys = ${JSON.stringify(requiredKeys)};
      const selectKeys = ${JSON.stringify(selectKeys)};
      const maxDepth = ${maxDepth};
      const maxNodes = ${maxNodes};
      const maxMatches = ${maxMatches};
      const blockedKeys = new Set([
        'window', 'self', 'globalThis', 'parent', 'top', 'frames',
        'document', 'ownerDocument', 'prototype', 'constructor',
        'caller', 'callee', 'arguments',
      ]);
      let root;
      if (rootName === 'globalThis') {
        root = globalThis;
      } else {
${PIXI_ROOT_RESOLVER_SNIPPET}
        const resolved = resolvePixiLastRendered();
        if (!resolved.available) {
          return { available: false, reason: resolved.reason, matches: [] };
        }
        root = resolved.value;
      }
      for (const segment of rootPath) {
        if ((typeof root !== 'object' && typeof root !== 'function') || root === null) {
          return { available: false, reason: 'root_path_not_found', matches: [] };
        }
        const descriptor = Object.getOwnPropertyDescriptor(root, segment);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          return { available: false, reason: 'root_path_not_found', matches: [] };
        }
        root = descriptor.value;
      }
      const isObject = (value) =>
        (typeof value === 'object' || typeof value === 'function') && value !== null;
      if (!isObject(root)) {
        return { available: false, reason: 'root_is_not_object', matches: [] };
      }
      const scalar = (value) => {
        if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
        if (typeof value === 'string') return value.slice(0, 65536);
        if (typeof value === 'bigint') return String(value);
        if (Array.isArray(value)) {
          return value.slice(0, 20000).map((item) => {
            if (item && typeof item === 'object') {
              const id = Object.getOwnPropertyDescriptor(item, 'api_id');
              return id && Object.prototype.hasOwnProperty.call(id, 'value')
                ? { api_id: id.value }
                : '[Object]';
            }
            return scalar(item);
          });
        }
        if (typeof value === 'function') return { type: 'function', name: value.name || '' };
        if (typeof value === 'object') {
          const output = {};
          for (const key of Object.getOwnPropertyNames(value).slice(0, 256)) {
            if (blockedKeys.has(key)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
            const item = descriptor.value;
            if (item === null || ['boolean', 'number', 'string', 'bigint'].includes(typeof item)) {
              output[key] = scalar(item);
            }
          }
          return output;
        }
        return String(value);
      };
      const queue = [{ value: root, path: rootPath, depth: 0 }];
      const seen = new WeakSet();
      const matches = [];
      let visited = 0;
      while (queue.length > 0 && visited < maxNodes && matches.length < maxMatches) {
        const current = queue.shift();
        if (!isObject(current.value) || seen.has(current.value)) continue;
        seen.add(current.value);
        visited += 1;
        let names;
        try {
          names = Object.getOwnPropertyNames(current.value).slice(0, 2048);
        } catch (_) {
          continue;
        }
        if (requiredKeys.every((key) => names.includes(key))) {
          const selected = {};
          for (const key of selectKeys) {
            const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
            if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
              selected[key] = scalar(descriptor.value);
            }
          }
          matches.push({ path: current.path, selected });
        }
        if (current.depth >= maxDepth) continue;
        for (const key of names) {
          if (blockedKeys.has(key) || key.length > 256) continue;
          let descriptor;
          try {
            descriptor = Object.getOwnPropertyDescriptor(current.value, key);
          } catch (_) {
            continue;
          }
          if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
          const child = descriptor.value;
          if (!isObject(child) || seen.has(child)) continue;
          if (child.nodeType || child.ownerDocument) continue;
          queue.push({
            value: child,
            path: [...current.path, key],
            depth: current.depth + 1,
          });
        }
      }
      return {
        available: true,
        visited,
        exhausted: queue.length === 0,
        matches,
      };
    })()`
    return boundedResult(await execute(frameInfo, expression))
  }

  async function evaluate(request = {}) {
    const script = boundedString(
      request.script,
      MAX_DEBUG_SCRIPT_LENGTH,
      'script',
    )
    const timeoutMs = boundedInteger(request.timeoutMs, 1000, 50, 5000)
    const frameInfo = selectFrame(request.frameId)
    const scriptHash = crypto.createHash('sha256').update(script).digest('hex')
    const startedAt = timestamp(now())
    const expression = `(() => {
      const script = ${JSON.stringify(script)};
      const timeoutMs = ${timeoutMs};
      const timeout = new Promise((_, reject) => setTimeout(
        () => reject(new Error('Debug evaluation timed out')), timeoutMs));
      return Promise.race([
        Promise.resolve().then(() => (0, eval)(script)),
        timeout,
      ]);
    })()`
    try {
      const value = boundedResult(await execute(frameInfo, expression))
      logger.log(
        `[poi-plugin-mcp] debug eval ${scriptHash} frame=${frameInfo.id} ok`,
      )
      return {
        ok: true,
        frameId: frameInfo.id,
        startedAt,
        scriptHash,
        value,
      }
    } catch (error) {
      logger.error(
        `[poi-plugin-mcp] debug eval ${scriptHash} frame=${frameInfo.id} failed: ${error.message}`,
      )
      const failure = new Error(error.message)
      failure.code = 'DEBUG_EVAL_FAILED'
      failure.details = { frameId: frameInfo.id, startedAt, scriptHash }
      throw failure
    }
  }

  return Object.freeze({ evaluate, findObjects, listFrames, readPath, readStorage })
}

function pixiInteractiveExpression({
  anyRequiredKeys,
  includeHidden,
  maxDepth,
  maxMatches,
  maxNodes,
  requiredKeys,
  rootName,
  rootPath,
  selectKeys,
}) {
  return `(() => {
    const rootName = ${JSON.stringify(rootName)};
    const rootPath = ${JSON.stringify(rootPath)};
    const anyRequiredKeys = ${JSON.stringify(anyRequiredKeys)};
    const requiredKeys = ${JSON.stringify(requiredKeys)};
    const selectKeys = ${JSON.stringify(selectKeys)};
    const maxDepth = ${maxDepth};
    const maxNodes = ${maxNodes};
    const maxMatches = ${maxMatches};
    const includeHidden = ${includeHidden ? 'true' : 'false'};
    const isObject = (value) =>
      (typeof value === 'object' || typeof value === 'function') && value !== null;
    const ownDescriptor = (object, key) => {
      if (!isObject(object)) return null;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
          ? descriptor
          : null;
      } catch (_) {
        return null;
      }
    };
    const ownData = (object, key) => {
      const descriptor = ownDescriptor(object, key);
      return descriptor ? descriptor.value : undefined;
    };
    const finiteNumber = (value) =>
      typeof value === 'number' && Number.isFinite(value)
        ? (Object.is(value, -0) ? 0 : value)
        : null;
    const scalar = (value) => {
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'number') return finiteNumber(value);
      if (typeof value === 'string') return value.slice(0, 65536);
      if (typeof value === 'bigint') return String(value);
      return undefined;
    };
    const scalarOrNull = (value) => {
      const selected = scalar(value);
      return selected === undefined ? null : selected;
    };
    const booleanOrNull = (value) => typeof value === 'boolean' ? value : null;
    const textureImageUrl = (value) => {
      if (typeof value !== 'string' || value.length === 0 || value.length > ${MAX_TEXTURE_URL_LENGTH}) {
        return null;
      }
      try {
        const relative = !/^[a-z][a-z0-9+.-]*:/iu.test(value);
        const url = new URL(value, 'https://poi-texture.invalid/');
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        if (relative && url.origin !== 'https://poi-texture.invalid') return null;
        return relative
          ? (value.startsWith('/') ? url.pathname : url.pathname.slice(1))
          : url.origin + url.pathname;
      } catch (_) {
        return null;
      }
    };
    const rectangle = (value) => {
      if (!isObject(value)) return null;
      const x = finiteNumber(ownData(value, 'x'));
      const y = finiteNumber(ownData(value, 'y'));
      const width = finiteNumber(ownData(value, 'width'));
      const height = finiteNumber(ownData(value, 'height'));
      if (x === null || y === null || width === null || height === null || width < 0 || height < 0) {
        return null;
      }
      return { x, y, width, height };
    };
    const textureRectangle = (value) => {
      const rect = rectangle(value);
      if (
        rect === null ||
        Math.abs(rect.x) > ${MAX_TEXTURE_RECTANGLE_VALUE} ||
        Math.abs(rect.y) > ${MAX_TEXTURE_RECTANGLE_VALUE} ||
        rect.width > ${MAX_TEXTURE_RECTANGLE_VALUE} ||
        rect.height > ${MAX_TEXTURE_RECTANGLE_VALUE}
      ) return null;
      return rect;
    };
    const textureIdentity = (node) => {
      const texture = ownData(node, '_texture') ?? ownData(node, 'texture');
      if (!isObject(texture)) return { imageUrl: null, frame: null, orig: null };
      const baseTexture = ownData(texture, 'baseTexture');
      return {
        imageUrl: textureImageUrl(ownData(baseTexture, 'imageUrl')),
        frame: textureRectangle(ownData(texture, '_frame') ?? ownData(texture, 'frame')),
        orig: textureRectangle(ownData(texture, '_orig') ?? ownData(texture, 'orig')),
      };
    };
    const affineTransform = (value) => {
      if (!isObject(value)) return null;
      const transform = {};
      for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty']) {
        const item = finiteNumber(ownData(value, key));
        if (item === null) return null;
        transform[key] = item;
      }
      return transform;
    };
    const unionBounds = (left, right) => {
      if (!left) return right;
      if (!right) return left;
      const x = Math.min(left.x, right.x);
      const y = Math.min(left.y, right.y);
      const farX = Math.max(left.x + left.width, right.x + right.width);
      const farY = Math.max(left.y + left.height, right.y + right.height);
      return { x, y, width: farX - x, height: farY - y };
    };
    const circleBounds = (value) => {
      if (!isObject(value)) return null;
      const x = finiteNumber(ownData(value, 'x'));
      const y = finiteNumber(ownData(value, 'y'));
      const radius = finiteNumber(ownData(value, 'radius'));
      if (x === null || y === null || radius === null || radius < 0) return null;
      return { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 };
    };
    const polygonBounds = (value) => {
      if (!isObject(value)) return null;
      const points = ownData(value, 'points');
      if (!Array.isArray(points) || points.length < 4 || points.length > 4096) return null;
      const numbers = [];
      for (let index = 0; index < points.length; index += 1) {
        const point = ownData(points, String(index));
        const number = finiteNumber(point);
        if (number === null) return null;
        numbers.push(number);
      }
      if (numbers.length % 2 !== 0) return null;
      const xs = [];
      const ys = [];
      for (let index = 0; index < numbers.length; index += 2) {
        xs.push(numbers[index]);
        ys.push(numbers[index + 1]);
      }
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    };
    const shapeBounds = (shape) => {
      if (!isObject(shape)) return null;
      const type = finiteNumber(ownData(shape, 'type'));
      if (type === 2) return circleBounds(shape);
      if (type === 0) return polygonBounds(shape);
      const rect = rectangle(shape);
      if (rect === null) return null;
      if (type === 3) {
        return {
          x: rect.x - rect.width,
          y: rect.y - rect.height,
          width: rect.width * 2,
          height: rect.height * 2,
        };
      }
      return rect;
    };
    const graphicsBounds = (node) => {
      const graphicsData = ownData(node, 'graphicsData');
      if (!Array.isArray(graphicsData)) return null;
      const length = ownData(graphicsData, 'length');
      if (!Number.isInteger(length) || length < 0 || length > 256) return null;
      let bounds = null;
      for (let index = 0; index < length; index += 1) {
        const item = ownData(graphicsData, String(index));
        const shape = ownData(item, 'shape');
        bounds = unionBounds(bounds, shapeBounds(shape));
      }
      return bounds;
    };
    const spriteBounds = (node) => {
      const texture = ownData(node, '_texture') || ownData(node, 'texture');
      if (!isObject(texture)) return null;
      const frame = ownData(texture, '_orig') || ownData(texture, 'orig') ||
        ownData(texture, '_frame') || ownData(texture, 'frame');
      const rect = rectangle(frame);
      if (rect === null || rect.width <= 0 || rect.height <= 0) return null;
      const anchor = ownData(node, '_anchor') || ownData(node, 'anchor');
      const anchorX = finiteNumber(ownData(anchor, '_x')) ?? finiteNumber(ownData(anchor, 'x')) ?? 0;
      const anchorY = finiteNumber(ownData(anchor, '_y')) ?? finiteNumber(ownData(anchor, 'y')) ?? 0;
      return {
        x: -anchorX * rect.width,
        y: -anchorY * rect.height,
        width: rect.width,
        height: rect.height,
      };
    };
    const localBounds = (node) => {
      const hitArea = rectangle(ownData(node, 'hitArea'));
      if (hitArea !== null) return hitArea;
      const graphics = graphicsBounds(node);
      if (graphics !== null) return graphics;
      return spriteBounds(node);
    };
    const worldTransform = (node) => {
      const direct = affineTransform(ownData(node, 'worldTransform'));
      if (direct !== null) return direct;
      return affineTransform(ownData(ownData(node, 'transform'), 'worldTransform'));
    };
    const shown = (node) => {
      if (ownData(node, 'visible') === false || ownData(node, 'renderable') === false) return false;
      const alpha = finiteNumber(ownData(node, 'worldAlpha'));
      return alpha === null || alpha > 0;
    };
    const transformedBounds = (hitArea, transform) => {
      if (!hitArea || !transform) return null;
      const corners = [
        [hitArea.x, hitArea.y],
        [hitArea.x + hitArea.width, hitArea.y],
        [hitArea.x, hitArea.y + hitArea.height],
        [hitArea.x + hitArea.width, hitArea.y + hitArea.height],
      ].map(([x, y]) => ({
        x: transform.a * x + transform.c * y + transform.tx,
        y: transform.b * x + transform.d * y + transform.ty,
      }));
      if (corners.some((corner) => !Number.isFinite(corner.x) || !Number.isFinite(corner.y))) {
        return null;
      }
      const xs = corners.map((corner) => corner.x);
      const ys = corners.map((corner) => corner.y);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      const right = Math.max(...xs);
      const bottom = Math.max(...ys);
      return {
        x: Object.is(left, -0) ? 0 : left,
        y: Object.is(top, -0) ? 0 : top,
        width: Object.is(right - left, -0) ? 0 : right - left,
        height: Object.is(bottom - top, -0) ? 0 : bottom - top,
      };
    };
    let root;
    if (rootName === 'globalThis') {
      root = globalThis;
    } else {
${PIXI_ROOT_RESOLVER_SNIPPET}
      const resolved = resolvePixiLastRendered();
      if (!resolved.available) {
        return { available: false, reason: resolved.reason, matches: [] };
      }
      root = resolved.value;
    }
    for (const segment of rootPath) {
      root = ownData(root, segment);
      if (!isObject(root)) return { available: false, matches: [] };
    }
    if (!isObject(root)) return { available: false, matches: [] };

    const queue = [{ node: root, path: rootPath, depth: 0, parent: -1 }];
    const seen = new WeakSet();
    const entries = [];
    let cursor = 0;
    let visited = 0;
    let inspectedChildren = 0;
    let prunedSubtrees = 0;
    let depthLimited = false;
    let childScanLimited = false;
    let truncatedBy = null;
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      if (!isObject(current.node) || seen.has(current.node)) continue;
      if (visited >= maxNodes) {
        truncatedBy = 'maxNodes';
        break;
      }
      seen.add(current.node);
      visited += 1;
      const nodeShown = shown(current.node);
      const entryIndex = entries.length;
      entries.push({
        node: current.node,
        path: current.path,
        depth: current.depth,
        parent: current.parent,
        ownWorldBounds: nodeShown
          ? transformedBounds(localBounds(current.node), worldTransform(current.node))
          : null,
        subtreeWorldBounds: null,
      });
      if (!nodeShown && !includeHidden) {
        // Hidden parent: children keep stale own flags (visible=true,
        // worldAlpha=1, on-screen transform) because PIXI skips
        // updateTransform for invisible subtrees — do not descend.
        prunedSubtrees += 1;
        continue;
      }

      const children = ownData(current.node, 'children');
      if (!Array.isArray(children)) continue;
      const length = ownData(children, 'length');
      if (!Number.isInteger(length) || length < 0) continue;
      for (let index = 0; index < length; index += 1) {
        if (inspectedChildren >= maxNodes) {
          if (index < length) childScanLimited = true;
          break;
        }
        inspectedChildren += 1;
        const child = ownData(children, String(index));
        if (!isObject(child) || seen.has(child)) continue;
        if (current.depth >= maxDepth) {
          depthLimited = true;
          continue;
        }
        queue.push({
          node: child,
          path: [...current.path, 'children', String(index)],
          depth: current.depth + 1,
          parent: entryIndex,
        });
      }
    }
    if (truncatedBy === null && cursor < queue.length) truncatedBy = 'maxNodes';
    if (truncatedBy === null && depthLimited) truncatedBy = 'maxDepth';
    if (truncatedBy === null && childScanLimited) truncatedBy = 'maxNodes';
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      entry.subtreeWorldBounds = unionBounds(entry.ownWorldBounds, entry.subtreeWorldBounds);
      if (entry.parent >= 0 && entry.subtreeWorldBounds !== null) {
        entries[entry.parent].subtreeWorldBounds = unionBounds(
          entries[entry.parent].subtreeWorldBounds,
          entry.subtreeWorldBounds,
        );
      }
    }
    const matches = [];
    for (const entry of entries) {
      if (
        anyRequiredKeys.length > 0 &&
        !anyRequiredKeys.some((key) => ownDescriptor(entry.node, key) !== null)
      ) continue;
      if (!requiredKeys.every((key) => ownDescriptor(entry.node, key) !== null)) continue;
      const name = scalarOrNull(ownData(entry.node, 'name'));
      const id = scalarOrNull(ownData(entry.node, 'id'));
      const hitArea = rectangle(ownData(entry.node, 'hitArea'));
      const attributes = {};
      for (const key of selectKeys) {
        const selected = scalar(ownData(entry.node, key));
        if (selected !== undefined) attributes[key] = selected;
      }
      const interaction = {
        interactive: booleanOrNull(ownData(entry.node, 'interactive')),
        eventMode: scalarOrNull(ownData(entry.node, 'eventMode')),
        enabled: booleanOrNull(ownData(entry.node, 'enabled')),
        visible: booleanOrNull(ownData(entry.node, 'visible')),
        renderable: booleanOrNull(ownData(entry.node, 'renderable')),
        worldAlpha: finiteNumber(ownData(entry.node, 'worldAlpha')),
      };
      const texture = textureIdentity(entry.node);
      const hasInteractionIdentity = interaction.interactive !== null || interaction.eventMode !== null;
      const hasSemanticIdentity = name !== null || id !== null;
      const hasSelectedScalar = Object.keys(attributes).length > 0;
      const hasTextureIdentity = texture.imageUrl !== null || texture.frame !== null || texture.orig !== null;
      if (
        entry.subtreeWorldBounds === null ||
        !(hasInteractionIdentity || hasSemanticIdentity || hasSelectedScalar || hasTextureIdentity)
      ) continue;
      if (matches.length >= maxMatches) {
        truncatedBy = 'maxMatches';
        break;
      }
      matches.push({
        path: entry.path,
        semanticId: { name, id },
        interaction,
        texture,
        hitArea,
        worldBounds: entry.subtreeWorldBounds,
        attributes,
      });
    }
    return {
      available: true,
      visited,
      exhausted: truncatedBy === null,
      truncatedBy,
      prunedSubtrees,
      matches,
    };
  })()`
}

function finalizePixiInteractiveProjection(value, options) {
  const available = Boolean(value && value.available === true)
  // Failure reasons from the frame expression (e.g. stale_renderer) are the
  // only signal that distinguishes "anchor went stale, reload the frame" from
  // any other unavailable shape, so pass them through for fail-closed readers.
  const reason = available === false &&
      typeof value.reason === 'string' &&
      value.reason.length > 0 &&
      value.reason.length <= 64
    ? value.reason
    : null
  const rawMatches = available && Array.isArray(value.matches)
    ? Array.from(value.matches).slice(0, options.maxMatches)
    : []
  const matches = rawMatches.map((match) => normalizeProjectedMatch(match))
  const semanticCounts = new Map()
  for (const match of matches) {
    const signature = semanticSignature(match)
    if (signature !== null) {
      semanticCounts.set(signature, (semanticCounts.get(signature) || 0) + 1)
    }
  }
  const identifiedMatches = matches.map((match) => {
    const signature = semanticSignature(match)
    const semanticId = {
      name: match.semanticId.name,
      id: match.semanticId.id,
      unique: signature !== null && semanticCounts.get(signature) === 1,
    }
    const normalized = {
      path: match.path,
      semanticId,
      interaction: match.interaction,
      texture: match.texture,
      hitArea: match.hitArea,
      worldBounds: match.worldBounds,
      attributes: match.attributes,
    }
    return {
      path: normalized.path,
      semanticId: normalized.semanticId,
      nodeToken: sha256Token({
        kind: 'poi.webview.pixi.node.v1',
        path: normalized.path,
        semanticId: {
          name: normalized.semanticId.name,
          id: normalized.semanticId.id,
        },
        interaction: normalized.interaction,
        texture: normalized.texture,
        hitArea: normalized.hitArea,
        worldBounds: normalized.worldBounds,
        attributes: normalized.attributes,
      }),
      interaction: normalized.interaction,
      texture: normalized.texture,
      hitArea: normalized.hitArea,
      worldBounds: normalized.worldBounds,
      attributes: normalized.attributes,
    }
  })
  const documentToken = sha256Token({
    kind: 'poi.webview.document.v1',
    frameId: options.frameId,
    frameUrl: options.frameUrl,
    root: options.rootName,
    rootPath: options.rootPath,
  })
  const pageToken = sha256Token({
    kind: 'poi.webview.pixi.page.v1',
    documentToken,
    matches: identifiedMatches.map((match) => ({
      path: match.path,
      semanticId: match.semanticId,
      texture: match.texture,
      attributes: match.attributes,
    })),
  })
  const visited = available && Number.isInteger(value.visited) && value.visited >= 0
    ? value.visited
    : 0
  const truncatedBy = available && ['maxDepth', 'maxNodes', 'maxMatches'].includes(value.truncatedBy)
    ? value.truncatedBy
    : null
  const exhausted = available && value.exhausted === true && truncatedBy === null
  const prunedSubtrees = available &&
    Number.isInteger(value.prunedSubtrees) && value.prunedSubtrees >= 0
    ? value.prunedSubtrees
    : 0
  const snapshotDigest = sha256Token({
    kind: 'poi.webview.pixi.snapshot.v1',
    available,
    documentToken,
    pageToken,
    visited,
    exhausted,
    truncatedBy,
    matches: identifiedMatches,
  })
  return {
    available,
    ...(reason === null ? {} : { reason }),
    frameId: options.frameId,
    root: options.rootName,
    capturedAt: options.capturedAt,
    documentToken,
    pageToken,
    snapshotDigest,
    visited,
    exhausted,
    truncatedBy,
    prunedSubtrees,
    matches: identifiedMatches,
  }
}

function normalizeProjectedMatch(value) {
  const match = value && typeof value === 'object' ? value : {}
  const semanticId = match.semanticId && typeof match.semanticId === 'object'
    ? match.semanticId
    : {}
  const interaction = match.interaction && typeof match.interaction === 'object'
    ? match.interaction
    : {}
  const attributes = match.attributes && typeof match.attributes === 'object' && !Array.isArray(match.attributes)
    ? match.attributes
    : {}
  const normalizedAttributes = {}
  for (const [key, item] of Object.entries(attributes)) {
    const scalar = normalizedScalar(item)
    if (scalar !== undefined) normalizedAttributes[key] = scalar
  }
  return {
    path: Array.isArray(match.path)
      ? Array.from(match.path, (segment) => String(segment).slice(0, 256))
        .slice(0, MAX_PATH_SEGMENTS)
      : [],
    semanticId: {
      name: normalizedScalarOrNull(semanticId.name),
      id: normalizedScalarOrNull(semanticId.id),
    },
    interaction: {
      interactive: normalizedBooleanOrNull(interaction.interactive),
      eventMode: normalizedScalarOrNull(interaction.eventMode),
      enabled: normalizedBooleanOrNull(interaction.enabled),
      visible: normalizedBooleanOrNull(interaction.visible),
      renderable: normalizedBooleanOrNull(interaction.renderable),
      worldAlpha: normalizedFiniteOrNull(interaction.worldAlpha),
    },
    texture: normalizedTextureIdentity(match.texture),
    hitArea: normalizedRectangle(match.hitArea),
    worldBounds: normalizedRectangle(match.worldBounds),
    attributes: normalizedAttributes,
  }
}

function normalizedTextureIdentity(value) {
  const texture = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    imageUrl: normalizedTextureImageUrl(texture.imageUrl),
    frame: normalizedTextureRectangle(texture.frame),
    orig: normalizedTextureRectangle(texture.orig),
  }
}

function normalizedTextureImageUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXTURE_URL_LENGTH) return null
  try {
    const relative = !/^[a-z][a-z0-9+.-]*:/iu.test(value)
    const url = new URL(value, 'https://poi-texture.invalid/')
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (relative && url.origin !== 'https://poi-texture.invalid') return null
    return relative
      ? (value.startsWith('/') ? url.pathname : url.pathname.slice(1))
      : `${url.origin}${url.pathname}`
  } catch (_) {
    return null
  }
}

function normalizedTextureRectangle(value) {
  const rectangle = normalizedRectangle(value)
  if (
    rectangle === null ||
    Math.abs(rectangle.x) > MAX_TEXTURE_RECTANGLE_VALUE ||
    Math.abs(rectangle.y) > MAX_TEXTURE_RECTANGLE_VALUE ||
    rectangle.width > MAX_TEXTURE_RECTANGLE_VALUE ||
    rectangle.height > MAX_TEXTURE_RECTANGLE_VALUE
  ) return null
  return rectangle
}

function normalizedScalar(value) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? normalizeZero(value) : null
  if (typeof value === 'string') return value.slice(0, 65536)
  if (typeof value === 'bigint') return String(value)
  return undefined
}

function normalizedScalarOrNull(value) {
  const scalar = normalizedScalar(value)
  return scalar === undefined ? null : scalar
}

function normalizedBooleanOrNull(value) {
  return typeof value === 'boolean' ? value : null
}

function normalizedFiniteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? normalizeZero(value) : null
}

function normalizedRectangle(value) {
  if (!value || typeof value !== 'object') return null
  const x = normalizedFiniteOrNull(value.x)
  const y = normalizedFiniteOrNull(value.y)
  const width = normalizedFiniteOrNull(value.width)
  const height = normalizedFiniteOrNull(value.height)
  if (x === null || y === null || width === null || height === null || width < 0 || height < 0) {
    return null
  }
  return { x, y, width, height }
}

function semanticSignature(match) {
  if (
    match.semanticId.name === null &&
    match.semanticId.id === null &&
    Object.keys(match.attributes).length === 0
  ) return null
  return canonicalJson({
    attributes: match.attributes,
    id: match.semanticId.id,
    name: match.semanticId.name,
  })
}

function sha256Token(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(normalizeZero(value))
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) =>
    `${JSON.stringify(key.normalize('NFC'))}:${canonicalJson(value[key])}`).join(',')}}`
}

function normalizeZero(value) {
  return Object.is(value, -0) ? 0 : value
}

function frameId(frame, fallbackIndex) {
  const processId = Number(frame.processId)
  const routingId = Number(frame.routingId)
  if (Number.isInteger(processId) && Number.isInteger(routingId)) {
    return `${processId}:${routingId}`
  }
  return fallbackIndex === 0 ? 'main' : `frame-${fallbackIndex}`
}

function isKanColleGameUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      (
        url.hostname === 'kancolle-server.com' ||
        url.hostname.endsWith('.kancolle-server.com')
      )
    )
  } catch (_) {
    return false
  }
}

function publicFrameUrl(value) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch (_) {
    return ''
  }
}

function validateInspectionRoot(value) {
  const root = value == null ? 'globalThis' : boundedString(value, 64, 'root')
  if (!WEBVIEW_ROOTS.includes(root)) {
    throw new Error(`Unsupported WebView inspection root: ${root}`)
  }
  return root
}

function validateFindProjection(value) {
  if (value == null) return null
  const projection = boundedString(value, 64, 'projection')
  if (!WEBVIEW_FIND_PROJECTIONS.includes(projection)) {
    throw new Error(`Unsupported WebView find projection: ${projection}`)
  }
  return projection
}

function validatePath(value) {
  if (!Array.isArray(value) || value.length > MAX_PATH_SEGMENTS) {
    throw new Error(`path must be an array with at most ${MAX_PATH_SEGMENTS} segments`)
  }
  return value.map((segment) => {
    const text = boundedString(segment, 256, 'path segment')
    if (
      ['__proto__', 'prototype', 'constructor'].includes(text) ||
      SENSITIVE_KEY.test(text)
    ) {
      throw new Error(`Unsafe path segment: ${text}`)
    }
    return text
  })
}

function validateKeyList(value, minimum, maximum, name) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${name} must contain ${minimum} to ${maximum} property names`)
  }
  const keys = value.map((key) => boundedString(key, 256, `${name} item`))
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) =>
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      SENSITIVE_KEY.test(key))
  ) {
    throw new Error(`${name} contains duplicate or unsafe property names`)
  }
  return keys
}

function boundedResult(value) {
  let encoded
  try {
    encoded = JSON.stringify(value)
  } catch (_) {
    throw new Error('WebView result is not serializable')
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('WebView result exceeds 2MB')
  }
  return value
}

function boundedString(value, maximum, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`${name} must be a non-empty string up to ${maximum} characters`)
  }
  return value
}

function boundedInteger(value, fallback, minimum, maximum, name = 'timeoutMs') {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('now must return a valid date')
  return date.toISOString()
}

function defaultGetStore(path) {
  if (typeof window !== 'undefined' && typeof window.getStore === 'function') {
    return window.getStore(path)
  }
  return null
}

function defaultResolveWebContents(id) {
  return require('@electron/remote').webContents.fromId(id)
}

module.exports = {
  MAX_DEBUG_SCRIPT_LENGTH,
  MAX_RESULT_BYTES,
  createPoiWebviewRuntime,
  isKanColleGameUrl,
}
