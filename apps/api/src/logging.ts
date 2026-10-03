/**
 * Structured JSON logging for the api (roadmap 1.7). Fastify uses pino
 * under the hood; the redaction paths come centrally from @fma/shared so
 * api and worker never drift apart.
 */
import type { LoggerOptions } from 'pino'
import { REDACT_LOG_PATHS } from '@fma/shared'

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
  }
}
