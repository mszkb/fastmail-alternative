import Fastify, { type FastifyInstance } from 'fastify'
import type { HealthStatus } from '@fma/shared'
import { registerAuth } from './auth/routes'
import { pool } from './db'
import { buildLoggerOptions } from './logging'
import { accountRoutes } from './mail/accounts'
import { Metrics } from './metrics'

export interface AppOptions {
  /** Logging can be disabled to keep test output clean. */
  logger?: boolean
}

/**
 * Builds the Fastify instance without starting to listen, so the app can be
 * started standalone and tested in integration tests later on.
 *
 * All routes live under /api/* (caddy forwards /api/* as-is; native clients
 * later use the same paths, see ADR-0010).
 */
export function buildApp({ logger = true }: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: logger ? buildLoggerOptions() : false,
    trustProxy: true,
  })

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

  return app
}
