/**
 * Shared types and domain logic used by api, worker and web (ADR-0008).
 *
 * This package is consumed as TypeScript source (no build step). Rename the
 * `@fma` scope once the project has a final product name.
 */

export type ServiceName = 'api' | 'worker' | 'web'

/** Response shape of the `GET /health` endpoint. */
export interface HealthStatus {
  status: 'ok'
  service: ServiceName
  version: string
}
