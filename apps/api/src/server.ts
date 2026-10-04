import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import { pool } from './db'
import { buildApp } from './app'

/**
 * Runs the migrations, then starts listening (HOST/PORT, default
 * 0.0.0.0:3001). Used by the api process (main.ts) and by the
 * single-process native mode (scripts/native.mjs).
 */
export async function startApi(): Promise<FastifyInstance> {
  const host = process.env.HOST ?? '0.0.0.0'
  const port = Number.parseInt(process.env.PORT ?? '3001', 10)
  const app = buildApp()

  // Migrations run automatically on startup (ADR-0007), before accepting
  // traffic. Idempotent: already-applied migrations are skipped.
  const applied = await runMigrations(pool)
  if (applied.length > 0) {
    app.log.info({ applied }, 'migrations applied')
  }

  await app.listen({ host, port })
  return app
}

/** Stops accepting requests, finishes open ones and closes the pool. */
export async function stopApi(app: FastifyInstance): Promise<void> {
  await app.close().catch((err: unknown) => app.log.error(err))
  await pool.end().catch(() => {})
}
