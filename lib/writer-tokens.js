const crypto = require('crypto')

const TOKEN_PATTERN = /^[a-f0-9]{32,128}$/
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Daemon-delegated writer tokens (2026-09-12 single-writer plan, Phase C).
 *
 * The static input token authorizes whoever can read the file — forever. A
 * zombie from an earlier session therefore holds a valid credential forever.
 * This registry replaces that for INPUT endpoints: the daemon mints short
 * lived tokens (a generation token for itself, one per spawned job), pushes
 * them here over the admin endpoint, and revokes job tokens when the reaper
 * collects the job. A process that missed a rotation is rejected with a
 * readable reason instead of silently competing for clicks.
 *
 * Module-level singleton: bridge restarts (settings apply, hot reload) must
 * not silently drop the registered set — and when a hot reload DOES purge
 * this module, the daemon's periodic re-registration self-heals within one
 * idle cycle. The threat model is accidents, not adversaries: holding a
 * current token is a sufficient proxy for "delegated by the current daemon
 * generation", so there is deliberately no per-pid challenge/response.
 */
function createWriterTokenRegistry() {
  const entries = new Map() // token -> { label, registeredAt, expiresAt }
  let legacyAuthCount = 0
  let lastLegacyAuthAt = null
  let lastLegacyAuthDetail = null

  function sweep(now = Date.now()) {
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(token)
    }
  }

  return {
    register(payload, now = Date.now()) {
      const mode = payload && (payload.mode === 'add' || payload.mode === 'remove') ? payload.mode : 'replace'
      const list = payload && Array.isArray(payload.tokens) ? payload.tokens : []
      if (mode === 'replace') entries.clear()
      let accepted = 0
      let rejected = []
      for (const item of list) {
        const token = item && typeof item.token === 'string' ? item.token : null
        if (!TOKEN_PATTERN.test(token || '')) {
          rejected.push('invalid token shape')
          continue
        }
        const ttlMs = Number.isFinite(item.ttlMs) && item.ttlMs > 0 && item.ttlMs <= 7 * DEFAULT_TTL_MS
          ? Math.trunc(item.ttlMs)
          : DEFAULT_TTL_MS
        entries.set(token, {
          label: typeof item.label === 'string' && item.label !== '' ? item.label.slice(0, 128) : 'unlabeled',
          registeredAt: now,
          expiresAt: now + ttlMs,
        })
        accepted += 1
      }
      if (mode === 'remove') {
        for (const item of list) {
          if (item && typeof item.label === 'string') {
            for (const [token, entry] of entries) {
              if (entry.label === item.label) entries.delete(token)
            }
          }
        }
      }
      sweep(now)
      return { accepted, rejected: rejected.length }
    },

    validate(token, now = Date.now()) {
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false
      const entry = entries.get(token)
      if (!entry) return false
      if (entry.expiresAt <= now) {
        entries.delete(token)
        return false
      }
      return true
    },

    noteLegacyAuth(now = Date.now(), detail = null) {
      legacyAuthCount += 1
      lastLegacyAuthAt = new Date(now).toISOString()
      lastLegacyAuthDetail = typeof detail === 'string' && detail !== '' ? detail.slice(0, 160) : null
    },

    status(now = Date.now()) {
      sweep(now)
      return {
        registered: entries.size,
        tokens: [...entries.values()].map((entry) => ({
          label: entry.label,
          registeredAt: new Date(entry.registeredAt).toISOString(),
          expiresAt: new Date(entry.expiresAt).toISOString(),
        })),
        legacyAuthCount,
        lastLegacyAuthAt,
        lastLegacyAuthDetail,
      }
    },
  }
}

let singleton = null

function getWriterTokenRegistry() {
  if (!singleton) singleton = createWriterTokenRegistry()
  return singleton
}

function mintWriterToken() {
  return crypto.randomBytes(32).toString('hex')
}

function hasValidWriterToken(headerValue, registry, now = Date.now()) {
  if (typeof headerValue !== 'string' || headerValue === '') return false
  // In-process registry lookup: the timing-safe compare discipline applies to
  // the STATIC bearer token (a file secret); membership here is an in-memory
  // Map hit against an unregistered attacker-chosen value with no secret to
  // leak.
  return registry.validate(headerValue, now)
}

module.exports = {
  TOKEN_PATTERN,
  DEFAULT_TTL_MS,
  createWriterTokenRegistry,
  getWriterTokenRegistry,
  mintWriterToken,
  hasValidWriterToken,
}
