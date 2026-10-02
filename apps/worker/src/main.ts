/**
 * Worker entrypoint. The real jobs (IMAP sync, SMTP send, push, cleanup) are
 * added in later phases. The heartbeat keeps the process alive and shows
 * that the runtime works; shutdown signals stop it cleanly.
 */
const HEARTBEAT_MS = 60_000

const heartbeat = setInterval(() => {
  console.log(`[worker] alive at ${new Date().toISOString()}`)
}, HEARTBEAT_MS)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[worker] received ${signal}, shutting down`)
    clearInterval(heartbeat)
    process.exit(0)
  })
}

console.log('[worker] started (skeleton, no jobs yet)')
