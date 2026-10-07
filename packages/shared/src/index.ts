/**
 * Shared types and domain logic used by api, worker and web (ADR-0008).
 *
 * This package is consumed as TypeScript source (no build step). Rename the
 * `@fma` scope once the project has a final product name.
 */

export * from './account-avatar'
export * from './attachments'
export * from './badge'
export * from './compose'
export * from './config-export'
export * from './drafts'
export * from './folders'
export * from './foreground-sync'
export * from './install'
export * from './mail'
export * from './offline'
export * from './provider-presets'
export * from './pull-to-refresh'
export * from './swipe-back'
export * from './sync-status'
export * from './push'
export * from './redact'
export * from './request-scope'
export * from './search'
export * from './shortcuts'
export * from './storage'
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
