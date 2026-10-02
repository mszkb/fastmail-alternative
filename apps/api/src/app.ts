import Fastify, { type FastifyInstance } from 'fastify'
import type { HealthStatus } from '@fma/shared'

export interface AppOptions {
  /** Logging can be disabled to keep test output clean. */
  logger?: boolean
}

/**
 * Builds the Fastify instance without starting to listen, so the app can be
 * started standalone and tested in integration tests later on.
 */
export function buildApp({ logger = true }: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger })

  app.get<{ Reply: HealthStatus }>('/health', async () => ({
    status: 'ok',
    service: 'api',
    version: process.env.APP_VERSION ?? '0.0.0',
  }))

  return app
}
