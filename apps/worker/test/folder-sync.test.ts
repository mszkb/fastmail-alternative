/**
 * Integration tests for the folder_sync job (roadmap 2.2 step 1). Requires
 * DATABASE_URL (Postgres) and a GreenMail instance (CI service containers,
 * locally via SSH tunnel + docker on the Pi). Skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import { runFolderSync } from '../src/jobs/folder-sync'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST

describe.skipIf(!databaseUrl || !greenmailHost)('folder_sync job', () => {
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job CASCADE',
    )

    // Create user + account rows directly (credentials encrypted like the api does).
    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [`sync-${Date.now()}@example.com`, 'not-a-real-hash'],
    )
    accountId = randomUUID()
    const masterKey = loadMasterKey(process.env.MASTER_KEY!)
    const dek = generateDataKey()
    const wrappedDek = wrapDataKey(masterKey, dek, process.env.MASTER_KEY_ID ?? 'v1')
    const credentialEnc = Buffer.from(
      encryptField(
        dek,
        JSON.stringify({
          imapUser: process.env.GREENMAIL_USER,
          imapPassword: process.env.GREENMAIL_PASSWORD,
        }),
        `mail_account.credential:${accountId}`,
      ),
      'utf8',
    )
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, 'Sync-Test', $3, $4, $5, 'smtp.test', 465, $6, $7, $8, 'ok')`,
      [
        accountId,
        user.rows[0]!.id,
        process.env.GREENMAIL_USER,
        greenmailHost,
        Number(process.env.GREENMAIL_IMAP_PORT),
        wrappedDek,
        process.env.MASTER_KEY_ID ?? 'v1',
        credentialEnc,
      ],
    )
  })

  afterAll(async () => {
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job CASCADE',
    )
    await pool.end()
  })

  it('syncs folders from the IMAP server', async () => {
    await runFolderSync(pool, accountId)

    const { rows } = await pool.query<{ path: string; special_use: string | null }>(
      'SELECT path, special_use FROM folder WHERE account_id = $1 ORDER BY path',
      [accountId],
    )
    const paths = rows.map((row) => row.path)
    expect(paths).toContain('INBOX')
    const inbox = rows.find((row) => row.path === 'INBOX')
    expect(inbox?.special_use).toBe('inbox')
  })

  it('fills per-folder sync state', async () => {
    const { rows } = await pool.query<{
      uidvalidity: string
      uidnext: string
      last_synced_at: string | null
    }>(
      'SELECT uidvalidity, uidnext, last_synced_at FROM folder WHERE account_id = $1 AND path = $2',
      [accountId, 'INBOX'],
    )
    const row = rows[0]
    if (!row) throw new Error('INBOX folder row missing')
    expect(row.uidvalidity).toBeTruthy()
    expect(Number(row.uidnext)).toBeGreaterThan(0)
    expect(row.last_synced_at).toBeTruthy()
  })

  it('is idempotent: a second run does not duplicate folders', async () => {
    await runFolderSync(pool, accountId)
    const { rows } = await pool.query(
      'SELECT count(*)::int AS count FROM folder WHERE account_id = $1',
      [accountId],
    )
    const first = rows[0].count
    await runFolderSync(pool, accountId)
    const { rows: rows2 } = await pool.query(
      'SELECT count(*)::int AS count FROM folder WHERE account_id = $1',
      [accountId],
    )
    expect(rows2[0].count).toBe(first)
    expect(first).toBeGreaterThan(0)
  })

  it('removes folders that no longer exist on the server', async () => {
    await pool.query(`INSERT INTO folder (account_id, path) VALUES ($1, 'Gelöschter Ordner')`, [
      accountId,
    ])
    await runFolderSync(pool, accountId)
    const { rowCount } = await pool.query(
      'SELECT 1 FROM folder WHERE account_id = $1 AND path = $2',
      [accountId, 'Gelöschter Ordner'],
    )
    expect(rowCount).toBe(0)
  })
})
