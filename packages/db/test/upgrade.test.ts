/**
 * Upgrade path between versions (roadmap 6.5): a database migrated by an
 * older app version (only a prefix of the migrations) with real, encrypted
 * data is upgraded to the current version. Data must survive unchanged and
 * the resulting schema must equal a fresh installation's.
 *
 * Uses two throwaway databases so the shared test database is untouched.
 * Skipped when DATABASE_URL is unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  decryptField,
  encryptField,
  generateDataKey,
  messageFieldAad,
  outboxContentAad,
  unwrapAccountKey,
  wrapDataKey,
} from '@fma/crypto'
import { migrations, runMigrations, SchemaTooNewError } from '../src/migrate'

const databaseUrl = process.env.DATABASE_URL
const MASTER_KEY_B64 = randomBytes(32).toString('base64')

/** Last migration of the simulated "previous version". */
const PREVIOUS_VERSION = '0006_outbox'

function urlFor(database: string): string {
  const url = new URL(databaseUrl ?? '')
  url.pathname = `/${database}`
  return url.toString()
}

/** Columns, indexes and constraints of the public schema, order-independent. */
async function schemaSnapshot(pool: pg.Pool): Promise<string[]> {
  const columns = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema = 'public'`,
  )
  const indexes = await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'`)
  const constraints = await pool.query(
    `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
  )
  return [
    ...columns.rows.map((r) => `col ${JSON.stringify(r)}`),
    ...indexes.rows.map((r) => `idx ${String(r.indexdef)}`),
    ...constraints.rows.map((r) => `con ${JSON.stringify(r)}`),
  ].sort()
}

describe.skipIf(!databaseUrl)('upgrade from a previous version', () => {
  let admin: pg.Pool
  let upgraded: pg.Pool
  let fresh: pg.Pool
  const dbs = [
    `fma_upgrade_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    `fma_fresh_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  ]

  const userId = randomUUID()
  const accountId = randomUUID()
  const identityId = randomUUID()
  const folderId = randomUUID()
  const messageId = randomUUID()
  const outboxId = randomUUID()
  const subject = 'Quarterly report – Grüße'
  const outboxContent = 'From: me@example.org\r\nSubject: queued\r\n\r\nqueued body\r\n'

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 })
    for (const name of dbs) await admin.query(`CREATE DATABASE ${name}`)
    upgraded = new pg.Pool({ connectionString: urlFor(dbs[0]!), max: 2 })
    fresh = new pg.Pool({ connectionString: urlFor(dbs[1]!), max: 2 })
  })

  afterAll(async () => {
    await upgraded.end()
    await fresh.end()
    for (const name of dbs) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.end()
  })

  it('upgrades a populated database and keeps encrypted data readable', async () => {
    const cut = migrations.findIndex((m) => m.name === PREVIOUS_VERSION) + 1
    expect(cut).toBeGreaterThan(0)
    expect(cut).toBeLessThan(migrations.length)
    const previous = migrations.slice(0, cut)

    // 1. "Previous version": schema up to PREVIOUS_VERSION.
    expect(await runMigrations(upgraded, previous)).toEqual(previous.map((m) => m.name))

    // 2. Data as the previous version wrote it.
    const dek = generateDataKey()
    const wrapped = Buffer.from(wrapDataKey(Buffer.from(MASTER_KEY_B64, 'base64'), dek, 'v1'))
    const enc = (field: 'subject' | 'from' | 'recipients' | 'snippet', value: string): Buffer =>
      Buffer.from(encryptField(dek, value, messageFieldAad(field, messageId)), 'utf8')

    await upgraded.query(
      `INSERT INTO "user" (id, email, password_hash) VALUES ($1, 'owner@example.org', 'hash')`,
      [userId],
    )
    await upgraded.query(
      `INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port,
         smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
       VALUES ($1, $2, 'Work', 'me@example.org', 'imap.example.org', 993,
         'smtp.example.org', 465, $3, 'v1', $4)`,
      [accountId, userId, wrapped, Buffer.from(encryptField(dek, 'secret', 'credential'))],
    )
    // Two identities with the same address: migration 0012 deduplicates them.
    await upgraded.query(
      `INSERT INTO identity (id, account_id, name, email_address) VALUES
         ($1, $2, 'Me', 'me@example.org'), ($3, $2, 'Me again', 'ME@example.org')`,
      [identityId, accountId, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
    )
    await upgraded.query(
      `INSERT INTO folder (id, account_id, path, special_use, uidvalidity, uidnext)
       VALUES ($1, $2, 'Sent', '\\Sent', 7, 42)`,
      [folderId, accountId],
    )
    await upgraded.query(
      `INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc,
         recipients_enc, snippet_enc, size_bytes)
       VALUES ($1, $2, '<m1@example.org>', $3, $4, $5, $6, 1234)`,
      [
        messageId,
        accountId,
        enc('subject', subject),
        enc('from', 'a@example.org'),
        enc('recipients', 'me@example.org'),
        enc('snippet', 'Hello'),
      ],
    )
    await upgraded.query(
      `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid, flags)
       VALUES ($1, $2, 7, 41, $3)`,
      [messageId, folderId, ['\\Seen']],
    )
    await upgraded.query(
      `INSERT INTO message_body (message_id, storage_ref) VALUES ($1, 'ab/cd.enc')`,
      [messageId],
    )
    await upgraded.query(
      `INSERT INTO outbox_message (id, account_id, identity_id, content_enc, message_id_header)
       VALUES ($1, $2, $3, $4, '<o1@example.org>')`,
      [
        outboxId,
        accountId,
        identityId,
        Buffer.from(encryptField(dek, outboxContent, outboxContentAad(outboxId))),
      ],
    )

    // 3. Upgrade: the current version applies the remaining migrations.
    const applied = await runMigrations(upgraded)
    expect(applied).toEqual(migrations.slice(cut).map((m) => m.name))

    // 4. Data survived and is still decryptable with the same master key.
    const account = await upgraded.query(
      'SELECT wrapped_dek, last_error_code, default_identity_id FROM mail_account WHERE id = $1',
      [accountId],
    )
    expect(account.rows).toHaveLength(1)
    const dekAfter = unwrapAccountKey(MASTER_KEY_B64, account.rows[0].wrapped_dek as Buffer)
    expect(dekAfter.equals(dek)).toBe(true)

    const msg = await upgraded.query(
      'SELECT subject_enc, metadata_version, thread_id FROM message WHERE id = $1',
      [messageId],
    )
    expect(
      decryptField(
        dekAfter,
        (msg.rows[0].subject_enc as Buffer).toString('utf8'),
        messageFieldAad('subject', messageId),
      ),
    ).toBe(subject)
    expect(msg.rows[0].metadata_version).toBe(1)

    const loc = await upgraded.query(
      'SELECT uid, flags FROM message_location WHERE message_id = $1',
      [messageId],
    )
    expect(loc.rows).toEqual([{ uid: '41', flags: ['\\Seen'] }])

    const body = await upgraded.query(
      'SELECT storage_ref, skip_reason FROM message_body WHERE message_id = $1',
      [messageId],
    )
    expect(body.rows).toEqual([{ storage_ref: 'ab/cd.enc', skip_reason: null }])

    const folder = await upgraded.query(
      'SELECT special_use_detected, selectable FROM folder WHERE id = $1',
      [folderId],
    )
    expect(folder.rows).toEqual([{ special_use_detected: '\\Sent', selectable: true }])

    const identities = await upgraded.query('SELECT id::text FROM identity WHERE account_id = $1', [
      accountId,
    ])
    expect(identities.rows).toEqual([{ id: identityId }])

    const outbox = await upgraded.query(
      'SELECT content_enc, status, attachment_count, client_id FROM outbox_message WHERE id = $1',
      [outboxId],
    )
    expect(outbox.rows[0].status).toBe('queued')
    expect(outbox.rows[0].attachment_count).toBe(0)
    expect(
      decryptField(
        dekAfter,
        (outbox.rows[0].content_enc as Buffer).toString('utf8'),
        outboxContentAad(outboxId),
      ),
    ).toBe(outboxContent)

    // 5. Schema equals a fresh installation of the current version.
    await runMigrations(fresh)
    expect(await schemaSnapshot(upgraded)).toEqual(await schemaSnapshot(fresh))
  })

  it('a second start after the upgrade applies nothing', async () => {
    expect(await runMigrations(upgraded)).toEqual([])
  })

  it('an older app version refuses a database migrated by a newer one', async () => {
    const older = migrations.slice(0, -1)
    await expect(runMigrations(upgraded, older)).rejects.toThrow(SchemaTooNewError)
    await expect(runMigrations(upgraded, older)).rejects.toThrow(
      migrations[migrations.length - 1]!.name,
    )
  })
})
