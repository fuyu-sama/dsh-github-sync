// Pre-push secret detection for dsh-github-sync.
//
// The repository is meant to hold configuration and skills, never credentials.
// A push that would publish something matching a known credential shape stops
// unless the caller explicitly forces it.

const RULES = [
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { id: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { id: 'api-key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'url-credentials', pattern: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/ }
]

/** Names that are never collected into the repository. */
const NEVER_SYNC_NAMES = new Set([
  '.env',
  '.git-credentials',
  '.npmrc',
  '.netrc',
  '.credentials.yaml',
  'credentials.yaml',
  'settings.yaml'
])

const NEVER_SYNC_SUFFIXES = ['.pem', '.key', '.p12', '.pfx']

export function isNeverSyncName(name) {
  if (NEVER_SYNC_NAMES.has(name)) return true
  if (name.startsWith('.env.')) return true
  if (name.startsWith('id_rsa') || name.startsWith('id_ed25519') || name.startsWith('id_ecdsa')) return true
  const lower = name.toLowerCase()
  return NEVER_SYNC_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

export function isLikelyBinary(buffer) {
  const limit = Math.min(buffer.length, 8192)
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

/** Scan one text value. Returns matches with a 1-based line number. */
export function scanText(text, relPath) {
  const matches = []
  const lines = String(text).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        matches.push({ path: relPath, line: index + 1, rule: rule.id })
      }
    }
  }
  return matches
}

/**
 * Scan collected snapshot entries. Binary files are skipped: the rules target
 * text tokens, and a binary match cannot be reviewed in a diff anyway.
 */
export function scanEntries(entries) {
  const matches = []
  for (const entry of entries) {
    if (isLikelyBinary(entry.data)) continue
    matches.push(...scanText(entry.data.toString('utf8'), entry.rel))
    if (matches.length >= 100) break
  }
  return matches
}
