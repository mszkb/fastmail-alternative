/**
 * Default security headers for every api response (roadmap 6.4).
 *
 * Only set when the route did not set the header itself: attachment
 * downloads and the HTML view bring their own, stricter or more specific
 * values (CSP sandbox, Cache-Control), which must not be overridden.
 *
 * The api only returns JSON and downloads, never a document that needs to
 * load anything, so the CSP denies everything. HSTS is added by caddy for
 * the whole origin (it knows whether TLS is in use).
 */
import type { FastifyInstance } from 'fastify'

export const API_SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  // API responses are per-user data; nothing may end up in shared caches.
  'cache-control': 'no-store',
}

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) void reply.header(name, value)
    }
    return payload
  })
}
