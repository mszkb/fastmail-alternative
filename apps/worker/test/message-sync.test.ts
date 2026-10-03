/**
 * Integration tests for the message_sync job (roadmap 2.2 step 2). Requires
 * DATABASE_URL + GreenMail (CI service containers / local docker on the Pi).
 *
 * Flow: send two real mails into GreenMail via SMTP, run folder_sync +
 * message_sync, then verify DB state: encrypted-at-rest fields, decrypted
 * values, locations, body files in the mail-data directory, idempotency.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { runMigrations } from '@fma/db/migrate'
import {
  decryptBytes,
  decryptField,
  encryptBytes,
  encryptField,
  generateDataKey,
  loadMasterKey,
  wrapDataKey,
} from '@fma/crypto'
import { loadAccountContext } from '../src/accounts'
import { runFolderSync } from '../src/jobs/folder-sync'
import { MESSAGE_METADATA_VERSION, runMessageSync } from '../src/jobs/message-sync'

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
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message, message_location, message_body, push_subscription CASCADE',
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

    // A logged-in device with push enabled: new INBOX mail enqueues push_notify.
    const device = await pool.query<{ id: string }>(
      `INSERT INTO device (user_id, name, platform, installation_id)
       VALUES ($1, 'Phone', 'ios_pwa', gen_random_uuid()) RETURNING id`,
      [user.rows[0]!.id],
    )
    await pool.query(
      `INSERT INTO session (device_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 day')`,
      [device.rows[0]!.id, randomBytes(32)],
    )
    await pool.query(
      `INSERT INTO push_subscription (device_id, transport, endpoint, keys_enc)
       VALUES ($1, 'webpush', 'https://push.example.net/sync-test', '\\x00')`,
      [device.rows[0]!.id],
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
      from: 'Sender Two <sender-two@example.com>',
      to: greenmailUser,
      cc: 'Carol <carol@example.com>',
      replyTo: 'Team <team@example.com>',
      inReplyTo: '<parent@example.org>',
      references: ['<root@example.org>', '<parent@example.org>'],
      subject: 'Zweite Testmail',
      text: 'Hallo von Testmail zwei.',
      // Envelope recipient of an alias (sender identity for replies, 3.6).
      headers: { 'Delivered-To': '<Alias@Example.com>' },
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
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message, message_location, message_body, push_subscription CASCADE',
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

  it('stores addresses, Reply-To and threading headers', async () => {
    const { rows } = await pool.query<{
      id: string
      from_enc: Buffer
      recipients_enc: Buffer
      in_reply_to: string | null
      references: string[]
      subject_enc: Buffer
    }>(
      `SELECT id, from_enc, recipients_enc, in_reply_to, "references", subject_enc
       FROM message WHERE account_id = $1`,
      [accountId],
    )
    const ctx = await loadAccountContext(pool, accountId, process.env.MASTER_KEY!)
    const decoded = rows.map((row) => ({
      subject: decryptField(ctx.dek, row.subject_enc.toString('utf8'), `message.subject:${row.id}`),
      from: JSON.parse(
        decryptField(ctx.dek, row.from_enc.toString('utf8'), `message.from:${row.id}`),
      ) as unknown,
      recipients: JSON.parse(
        decryptField(ctx.dek, row.recipients_enc.toString('utf8'), `message.recipients:${row.id}`),
      ) as { to: unknown; cc: unknown; replyTo: unknown; deliveredTo?: string[] },
      inReplyTo: row.in_reply_to,
      references: row.references,
    }))
    const first = decoded.find((m) => m.subject === 'Erste Testmail')!
    const second = decoded.find((m) => m.subject === 'Zweite Testmail')!

    expect(first.from).toEqual([{ name: '', address: 'sender-one@example.com' }])
    expect(first.recipients.to).toEqual([{ name: '', address: greenmailUser }])
    // No Reply-To header: the envelope's reply-to (= From) is not stored.
    expect(first.recipients.replyTo).toEqual([])
    expect(first.references).toEqual([])

    expect(second.from).toEqual([{ name: 'Sender Two', address: 'sender-two@example.com' }])
    expect(second.recipients.cc).toEqual([{ name: 'Carol', address: 'carol@example.com' }])
    expect(second.recipients.replyTo).toEqual([{ name: 'Team', address: 'team@example.com' }])
    expect(second.recipients.deliveredTo).toContain('alias@example.com')
    expect(second.inReplyTo).toBe('<parent@example.org>')
    // References come from the raw message (not part of the IMAP envelope).
    expect(second.references).toEqual(['<root@example.org>', '<parent@example.org>'])
  })

  /** Simulates rows synced before the address fix (metadata_version 1). */
  async function resetToLegacyMetadata(messageIds: string[]): Promise<void> {
    const ctx = await loadAccountContext(pool, accountId, process.env.MASTER_KEY!)
    for (const id of messageIds) {
      await pool.query(
        `UPDATE message SET from_enc = $2, recipients_enc = $3, in_reply_to = NULL,
           "references" = '{}', metadata_version = 1
         WHERE id = $1`,
        [
          id,
          Buffer.from(encryptField(ctx.dek, '[]', `message.from:${id}`), 'utf8'),
          Buffer.from(
            encryptField(ctx.dek, JSON.stringify({ to: [], cc: [] }), `message.recipients:${id}`),
            'utf8',
          ),
        ],
      )
    }
  }

  async function loadDecoded(): Promise<
    {
      id: string
      subject: string
      from: unknown
      recipients: { to: unknown; cc: unknown; replyTo: unknown; deliveredTo?: string[] }
      inReplyTo: string | null
      references: string[]
      metadataVersion: number
    }[]
  > {
    const ctx = await loadAccountContext(pool, accountId, process.env.MASTER_KEY!)
    const { rows } = await pool.query<{
      id: string
      subject_enc: Buffer
      from_enc: Buffer
      recipients_enc: Buffer
      in_reply_to: string | null
      references: string[]
      metadata_version: number
    }>(
      `SELECT id, subject_enc, from_enc, recipients_enc, in_reply_to, "references",
              metadata_version
       FROM message WHERE account_id = $1`,
      [accountId],
    )
    return rows.map((row) => ({
      id: row.id,
      subject: decryptField(ctx.dek, row.subject_enc.toString('utf8'), `message.subject:${row.id}`),
      from: JSON.parse(
        decryptField(ctx.dek, row.from_enc.toString('utf8'), `message.from:${row.id}`),
      ) as unknown,
      recipients: JSON.parse(
        decryptField(ctx.dek, row.recipients_enc.toString('utf8'), `message.recipients:${row.id}`),
      ) as { to: unknown; cc: unknown; replyTo: unknown; deliveredTo?: string[] },
      inReplyTo: row.in_reply_to,
      references: row.references,
      metadataVersion: row.metadata_version,
    }))
  }

  function expectCurrentMetadata(decoded: Awaited<ReturnType<typeof loadDecoded>>): void {
    const first = decoded.find((m) => m.subject === 'Erste Testmail')!
    const second = decoded.find((m) => m.subject === 'Zweite Testmail')!
    expect(first.metadataVersion).toBe(MESSAGE_METADATA_VERSION)
    expect(second.metadataVersion).toBe(MESSAGE_METADATA_VERSION)
    expect(first.from).toEqual([{ name: '', address: 'sender-one@example.com' }])
    expect(first.recipients.to).toEqual([{ name: '', address: greenmailUser }])
    expect(first.recipients.replyTo).toEqual([])
    expect(second.from).toEqual([{ name: 'Sender Two', address: 'sender-two@example.com' }])
    expect(second.recipients.to).toEqual([{ name: '', address: greenmailUser }])
    expect(second.recipients.cc).toEqual([{ name: 'Carol', address: 'carol@example.com' }])
    expect(second.recipients.replyTo).toEqual([{ name: 'Team', address: 'team@example.com' }])
    expect(second.recipients.deliveredTo).toContain('alias@example.com')
    expect(second.inReplyTo).toBe('<parent@example.org>')
    expect(second.references).toEqual(['<root@example.org>', '<parent@example.org>'])
  }

  it('backfills outdated metadata from the stored raw mail', async () => {
    const ids = (await loadDecoded()).map((m) => m.id)
    await resetToLegacyMetadata(ids)
    // Raw files written before the binary format (text envelope) stay readable.
    const ctx = await loadAccountContext(pool, accountId, process.env.MASTER_KEY!)
    const { rows: bodies } = await pool.query<{ message_id: string; storage_ref: string }>(
      'SELECT message_id::text, storage_ref FROM message_body WHERE message_id = ANY($1::uuid[])',
      [ids],
    )
    for (const body of bodies) {
      const file = path.join(mailDataDir, body.storage_ref)
      const aad = `message.body:${body.message_id}`
      const raw = decryptBytes(ctx.dek, await readFile(file), aad)
      await writeFile(file, encryptField(ctx.dek, raw.toString('latin1'), aad))
    }
    const legacy = await loadDecoded()
    expect(legacy.every((m) => m.metadataVersion === 1)).toBe(true)
    expect(legacy.every((m) => JSON.stringify(m.from) === '[]')).toBe(true)

    try {
      await runMessageSync(pool, accountId, inboxFolderId)
    } finally {
      // Back to the current format for the following tests.
      for (const body of bodies) {
        const file = path.join(mailDataDir, body.storage_ref)
        const aad = `message.body:${body.message_id}`
        await writeFile(
          file,
          encryptBytes(ctx.dek, decryptBytes(ctx.dek, await readFile(file), aad), aad),
        )
      }
    }

    expectCurrentMetadata(await loadDecoded())
  })

  it('backfills outdated metadata from IMAP when no raw mail is stored', async () => {
    const ids = (await loadDecoded()).map((m) => m.id)
    await resetToLegacyMetadata(ids)
    // Make the stored raw files unusable for this run (restored afterwards).
    const { rows: bodies } = await pool.query<{ message_id: string; storage_ref: string }>(
      'SELECT message_id::text, storage_ref FROM message_body WHERE message_id = ANY($1::uuid[])',
      [ids],
    )
    await pool.query(
      `UPDATE message_body SET storage_ref = 'missing/raw.eml.enc'
       WHERE message_id = ANY($1::uuid[])`,
      [ids],
    )
    try {
      await runMessageSync(pool, accountId, inboxFolderId)
    } finally {
      for (const body of bodies) {
        await pool.query('UPDATE message_body SET storage_ref = $2 WHERE message_id = $1', [
          body.message_id,
          body.storage_ref,
        ])
      }
    }

    expectCurrentMetadata(await loadDecoded())
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
      expect(file.subarray(0, 7).toString('latin1')).toBe('fma.b1.')
      expect(file.toString('latin1')).not.toContain('Hallo von Testmail')
      const raw = decryptBytes(ctx.dek, file, `message.body:${row.message_id}`)
      expect(raw.toString('latin1')).toContain('Hallo von Testmail')

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
    const pushJobs = async (): Promise<number> =>
      (await pool.query(`SELECT 1 FROM job WHERE type = 'push_notify'`)).rowCount ?? 0
    // The initial sync (earlier tests) never notifies.
    expect(await pushJobs()).toBe(0)

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
    // New unseen INBOX mail on an incremental run: one (coalesced) push job.
    expect(await pushJobs()).toBe(1)

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

  it('discards stale locations after a UIDVALIDITY change without mixing up bodies', async () => {
    const ctx = await loadAccountContext(pool, accountId, process.env.MASTER_KEY!)
    const textOf = async (messageId: string): Promise<string | null> => {
      const { rows } = await pool.query<{ text_plain_enc: Buffer | null }>(
        'SELECT text_plain_enc FROM message_body WHERE message_id = $1',
        [messageId],
      )
      const enc = rows[0]?.text_plain_enc
      return enc ? decryptField(ctx.dek, enc.toString('utf8'), `message.text:${messageId}`) : null
    }
    const { rows: before } = await pool.query<{
      message_id: string
      uid: string
      uidvalidity: string
    }>(
      `SELECT message_id::text, uid::text, uidvalidity::text FROM message_location
       WHERE folder_id = $1 ORDER BY uid`,
      [inboxFolderId],
    )
    expect(before).toHaveLength(2)
    const [a, b] = [before[0]!, before[1]!]
    const textA = await textOf(a.message_id)
    expect(textA).toMatch(/Hallo von Testmail/)

    // Simulate a UIDVALIDITY reset on the server: everything stored refers to
    // an older uidvalidity, and the old UIDs point at different messages now.
    const stale = (BigInt(a.uidvalidity) - 1n).toString()
    await pool.query(
      `UPDATE message_location SET uidvalidity = $2,
         uid = CASE WHEN message_id = $3 THEN $4::bigint ELSE $5::bigint END
       WHERE folder_id = $1`,
      [inboxFolderId, stale, a.message_id, b.uid, '999999'],
    )
    await pool.query('UPDATE folder SET uidvalidity = $2 WHERE id = $1', [inboxFolderId, stale])
    // A's body was never downloaded (interrupted sync) ...
    await pool.query('DELETE FROM message_body WHERE message_id = $1', [a.message_id])
    // ... and a message that is gone on the server only has a stale location
    // whose old UID now belongs to A.
    const ghostId = randomUUID()
    const empty = (field: string) =>
      Buffer.from(encryptField(ctx.dek, '', `message.${field}:${ghostId}`), 'utf8')
    await pool.query(
      `INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc,
         recipients_enc, snippet_enc)
       VALUES ($1, $2, '<ghost@example.org>', $3, $4, $5, $6)`,
      [ghostId, accountId, empty('subject'), empty('from'), empty('recipients'), empty('snippet')],
    )
    await pool.query(
      `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid)
       VALUES ($1, $2, $3, $4)`,
      [ghostId, inboxFolderId, stale, a.uid],
    )

    // folder_sync runs before every message_sync and must not hide the change.
    await runFolderSync(pool, accountId)
    await runMessageSync(pool, accountId, inboxFolderId)

    const { rows: after } = await pool.query<{
      message_id: string
      uid: string
      uidvalidity: string
    }>(
      `SELECT message_id::text, uid::text, uidvalidity::text FROM message_location
       WHERE folder_id = $1 ORDER BY uid`,
      [inboxFolderId],
    )
    // One location per message, all with the server's uidvalidity and UIDs.
    expect(after).toEqual(before)
    const ghost = await pool.query('SELECT 1 FROM message WHERE id = $1', [ghostId])
    expect(ghost.rowCount).toBe(0)
    // A's body is A's (not the message its stale UID pointed at).
    expect(await textOf(a.message_id)).toBe(textA)
    const folder = await pool.query<{ uidvalidity: string; unread_count: number }>(
      'SELECT uidvalidity::text, unread_count FROM folder WHERE id = $1',
      [inboxFolderId],
    )
    expect(folder.rows[0]!.uidvalidity).toBe(a.uidvalidity)
  })

  it('skips \\Noselect containers without selecting them', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO folder (account_id, path, delimiter, selectable)
       VALUES ($1, '[Gmail]', '/', false) RETURNING id`,
      [accountId],
    )
    // GreenMail has no such mailbox: selecting it would fail the job.
    await expect(runMessageSync(pool, accountId, rows[0]!.id)).resolves.toBeUndefined()
    await pool.query('DELETE FROM folder WHERE id = $1', [rows[0]!.id])
  })

  it('stores a skip marker for bodies over the size limit instead of retrying', async () => {
    const { rows } = await pool.query<{ message_id: string }>(
      'SELECT message_id::text FROM message_location WHERE folder_id = $1 ORDER BY uid LIMIT 1',
      [inboxFolderId],
    )
    const messageId = rows[0]!.message_id
    await pool.query('DELETE FROM message_body WHERE message_id = $1', [messageId])
    await rm(path.join(mailDataDir, accountId, messageId), { recursive: true, force: true })
    // Force the body backfill path: one new mail arrives.
    const transporter = nodemailer.createTransport({
      host: greenmailHost,
      port: Number(process.env.GREENMAIL_SMTP_PORT),
      secure: false,
      tls: { rejectUnauthorized: false },
    })
    await transporter.sendMail({
      from: 'sender-four@example.com',
      to: greenmailUser,
      subject: 'Vierte Testmail',
      text: 'Hallo von Testmail vier.',
    })
    transporter.close()

    process.env.MAX_RAW_MESSAGE_BYTES = '100'
    try {
      let count = 0
      for (let attempt = 0; attempt < 10 && count < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await runMessageSync(pool, accountId, inboxFolderId)
        const messages = await pool.query(
          'SELECT count(*)::int AS count FROM message WHERE account_id = $1',
          [accountId],
        )
        count = messages.rows[0].count
      }
      expect(count).toBe(3)
    } finally {
      delete process.env.MAX_RAW_MESSAGE_BYTES
    }

    const { rows: markers } = await pool.query<{
      storage_ref: string | null
      skip_reason: string | null
    }>(
      `SELECT mb.storage_ref, mb.skip_reason FROM message_body mb
       JOIN message_location ml ON ml.message_id = mb.message_id
       WHERE ml.folder_id = $1 AND mb.skip_reason IS NOT NULL`,
      [inboxFolderId],
    )
    // The backfilled one and the new one: marked, nothing stored.
    expect(markers).toHaveLength(2)
    expect(
      markers.every((row) => row.storage_ref === null && row.skip_reason === 'too_large'),
    ).toBe(true)
    expect(await readdir(path.join(mailDataDir, accountId, messageId)).catch(() => [])).toEqual([])

    // Marked bodies are not downloaded again (even without the limit now).
    await runMessageSync(pool, accountId, inboxFolderId)
    const still = await pool.query(
      'SELECT 1 FROM message_body WHERE message_id = $1 AND skip_reason IS NOT NULL',
      [messageId],
    )
    expect(still.rowCount).toBe(1)
  })
})
