/**
 * Integration tests for the message_sync job (roadmap 2.2 step 2). Requires
 * DATABASE_URL + GreenMail (CI service containers / local docker on the Pi).
 *
 * Flow: send two real mails into GreenMail via SMTP, run folder_sync +
 * message_sync, then verify DB state: encrypted-at-rest fields, decrypted
 * values, locations, body files in the mail-data directory, idempotency.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { runMigrations } from '@fma/db/migrate'
import {
  decryptField,
  encryptField,
  generateDataKey,
  loadMasterKey,
  wrapDataKey,
} from '@fma/crypto'
import { loadAccountContext } from '../src/accounts'
import { runFolderSync } from '../src/jobs/folder-sync'
import { runMessageSync } from '../src/jobs/message-sync'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST
const greenmailUser = process.env.GREENMAIL_USER ?? ''
const greenmailPassword = process.env.GREENMAIL_PASSWORD ?? ''

/** Runs fn with INBOX selected on GreenMail (used to mutate server state). */
async function withInbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: greenmailHost!,
    port: Number(process.env.GREENMAIL_IMAP_PORT),
    secure: false,
    auth: { user: greenmailUser, pass: greenmailPassword },
    logger: false,
    tls: { rejectUnauthorized: false },
    doSTARTTLS: false,
  })
  await client.connect()
  const lock = await client.getMailboxLock('INBOX')
  try {
    return await fn(client)
  } finally {
    lock.release()
    await client.logout().catch(() => client.close())
  }
}

