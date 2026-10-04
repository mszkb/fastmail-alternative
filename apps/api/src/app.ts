import Fastify, { type FastifyInstance } from 'fastify'
import type { HealthStatus } from '@fma/shared'
import { registerAuth } from './auth/routes'
import { pool } from './db'
import { buildLoggerOptions } from './logging'
import { accountRoutes } from './mail/accounts'
import { configTransferRoutes } from './mail/config-transfer'
import { draftRoutes } from './mail/drafts'
import { folderRoutes } from './mail/folders'
import { identityRoutes } from './mail/identities'
import { messageActionRoutes } from './mail/message-actions'
import { attachmentRoutes } from './mail/attachments'
import { messageHtmlRoutes } from './mail/message-html'
import { messageRoutes } from './mail/messages'
import { outboxRoutes } from './mail/outbox'
import { searchRoutes } from './mail/search'
import { storageRoutes } from './mail/storage'
import { syncRoutes } from './mail/sync'
import { Metrics } from './metrics'
import { pushRoutes } from './push/routes'
import { trustOnePrivateProxy } from './security/client-ip'
import { registerCsrfProtection } from './security/csrf'
import { registerSecurityHeaders } from './security/headers'
import { DEFAULT_RATE_LIMITS, registerRateLimits, type RateLimitRule } from './security/rate-limit'

/** Time to receive one complete request (also upload bodies on slow links). */
export const REQUEST_TIMEOUT_MS = 120_000

export interface AppOptions {
  /** Logging can be disabled to keep test output clean. */
  logger?: boolean
  /** Destination of the log lines (tests inspect them); default stdout. */
  logStream?: NodeJS.WritableStream
  /** Rate limit rules (tests lower them); default DEFAULT_RATE_LIMITS. */
  rateLimits?: RateLimitRule[]
}

/**
 * Builds the Fastify instance without starting to listen, so the app can be
 * started standalone and tested in integration tests later on.
 *
 * All routes live under /api/* (caddy forwards /api/* as-is; native clients
 * later use the same paths, see ADR-0010).
 */
export function buildApp({
  logger = true,
  logStream,
  rateLimits = DEFAULT_RATE_LIMITS,
}: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: logger
      ? { ...buildLoggerOptions(), ...(logStream ? { stream: logStream } : {}) }
      : false,
    // Only the reverse proxy in front of the api is trusted for
    // X-Forwarded-For (security/client-ip.ts).
    trustProxy: trustOnePrivateProxy,
    // Slow-body protection: a request (headers and body, e.g. a 10 MB
    // upload) must arrive within this time, else the socket is closed.
    // Fastify's default (0) would switch off Node's own limit.
    requestTimeout: REQUEST_TIMEOUT_MS,
  })

  // Hardening (roadmap 6.4): order matters - rejected requests are answered
  // before authentication or body parsing. Protected routes authenticate in
  // onRequest as well (requireAuth), i.e. before any body is read.
  registerSecurityHeaders(app)
  registerRateLimits(app, rateLimits)
  registerCsrfProtection(app)

  const metrics = new Metrics()

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url ?? 'unmatched'
    metrics.inc(`{method="${request.method}",route="${route}",status="${reply.statusCode}"}`)
    metrics.observe('http_request_duration_seconds', reply.elapsedTime / 1000)
  })

  // Liveness/readiness: reports ok only when the database is reachable,
  // since the api cannot serve any request without it.
  app.get<{ Reply: HealthStatus }>('/api/health', async (request, reply) => {
    let database: 'ok' | 'down' = 'ok'
    try {
      await pool.query('SELECT 1')
    } catch (err) {
      database = 'down'
      request.log.warn({ err: (err as Error).message }, 'health check: database unreachable')
    }
    const body: HealthStatus = {
      status: database === 'ok' ? 'ok' : 'degraded',
      service: 'api',
      version: process.env.APP_VERSION ?? '0.0.0',
      checks: { database },
    }
    if (database === 'down') {
      await reply.code(503).send(body)
      return
    }
    await reply.send(body)
  })

  // Prometheus metrics. Disabled unless METRICS_TOKEN is configured; the
  // token avoids exposing operational data publicly.
  app.get('/api/metrics', async (request, reply) => {
    const expected = process.env.METRICS_TOKEN
    if (!expected) {
      await reply.code(404).send({ message: 'Not found' })
      return
    }
    if (request.headers.authorization !== `Bearer ${expected}`) {
      await reply.code(401).send({ message: 'Invalid metrics token' })
      return
    }
    await reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render())
  })

  registerAuth(app, pool)
  app.register(accountRoutes)
  app.register(messageRoutes)
  app.register(folderRoutes)
  app.register(messageActionRoutes)
  app.register(messageHtmlRoutes)
  app.register(attachmentRoutes)
  app.register(outboxRoutes)
  app.register(draftRoutes)
  app.register(searchRoutes)
  app.register(identityRoutes)
  app.register(syncRoutes)
  app.register(storageRoutes)
  app.register(pushRoutes)
  app.register(configTransferRoutes)

  return app
}
