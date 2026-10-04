/**
 * Integration tests for the send_message job (roadmap 2.7). Requires
 * DATABASE_URL + GreenMail; skipped when unset.
 *
 * Messages are sent to the GreenMail test user itself, so delivery can be
 * checked via IMAP in its INBOX; the Sent copy goes to a dedicated test
 * folder marked as special-use "sent".
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { ImapFlow } from 'imapflow'
import { runMigrations } from '@fma/db/migrate'
import { failJob } from '@fma/db/job-queue'
import { simpleParser } from 'mailparser'
import {
  encryptBytes,
  encryptField,
  generateDataKey,
  loadMasterKey,
  outboxContentAad,
  uploadFieldAad,
  wrapDataKey,
} from '@fma/crypto'
import type { OutboxContent } from '@fma/shared'
import MailComposer from 'nodemailer/lib/mail-composer'
// The api copies the original's attachments when a forward is opened; the
// worker sends them like any upload (end-to-end: forward -> GreenMail).
import { copyAttachmentsToUploads } from '../../api/src/mail/attachments'
import type { AccountContext } from '../src/accounts'
import {
  SendRetryError,
  classifySmtpError,
  markSendGivenUp,
  providerSavesSentCopy,
  runSendMessage,
} from '../src/jobs/send-message'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST
const greenmailUser = process.env.GREENMAIL_USER ?? ''
const greenmailPassword = process.env.GREENMAIL_PASSWORD ?? ''

const TABLES =
  'session, device, "user", mail_account, identity, folder, job, message, message_location, message_body, outbox_message, attachment_upload'
const SENT = 'FmaSendSent'

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

/** Raw sources of all messages in `mailbox` with the given Message-ID. */
async function findByMessageId(mailbox: string, messageId: string): Promise<string[]> {
  const client = imapClient()
  await client.connect()
  const lock = await client.getMailboxLock(mailbox)
  try {
    const status = (client as unknown as { mailbox?: { exists?: number } }).mailbox
    if ((status?.exists ?? 0) === 0) return []
    const found: string[] = []
    for await (const msg of client.fetch('1:*', { envelope: true, source: true, flags: true })) {
      if (msg.envelope?.messageId === messageId) {
        found.push(`${[...(msg.flags ?? [])].join(' ')}\n${msg.source?.toString('utf8') ?? ''}`)
      }
    }
    return found
  } finally {
    lock.release()
    await client.logout().catch(() => client.close())
  }
}

/** Waits until GreenMail has delivered `count` copies (SMTP delivery is async). */
async function waitForDelivery(messageId: string, count = 1): Promise<string[]> {
  const start = Date.now()
  let found = await findByMessageId('INBOX', messageId)
  while (found.length < count && Date.now() - start < 20_000) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    found = await findByMessageId('INBOX', messageId)
  }
  return found
}

describe('send_message helpers', () => {
  it('classifies SMTP errors into permanent and transient', () => {
    expect(classifySmtpError({ code: 'EAUTH', responseCode: 535 })).toEqual({
      code: 'AUTH_FAILED',
      permanent: true,
    })
    expect(classifySmtpError({ code: 'EENVELOPE', responseCode: 550 })).toEqual({
      code: 'SMTP_REJECTED',
      permanent: true,
    })
    expect(classifySmtpError({ code: 'EENVELOPE', responseCode: 451 })).toEqual({
      code: 'SMTP_TEMPORARY',
      permanent: false,
    })
    expect(
      classifySmtpError({ code: 'ESOCKET', message: 'connect ECONNREFUSED 1.2.3.4:25' }),
    ).toEqual({ code: 'CONNECTION_REFUSED', permanent: false })
    expect(classifySmtpError({ code: 'PRIVATE_HOST_BLOCKED' })).toEqual({
      code: 'BLOCKED_HOST',
      permanent: true,
    })
    expect(classifySmtpError(new Error('Greeting never received'))).toEqual({
      code: 'UNKNOWN',
      permanent: false,
    })
  })

  it('skips the Sent copy for Gmail hosts only', () => {
    const ctx = (imap: string, smtp: string) =>
      ({ imap: { host: imap }, smtp: { host: smtp } }) as unknown as AccountContext
    expect(providerSavesSentCopy(ctx('imap.gmail.com', 'smtp.gmail.com'))).toBe(true)
    expect(providerSavesSentCopy(ctx('imap.example.com', 'smtp.googlemail.com'))).toBe(true)
    expect(providerSavesSentCopy(ctx('imap.fastmail.com', 'smtp.fastmail.com'))).toBe(false)
    expect(providerSavesSentCopy(ctx('imap.notgmail.com', 'smtp.notgmail.com'))).toBe(false)
  })
})