describe.skipIf(!databaseUrl || !greenmailHost)('message_sync job', () => {
  let pool: pg.Pool
  let accountId: string
  let inboxFolderId: string
  let mailDataDir: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message, message_location, message_body CASCADE',
    )

    mailDataDir = await mkdtemp(path.join(tmpdir(), 'fma-mail-data-'))
    process.env.MAIL_DATA_DIR = mailDataDir

    // Register the account (single user) with GreenMail credentials.
    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [`msg-${Date.now()}@example.com`, 'not-a-real-hash'],
    )
    accountId = randomUUID()
    const masterKey = loadMasterKey(process.env.MASTER_KEY!)
    const dek = generateDataKey()
    const wrappedDek = wrapDataKey(masterKey, dek, process.env.MASTER_KEY_ID ?? 'v1')
    const credentialEnc = Buffer.from(
      encryptField(
        dek,
        JSON.stringify({ imapUser: greenmailUser, imapPassword: greenmailPassword }),
        `mail_account.credential:${accountId}`,
      ),
      'utf8',
    )
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, 'Msg-Test', $3, $4, $5, 'smtp.test', 465, $6, $7, $8, 'ok')`,
      [
        accountId,
        user.rows[0]!.id,
        greenmailUser,
        greenmailHost,
        Number(process.env.GREENMAIL_IMAP_PORT),
        wrappedDek,
        process.env.MASTER_KEY_ID ?? 'v1',
        credentialEnc,
      ],
    )

    // Helper: list INBOX UIDs via IMAP (also used to wait for deliveries).
    const { ImapFlow } = await import('imapflow')
    const fetchInboxUids = async (): Promise<number[]> => {
      const probe = new ImapFlow({
        host: greenmailHost,
        port: Number(process.env.GREENMAIL_IMAP_PORT),
        secure: false,
        auth: { user: greenmailUser, pass: greenmailPassword },
        logger: false,
        tls: { rejectUnauthorized: false },
        doSTARTTLS: false,
      })
      await probe.connect()
      const lock = await probe.getMailboxLock('INBOX')
      try {
        const uids: number[] = []
        for await (const msg of probe.fetch('1:*', { uid: true })) uids.push(msg.uid)
        return uids
      } finally {
        lock.release()
        probe.close()
      }
    }

    // Purge leftovers from previous test runs (GreenMail keeps mails for
    // the lifetime of the container).
    const purgeUids = await fetchInboxUids()
    if (purgeUids.length > 0) {
      const purge = new ImapFlow({
        host: greenmailHost,
        port: Number(process.env.GREENMAIL_IMAP_PORT),
        secure: false,
        auth: { user: greenmailUser, pass: greenmailPassword },
        logger: false,
        tls: { rejectUnauthorized: false },
        doSTARTTLS: false,
      })
      await purge.connect()
      const purgeLock = await purge.getMailboxLock('INBOX')
      try {
        await purge.messageDelete(purgeUids, { uid: true })
      } finally {
        purgeLock.release()
        purge.close()
      }
    }

    // Deliver two real mails into GreenMail via SMTP.
    const transporter = nodemailer.createTransport({
      host: greenmailHost,
      port: Number(process.env.GREENMAIL_SMTP_PORT),
      secure: false,
      tls: { rejectUnauthorized: false },
    })
    await transporter.sendMail({
      from: 'sender-one@example.com',
      to: greenmailUser,
      subject: 'Erste Testmail',
      text: 'Hallo von Testmail eins.',
    })
    await transporter.sendMail({
      from: 'sender-two@example.com',
      to: greenmailUser,
      subject: 'Zweite Testmail',
      text: 'Hallo von Testmail zwei.',
    })
    transporter.close()

    // GreenMail delivers asynchronously: wait until both mails are visible
    // via IMAP before syncing.
    const waitStart = Date.now()
    let visible = 0
    while (Date.now() - waitStart < 20_000) {
      visible = (await fetchInboxUids()).length
      if (visible >= 2) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    expect(visible).toBeGreaterThanOrEqual(2)

    // Mark the first mail as read on the server (unread_count must be 1).
    const seenClient = new ImapFlow({
      host: greenmailHost,
      port: Number(process.env.GREENMAIL_IMAP_PORT),
      secure: false,
      auth: { user: greenmailUser, pass: greenmailPassword },
      logger: false,
      tls: { rejectUnauthorized: false },
      doSTARTTLS: false,
    })
    await seenClient.connect()
    const seenLock = await seenClient.getMailboxLock('INBOX')
    try {
      await seenClient.messageFlagsAdd('1', ['\\Seen'])
    } finally {
      seenLock.release()
      seenClient.close()
    }

    // Sync folders first, then messages.
    await runFolderSync(pool, accountId)
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM folder WHERE account_id = $1 AND path = 'INBOX'",
      [accountId],
    )
    inboxFolderId = rows[0]!.id
  })

  afterAll(async () => {
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message, message_location, message_body CASCADE',
    )
    await pool.end()
    await rm(mailDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('syncs messages with encrypted metadata', async () => {
    await runMessageSync(pool, accountId, inboxFolderId)

    const { rows } = await pool.query<{
      id: string
      message_id_header: string
      subject_enc: Buffer
      from_enc: Buffer
      sent_at: Date | null
    }>(
      `SELECT id, message_id_header, subject_enc, from_enc, sent_at
       FROM message WHERE account_id = $1 ORDER BY created_at, message_id_header`,
      [accountId],
    )
    expect(rows.length).toBe(2)

    // Encrypted at rest: plaintext subjects must not be in the DB.
    const rawDb = JSON.stringify(rows)
    expect(rawDb).not.toContain('Erste Testmail')
    expect(rawDb).not.toContain('Zweite Testmail')

    // Decrypt via the account DEK and verify.
    const ctx = await loadAccountContext(pool, accountId, process.env.MASTER_KEY!)
    const subjects = rows.map((row) =>
      decryptField(ctx.dek, row.subject_enc.toString('utf8'), `message.subject:${row.id}`),
    )
    expect(subjects).toContain('Erste Testmail')
    expect(subjects).toContain('Zweite Testmail')
  })

  it('stores locations with uidvalidity and flags', async () => {
    const { rows } = await pool.query<{ uid: string; uidvalidity: string; flags: string[] }>(
      `SELECT ml.uid::text, ml.uidvalidity::text, ml.flags
       FROM message_location ml
       JOIN folder f ON f.id = ml.folder_id
       WHERE f.account_id = $1`,
      [accountId],
    )
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(Number(row.uid)).toBeGreaterThan(0)
      expect(BigInt(row.uidvalidity)).toBeGreaterThan(0)
    }
    // One mail was marked \Seen on the server before the sync.
    expect(rows.filter((row) => row.flags.includes('\\Seen')).length).toBe(1)

    const folder = await pool.query<{ unread_count: number }>(
      'SELECT unread_count FROM folder WHERE id = $1',
      [inboxFolderId],
    )
    expect(folder.rows[0]!.unread_count).toBe(1)
  })

  it('stores the raw mail encrypted in the mail-data directory', async () => {
    const { rows } = await pool.query<{
      message_id: string
      storage_ref: string
      text_plain_enc: Buffer
    }>('SELECT message_id, storage_ref, text_plain_enc FROM message_body')
    expect(rows.length).toBe(2)

    const ctx = await loadAccountContext(pool, accountId, process.env.MASTER_KEY!)
    for (const row of rows) {
      expect(row.storage_ref).toContain(accountId)
      const file = await readFile(path.join(mailDataDir, row.storage_ref))
      expect(file.toString('utf8')).toContain('fma.f1.')
      expect(file.toString('utf8')).not.toContain('Hallo von Testmail')

      const text = decryptField(
        ctx.dek,
        row.text_plain_enc.toString('utf8'),
        `message.text:${row.message_id}`,
      )
      expect(text).toMatch(/Hallo von Testmail (eins|zwei)\./)
    }
  })

  it('is idempotent: re-running does not duplicate messages or bodies', async () => {
    await runMessageSync(pool, accountId, inboxFolderId)

    const messages = await pool.query(
      'SELECT count(*)::int AS count FROM message WHERE account_id = $1',
      [accountId],
    )
    expect(messages.rows[0].count).toBe(2)
    const bodies = await pool.query('SELECT count(*)::int AS count FROM message_body')
    expect(bodies.rows[0].count).toBe(2)
    const locations = await pool.query('SELECT count(*)::int AS count FROM message_location')
    expect(locations.rows[0].count).toBe(2)
  })

  it('fetches only new messages on incremental runs', async () => {
    // Deliver a third mail, sync again: only the new one is fetched.
    const transporter = nodemailer.createTransport({
      host: greenmailHost,
      port: Number(process.env.GREENMAIL_SMTP_PORT),
      secure: false,
      tls: { rejectUnauthorized: false },
    })
    await transporter.sendMail({
      from: 'sender-three@example.com',
      to: greenmailUser,
      subject: 'Dritte Testmail',
      text: 'Hallo von Testmail drei.',
    })
    transporter.close()

    // GreenMail delivers asynchronously - poll until the new mail shows up.
    let count = 0
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      await runMessageSync(pool, accountId, inboxFolderId)
      const messages = await pool.query(
        'SELECT count(*)::int AS count FROM message WHERE account_id = $1',
        [accountId],
      )
      count = messages.rows[0].count
      if (count === 3) break
    }
    expect(count).toBe(3)

    // Incrementally fetched messages get their real server UID (regression:
    // the uid used to be mapped by fetch position and stored as 0).
    const serverUids = await withInbox(async (client) => {
      const uids: number[] = []
      for await (const msg of client.fetch('1:*', { uid: true })) uids.push(msg.uid)
      return uids
    })
    const locations = await pool.query<{ uid: string }>(
      'SELECT uid::text FROM message_location WHERE folder_id = $1 ORDER BY uid',
      [inboxFolderId],
    )
    expect(locations.rows.map((row) => Number(row.uid))).toEqual(serverUids)
  })

  it('reflects flag changes made on the server after a resync', async () => {
    const before = await pool.query<{ uid: string; flags: string[] }>(
      'SELECT uid::text, flags FROM message_location WHERE folder_id = $1 ORDER BY uid',
      [inboxFolderId],
    )
    const seenUid = Number(before.rows.find((row) => row.flags.includes('\\Seen'))!.uid)
    const unseenUid = Number(before.rows.find((row) => !row.flags.includes('\\Seen'))!.uid)

    // Server-side: unread the read mail, flag + read another one. Mutate by
    // sequence number (GreenMail's UID STORE with uid sets is unreliable).
    await withInbox(async (client) => {
      const uids: number[] = []
      for await (const msg of client.fetch('1:*', { uid: true })) uids.push(msg.uid)
      const seq = (uid: number) => String(uids.indexOf(uid) + 1)
      await client.messageFlagsRemove(seq(seenUid), ['\\Seen'])
      await client.messageFlagsAdd(seq(unseenUid), ['\\Seen', '\\Flagged'])
    })

    await runMessageSync(pool, accountId, inboxFolderId)

    const after = await pool.query<{ uid: string; flags: string[] }>(
      'SELECT uid::text, flags FROM message_location WHERE folder_id = $1',
      [inboxFolderId],
    )
    const flagsOf = (uid: number) => after.rows.find((row) => Number(row.uid) === uid)!.flags
    expect(flagsOf(seenUid)).not.toContain('\\Seen')
    expect(flagsOf(unseenUid)).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']))

    const unread = after.rows.filter((row) => !row.flags.includes('\\Seen')).length
    const folder = await pool.query<{ unread_count: number }>(
      'SELECT unread_count FROM folder WHERE id = $1',
      [inboxFolderId],
    )
    expect(folder.rows[0]!.unread_count).toBe(unread)
  })

  it('removes messages expunged on the server, including the body file', async () => {
    const { rows } = await pool.query<{ uid: string; message_id: string; storage_ref: string }>(
      `SELECT ml.uid::text, ml.message_id::text, mb.storage_ref
       FROM message_location ml JOIN message_body mb ON mb.message_id = ml.message_id
       WHERE ml.folder_id = $1 ORDER BY ml.uid LIMIT 1`,
      [inboxFolderId],
    )
    const victim = rows[0]!
    const bodyFile = path.join(mailDataDir, victim.storage_ref)
    await access(bodyFile) // exists before

    await withInbox(async (client) => {
      const uids: number[] = []
      for await (const msg of client.fetch('1:*', { uid: true })) uids.push(msg.uid)
      await client.messageDelete(String(uids.indexOf(Number(victim.uid)) + 1))
    })

    await runMessageSync(pool, accountId, inboxFolderId)

    const message = await pool.query('SELECT 1 FROM message WHERE id = $1', [victim.message_id])
    expect(message.rowCount).toBe(0)
    const location = await pool.query('SELECT 1 FROM message_location WHERE message_id = $1', [
      victim.message_id,
    ])
    expect(location.rowCount).toBe(0)
    const body = await pool.query('SELECT 1 FROM message_body WHERE message_id = $1', [
      victim.message_id,
    ])
    expect(body.rowCount).toBe(0)
    await expect(access(bodyFile)).rejects.toThrow()

    // The other messages are untouched.
    const remaining = await pool.query(
      'SELECT count(*)::int AS count FROM message WHERE account_id = $1',
      [accountId],
    )
    expect(remaining.rows[0].count).toBe(2)
  })
})
