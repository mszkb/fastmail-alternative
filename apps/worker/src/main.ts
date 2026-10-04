/**
 * Worker entrypoint: one process that runs the worker service (./service)
 * until SIGINT/SIGTERM, then lets running jobs finish.
 */
import { log } from './log'
import { runWorker } from './service'

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'shutting down after running jobs')
    controller.abort()
  })
}

runWorker(controller.signal).catch((err) => {
  log.error({ err: (err as Error).stack ?? String(err) }, 'worker crashed')
  process.exit(1)
})
