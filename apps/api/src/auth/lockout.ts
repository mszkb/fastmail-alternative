/**
 * Login lockout (ADR-0004: mandatory already in phase 1).
 *
 * In-memory, keyed by client IP: after 5 failed logins within 15 minutes,
 * the IP is locked out for 15 minutes. Single api instance, so in-memory
 * is sufficient; a restart clears the state (acceptable for a lockout).
 */

const WINDOW_MS = 15 * 60_000
const MAX_FAILS = 5
const LOCK_MS = 15 * 60_000

interface Entry {
  fails: number
  windowStart: number
  lockedUntil: number
}

const entries = new Map<string, Entry>()

/** Returns remaining lockout in seconds, or 0 if the IP may try to log in. */
export function isLockedOut(ip: string): number {
  const entry = entries.get(ip)
  if (!entry) return 0
  const remaining = entry.lockedUntil - Date.now()
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

/** Records a failed attempt; returns true when it started a lockout. */
export function recordFail(ip: string): boolean {
  const now = Date.now()
  prune(now)

  const entry = entries.get(ip)
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entries.set(ip, { fails: 1, windowStart: now, lockedUntil: 0 })
    return false
  }
  entry.fails += 1
  if (entry.fails >= MAX_FAILS && entry.lockedUntil <= now) {
    entry.lockedUntil = now + LOCK_MS
    return true
  }
  return false
}

export function recordSuccess(ip: string): void {
  entries.delete(ip)
}

function prune(now: number): void {
  for (const [ip, entry] of entries) {
    if (now - entry.windowStart > WINDOW_MS && entry.lockedUntil < now) {
      entries.delete(ip)
    }
  }
}