describe.skipIf(!databaseUrl || !greenmailHost)('send_message job', () => {
  let pool: pg.Pool
  let accountId: string
  let dek: Buffer
  let sentFolderId: string

  async function createOutbox(
    content: Partial<OutboxContent> = {},
    extra: { inReplyTo?: string } = {},
  ): Promise<{ id: string; messageId: string }> {
    const id = randomUUID()
    const messageId = `<${randomUUID()}@example.com>`
    const full: OutboxContent = {
      from: { name: 'Test Sender', address: greenmailUser },
      to: [{ name: 'Test Empfänger', address: greenmailUser }],
      cc: [],
      bcc: [],
      subject: 'Versandtest',
      text: 'Hallo aus dem Versand-Worker.',
      ...content,
    }
    await pool.query(
      `INSERT INTO outbox_message (id, account_id, status, content_enc, message_id_header, in_reply_to)
       VALUES ($1, $2, 'queued', $3, $4, $5)`,
      [
        id,
        accountId,
        Buffer.from(encryptField(dek, JSON.stringify(full), outboxContentAad(id)), 'utf8'),
        messageId,
        extra.inReplyTo ?? null,
      ],
    )
    return { id, messageId }
  }

  async function outbox(id: string) {
    const { rows } = await pool.query<{
      status: string
      attempts: number
      last_error_code: string | null
      sent_copy: string | null
      sent_at: Date | null
      content_enc: Buffer | null
    }>(
      `SELECT status, attempts, last_error_code, sent_copy, sent_at, content_enc
       FROM outbox_message WHERE id = $1`,
      [id],
    )
    return rows[0]!
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)

    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'not-a-real-hash') RETURNING id`,
      [`send-${Date.now()}@example.com`],
    )
    accountId = randomUUID()
    dek = generateDataKey()
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, 'Send-Test', $3, $4, $5, $4, $6, $7, 'v1', $8, 'ok')`,
      [
        accountId,
        user.rows[0]!.id,
        greenmailUser,
        greenmailHost,
        Number(process.env.GREENMAIL_IMAP_PORT),
        Number(process.env.GREENMAIL_SMTP_PORT),
        wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1'),
        Buffer.from(
          encryptField(
            dek,
            JSON.stringify({
              imapUser: greenmailUser,
              imapPassword: greenmailPassword,
              smtpUser: greenmailUser,
              smtpPassword: greenmailPassword,
            }),
            `mail_account.credential:${accountId}`,
          ),
          'utf8',
        ),
      ],
    )

    const setup = imapClient()
    await setup.connect()
    await setup.mailboxDelete(SENT).catch(() => {})
    await setup.mailboxCreate(SENT)
    await setup.logout().catch(() => setup.close())
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO folder (account_id, path, delimiter, special_use)
       VALUES ($1, $2, '.', 'sent') RETURNING id`,
      [accountId, SENT],
    )
    sentFolderId = rows[0]!.id
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM job')
    await pool.query('UPDATE mail_account SET smtp_port = $2 WHERE id = $1', [
      accountId,
      Number(process.env.GREENMAIL_SMTP_PORT),
    ])
    await pool.query(`UPDATE folder SET path = $2 WHERE id = $1`, [sentFolderId, SENT])
  })

  afterAll(async () => {
    const cleanup = imapClient()
    await cleanup.connect()
    await cleanup.mailboxDelete(SENT).catch(() => {})
    await cleanup.logout().catch(() => cleanup.close())
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('sends via SMTP, stores a \\Seen copy in Sent and clears the content', async () => {
    const { id, messageId } = await createOutbox(
      { bcc: [{ name: '', address: 'bcc-recipient@example.com' }] },
      { inReplyTo: '<original@example.com>' },
    )
    expect(await runSendMessage(pool, accountId, { outboxId: id })).toBe('sent')

    const delivered = await waitForDelivery(messageId)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('Subject: Versandtest')
    expect(delivered[0]).toContain('In-Reply-To: <original@example.com>')
    expect(delivered[0]).toMatch(/^From: .*Test Sender/m)
    // Bcc never travels in the sent message ...
    expect(delivered[0]).not.toContain('bcc-recipient@example.com')

    // ... but is kept in the user's own copy.
    const copies = await findByMessageId(SENT, messageId)
    expect(copies).toHaveLength(1)
    expect(copies[0]).toContain('\\Seen')
    expect(copies[0]).toContain('bcc-recipient@example.com')

    const row = await outbox(id)
    expect(row).toMatchObject({ status: 'sent', attempts: 1, sent_copy: 'done' })
    expect(row.last_error_code).toBeNull()
    expect(row.sent_at).not.toBeNull()
    expect(row.content_enc).toBeNull()

    // The Sent folder is resynced so the copy shows up.
    const { rows: jobs } = await pool.query(
      `SELECT payload FROM job WHERE type = 'message_sync' AND account_id = $1`,
      [accountId],
    )
    expect(jobs).toEqual([{ payload: { folderId: sentFolderId } }])

    // A duplicate job neither resends nor fails.
    expect(await runSendMessage(pool, accountId, { outboxId: id })).toBe('already_done')
  })

  it('sends uploaded attachments and deletes them afterwards', async () => {
    const { id, messageId } = await createOutbox({ subject: 'Mit Anhang' })
    const pdf = randomBytes(200_000)
    for (const [filename, type, content] of [
      ['Bericht März.pdf', 'application/pdf', pdf],
      ['notiz.txt', 'text/plain', Buffer.from('Notiz äöü')],
    ] as const) {
      const uploadId = randomUUID()
      await pool.query(
        `INSERT INTO attachment_upload
           (id, account_id, outbox_id, filename_enc, content_type, size_bytes, content_enc)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          uploadId,
          accountId,
          id,
          Buffer.from(encryptField(dek, filename, uploadFieldAad('filename', uploadId)), 'utf8'),
          type,
          content.length,
          encryptBytes(dek, content, uploadFieldAad('content', uploadId)),
        ],
      )
    }
    expect(await runSendMessage(pool, accountId, { outboxId: id })).toBe('sent')

    const delivered = await waitForDelivery(messageId)
    expect(delivered).toHaveLength(1)
    const parsed = await simpleParser(delivered[0]!.slice(delivered[0]!.indexOf('\n') + 1))
    expect(parsed.text?.trim()).toBe('Hallo aus dem Versand-Worker.')
    expect(parsed.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ['Bericht März.pdf', 'application/pdf'],
      ['notiz.txt', 'text/plain'],
    ])
    expect(parsed.attachments[0]!.content.equals(pdf)).toBe(true)
    expect(parsed.attachments[1]!.content.toString('utf8')).toBe('Notiz äöü')

    const { rows } = await pool.query('SELECT 1 FROM attachment_upload WHERE outbox_id = $1', [id])
    expect(rows).toHaveLength(0)
  })

  it('forwards the attachments and inline images of the original message', async () => {
    const pdf = randomBytes(120_000)
    const logo = randomBytes(10)
    const original = await new MailComposer({
      from: 'kunde@example.org',
      to: greenmailUser,
      subject: 'Rechnung',
      text: 'Anbei die Rechnung.',
      html: '<p>Anbei <img src="cid:logo"></p>',
      attachments: [
        { filename: 'Rechnung 42.pdf', contentType: 'application/pdf', content: pdf },
        { filename: 'logo.png', contentType: 'image/png', content: logo, cid: 'logo' },
      ],
    })
      .compile()
      .build()
    const { rows: accounts } = await pool.query<{ id: string; wrapped_dek: Buffer }>(
      'SELECT id, wrapped_dek FROM mail_account WHERE id = $1',
      [accountId],
    )
    const copied = await copyAttachmentsToUploads(pool, original, accounts[0]!, null, {
      includeInline: true,
    })
    // The inline logo of the HTML body is taken over as an attachment.
    expect(copied.skipped).toBe(0)
    expect(copied.attachments.map((a) => [a.filename, a.size])).toEqual([
      ['logo.png', logo.length],
      ['Rechnung 42.pdf', pdf.length],
    ])
    const { rows: stored } = await pool.query<{ filename_enc: Buffer }>(
      'SELECT filename_enc FROM attachment_upload WHERE id = $1',
      [copied.attachments[1]!.id],
    )
    expect(stored[0]!.filename_enc.toString('utf8')).not.toContain('Rechnung')

    // POST /api/outbox binds the uploads; the worker sends them.
    const { id, messageId } = await createOutbox({ subject: 'Fwd: Rechnung' })
    await pool.query('UPDATE attachment_upload SET outbox_id = $1 WHERE id = ANY($2::uuid[])', [
      id,
      copied.attachments.map((a) => a.id),
    ])
    await pool.query('UPDATE outbox_message SET attachment_count = 2 WHERE id = $1', [id])
    expect(await runSendMessage(pool, accountId, { outboxId: id })).toBe('sent')
    const delivered = await waitForDelivery(messageId)
    expect(delivered).toHaveLength(1)
    const parsed = await simpleParser(delivered[0]!.slice(delivered[0]!.indexOf('\n') + 1))
    expect(parsed.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ['logo.png', 'image/png'],
      ['Rechnung 42.pdf', 'application/pdf'],
    ])
    expect(parsed.attachments[0]!.content.equals(logo)).toBe(true)
    expect(parsed.attachments[1]!.content.equals(pdf)).toBe(true)
  })

  it('fails for good instead of sending without a vanished attachment', async () => {
    const { id, messageId } = await createOutbox({ subject: 'Anhang fehlt' })
    // The api bound two uploads; one is gone meanwhile.
    await pool.query('UPDATE outbox_message SET attachment_count = 2 WHERE id = $1', [id])
    const uploadId = randomUUID()
    await pool.query(
      `INSERT INTO attachment_upload
         (id, account_id, outbox_id, filename_enc, content_type, size_bytes, content_enc)
       VALUES ($1, $2, $3, $4, 'text/plain', 1, $5)`,
      [
        uploadId,
        accountId,
        id,
        Buffer.from(encryptField(dek, 'a.txt', uploadFieldAad('filename', uploadId)), 'utf8'),
        encryptBytes(dek, Buffer.from('a'), uploadFieldAad('content', uploadId)),
      ],
    )
    const failed: string[] = []
    expect(
      await runSendMessage(
        pool,
        accountId,
        { outboxId: id },
        { onFailed: (code) => failed.push(code) },
      ),
    ).toBe('failed')
    expect(failed).toEqual(['ATTACHMENT_MISSING'])
    const row = await outbox(id)
    expect(row.status).toBe('failed')
    expect(row.last_error_code).toBe('ATTACHMENT_MISSING')
    expect(row.attempts).toBe(0)
    expect(await findByMessageId('INBOX', messageId)).toHaveLength(0)
  })

  it('retries only the Sent copy when APPEND fails after SMTP succeeded', async () => {
    const { id, messageId } = await createOutbox({ subject: 'Append-Retry' })
    await pool.query(`UPDATE folder SET path = 'FmaDoesNotExist' WHERE id = $1`, [sentFolderId])

    await expect(runSendMessage(pool, accountId, { outboxId: id }, { attempt: 1 })).rejects.toThrow(
      SendRetryError,
    )
    expect(await outbox(id)).toMatchObject({ status: 'sent', sent_copy: 'pending', attempts: 1 })

    await pool.query(`UPDATE folder SET path = $2 WHERE id = $1`, [sentFolderId, SENT])
    expect(await runSendMessage(pool, accountId, { outboxId: id }, { attempt: 2 })).toBe('sent')
    expect(await outbox(id)).toMatchObject({ status: 'sent', sent_copy: 'done', attempts: 1 })

    // Delivered exactly once, copy exactly once.
    await waitForDelivery(messageId)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await findByMessageId('INBOX', messageId)).toHaveLength(1)
    expect(await findByMessageId(SENT, messageId)).toHaveLength(1)
  })

  it('gives up the Sent copy after the last attempt but keeps status sent', async () => {
    const { id } = await createOutbox({ subject: 'Append-Aufgegeben' })
    await pool.query(`UPDATE folder SET path = 'FmaDoesNotExist' WHERE id = $1`, [sentFolderId])
    expect(
      await runSendMessage(pool, accountId, { outboxId: id }, { attempt: 5, maxAttempts: 5 }),
    ).toBe('sent')
    expect(await outbox(id)).toMatchObject({ status: 'sent', sent_copy: 'failed' })
  })

  it('skips the Sent copy when the account has no Sent folder', async () => {
    const { id } = await createOutbox({ subject: 'Ohne Gesendet' })
    await pool.query(`UPDATE folder SET special_use = NULL WHERE id = $1`, [sentFolderId])
    try {
      expect(await runSendMessage(pool, accountId, { outboxId: id })).toBe('sent')
    } finally {
      await pool.query(`UPDATE folder SET special_use = 'sent' WHERE id = $1`, [sentFolderId])
    }
    expect(await outbox(id)).toMatchObject({ status: 'sent', sent_copy: 'skipped' })
  })

  it('keeps transient SMTP errors queued with backoff and fails after the last attempt', async () => {
    const { id } = await createOutbox({ subject: 'Falscher Port' })
    // Nothing listens on port 1: connection refused (transient).
    await pool.query('UPDATE mail_account SET smtp_port = 1 WHERE id = $1', [accountId])

    const jobId = (
      await pool.query<{ id: string }>(
        `INSERT INTO job (type, account_id, payload, state, attempts)
         VALUES ('send_message', $1, $2, 'running', 1) RETURNING id`,
        [accountId, { outboxId: id }],
      )
    ).rows[0]!.id
    const error = await runSendMessage(pool, accountId, { outboxId: id }, { attempt: 1 }).catch(
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(SendRetryError)
    expect(await outbox(id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      last_error_code: 'CONNECTION_REFUSED',
      sent_at: null,
    })
    // The worker loop hands the error to the job queue: retry with backoff.
    await failJob(pool, String(jobId), 1, (error as Error).message)
    const { rows } = await pool.query<{ state: string; later: boolean }>(
      `SELECT state, run_at > now() + interval '10 seconds' AS later FROM job WHERE id = $1`,
      [jobId],
    )
    expect(rows[0]).toEqual({ state: 'queued', later: true })

    expect(
      await runSendMessage(pool, accountId, { outboxId: id }, { attempt: 5, maxAttempts: 5 }),
    ).toBe('failed')
    expect(await outbox(id)).toMatchObject({
      status: 'failed',
      attempts: 2,
      last_error_code: 'CONNECTION_REFUSED',
    })
    // Failed messages are not picked up again until the user retries.
    expect(await runSendMessage(pool, accountId, { outboxId: id })).toBe('not_queued')
  })

  it('marks a message failed when the job queue gives up on an unexpected error', async () => {
    const { id } = await createOutbox({ subject: 'Unerwartet' })
    await markSendGivenUp(pool, { outboxId: id })
    expect(await outbox(id)).toMatchObject({ status: 'failed', last_error_code: 'UNKNOWN' })
  })
})
