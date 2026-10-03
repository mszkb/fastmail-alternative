/**
 * send_message job (roadmap 2.7): sends an outbox message via SMTP and
 * stores a copy in the account's "Sent" folder (IMAP APPEND, \Seen).
 *
 * Flow per attempt:
 * 1. Not yet accepted by SMTP (`sent_at` NULL): build the RFC 5322 message
 *    with nodemailer's MailComposer (Message-ID from the api, Date = now)
 *    and send it with the decrypted SMTP credentials.
 *    - Permanent errors (authentication, 5xx replies, blocked host) mark
 *      the message 'failed' right away - no pointless retries.
 *    - Transient errors (connection, timeout, 4xx) leave it 'queued' with
 *      the error code and throw, so the job queue retries with backoff;
 *      after the last attempt the message becomes 'failed'.
 *    The user can re-queue a failed message (POST /api/outbox/:id/retry).
 * 2. Accepted (`sent_at` set): the message is NEVER sent again. Only the
 *    Sent copy is (re)tried: APPEND failures throw and retry with backoff;
 *    after the last attempt the copy is given up (`sent_copy` 'failed',
 *    warning logged) - the message itself was delivered.
 *
 * The Sent copy is skipped when the account has no Sent folder or the
 * provider stores sent mail itself (heuristic: Gmail/Googlemail hosts,
 * where an APPEND would create a duplicate). After the copy settles, the
 * encrypted content is cleared (data model: kept only until sent); a
 * message_sync of the Sent folder picks the copy up.
 *
 * Known limit (simplest approach): if the worker dies after the SMTP server
 * accepted the message but before `sent_at` is stored, the stale-job
 * requeue sends it again (duplicate rather than lost mail).
 *
 * Never logged: content, addresses, server replies (may echo addresses).
 */
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import type { Pool } from '@fma/db'
import { decryptField, outboxContentAad } from '@fma/crypto'
import { MAX_JOB_ATTEMPTS } from '@fma/db/job-queue'
import type { OutboxContent, OutboxErrorCode, OutboxStatus, SentCopyStatus } from '@fma/shared'
import { assertPublicHost } from '@fma/shared/ssrf'
import { loadAccountContext, type AccountContext } from '../accounts'
import { closeOnJobAbort } from '../job-context'
import { log } from '../log'
import { mailTestMode } from '../ports'
import { enqueueMessageSync } from '../scheduler'

const CONNECT_TIMEOUT_MS = 15_000
const SOCKET_TIMEOUT_MS = 60_000

/** Providers that file sent mail into "Sent" themselves (APPEND would duplicate it). */
const AUTO_SAVE_HOST_RE = /(^|\.)(gmail|googlemail)\.com$/i

export type SendMessageOutcome =
  'sent' | 'failed' | 'retry' | 'already_done' | 'missing' | 'not_queued'

export interface SendMessageOptions {
  /** Attempt number of the job (1-based); the last one fails for good. */
  attempt?: number
  maxAttempts?: number
  context?: AccountContext
  /**
   * Called with the error code when sending fails for good without throwing
   * (the account health tracking needs e.g. AUTH_FAILED, roadmap 3.4).
   */
  onFailed?: (code: OutboxErrorCode) => void
}

interface OutboxRow {
  id: string
  status: OutboxStatus
  content_enc: Buffer | null
  message_id_header: string
  in_reply_to: string | null
  references: string[]
  sent_copy: SentCopyStatus | null
  sent_at: Date | null
}

/** Error with a stable code; thrown to make the job queue retry. */
export class SendRetryError extends Error {
  constructor(readonly code: string) {
    super(`send_message retry: ${code}`)
  }
}

