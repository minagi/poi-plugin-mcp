const crypto = require('node:crypto')

const DEFAULT_CAPACITY = 128
const DEFAULT_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const SENSITIVE_KEY = /^(?:api_token|authorization|cookie|credentials?|loginData|password|secret|ticket)$/iu

function createPoiApiResponses(options = {}) {
  const now = options.now || (() => new Date())
  const capacity = boundedInteger(
    options.capacity == null ? DEFAULT_CAPACITY : options.capacity,
    1,
    512,
    'capacity',
  )
  const maxTotalBytes = boundedInteger(
    options.maxTotalBytes == null ? DEFAULT_TOTAL_BYTES : options.maxTotalBytes,
    1024,
    128 * 1024 * 1024,
    'maxTotalBytes',
  )
  const sessionId = String(options.sessionId || crypto.randomUUID())
  const responses = []
  let latestGeneration = 0
  let totalBytes = 0

  function capture(detail, capturedAt) {
    if (
      !detail ||
      typeof detail !== 'object' ||
      Array.isArray(detail) ||
      typeof detail.path !== 'string' ||
      !detail.path.startsWith('/kcsapi/')
    ) {
      return null
    }
    const body = sanitize(detail.body)
    const postBody = sanitize(detail.postBody)
    const apiResult = readApiResult(detail)
    latestGeneration += 1
    const base = {
      generation: latestGeneration,
      capturedAt: capturedAt == null ? timestamp(now()) : timestamp(capturedAt),
      path: detail.path,
      apiResult,
      postBody: isObject(postBody) ? postBody : {},
    }
    let responseBody = body
    let truncated = false
    let bytes = encodedBytes({ ...base, responseBody })
    if (bytes > MAX_RESPONSE_BYTES) {
      responseBody = null
      truncated = true
      bytes = encodedBytes({ ...base, responseBody, truncated })
    }
    const entry = Object.freeze({
      ...base,
      responseBody,
      truncated,
      bytes,
    })
    responses.push(entry)
    totalBytes += bytes
    while (responses.length > capacity || totalBytes > maxTotalBytes) {
      const removed = responses.shift()
      totalBytes -= removed.bytes
    }
    return entry
  }

  function read(options = {}) {
    const after = options.after == null
      ? 0
      : boundedInteger(options.after, 0, Number.MAX_SAFE_INTEGER, 'after')
    const limit = options.limit == null
      ? 64
      : boundedInteger(options.limit, 1, 256, 'limit')
    const apiPath = options.path == null ? null : String(options.path)
    return {
      available: true,
      sessionId,
      earliestGeneration: responses.length === 0 ? 0 : responses[0].generation,
      latestGeneration,
      retainedBytes: totalBytes,
      responses: responses
        .filter((response) =>
          response.generation > after &&
          (apiPath === null || response.path === apiPath))
        .slice(0, limit)
        .map(({ bytes, ...response }) => response),
    }
  }

  return Object.freeze({ capture, read })
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value
  }
  if (typeof value === 'string') return value.slice(0, 512 * 1024)
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return '[Circular]'
  if (depth >= 32) return '[MaxDepth]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.slice(0, 100_000).map((item) => sanitize(item, depth + 1, seen))
  }
  const output = {}
  for (const [key, item] of Object.entries(value).slice(0, 100_000)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = '[REDACTED]'
      continue
    }
    const sanitized = sanitize(item, depth + 1, seen)
    if (sanitized !== undefined) output[key] = sanitized
  }
  return output
}

function readApiResult(detail) {
  const candidates = [
    detail.apiResult,
    detail.api_result,
    detail.result,
    detail.body && detail.body.api_result,
  ]
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue
    const parsed = Number(candidate)
    if (Number.isInteger(parsed)) return parsed
  }
  return null
}

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function boundedInteger(value, minimum, maximum, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('now must return a valid date')
  return date.toISOString()
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

module.exports = {
  MAX_RESPONSE_BYTES,
  createPoiApiResponses,
}
