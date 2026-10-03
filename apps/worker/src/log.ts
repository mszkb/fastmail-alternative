/**
 * Shared worker logger: structured JSON via pino with the central redaction
 * rules (roadmap 1.7). Never log mail contents or credentials.
 */
import pino from 'pino'
import { REDACT_LOG_PATHS } from '@fma/shared'

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACT_LOG_PATHS, censor: '[REDACTED]' },
  base: { service: 'worker' },
})
