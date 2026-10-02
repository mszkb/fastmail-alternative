/**
 * Worker entrypoint. The real jobs (IMAP sync, SMTP send, push, cleanup) are
 * added in later phases; this skeleton keeps the process alive, reacts to
 * shutdown signals and proves that the runtime works.
 */
const HEARTBEAT_MS = 60_000

const heartbeat = setInterval(() => {
  console.log(`[worker] alive at ${new Date().toISOString()}`)
}, HEARTBEAT_MS)
heartbeat.unref()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[worker] received ${signal}, shutting down`)
    clearInterval(heartbeat)
    process.exit(0)
  })
}

console.log('[worker] started (skeleton, no jobs yet)')
