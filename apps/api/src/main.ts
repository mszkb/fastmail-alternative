import { runMigrations } from '@fma/db/migrate'
import { pool } from './db'
import { buildApp } from './app'
import { ensureSetupCode } from './auth/setup-code'

const host = process.env.HOST ?? '0.0.0.0'
const port = Number.parseInt(process.env.PORT ?? '3001', 10)

async function main(): Promise<void> {
  const app = buildApp()

  // Migrations run automatically on startup (ADR-0007), before accepting
  // traffic. Idempotent: already-applied migrations are skipped.
  const applied = await runMigrations(pool)
  if (applied.length > 0) {
    app.log.info({ applied }, 'migrations applied')
  }

  // First-run setup (ASVS review M1): log the setup code once while the
  // instance has no user yet.
  const { rows } = await pool.query('SELECT NOT EXISTS (SELECT 1 FROM "user") AS fresh')
  if (rows[0].fresh === true) ensureSetupCode(app.log)

  await app.listen({ host, port })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info({ signal }, 'shutting down')
      app
        .close()
        .catch((err) => app.log.error(err))
        .finally(() => {
          pool.end().catch(() => {})
          process.exit(0)
        })
    })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
