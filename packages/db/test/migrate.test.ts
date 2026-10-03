/**
 * Integration test for the migration runner. Requires a PostgreSQL instance:
 * set DATABASE_URL (CI provides a service container; locally e.g. via an
 * SSH tunnel to the compose postgres). Skipped when DATABASE_URL is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { migrations, runMigrations } from '../src/migrate'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('runMigrations', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    // Clean slate: drop everything the migrations create (test-only!).
    await pool.query(
      'DROP TABLE IF EXISTS job, folder, identity, mail_account, push_subscription, session, device, "user", schema_migrations CASCADE',
    )
    await pool.query('DROP EXTENSION IF EXISTS citext')
  })

  afterAll(async () => {
    await pool.query(
      'DROP TABLE IF EXISTS job, folder, identity, mail_account, push_subscription, session, device, "user", schema_migrations CASCADE',
    )
    await pool.query('DROP EXTENSION IF EXISTS citext')
    await pool.end()
  })

  it('applies all migrations and creates the expected tables', async () => {
    const applied = await runMigrations(pool)
    expect(applied).toEqual(migrations.map((m) => m.name))

    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    )
    const tables = rows.map((r) => String(r.table_name))
    for (const expected of [
      'user',
      'device',
      'session',
      'push_subscription',
      'schema_migrations',
    ]) {
      expect(tables).toContain(expected)
    }
  })

  it('is idempotent: a second run applies nothing', async () => {
    const applied = await runMigrations(pool)
    expect(applied).toEqual([])
  })
})
