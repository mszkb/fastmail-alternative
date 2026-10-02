import Fastify, { type FastifyInstance } from 'fastify'
import type { HealthStatus } from '@fma/shared'

/**
 * Builds the Fastify instance without starting to listen, so the app can be
 * started standalone and tested in integration tests later on.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true })

  app.get<{ Reply: HealthStatus }>('/health', async () => ({
    status: 'ok',
    service: 'api',
    version: process.env.APP_VERSION ?? '0.0.0',
  }))

  return app
}
