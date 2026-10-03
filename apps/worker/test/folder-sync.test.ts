/**
 * Integration tests for the folder_sync job (roadmap 2.2 step 1). Requires
 * DATABASE_URL (Postgres) and a GreenMail instance (CI service containers,
 * locally via SSH tunnel + docker on the Pi). Skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { ImapFlow } from 'imapflow'
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

  it('refuses to connect to private hosts outside test mode (SSRF guard)', async () => {
    const allow = process.env.MAIL_ALLOW_PRIVATE_HOSTS
    delete process.env.MAIL_ALLOW_PRIVATE_HOSTS
    try {
      // GreenMail runs on a loopback/private address.
      await expect(runFolderSync(pool, accountId)).rejects.toMatchObject({
        code: 'PRIVATE_HOST_BLOCKED',
      })
    } finally {
      if (allow !== undefined) process.env.MAIL_ALLOW_PRIVATE_HOSTS = allow
    }
    const { rows } = await pool.query('SELECT 1 FROM folder WHERE account_id = $1', [accountId])
    expect(rows).toHaveLength(0)
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
    // uidvalidity belongs to message_sync (changes must stay detectable).
    expect(row.uidvalidity).toBeNull()
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

  it('detects roles by name without SPECIAL-USE and keeps manual overrides', async () => {
    const imap = new ImapFlow({
      host: greenmailHost!,
      port: Number(process.env.GREENMAIL_IMAP_PORT),
      secure: false,
      doSTARTTLS: false,
      auth: { user: process.env.GREENMAIL_USER!, pass: process.env.GREENMAIL_PASSWORD! },
      logger: false,
    })
    const created = ['Gesendete Objekte', 'Papierkorb', 'Junk-E-Mail', 'Projekte']
    await imap.connect()
    for (const path of created) await imap.mailboxCreate(path).catch(() => {})

    const roles = async () => {
      const { rows } = await pool.query<{ path: string; special_use: string | null }>(
        'SELECT path, special_use FROM folder WHERE account_id = $1',
        [accountId],
      )
      return Object.fromEntries(rows.map((row) => [row.path, row.special_use]))
    }

    await runFolderSync(pool, accountId)
    expect(await roles()).toMatchObject({
      INBOX: 'inbox',
      'Gesendete Objekte': 'sent',
      Papierkorb: 'trash',
      'Junk-E-Mail': 'junk',
      Projekte: null,
    })

    // Manual mapping (PATCH /api/folders/:id) survives the next sync.
    await pool.query(
      `UPDATE folder SET special_use_override = 'sent'
       WHERE account_id = $1 AND path = 'Projekte'`,
      [accountId],
    )
    await runFolderSync(pool, accountId)
    const after = await roles()
    expect(after).toMatchObject({ Projekte: 'sent', 'Gesendete Objekte': null })
    expect(Object.values(after).filter((role) => role === 'sent')).toHaveLength(1)

    for (const path of created) await imap.mailboxDelete(path).catch(() => {})
    await imap.logout()
  })
})
