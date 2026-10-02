/**
 * Central log redaction rules (roadmap 1.7, DoD security rule 6: no
 * sensitive content in logs).
 *
 * Two mechanisms:
 * - `REDACT_LOG_PATHS`: static paths for pino's built-in redaction
 *   (used by api and worker logger configs).
 * - `redactForLog`: recursive key-based censoring for arbitrary objects
 *   before handing them to a logger.
 *
 * Never logged in cleartext: credentials, tokens, and everything a human
 * reads (subject, snippet, body, addresses) - see
 * docs/architecture/data-model.md (Verschlüsselung).
 */

export const SENSITIVE_LOG_KEYS = [
  // Credentials and tokens
  'password',
  'pass',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
  'credentials',
  'master_key',
  'vapid_private_key',
  // Mail content: everything a human reads (data model "Verschlüsselung")
  'subject',
  'snippet',
  'preview',
  'body',
  'html',
  'text',
  'address',
  'addresses',
] as const

const SENSITIVE_SET = new Set<string>(SENSITIVE_LOG_KEYS)

/** pino redact paths: top level, one and two levels of nesting. */
export const REDACT_LOG_PATHS: string[] = [
  ...SENSITIVE_LOG_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
  // Request logging leak vectors
  'req.headers.cookie',
  'req.headers.authorization',
  'req.body',
  'headers.cookie',
  'headers.authorization',
]

const CENSOR = '[REDACTED]'
const MAX_DEPTH = 10

/**
 * Returns a copy of `value` with sensitive keys censored. Handles nested
 * objects and arrays, is cycle-safe and never mutates the input.
 */
export function redactForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date || value instanceof Buffer) return value
  if (depth >= MAX_DEPTH || seen.has(value)) return CENSOR
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((entry) => redactForLog(entry, depth + 1, seen))
  }

  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_SET.has(key.toLowerCase())
      ? CENSOR
      : redactForLog(entry, depth + 1, seen)
  }
  return result
}
