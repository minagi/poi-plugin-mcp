const crypto = require('node:crypto')

const DEFAULT_TTL_MS = 10_000
const MAX_TTL_MS = 30_000
const MAX_ID_LENGTH = 256

function createPoiInputLease(options = {}) {
  const now = options.now || Date.now
  const createId = options.createId || crypto.randomUUID
  const defaultTtlMs = positiveInteger(
    options.defaultTtlMs == null ? DEFAULT_TTL_MS : options.defaultTtlMs,
    'defaultTtlMs',
  )
  const maxTtlMs = positiveInteger(
    options.maxTtlMs == null ? MAX_TTL_MS : options.maxTtlMs,
    'maxTtlMs',
  )
  if (defaultTtlMs > maxTtlMs) {
    throw new Error('defaultTtlMs must not exceed maxTtlMs')
  }

  let active = null

  function current() {
    if (active && active.expiresAtMs <= now()) {
      active = null
    }
    return active
  }

  function status() {
    const lease = current()
    return lease ? publicLease(lease) : null
  }

  function acquire(request) {
    if (current()) {
      throw leaseError('INPUT_LEASE_BUSY', 'Another input lease is active.')
    }
    const normalized = normalizeAcquireRequest(request, defaultTtlMs, maxTtlMs)
    const leaseId = boundedId(createId(), 'leaseId')
    active = {
      leaseId,
      ownerSessionId: normalized.ownerSessionId,
      runId: normalized.runId,
      mode: normalized.mode,
      action: normalized.action,
      expiresAtMs: now() + normalized.ttlMs,
      nextSequence: 1,
    }
    return publicLease(active)
  }

  function renew(request) {
    const lease = requireMatchingLease(request)
    const ttlMs = normalizeTtl(request && request.ttlMs, defaultTtlMs, maxTtlMs)
    lease.expiresAtMs = now() + ttlMs
    return publicLease(lease)
  }

  function release(request) {
    requireMatchingLease(request)
    active = null
    return true
  }

  function revoke(request) {
    const lease = current()
    if (!lease) {
      throw leaseError('INPUT_LEASE_REQUIRED', 'No input lease is active.')
    }
    if (boundedId(request && request.leaseId, 'leaseId') !== lease.leaseId) {
      throw leaseError('INPUT_LEASE_MISMATCH', 'Input lease identity does not match.')
    }
    active = null
    return true
  }

  function consumeInput(request) {
    const lease = requireMatchingLease(request)
    const action = boundedId(request && request.action, 'action')
    if (lease.mode === 'action' && action !== lease.action) {
      throw leaseError(
        'INPUT_LEASE_ACTION_MISMATCH',
        `Input action ${action} does not match lease action ${lease.action}.`,
      )
    }
    const sequence = request && request.sequence
    if (!Number.isSafeInteger(sequence) || sequence !== lease.nextSequence) {
      throw leaseError(
        'INPUT_SEQUENCE_MISMATCH',
        `Input sequence must be ${lease.nextSequence}.`,
      )
    }
    lease.nextSequence += 1
    return Object.freeze({
      leaseId: lease.leaseId,
      ownerSessionId: lease.ownerSessionId,
      runId: lease.runId,
      action,
      sequence,
      acceptedAt: new Date(now()).toISOString(),
    })
  }

  function assertClaimActive(claim) {
    const lease = requireMatchingLease(claim)
    const action = boundedId(claim && claim.action, 'action')
    const sequence = claim && claim.sequence
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequence >= lease.nextSequence ||
      (lease.mode === 'action' && action !== lease.action)
    ) {
      throw leaseError('INPUT_LEASE_MISMATCH', 'Input claim does not match the lease.')
    }
    return true
  }

  function requireMatchingLease(request) {
    const lease = current()
    if (!lease) {
      throw leaseError('INPUT_LEASE_REQUIRED', 'No input lease is active.')
    }
    const leaseId = boundedId(request && request.leaseId, 'leaseId')
    const ownerSessionId = boundedId(
      request && request.ownerSessionId,
      'ownerSessionId',
    )
    const runId = boundedId(request && request.runId, 'runId')
    if (
      lease.leaseId !== leaseId ||
      lease.ownerSessionId !== ownerSessionId ||
      lease.runId !== runId
    ) {
      throw leaseError('INPUT_LEASE_MISMATCH', 'Input lease identity does not match.')
    }
    return lease
  }

  return Object.freeze({
    status,
    acquire,
    renew,
    release,
    revoke,
    consumeInput,
    assertClaimActive,
  })
}

function normalizeAcquireRequest(request, defaultTtlMs, maxTtlMs) {
  const ownerSessionId = boundedId(request && request.ownerSessionId, 'ownerSessionId')
  const runId = boundedId(request && request.runId, 'runId')
  const mode = request && request.mode
  if (mode !== 'action' && mode !== 'workflow') {
    throw leaseError('INVALID_INPUT_LEASE', 'Input lease mode must be action or workflow.')
  }
  const action = request && request.action
  if (
    (mode === 'action' && (typeof action !== 'string' || action.length === 0)) ||
    (mode === 'workflow' && action !== null)
  ) {
    throw leaseError(
      'INVALID_INPUT_LEASE',
      'Action leases require an action and workflow leases require action null.',
    )
  }
  return {
    ownerSessionId,
    runId,
    mode,
    action: mode === 'action' ? boundedId(action, 'action') : null,
    ttlMs: normalizeTtl(request.ttlMs, defaultTtlMs, maxTtlMs),
  }
}

function normalizeTtl(value, defaultTtlMs, maxTtlMs) {
  const ttlMs = value == null ? defaultTtlMs : value
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw leaseError('INVALID_INPUT_LEASE', 'Input lease ttlMs must be a positive integer.')
  }
  return Math.min(ttlMs, maxTtlMs)
}

function publicLease(lease) {
  return Object.freeze({
    leaseId: lease.leaseId,
    ownerSessionId: lease.ownerSessionId,
    runId: lease.runId,
    mode: lease.mode,
    action: lease.action,
    expiresAt: new Date(lease.expiresAtMs).toISOString(),
    nextSequence: lease.nextSequence,
  })
}

function boundedId(value, name) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    throw leaseError('INVALID_INPUT_LEASE', `${name} must be a non-empty string.`)
  }
  return value
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function leaseError(code, message) {
  const error = new Error(message)
  error.code = code
  error.statusCode = code === 'INVALID_INPUT_LEASE' ? 400 : 409
  return error
}

module.exports = {
  createPoiInputLease,
}
