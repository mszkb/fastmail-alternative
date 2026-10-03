/**
 * CSRF protection for state-changing requests (ADR-0004, roadmap 6.4).
 *
 * Two layers, no tokens:
 * 1. The session cookie is SameSite=Strict, so browsers do not attach it to
 *    cross-site requests at all.
 * 2. Every request with a method other than GET/HEAD/OPTIONS is checked for
 *    its browser-provided origin (same approach as Go's
 *    http.CrossOriginProtection):
 *    - `Sec-Fetch-Site` present: only `same-origin` is accepted
 *      (`same-site` is rejected too: a sibling subdomain is not trusted).
 *    - otherwise `Origin` present: its host must equal the request host.
 *    - neither header: not a (modern) browser request, e.g. curl or a future
 *      native client; such clients cannot be driven cross-site, so the
 *      request is allowed.
 *
 * Both headers are forbidden header names, i.e. page scripts cannot forge
 * them, and browsers send them on every fetch()/form POST. Therefore the web
 * client needs no custom header or token. The check runs in onRequest,
 * before any body (e.g. an attachment upload) is read.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isCrossOriginRequest(request: FastifyRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return false
  const fetchSite = request.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== '') {
    return fetchSite !== 'same-origin'
  }
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return true // "null" (sandboxed frames, file://) or garbage
    }
    return originHost.toLowerCase() !== (request.headers.host ?? '').toLowerCase()
  }
  return false
}

export function registerCsrfProtection(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isCrossOriginRequest(request)) {
      await reply.code(403).send({ message: 'Cross-origin request rejected' })
    }
  })
}
