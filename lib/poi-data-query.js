const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createPoiWebviewRuntime } = require('./poi-webview-runtime')

const QUERY_SCHEMA_VERSION = 1
const MAX_QUERY_BODY_BYTES = 64 * 1024
const MAX_QUERY_RESULT_BYTES = 8 * 1024 * 1024
const MAX_CACHE_FILE_BYTES = 16 * 1024 * 1024
const MAX_PATH_SEGMENTS = 64
const SENSITIVE_KEY = /^(?:api_token|authorization|cookies?|credentials?|loginData|password|secret|ticket|accessToken|refreshToken)$/iu

function createPoiDataQuery(options = {}) {
  const getStore = options.getStore || defaultGetStore
  const getApiResponses = options.getApiResponses || (() => ({
    available: false,
    latestGeneration: 0,
    responses: [],
  }))
  const cacheRoot = path.resolve(options.cacheRoot || defaultCacheRoot())
  const runtime = options.runtime || createPoiWebviewRuntime({
    getStore,
    resolveWebContents: options.resolveWebContents,
    logger: options.logger,
    now: options.now,
  })

  async function query(request = {}) {
    const source = boundedString(request.source, 64, 'source')
    let value
    switch (source) {
      case 'capabilities':
        value = {
          schemaVersion: QUERY_SCHEMA_VERSION,
          sources: [
            'poi.store',
            'api.responses',
            'cache.json',
            'webview.frames',
            'webview.storage',
            'webview.path',
            'webview.find',
          ],
          pathFormat: 'array',
          webviewRoots: ['globalThis', 'pixi.last-rendered'],
          webviewProjections: ['pixi.interactive'],
          cacheRoot,
        }
        break
      case 'poi.store':
        value = selectPath(getStore(), validatePath(request.path))
        break
      case 'api.responses': {
        const response = getApiResponses({
          after: optionalInteger(request.after, 0, Number.MAX_SAFE_INTEGER, 'after'),
          limit: optionalInteger(request.limit, 1, 256, 'limit'),
          path: request.apiPath == null
            ? undefined
            : boundedString(request.apiPath, 512, 'apiPath'),
        })
        value = selectPath(response, validatePath(request.path))
        break
      }
      case 'cache.json': {
        const filename = resolveCacheFile(
          cacheRoot,
          boundedString(request.file, 1024, 'file'),
        )
        const stat = fs.statSync(filename)
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CACHE_FILE_BYTES) {
          throw queryError('CACHE_FILE_INVALID', 'Cache JSON file is empty or exceeds 16MB', 400)
        }
        const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'))
        value = selectPath(parsed, validatePath(request.path))
        break
      }
      case 'webview.frames':
        value = await runtime.listFrames()
        break
      case 'webview.storage':
        value = await runtime.readStorage(request)
        break
      case 'webview.path':
        value = await runtime.readPath(request)
        break
      case 'webview.find':
        value = await runtime.findObjects(request)
        break
      default:
        throw queryError('QUERY_SOURCE_UNKNOWN', `Unknown query source: ${source}`, 400)
    }
    const sanitized = sanitize(value)
    assertResultSize(sanitized)
    return {
      schemaVersion: QUERY_SCHEMA_VERSION,
      source,
      value: sanitized,
    }
  }

  return Object.freeze({ query, runtime })
}

function validatePath(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_PATH_SEGMENTS) {
    throw queryError(
      'QUERY_PATH_INVALID',
      `path must be an array with at most ${MAX_PATH_SEGMENTS} segments`,
      400,
    )
  }
  return value.map((segment) => {
    if (
      (typeof segment !== 'string' && !Number.isInteger(segment)) ||
      String(segment).length > 256
    ) {
      throw queryError('QUERY_PATH_INVALID', 'path segments must be short strings or integers', 400)
    }
    const text = String(segment)
    if (
      ['__proto__', 'prototype', 'constructor'].includes(text) ||
      SENSITIVE_KEY.test(text)
    ) {
      throw queryError('QUERY_PATH_INVALID', `Unsafe path segment: ${text}`, 400)
    }
    return text
  })
}

function selectPath(root, segments) {
  let current = root
  for (const segment of segments) {
    if (
      current === null ||
      (typeof current !== 'object' && typeof current !== 'function') ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      throw queryError('QUERY_PATH_NOT_FOUND', `Query path was not found at ${segment}`, 404)
    }
    current = current[segment]
  }
  return current
}

function resolveCacheFile(root, relativeFile) {
  if (path.isAbsolute(relativeFile)) {
    throw queryError('CACHE_PATH_INVALID', 'Cache file must be relative to the Poi data root', 400)
  }
  const segments = relativeFile.split(/[\\/]+/u).filter(Boolean)
  if (
    segments.length === 0 ||
    segments.some((segment) =>
      segment === '..' || SENSITIVE_KEY.test(path.parse(segment).name))
  ) {
    throw queryError('CACHE_PATH_INVALID', 'Cache file path is unsafe', 400)
  }
  const resolved = path.resolve(root, ...segments)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw queryError('CACHE_PATH_INVALID', 'Cache file escapes the Poi data root', 400)
  }
  if (path.extname(resolved).toLowerCase() !== '.json') {
    throw queryError('CACHE_PATH_INVALID', 'Only JSON cache files can be queried', 400)
  }
  return resolved
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value
  }
  if (typeof value === 'string') return value.slice(0, 256 * 1024)
  if (typeof value === 'bigint') return String(value)
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return '[Circular]'
  if (depth >= 16) return '[MaxDepth]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.slice(0, 20_000).map((item) => sanitize(item, depth + 1, seen))
  }
  const output = {}
  for (const [key, item] of Object.entries(value).slice(0, 20_000)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = '[REDACTED]'
      continue
    }
    const sanitized = sanitize(item, depth + 1, seen)
    if (sanitized !== undefined) output[key] = sanitized
  }
  return output
}

function assertResultSize(value) {
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (size > MAX_QUERY_RESULT_BYTES) {
    throw queryError('QUERY_RESULT_TOO_LARGE', 'Query result exceeds 8MB; select a narrower path', 413)
  }
}

function boundedString(value, maximum, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw queryError(
      'QUERY_ARGUMENT_INVALID',
      `${name} must be a non-empty string up to ${maximum} characters`,
      400,
    )
  }
  return value
}

function optionalInteger(value, minimum, maximum, name) {
  if (value == null) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw queryError(
      'QUERY_ARGUMENT_INVALID',
      `${name} must be an integer from ${minimum} to ${maximum}`,
      400,
    )
  }
  return parsed
}

function queryError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function defaultCacheRoot() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'poi',
  )
}

function defaultGetStore(storePath) {
  if (typeof window !== 'undefined' && typeof window.getStore === 'function') {
    return window.getStore(storePath)
  }
  return null
}

module.exports = {
  MAX_QUERY_BODY_BYTES,
  QUERY_SCHEMA_VERSION,
  createPoiDataQuery,
}
