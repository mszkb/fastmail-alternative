/**
 * Worker entrypoint. The real jobs (IMAP sync, SMTP send, push, cleanup) are
 * added in later phases. The heartbeat keeps the process alive and shows
 * that the runtime works; shutdown signals stop it cleanly.
 *
 * Logging: structured JSON via pino with the central redaction rules
 * (roadmap 1.7).
 */
import pino from 'pino'
import { REDACT_LOG_PATHS } from '@fma/shared'

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACT_LOG_PATHS, censor: '[REDACTED]' },
  base: { service: 'worker' },
})

const HEARTBEAT_MS = 60_000

const heartbeat = setInterval(() => {
  log.info('alive')
}, HEARTBEAT_MS)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'shutting down')
    clearInterval(heartbeat)
    process.exit(0)
  })
}

log.info('worker started (skeleton, no jobs yet)')
