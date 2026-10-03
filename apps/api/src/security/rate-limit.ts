/**
 * In-memory rate limits per client IP (roadmap 6.4).
 *
 * Fixed one-minute windows, keyed by rule and IP. A single api instance
 * serves the whole installation, so no shared store (Redis) is needed; a
 * restart clears the counters, which is acceptable for abuse protection.
 *
 * The login lockout (auth/lockout.ts) and the per-account search limit
 * (mail/search.ts) stay in place; these limits come on top and also cover
 * routes that reach out to mail providers or accept large bodies.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export interface RateLimitRule {
  /** Name used in the key and in tests. */
  name: string
  /** Requests per window and IP. */
  max: number
  /** HTTP method and route pattern (Fastify route url); omitted = every request. */
  method?: string
  routes?: string[]
}

const WINDOW_MS = 60_000

/**
 * Specific rules are checked in addition to the global one, so a request
 * counts against both.
 */
export const DEFAULT_RATE_LIMITS: RateLimitRule[] = [
  // Generous ceiling for everything: the PWA syncs folders/lists in bursts.
  { name: 'global', max: 600 },
  // Password guessing (on top of the lockout) and the one-time setup.
  { name: 'auth', max: 10, method: 'POST', routes: ['/api/auth/login', '/api/auth/setup'] },
  // Creating/updating an account tests the credentials at the provider.
  { name: 'account-test', max: 10, method: 'POST', routes: ['/api/accounts'] },
  { name: 'account-test', max: 10, method: 'PATCH', routes: ['/api/accounts/:id'] },
  // Sending mail (an offline queue may replay several at once) and uploads.
  { name: 'send', max: 60, method: 'POST', routes: ['/api/outbox', '/api/outbox/:id/retry'] },
  { name: 'upload', max: 60, method: 'POST', routes: ['/api/accounts/:id/uploads'] },
  { name: 'import', max: 5, method: 'POST', routes: ['/api/import/config'] },
]

interface Counter {
  count: number
  resetAt: number
}

export class RateLimiter {
  private readonly counters = new Map<string, Counter>()
  private lastPrune = 0

  constructor(private readonly rules: RateLimitRule[]) {}

  /** Counts the request; returns seconds to wait when a limit is exceeded, else 0. */
  hit(method: string, route: string, ip: string, now = Date.now()): number {
    this.prune(now)
    let retryAfter = 0
    for (const rule of this.rules) {
      if (rule.method && rule.method !== method) continue
      if (rule.routes && !rule.routes.includes(route)) continue
      const key = `${rule.name}|${ip}`
      let counter = this.counters.get(key)
      if (!counter || counter.resetAt <= now) {
        counter = { count: 0, resetAt: now + WINDOW_MS }
        this.counters.set(key, counter)
      }
      counter.count += 1
      if (counter.count > rule.max) {
        retryAfter = Math.max(retryAfter, Math.ceil((counter.resetAt - now) / 1000))
      }
    }
    return retryAfter
  }

  private prune(now: number): void {
    if (now - this.lastPrune < WINDOW_MS) return
    this.lastPrune = now
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) this.counters.delete(key)
    }
  }
}

/** Registers the limiter as an onRequest hook (runs before body parsing). */
export function registerRateLimits(app: FastifyInstance, rules: RateLimitRule[]): void {
  const limiter = new RateLimiter(rules)
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const route = request.routeOptions?.url ?? 'unmatched'
    const retryAfter = limiter.hit(request.method, route, request.ip)
    if (retryAfter > 0) {
      await reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({ message: 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.' })
    }
  })
}
