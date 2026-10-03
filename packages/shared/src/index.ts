/**
 * Shared types and domain logic used by api, worker and web (ADR-0008).
 *
 * This package is consumed as TypeScript source (no build step). Rename the
 * `@fma` scope once the project has a final product name.
 */

export * from './compose'
export * from './mail'
export * from './redact'
export * from './request-scope'
export * from './threading'

export type ServiceName = 'api' | 'worker' | 'web'

/** Response shape of the `GET /api/health` endpoint. */
export interface HealthStatus {
  status: 'ok' | 'degraded'
  service: ServiceName
  version: string
  checks?: {
    database: 'ok' | 'down'
  }
}