/** Maps nodemailer/network errors to a code and whether retrying can help. */
export function classifySmtpError(err: unknown): { code: OutboxErrorCode; permanent: boolean } {
  const error = (err ?? {}) as { code?: string; responseCode?: number; message?: string }
  const text = String(error.message ?? err)
  if (error.code === 'PRIVATE_HOST_BLOCKED') return { code: 'BLOCKED_HOST', permanent: true }
  if (error.code === 'EAUTH' || error.code === 'ENOAUTH') {
    return { code: 'AUTH_FAILED', permanent: true }
  }
  const responseCode = Number(error.responseCode)
  if (responseCode >= 500 && responseCode < 600) {
    return {
      code: responseCode === 530 || responseCode === 535 ? 'AUTH_FAILED' : 'SMTP_REJECTED',
      permanent: true,
    }
  }
  if (responseCode >= 400 && responseCode < 500) return { code: 'SMTP_TEMPORARY', permanent: false }
  if (/ENOTFOUND|EAI_AGAIN/.test(text) || error.code === 'EDNS') {
    return { code: 'HOST_NOT_FOUND', permanent: false }
  }
  if (/ECONNREFUSED/.test(text)) return { code: 'CONNECTION_REFUSED', permanent: false }
  if (error.code === 'ETIMEDOUT' || /timed? ?out/i.test(text)) {
    return { code: 'TIMEOUT', permanent: false }
  }
  if (error.code === 'ETLS' || /certificate|TLS|SSL/i.test(text)) {
    return { code: 'TLS_ERROR', permanent: false }
  }
  return { code: 'UNKNOWN', permanent: false }
}

/** True for providers that store sent mail in "Sent" on their own. */
export function providerSavesSentCopy(ctx: AccountContext): boolean {
  return AUTO_SAVE_HOST_RE.test(ctx.smtp.host) || AUTO_SAVE_HOST_RE.test(ctx.imap.host)
}

