/**
 * Structured JSON logging for the api (roadmap 1.7). Fastify uses pino
 * under the hood; the redaction paths come centrally from @fma/shared so
 * api and worker never drift apart.
 */
import type { LoggerOptions } from 'pino'
import { REDACT_LOG_PATHS } from '@fma/shared'

interface LoggedRequest {
  method?: string
  url?: string
  host?: string
  hostname?: string
  ip?: string
  socket?: { remotePort?: number }
}

/** Path without query string: queries may carry search terms (roadmap 5.1). */
export function stripQuery(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  const index = url.indexOf('?')
  return index < 0 ? url : url.slice(0, index)
}

export function buildLoggerOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: REDACT_LOG_PATHS,
      censor: '[REDACTED]',
    },
    base: {
      service: 'api',
    },
    // Like Fastify's default request serializer, but never with the query
    // string (e.g. GET /api/accounts/:id/search?q=...).
    serializers: {
      req(request: LoggedRequest) {
        return {
          method: request.method,
          url: stripQuery(request.url),
          host: request.host ?? request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        }
      },
    },
  }
}
