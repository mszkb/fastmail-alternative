/**
 * Integration tests for IMAP IDLE (roadmap 2.2). Requires DATABASE_URL +
 * GreenMail. Other tests share the GreenMail INBOX, so assertions only look
 * at job rows of the accounts created here.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import nodemailer from 'nodemailer'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import { IdleManager, idleBackoffMs } from '../src/idle'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST
const greenmailUser = process.env.GREENMAIL_USER ?? ''
const greenmailPassword = process.env.GREENMAIL_PASSWORD ?? ''

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

describe('idle backoff', () => {
  it('grows exponentially with jitter and is capped', () => {
    expect(idleBackoffMs(1, () => 1)).toBe(5_000)
    expect(idleBackoffMs(1, () => 0)).toBe(2_500)
    expect(idleBackoffMs(3, () => 1)).toBe(20_000)
    expect(idleBackoffMs(50, () => 1)).toBe(30 * 60_000)
  })
})

describe.skipIf(!databaseUrl || !greenmailHost)('IMAP IDLE manager', () => {
  let pool: pg.Pool
  let userId: string

  async function createAccount(password: string): Promise<{ accountId: string; folderId: string }> {
    const accountId = randomUUID()
    const masterKey = loadMasterKey(process.env.MASTER_KEY!)
    const dek = generateDataKey()
    const wrappedDek = wrapDataKey(masterKey, dek, process.env.MASTER_KEY_ID ?? 'v1')
    const credentialEnc = Buffer.from(
      encryptField(
        dek,
        JSON.stringify({ imapUser: greenmailUser, imapPassword: password }),
        `mail_account.credential:${accountId}`,
      ),
      'utf8',
    )
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, 'Idle', $3, $4, $5, 'smtp.test', 465, $6, $7, $8, 'ok')`,
      [
        accountId,
        userId,
        greenmailUser,
        greenmailHost,
        Number(process.env.GREENMAIL_IMAP_PORT),
        wrappedDek,
        process.env.MASTER_KEY_ID ?? 'v1',
        credentialEnc,
      ],
    )
    const folder = await pool.query<{ id: string }>(
      `INSERT INTO folder (account_id, path) VALUES ($1, 'INBOX') RETURNING id`,
      [accountId],
    )
    return { accountId, folderId: folder.rows[0]!.id }
  }

  async function inboxSyncJobs(accountId: string, folderId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM job
       WHERE type = 'message_sync' AND account_id = $1 AND payload->>'folderId' = $2`,
      [accountId, folderId],
    )
    return Number(rows[0]!.count)
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message, message_location, message_body CASCADE',
    )
    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`idle-${Date.now()}@example.com`],
    )
    userId = user.rows[0]!.id
  })

  afterAll(async () => {
    await pool.query('TRUNCATE "user", mail_account, job CASCADE')
    await pool.end()
  })

  it('enqueues an INBOX message_sync on new mail; a bad account blocks nothing', async () => {
    const good = await createAccount(greenmailPassword)
    const bad = await createAccount('wrong-password')
    const disabled = await createAccount(greenmailPassword)
    await pool.query(`UPDATE mail_account SET status = 'disabled' WHERE id = $1`, [
      disabled.accountId,
    ])

    const manager = new IdleManager(pool, { reconcileMs: 500 })
    try {
      await manager.start()
      expect(manager.managedAccountIds().sort()).toEqual([good.accountId, bad.accountId].sort())
      expect(await waitFor(() => manager.connectedAccountIds().includes(good.accountId))).toBe(true)
      expect(manager.connectedAccountIds()).not.toContain(bad.accountId)
      await pool.query('DELETE FROM job WHERE account_id = $1', [good.accountId])

      const transporter = nodemailer.createTransport({
        host: greenmailHost,
        port: Number(process.env.GREENMAIL_SMTP_PORT),
        secure: false,
        tls: { rejectUnauthorized: false },
      })
      await transporter.sendMail({
        from: 'idle-sender@example.com',
        to: greenmailUser,
        subject: 'IDLE test',
        text: 'IDLE test mail.',
      })

      expect(
        await waitFor(async () => (await inboxSyncJobs(good.accountId, good.folderId)) > 0),
      ).toBe(true)
      // Deduplicated: further events while the job is queued add nothing.
      expect(await inboxSyncJobs(good.accountId, good.folderId)).toBe(1)
      expect(await inboxSyncJobs(bad.accountId, bad.folderId)).toBe(0)

      // Disabling an account closes its connection on the next reconcile.
      await pool.query(`UPDATE mail_account SET status = 'disabled' WHERE id = $1`, [
        good.accountId,
      ])
      expect(await waitFor(() => !manager.managedAccountIds().includes(good.accountId))).toBe(true)
      await pool.query(`UPDATE mail_account SET status = 'ok' WHERE id = $1`, [good.accountId])
      expect(await waitFor(() => manager.connectedAccountIds().includes(good.accountId))).toBe(true)
    } finally {
      await manager.stop()
    }
    expect(manager.managedAccountIds()).toEqual([])
    expect(manager.connectedAccountIds()).toEqual([])
  })
})
