/**
 * Minimal forward-only SQL migration runner (ADR-0002: pure SQL migrations,
 * chosen for phase 1.4).
 *
 * - Migrations are plain SQL, one module per migration, ordered by name.
 * - Applied migrations are recorded in `schema_migrations`; re-running is a
 *   no-op (idempotent startup per roadmap 1.4).
 * - Each migration runs in its own transaction.
 * - A session-level advisory lock prevents concurrent api instances from
 *   migrating at the same time.
 */
import type pg from 'pg'

export interface Migration {
  /** Unique, ordered name, e.g. `0001_users_devices_sessions`. */
  name: string
  /** Pure SQL, executed inside one transaction. */
  sql: string
}

/** Arbitrary but fixed lock id for this app's migration runner. */
const MIGRATION_LOCK_ID = 0x2f6d61n // "fma"

export const migrations: Migration[] = [
  {
    name: '0001_users_devices_sessions',
    sql: /* sql */ `
      CREATE EXTENSION IF NOT EXISTS citext;

      CREATE TABLE "user" (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email                  citext NOT NULL UNIQUE,
        password_hash          text NOT NULL,
        totp_secret_enc        bytea,
        unified_inbox_enabled  boolean NOT NULL DEFAULT false,
        created_at             timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE device (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
        name             text NOT NULL,
        platform         text NOT NULL,
        installation_id  uuid NOT NULL UNIQUE,
        last_seen_at     timestamptz,
        revoked_at       timestamptz
      );

      CREATE TABLE session (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id   uuid NOT NULL REFERENCES device (id) ON DELETE CASCADE,
        token_hash  bytea NOT NULL UNIQUE,
        expires_at  timestamptz NOT NULL,
        rotated_at  timestamptz
      );
      CREATE INDEX session_expires_at_idx ON session (expires_at);

      CREATE TABLE push_subscription (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id       uuid NOT NULL REFERENCES device (id) ON DELETE CASCADE,
        transport       text NOT NULL,
        endpoint        text NOT NULL,
        keys_enc        bytea NOT NULL,
        failure_count   integer NOT NULL DEFAULT 0,
        disabled_at     timestamptz
      );
      CREATE INDEX push_subscription_active_idx
        ON push_subscription (device_id) WHERE disabled_at IS NULL;
    `,
  },
]

/**
 * Runs all pending migrations. Returns the names of newly applied
 * migrations (empty array when everything was already applied).
 */
export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])

    await client.query(/* sql */ `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const { rows } = await client.query('SELECT name FROM schema_migrations')
    const applied = new Set<string>(rows.map((row) => String(row.name)))

    const newlyApplied: string[] = []
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name])
        await client.query('COMMIT')
        newlyApplied.push(migration.name)
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${migration.name} failed: ${String(err)}`)
      }
    }
    return newlyApplied
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {})
    client.release()
  }
}
