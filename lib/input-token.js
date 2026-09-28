const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_INPUT_TOKEN_FILE = path.join(os.homedir(), '.poi-mcp', 'input-token')
const TOKEN_PATTERN = /^[a-f0-9]{64}$/

function loadOrCreateInputToken(tokenFile = DEFAULT_INPUT_TOKEN_FILE) {
  const existing = readValidToken(tokenFile)
  if (existing) {
    restrictPermissions(tokenFile)
    return existing
  }

  const directory = path.dirname(tokenFile)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  restrictPermissions(directory, 0o700)

  const token = crypto.randomBytes(32).toString('hex')
  try {
    fs.writeFileSync(tokenFile, `${token}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error

    const concurrent = readValidToken(tokenFile)
    if (concurrent) {
      restrictPermissions(tokenFile)
      return concurrent
    }
    fs.writeFileSync(tokenFile, `${token}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  restrictPermissions(tokenFile)
  return token
}

function readValidToken(tokenFile) {
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim()
    return TOKEN_PATTERN.test(token) ? token : null
  } catch (_) {
    return null
  }
}

function restrictPermissions(target, mode = 0o600) {
  try {
    fs.chmodSync(target, mode)
  } catch (_) {}
}

module.exports = {
  DEFAULT_INPUT_TOKEN_FILE,
  loadOrCreateInputToken,
}
