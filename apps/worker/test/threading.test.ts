/**
 * Integration test for threading (roadmap 2.5) through the real sync:
 * GreenMail delivers a small corpus, message_sync assigns threads.
 * Covers out-of-order arrival across folders (the connecting parent shows
 * up later in a Sent folder), the subject fallback, subject collisions and
 * the rebuild of threads for backfilled (metadata_version 1) messages.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import nodemailer, { type SendMailOptions } from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import { runFolderSync } from '../src/jobs/folder-sync'
import { runMessageSync } from '../src/jobs/message-sync'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST
const greenmailUser = process.env.GREENMAIL_USER ?? ''
const greenmailPassword = process.env.GREENMAIL_PASSWORD ?? ''
const SENT = 'Threads-Sent'
const DAY = 24 * 60 * 60 * 1000
const BASE = Date.UTC(2026, 8, 1, 8, 0, 0)

function imapClient(): ImapFlow {
  return new ImapFlow({
    host: greenmailHost!,
    port: Number(process.env.GREENMAIL_IMAP_PORT),
    secure: false,
    auth: { user: greenmailUser, pass: greenmailPassword },
    logger: false,
    tls: { rejectUnauthorized: false },
    doSTARTTLS: false,
  })
}

async function inboxCount(): Promise<number> {
  const client = imapClient()
  await client.connect()
  try {
    const status = await client.status('INBOX', { messages: true })
    return status ? (status.messages ?? 0) : 0
  } finally {
    await client.logout().catch(() => client.close())
  }
}

describe.skipIf(!databaseUrl || !greenmailHost)('threading through message_sync', () => {
  let pool: pg.Pool
  let accountId: string
  let mailDataDir: string
  const folderIds: Record<string, string> = {}

  /** message_id_header -> thread_id of the account. */
  async function threadsByMessageId(): Promise<Map<string, string | null>> {
    const { rows } = await pool.query<{ message_id_header: string; thread_id: string | null }>(
      'SELECT message_id_header, thread_id::text FROM message WHERE account_id = $1',
      [accountId],
    )
    return new Map(rows.map((row) => [row.message_id_header, row.thread_id]))
  }

  async function syncFolders(...paths: string[]): Promise<void> {
    await runFolderSync(pool, accountId)
    const { rows } = await pool.query<{ id: string; path: string }>(
      'SELECT id, path FROM folder WHERE account_id = $1',
      [accountId],
    )
    for (const row of rows) folderIds[row.path] = row.id
    for (const folderPath of paths) await runMessageSync(pool, accountId, folderIds[folderPath]!)
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message, message_location, message_body, thread CASCADE',
    )
    mailDataDir = await mkdtemp(path.join(tmpdir(), 'fma-mail-data-'))
    process.env.MAIL_DATA_DIR = mailDataDir

    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'not-a-real-hash') RETURNING id`,
      [`threads-${Date.now()}@example.com`],
    )
    accountId = randomUUID()
    const dek = generateDataKey()
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, 'Thread-Test', $3, $4, $5, 'smtp.test', 465, $6, 'v1', $7, 'ok')`,
      [
        accountId,
        user.rows[0]!.id,
        greenmailUser,
        greenmailHost,
        Number(process.env.GREENMAIL_IMAP_PORT),
        wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1'),
        Buffer.from(
          encryptField(
            dek,
            JSON.stringify({ imapUser: greenmailUser, imapPassword: greenmailPassword }),
            `mail_account.credential:${accountId}`,
          ),
          'utf8',
        ),
      ],
    )

    // Clean server state: empty INBOX, fresh Sent test folder.
    const setup = imapClient()
    await setup.connect()
    await setup.mailboxDelete(SENT).catch(() => {})
    await setup.mailboxCreate(SENT)
    const lock = await setup.getMailboxLock('INBOX')
    try {
      const exists = setup.mailbox ? setup.mailbox.exists : 0
      if (exists > 0) await setup.messageDelete('1:*')
    } finally {
      lock.release()
    }
    await setup.logout().catch(() => setup.close())

    // The corpus, delivered child-before-parent where it matters.
    const transporter = nodemailer.createTransport({
      host: greenmailHost,
      port: Number(process.env.GREENMAIL_SMTP_PORT),
      secure: false,
      tls: { rejectUnauthorized: false },
    })
    const send = (options: SendMailOptions) =>
      transporter.sendMail({ from: 'alice@example.org', to: greenmailUser, ...options })
    // Reply to <p@thread.test>, which only arrives later (in Sent).
    await send({
      messageId: '<c@thread.test>',
      subject: 'Re: Re: Planung',
      inReplyTo: '<p@thread.test>',
      references: ['<p@thread.test>'],
      date: new Date(BASE + 2 * DAY),
      text: 'Kind',
    })
    await send({
      messageId: '<r@thread.test>',
      subject: 'Planung',
      date: new Date(BASE),
      text: 'Wurzel',
    })
    // Unrelated mail with the same subject (no reply prefix, no references).
    await send({
      messageId: '<u@thread.test>',
      subject: 'Planung',
      date: new Date(BASE + 1 * DAY),
      text: 'Fremd',
    })
    // Subject fallback: client without reference headers.
    await send({
      messageId: '<g1@thread.test>',
      subject: 'Grillfest',
      date: new Date(BASE),
      text: 'Wer kommt?',
    })
    await send({
      messageId: '<g2@thread.test>',
      subject: 'AW: Grillfest',
      date: new Date(BASE + 1 * DAY),
      text: 'Ich!',
    })
    transporter.close()
    const start = Date.now()
    while ((await inboxCount()) < 5 && Date.now() - start < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    expect(await inboxCount()).toBe(5)
  })

  afterAll(async () => {
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message, message_location, message_body, thread CASCADE',
    )
    await pool.end()
    await rm(mailDataDir, { recursive: true, force: true }).catch(() => {})
    const cleanup = imapClient()
    await cleanup.connect()
    await cleanup.mailboxDelete(SENT).catch(() => {})
    await cleanup.logout().catch(() => cleanup.close())
  })

  it('assigns threads during sync', async () => {
    await syncFolders('INBOX')
    const threads = await threadsByMessageId()
    expect(threads.size).toBe(5)
    for (const threadId of threads.values()) expect(threadId).not.toBeNull()

    // The child's parent is missing so far: root and child are separate.
    expect(threads.get('<c@thread.test>')).not.toBe(threads.get('<r@thread.test>'))
    // Same subject, no relation: separate threads.
    expect(threads.get('<u@thread.test>')).not.toBe(threads.get('<r@thread.test>'))
    // Subject fallback.
    expect(threads.get('<g2@thread.test>')).toBe(threads.get('<g1@thread.test>'))
  })

  it('merges threads when the connecting parent arrives later in another folder', async () => {
    const parent = [
      'From: ' + greenmailUser,
      'To: alice@example.org',
      'Subject: Re: Planung',
      'Message-ID: <p@thread.test>',
      'In-Reply-To: <r@thread.test>',
      'References: <r@thread.test>',
      `Date: ${new Date(BASE + DAY).toUTCString()}`,
      '',
      'Elternteil',
      '',
    ].join('\r\n')
    const client = imapClient()
    await client.connect()
    await client.append(SENT, parent, ['\\Seen'])
    await client.logout().catch(() => client.close())

    await syncFolders(SENT)
    const threads = await threadsByMessageId()
    const root = threads.get('<r@thread.test>')
    expect(threads.get('<p@thread.test>')).toBe(root)
    expect(threads.get('<c@thread.test>')).toBe(root)
    expect(threads.get('<u@thread.test>')).not.toBe(root)

    // The merged-away thread is gone; last_message_at follows the newest message.
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM thread WHERE account_id = $1',
      [accountId],
    )
    expect(rows[0]!.count).toBe(3) // Planung, fremde Planung, Grillfest
    const thread = await pool.query<{ last_message_at: Date }>(
      'SELECT last_message_at FROM thread WHERE id = $1',
      [root],
    )
    expect(thread.rows[0]!.last_message_at.getTime()).toBe(BASE + 2 * DAY)
  })

  it('rebuilds the same threads for backfilled messages', async () => {
    const before = await threadsByMessageId()
    await pool.query(
      `UPDATE message SET thread_id = NULL, subject_hash = NULL, metadata_version = 1
       WHERE account_id = $1`,
      [accountId],
    )
    await pool.query('DELETE FROM thread WHERE account_id = $1', [accountId])

    await syncFolders('INBOX', SENT)
    const after = await threadsByMessageId()
    const groups = (threads: Map<string, string | null>) => {
      const byThread = new Map<string, string[]>()
      for (const [messageId, threadId] of threads) {
        byThread.set(threadId!, [...(byThread.get(threadId!) ?? []), messageId].sort())
      }
      return [...byThread.values()].sort((a, b) => a[0]!.localeCompare(b[0]!))
    }
    expect([...after.values()].every((id) => id !== null)).toBe(true)
    expect(groups(after)).toEqual(groups(before))
  })

  it('removes threads left without messages', async () => {
    const { rows } = await pool.query<{ thread_id: string }>(
      "SELECT thread_id::text FROM message WHERE message_id_header = '<u@thread.test>'",
    )
    const client = imapClient()
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      const seqs: number[] = []
      for await (const msg of client.fetch('1:*', { envelope: true })) {
        if (msg.envelope?.messageId === '<u@thread.test>') seqs.push(msg.seq)
      }
      await client.messageDelete(seqs.join(','))
    } finally {
      lock.release()
      await client.logout().catch(() => client.close())
    }

    await syncFolders('INBOX')
    const thread = await pool.query('SELECT 1 FROM thread WHERE id = $1', [rows[0]!.thread_id])
    expect(thread.rowCount).toBe(0)
  })
})
