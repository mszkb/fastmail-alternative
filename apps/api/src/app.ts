import Fastify, { type FastifyInstance } from 'fastify'
import type { HealthStatus } from '@fma/shared'
import { registerAuth } from './auth/routes'
import { pool } from './db'

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
  const app = Fastify({ logger, trustProxy: true })

  app.get<{ Reply: HealthStatus }>('/api/health', async () => ({
    status: 'ok',
    service: 'api',
    version: process.env.APP_VERSION ?? '0.0.0',
  }))

  registerAuth(app, pool)

  return app
}