/** Builds the raw RFC 5322 message; `keepBcc` only for the Sent copy. */
async function buildMessage(
  row: OutboxRow,
  content: OutboxContent,
  date: Date,
  keepBcc: boolean,
): Promise<{ raw: Buffer; envelope: { from: string; to: string[] } }> {
  const composer = new MailComposer({
    from: content.from,
    to: content.to,
    cc: content.cc,
    bcc: content.bcc,
    subject: content.subject,
    text: content.text,
    messageId: row.message_id_header,
    date,
    inReplyTo: row.in_reply_to ?? undefined,
    references: row.references.length > 0 ? row.references : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  const node = composer.compile()
  node.keepBcc = keepBcc
  const envelope = node.getEnvelope() as { from: string; to: string[] }
  const raw = await node.build()
  return { raw, envelope }
}

async function sendViaSmtp(
  ctx: AccountContext,
  raw: Buffer,
  envelope: { from: string; to: string[] },
): Promise<void> {
  if (!mailTestMode()) await assertPublicHost(ctx.smtp.host)
  const transporter = nodemailer.createTransport({
    host: ctx.smtp.host,
    port: ctx.smtp.port,
    secure: ctx.smtp.secure,
    auth: { user: ctx.smtp.user, pass: ctx.smtp.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    tls: mailTestMode() ? { rejectUnauthorized: false } : undefined,
    ignoreTLS: mailTestMode(),
  })
  const unregister = closeOnJobAbort(() => transporter.close())
  try {
    await transporter.sendMail({ envelope, raw })
  } finally {
    unregister()
    transporter.close()
  }
}

async function appendToSent(ctx: AccountContext, path: string, raw: Buffer, date: Date) {
  if (!mailTestMode()) await assertPublicHost(ctx.imap.host)
  const client = new ImapFlow({
    host: ctx.imap.host,
    port: ctx.imap.port,
    secure: ctx.imap.secure,
    auth: { user: ctx.imap.user, pass: ctx.imap.password },
    logger: false,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    tls: mailTestMode() ? { rejectUnauthorized: false } : undefined,
    ...(mailTestMode() ? { doSTARTTLS: false as const } : {}),
  })
  const unregister = closeOnJobAbort(() => client.close())
  try {
    await client.connect()
    await client.append(path, raw, ['\\Seen'], date)
  } finally {
    unregister()
    await client.logout().catch(() => client.close())
  }
}

async function setStatus(pool: Pool, id: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields)
  const sets = keys.map((key, index) => `${key} = $${index + 2}`)
  await pool.query(
    `UPDATE outbox_message SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1`,
    [id, ...keys.map((key) => fields[key])],
  )
}

export async function runSendMessage(
  pool: Pool,
  accountId: string,
  payload: Record<string, unknown>,
  options: SendMessageOptions = {},
): Promise<SendMessageOutcome> {
  const outboxId = typeof payload.outboxId === 'string' ? payload.outboxId : null
  if (!outboxId) throw new Error('send_message job without outbox id')
  const finalAttempt = (options.attempt ?? 1) >= (options.maxAttempts ?? MAX_JOB_ATTEMPTS)

  const { rows } = await pool.query<OutboxRow>(
    `SELECT id, status, content_enc, message_id_header, in_reply_to, "references", sent_copy,
            sent_at
     FROM outbox_message WHERE id = $1 AND account_id = $2`,
    [outboxId, accountId],
  )
  const row = rows[0]
  if (!row) return 'missing'
  if (row.sent_at && row.sent_copy !== 'pending') return 'already_done'
  // A duplicate job, or the message failed for good meanwhile (retry re-queues it).
  if (!row.sent_at && row.status !== 'queued' && row.status !== 'sending') return 'not_queued'
  if (!row.content_enc) throw new Error('outbox message without content')

  const ctx =
    options.context ?? (await loadAccountContext(pool, accountId, process.env.MASTER_KEY ?? ''))
  const content = JSON.parse(
    decryptField(ctx.dek, row.content_enc.toString('utf8'), outboxContentAad(row.id)),
  ) as OutboxContent

  // Step 1: SMTP (only while not yet accepted).
  let sentAt = row.sent_at
  if (!sentAt) {
    await pool.query(
      `UPDATE outbox_message SET status = 'sending', attempts = attempts + 1, updated_at = now()
       WHERE id = $1`,
      [row.id],
    )
    const date = new Date()
    try {
      const { raw, envelope } = await buildMessage(row, content, date, false)
      await sendViaSmtp(ctx, raw, envelope)
    } catch (err) {
      const { code, permanent } = classifySmtpError(err)
      if (permanent || finalAttempt) {
        await setStatus(pool, row.id, { status: 'failed', last_error_code: code })
        log.warn({ accountId, outboxId, code, permanent }, 'send_message failed')
        options.onFailed?.(code)
        return 'failed'
      }
      await setStatus(pool, row.id, { status: 'queued', last_error_code: code })
      throw new SendRetryError(code)
    }
    sentAt = date
    await setStatus(pool, row.id, {
      status: 'sent',
      sent_at: date,
      last_error_code: null,
      sent_copy: 'pending',
    })
    log.info({ accountId, outboxId }, 'send_message accepted by smtp')
  }

  // Step 2: copy in "Sent".
  const { rows: sentFolders } = await pool.query<{ id: string; path: string }>(
    `SELECT id, path FROM folder WHERE account_id = $1 AND special_use = 'sent'
     ORDER BY path LIMIT 1`,
    [accountId],
  )
  const sentFolder = sentFolders[0]
  let sentCopy: SentCopyStatus
  if (providerSavesSentCopy(ctx) || !sentFolder) {
    sentCopy = 'skipped'
  } else {
    try {
      const { raw } = await buildMessage(row, content, sentAt, true)
      await appendToSent(ctx, sentFolder.path, raw, sentAt)
      sentCopy = 'done'
    } catch (err) {
      if (!finalAttempt) throw new SendRetryError('SENT_COPY_FAILED')
      log.warn(
        { accountId, outboxId, err: (err as { code?: string }).code ?? 'unknown' },
        'send_message: copy to Sent failed for good',
      )
      sentCopy = 'failed'
    }
  }
  // Settled: drop the content (the copy lives in "Sent" on the server now).
  await setStatus(pool, row.id, { sent_copy: sentCopy, content_enc: null })
  if (sentCopy === 'done') await enqueueMessageSync(pool, accountId, sentFolder!.id)
  return 'sent'
}

/**
 * After the job queue gave up on an unexpected error (e.g. undecryptable
 * credentials), marks a not-yet-sent message as failed so the user sees it
 * (and can retry). Already accepted messages keep status 'sent'.
 */
export async function markSendGivenUp(pool: Pool, payload: Record<string, unknown>): Promise<void> {
  if (typeof payload.outboxId !== 'string') return
  await pool.query(
    `UPDATE outbox_message
     SET status = 'failed', last_error_code = COALESCE(last_error_code, 'UNKNOWN'),
         updated_at = now()
     WHERE id = $1 AND sent_at IS NULL AND status IN ('queued', 'sending')`,
    [payload.outboxId],
  )
  await pool.query(
    `UPDATE outbox_message SET sent_copy = 'failed', content_enc = NULL, updated_at = now()
     WHERE id = $1 AND sent_at IS NOT NULL AND sent_copy = 'pending'`,
    [payload.outboxId],
  )
}
