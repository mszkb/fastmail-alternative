/**
 * Setup code for the first-run setup (ASVS review M1).
 *
 * As long as no user exists, `POST /api/auth/setup` only accepts requests
 * carrying this code, so a scanner that finds a fresh instance (the domain
 * is public via Certificate Transparency as soon as Caddy fetched its
 * certificate) cannot claim it before the operator does.
 *
 * Source of the code:
 * - `SETUP_TOKEN` from the environment, if set (operator-chosen), else
 * - a random code generated on demand and written once to the log
 *   (`docker compose logs api`). It only exists while no user exists and is
 *   dropped after a successful setup.
 *
 * Comparison is case-insensitive and ignores spaces and dashes, so the code
 * can be typed in groups.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** 6 groups of 4 Base32 characters = 120 bits. */
const GROUPS = 6
const GROUP_LENGTH = 4

let generated: string | null = null
let tokenHintLogged = false

function normalize(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase()
}

function configuredToken(): string | null {
  const token = process.env.SETUP_TOKEN?.trim()
  return token ? token : null
}

function generateCode(): string {
  const bytes = randomBytes(GROUPS * GROUP_LENGTH)
  const chars = Array.from(bytes, (byte) => BASE32[byte % 32])
  const groups: string[] = []
  for (let i = 0; i < GROUPS; i += 1) {
    groups.push(chars.slice(i * GROUP_LENGTH, (i + 1) * GROUP_LENGTH).join(''))
  }
  return groups.join('-')
}

/**
 * Makes sure a setup code exists. Call only while no user exists: the
 * generated code is logged once, clearly marked. A configured SETUP_TOKEN
 * is never logged.
 */
export function ensureSetupCode(log: FastifyBaseLogger): void {
  if (configuredToken()) {
    if (!tokenHintLogged) {
      tokenHintLogged = true
      log.warn({ event: 'setup.pending' }, 'FIRST-RUN SETUP: enter the SETUP_TOKEN from .env')
    }
    return
  }
  if (generated) return
  generated = generateCode()
  // Deliberately logged: the operator needs it once to claim the instance.
  // It is no secret in the sense of stored credentials and loses all value
  // as soon as the first user exists.
  log.warn(
    { event: 'setup.pending' },
    `FIRST-RUN SETUP CODE: ${generated} (enter it on the setup page; valid until setup is done)`,
  )
}

/** Constant-time check of a submitted setup code. */
export function setupCodeMatches(given: unknown): boolean {
  const expected = configuredToken() ?? generated
  if (!expected || typeof given !== 'string' || given.length > 200) return false
  const digest = (value: string) => createHash('sha256').update(normalize(value), 'utf8').digest()
  return timingSafeEqual(digest(given), digest(expected))
}

/** Drops the generated code after a successful setup. */
export function discardSetupCode(): void {
  generated = null
  tokenHintLogged = false
}
