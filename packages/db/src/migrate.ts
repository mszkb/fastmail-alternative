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
 * - A database migrated by a newer app version (applied migrations this
 *   version does not know) is refused instead of running on an unknown
 *   schema; rollback = old image + restore of the pre-upgrade backup
 *   (docs/operations/upgrade.md).
 */
import type pg from 'pg'
import { migration0001 } from './migrations/0001_users_devices_sessions'
import { migration0002 } from './migrations/0002_mail_accounts'
import { migration0003 } from './migrations/0003_jobs_folders'
import { migration0004 } from './migrations/0004_messages'
import { migration0005 } from './migrations/0005_message_actions'
import { migration0006 } from './migrations/0006_outbox'
import { migration0007 } from './migrations/0007_message_metadata_version'
import { migration0008 } from './migrations/0008_threads'
import { migration0009 } from './migrations/0009_account_health'
import { migration0010 } from './migrations/0010_push'
import { migration0011 } from './migrations/0011_folder_roles'
import { migration0012 } from './migrations/0012_default_identity'
import { migration0013 } from './migrations/0013_message_body_skip'
import { migration0014 } from './migrations/0014_folder_selectable'
import { migration0015 } from './migrations/0015_outbox_client_id'
import { migration0016 } from './migrations/0016_drafts'
import { migration0017 } from './migrations/0017_attachment_uploads'
import { migration0018 } from './migrations/0018_cleanup_indexes'
import { migration0019 } from './migrations/0019_outbox_attachment_count'
import { migration0020 } from './migrations/0020_draft_attachments'
import { migration0021 } from './migrations/0021_draft_keep_source'

export interface Migration {
  /** Unique, ordered name, e.g. `0001_users_devices_sessions`. */
  name: string
  /** Pure SQL, executed inside one transaction. */
  sql: string
}

/** Arbitrary but fixed lock id for this app's migration runner. */
const MIGRATION_LOCK_ID = 0x2f6d61n // "fma"

/** Ordered list of all migrations. Append new ones at the end. */
export const migrations: Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
  migration0014,
  migration0015,
  migration0016,
  migration0017,
  migration0018,
  migration0019,
  migration0020,
  migration0021,
]

/** The database schema is newer than this app version. */
export class SchemaTooNewError extends Error {
  constructor(readonly unknownMigrations: string[]) {
    super(
      `database schema is newer than this app version (unknown migrations: ${unknownMigrations.join(', ')}); ` +
        'start the newer version or restore the pre-upgrade backup',
    )
    this.name = 'SchemaTooNewError'
  }
}

/**
 * Runs all pending migrations. Returns the names of newly applied
 * migrations (empty array when everything was already applied).
 */
export async function runMigrations(
  pool: pg.Pool,
  /** Migrations this app version knows; only tests pass a prefix. */
  list: readonly Migration[] = migrations,
): Promise<string[]> {
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
    const known = new Set(list.map((m) => m.name))
    const unknown = [...applied].filter((name) => !known.has(name)).sort()
    if (unknown.length > 0) throw new SchemaTooNewError(unknown)

    const newlyApplied: string[] = []
    for (const migration of list) {
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
