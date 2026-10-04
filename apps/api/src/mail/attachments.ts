/**
 * Attachments (roadmap 5.3).
 *
 * Received attachments - derived on demand from the encrypted raw mail in
 * the mail-data volume (like the HTML view, 2.9), nothing is stored:
 * - `GET /api/messages/:id/attachments` lists them (name, type, size).
 * - `GET /api/messages/:id/attachments/:index[?inline=1]` streams one
 *   decoded attachment out of the MIME parser (never buffered as a whole).
 *   Sandboxing: always `X-Content-Type-Options: nosniff`, a CSP with
 *   `sandbox` and `default-src 'none'`, no caching. Only raster images and
 *   plain text may be shown inline (`?inline=1`); every other type - HTML,
 *   SVG, scripts, PDF, unknown - is sent as `application/octet-stream`
 *   with `Content-Disposition: attachment`, so it can never run in the
 *   app's origin.
 *
 * Attachments to send:
 * - `POST /api/accounts/:id/uploads` takes one file as the raw request body
 *   (`Content-Type: application/octet-stream`, name in `X-Filename`
 *   percent-encoded, type in `X-Content-Type`), limited to
 *   MAX_ATTACHMENT_BYTES, and stores it encrypted with the account DEK.
 *   Session, account ownership and a global limit of uploads in progress
 *   (MAX_CONCURRENT_UPLOADS, default 2, else 429) are checked in onRequest,
 *   i.e. before the body is read: unauthenticated clients cannot make the
 *   api buffer large bodies (memory limit of the container). Copies out of
 *   a raw mail (forward, opening a draft of another client) share this
 *   admission with weight 2 (tryAdmitUpload). Per account at most
 *   MAX_PENDING_UPLOADS uploads without draft/message and MAX_DRAFT_UPLOADS
 *   uploads kept with drafts; count + insert run under an advisory lock.
 * - `DELETE /api/uploads/:id` removes an upload not yet attached to a
 *   message. `POST /api/outbox` attaches uploads via `attachmentIds`
 *   (see ./outbox), the worker deletes them after sending.
 *   `PUT /api/drafts/:id` keeps uploads with a draft (`draft_id`, see
 *   ./drafts), so they survive closing and reopening it.
 * - `POST /api/messages/:id/attachments/copy` (forwarding, #53) copies the
 *   attachments of a received message into new uploads of the sending
 *   account: decrypted raw mail -> one attachment at a time out of the MIME
 *   parser -> encrypted upload. Done once when the forward is opened, so
 *   the composer, drafts, limits and the worker treat them like any picked
 *   file (the user can remove single ones), and sending needs no access to
 *   the mail-data volume in the worker's MIME builder. With
 *   `includeInline: true` (the composer's forward) inline raster images
 *   (png/jpeg/gif/webp, never SVG/HTML) are copied too, as normal
 *   attachments: the forward is sent as text, so the cid: references of
 *   the original HTML are gone and the images would be lost otherwise.
 *
 * File names are mail content: never logged, encrypted at rest.
 */
import { randomUUID } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import type { Pool, PoolClient } from '@fma/db'
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { MailParser, type AttachmentStream, type MessageText } from 'mailparser'
import { encryptBytes, encryptField, unwrapAccountKey, uploadFieldAad } from '@fma/crypto'
import {
  ATTACHMENT_LIMIT_DEFAULTS,
  contentDisposition,
  FORWARD_INLINE_IMAGE_TYPES,
  formatByteSize,
  isInlineSafeType,
  normalizeContentType,
  sanitizeFilename,
  type CopyAttachmentsResponse,
  type MessageAttachment,
  type MessageAttachmentListResponse,
  type UploadedAttachment,
} from '@fma/shared'
import { requireAuth } from '../auth/routes'
import { readRaw, slices } from './message-html'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * Uploads neither kept with a draft nor attached to a message, per account
 * (bounded until the cleanup removes them, #55).
 */
export const MAX_PENDING_UPLOADS = 100
/**
 * Uploads kept with drafts, per account. The cleanup leaves them alone
 * while their draft exists, so they have their own, more generous limit
 * (otherwise a few drafts with attachments would block new uploads).
 */
export const MAX_DRAFT_UPLOADS = 200
/** Weight units in progress at the same time (MAX_CONCURRENT_UPLOADS), see tryAdmitUpload. */
const DEFAULT_MAX_CONCURRENT_UPLOADS = 2
/**
 * Weight of copying a message's attachments (raw mail + parser + one
 * decoded attachment + its encrypted copy in memory): about twice an upload.
 */
export const COPY_ADMISSION_WEIGHT = 2
/** Advisory lock class for "count + insert" of an account's uploads. */
const UPLOAD_LOCK_CLASS = 0x2f7570 // "/up"
const TOO_MANY_UPLOADS = 'Gerade laufen zu viele Uploads - bitte gleich erneut versuchen.'
const ATTACHMENT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"

function envBytes(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function maxConcurrentUploads(): number {
  return envBytes('MAX_CONCURRENT_UPLOADS', DEFAULT_MAX_CONCURRENT_UPLOADS)
}

/** Weight in progress in this process (upload bodies, attachment copies). */
let activeUploadWeight = 0

/**
 * Admission for memory-heavy attachment work (upload bodies, copies out of
 * a raw mail), shared by all routes of this process: returns a release
 * function, or null when MAX_CONCURRENT_UPLOADS weight units are in use
 * (the caller answers 429). A weight above the limit counts as the limit,
 * so a copy still runs alone with MAX_CONCURRENT_UPLOADS=1.
 */
export function tryAdmitUpload(weight = 1): (() => void) | null {
  const capacity = maxConcurrentUploads()
  const units = Math.min(weight, capacity)
  if (activeUploadWeight + units > capacity) return null
  activeUploadWeight += units
  let released = false
  return () => {
    if (released) return
    released = true
    activeUploadWeight -= units
  }
}

/**
 * Serializes "count + insert/attach" of an account's uploads until the end
 * of the transaction of `client`, so concurrent requests cannot exceed the
 * per-account limits.
 */
export async function lockAccountUploads(client: PoolClient, accountId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
    UPLOAD_LOCK_CLASS,
    accountId,
  ])
}

/** Uploads kept with drafts of an account (to check MAX_DRAFT_UPLOADS). */
export async function countDraftUploads(client: PoolClient, accountId: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*) FROM attachment_upload
     WHERE account_id = $1 AND draft_id IS NOT NULL AND outbox_id IS NULL`,
    [accountId],
  )
  return Number(rows[0]?.count ?? 0)
}

/**
 * Inserts an encrypted upload unless the account's limit for its kind
 * (pending: MAX_PENDING_UPLOADS, kept with a draft: MAX_DRAFT_UPLOADS) is
 * reached; false = limit reached, nothing inserted.
 */
async function insertUpload(
  pool: Pool,
  upload: {
    id: string
    accountId: string
    filenameEnc: Buffer
    contentType: string
    size: number
    contentEnc: Buffer
    draftId: string | null
  },
): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await lockAccountUploads(client, upload.accountId)
    let count: number
    if (upload.draftId) {
      count = await countDraftUploads(client, upload.accountId)
    } else {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) FROM attachment_upload
         WHERE account_id = $1 AND draft_id IS NULL AND outbox_id IS NULL`,
        [upload.accountId],
      )
      count = Number(rows[0]?.count ?? 0)
    }
    if (count >= (upload.draftId ? MAX_DRAFT_UPLOADS : MAX_PENDING_UPLOADS)) {
      await client.query('ROLLBACK')
      return false
    }
    await client.query(
      `INSERT INTO attachment_upload
         (id, account_id, filename_enc, content_type, size_bytes, content_enc, draft_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        upload.id,
        upload.accountId,
        upload.filenameEnc,
        upload.contentType,
        upload.size,
        upload.contentEnc,
        upload.draftId,
      ],
    )
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Configured attachment limits (bytes), read per call so tests can override them. */
export function attachmentLimits(): { maxFileBytes: number; maxTotalBytes: number } {
  return {
    maxFileBytes: envBytes('MAX_ATTACHMENT_BYTES', ATTACHMENT_LIMIT_DEFAULTS.maxFileBytes),
    maxTotalBytes: envBytes('MAX_ATTACHMENTS_TOTAL_BYTES', ATTACHMENT_LIMIT_DEFAULTS.maxTotalBytes),
  }
}

function newParser(): MailParser {
  return new MailParser({
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    skipImageLinks: true,
  })
}

function metaOf(data: AttachmentStream, index: number): MessageAttachment {
  return {
    index,
    filename: sanitizeFilename(data.filename, `anhang-${index + 1}`),
    contentType: normalizeContentType(data.contentType),
    size: 0,
    inline: Boolean(data.related),
  }
}

/** Lists the attachments of a raw mail; contents are counted and dropped. */
export function listAttachments(raw: Buffer): Promise<MessageAttachment[]> {
  return new Promise((resolve, reject) => {
    const parser = newParser()
    const list: MessageAttachment[] = []
    parser.on('data', (data: AttachmentStream | MessageText) => {
      if (data.type === 'text') return
      const meta = metaOf(data, list.length)
      list.push(meta)
      data.content.on('data', (chunk: Buffer) => {
        meta.size += chunk.length
      })
      data.content.on('end', () => data.release())
    })
    parser.once('error', reject)
    parser.once('end', () => resolve(list))
    Readable.from(slices(raw)).pipe(parser)
  })
}

/**
 * Opens attachment `index` of a raw mail as a stream (decoded content).
 * Resolves null when the mail has no such attachment. Other parts are
 * drained; when the consumer goes away early, the rest is drained too, so
 * the parser always finishes and frees the raw mail.
 */
export function openAttachment(
  raw: Buffer,
  index: number,
): Promise<{ meta: MessageAttachment; stream: Readable } | null> {
  return new Promise((resolve, reject) => {
    const parser = newParser()
    let seen = 0
    let output: PassThrough | null = null
    parser.on('data', (data: AttachmentStream | MessageText) => {
      if (data.type === 'text') return
      const current = seen++
      if (current !== index || output) {
        ;(data.content as Readable).resume()
        data.release()
        return
      }
      const stream = new PassThrough()
      output = stream
      const content = data.content as Readable
      content.on('end', () => data.release())
      stream.on('close', () => {
        if (!content.readableEnded) {
          content.unpipe(stream)
          content.resume()
        }
      })
      content.pipe(stream)
      resolve({ meta: metaOf(data, current), stream })
    })
    parser.once('error', (err) => {
      if (output) output.destroy(err)
      else reject(err)
    })
    parser.once('end', () => {
      if (!output) resolve(null)
    })
    Readable.from(slices(raw)).pipe(parser)
  })
}

/**
 * Decrypted raw mail of a message of the user; 'missing' = no such
 * message (or foreign), null = raw mail not stored (yet).
 */
export async function loadOwnedRaw(
  pool: Pool,
  log: FastifyBaseLogger,
  userId: string,
  messageId: string,
): Promise<Buffer | 'missing' | null> {
  if (!UUID_RE.test(messageId)) return 'missing'
  const { rows } = await pool.query<{ wrapped_dek: Buffer; storage_ref: string | null }>(
    `SELECT a.wrapped_dek, mb.storage_ref
     FROM message m
     JOIN mail_account a ON a.id = m.account_id
     LEFT JOIN message_body mb ON mb.message_id = m.id
     WHERE m.id = $1 AND a.user_id = $2`,
    [messageId, userId],
  )
  const row = rows[0]
  if (!row) return 'missing'
  if (!row.storage_ref) return null
  const dek = unwrapAccountKey(process.env.MASTER_KEY ?? '', row.wrapped_dek)
  return readRaw(log, dek, messageId, row.storage_ref)
}

/** Reads a stream into one buffer; null when it exceeds `limit` bytes. */
async function collect(stream: Readable, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += (chunk as Buffer).length
    if (size > limit) {
      stream.destroy()
      return null
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Copies the (non-inline) attachments of a raw mail into encrypted uploads
 * of `account`, optionally kept with `draftId` (forwarding, opening a
 * draft of another client). With `includeInline` inline parts of a safe
 * raster image type (FORWARD_INLINE_IMAGE_TYPES) are copied as well;
 * unnamed ones are called `bild-N.<ext>`. Only one attachment is in memory
 * at a time; attachments beyond the per-file, total, count or pending
 * limits are skipped. File names are never logged.
 */
export async function copyAttachmentsToUploads(
  pool: Pool,
  raw: Buffer,
  account: { id: string; wrapped_dek: Buffer },
  draftId: string | null = null,
  options: { includeInline?: boolean } = {},
): Promise<CopyAttachmentsResponse> {
  const list = (await listAttachments(raw)).filter(
    (attachment) =>
      !attachment.inline ||
      (options.includeInline === true && attachment.contentType in FORWARD_INLINE_IMAGE_TYPES),
  )
  let inlineCount = 0
  const { maxFileBytes, maxTotalBytes } = attachmentLimits()
  const dek = unwrapAccountKey(process.env.MASTER_KEY ?? '', account.wrapped_dek)
  const attachments: UploadedAttachment[] = []
  let total = 0
  let skipped = 0
  let full = false
  for (const meta of list) {
    if (
      full ||
      attachments.length >= ATTACHMENT_LIMIT_DEFAULTS.maxCount ||
      meta.size > maxFileBytes ||
      total + meta.size > maxTotalBytes
    ) {
      skipped++
      continue
    }
    const opened = await openAttachment(raw, meta.index)
    const content = opened ? await collect(opened.stream, maxFileBytes) : null
    if (!opened || !content) {
      skipped++
      continue
    }
    const id = randomUUID()
    const contentType = opened.meta.contentType
    let filename = opened.meta.filename
    if (meta.inline) {
      inlineCount++
      // metaOf's fallback name: replace it by one telling the image type.
      if (filename === `anhang-${meta.index + 1}`) {
        filename = `bild-${inlineCount}.${FORWARD_INLINE_IMAGE_TYPES[contentType]}`
      }
    }
    const inserted = await insertUpload(pool, {
      id,
      accountId: account.id,
      filenameEnc: Buffer.from(encryptField(dek, filename, uploadFieldAad('filename', id)), 'utf8'),
      contentType,
      size: content.length,
      contentEnc: encryptBytes(dek, content, uploadFieldAad('content', id)),
      draftId,
    })
    if (!inserted) {
      full = true
      skipped++
      continue
    }
    total += content.length
    attachments.push({ id, filename, contentType, size: content.length })
  }
  return { attachments, skipped }
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  function loadRaw(request: FastifyRequest, messageId: string) {
    return loadOwnedRaw(pool, request.log, request.auth!.userId, messageId)
  }

  app.get<{ Params: { id: string } }>(
    '/api/messages/:id/attachments',
    { onRequest: requireAuth },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store')
      const raw = await loadRaw(request, request.params.id)
      if (raw === 'missing') {
        await reply.code(404).send({ message: 'Nachricht nicht gefunden.' })
        return
      }
      let attachments: MessageAttachment[] = []
      if (raw) {
        try {
          attachments = await listAttachments(raw)
        } catch {
          request.log.warn({ messageId: request.params.id }, 'raw message could not be parsed')
        }
      }
      const body: MessageAttachmentListResponse = { attachments }
      await reply.send(body)
    },
  )

  app.get<{ Params: { id: string; index: string }; Querystring: { inline?: string } }>(
    '/api/messages/:id/attachments/:index',
    { onRequest: requireAuth },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store')
      const index = Number(request.params.index)
      const raw =
        Number.isInteger(index) && index >= 0
          ? await loadRaw(request, request.params.id)
          : 'missing'
      let opened: Awaited<ReturnType<typeof openAttachment>> = null
      if (raw && raw !== 'missing') {
        try {
          opened = await openAttachment(raw, index)
        } catch {
          request.log.warn({ messageId: request.params.id }, 'raw message could not be parsed')
        }
      }
      if (!opened) {
        await reply.code(404).send({ message: 'Anhang nicht gefunden.' })
        return
      }
      const { meta, stream } = opened
      const safe = isInlineSafeType(meta.contentType)
      const inline = safe && request.query.inline === '1'
      void reply
        .header('content-type', safe ? meta.contentType : 'application/octet-stream')
        .header(
          'content-disposition',
          contentDisposition(inline ? 'inline' : 'attachment', meta.filename),
        )
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', ATTACHMENT_CSP)
        .header('cross-origin-resource-policy', 'same-origin')
        .header('referrer-policy', 'no-referrer')
      return reply.send(stream)
    },
  )

  // Raw uploads: only this plugin parses application/octet-stream bodies.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  )

  /** Account resolved by admitUpload, per request. */
  const uploadAccounts = new WeakMap<FastifyRequest, { id: string; wrapped_dek: Buffer }>()

  /**
   * Runs before the body is read (onRequest, after requireAuth): only an
   * owner of the account may make the api buffer up to MAX_ATTACHMENT_BYTES,
   * and at most MAX_CONCURRENT_UPLOADS weight units (bodies, copies) are in
   * memory at once.
   */
  async function admitUpload(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const accountId = request.params.id
    const { rows } = UUID_RE.test(accountId)
      ? await pool.query<{ id: string; wrapped_dek: Buffer }>(
          'SELECT id, wrapped_dek FROM mail_account WHERE id = $1 AND user_id = $2',
          [accountId, request.auth!.userId],
        )
      : { rows: [] }
    const account = rows[0]
    if (!account) {
      await reply.code(404).send({ message: 'Konto nicht gefunden.' })
      return
    }
    const release = tryAdmitUpload()
    if (!release) {
      await reply.code(429).header('retry-after', '2').send({ message: TOO_MANY_UPLOADS })
      return
    }
    // 'close' fires after the response was sent and when the client aborts.
    reply.raw.once('close', release)
    uploadAccounts.set(request, account)
  }

  app.post<{ Params: { id: string }; Body: Buffer }>(
    '/api/accounts/:id/uploads',
    {
      onRequest: [requireAuth, admitUpload],
      bodyLimit: attachmentLimits().maxFileBytes,
      errorHandler: async (error, _request, reply) => {
        if ((error as { statusCode?: number }).statusCode === 413) {
          await reply.code(413).send({
            message: `Die Datei ist zu groß (höchstens ${formatByteSize(attachmentLimits().maxFileBytes)}).`,
          })
          return
        }
        throw error
      },
    },
    async (request, reply) => {
      const account = uploadAccounts.get(request)!
      const body = request.body
      if (!Buffer.isBuffer(body)) {
        await reply.code(415).send({ message: 'Erwartet: application/octet-stream.' })
        return
      }
      const { maxFileBytes } = attachmentLimits()
      if (body.length > maxFileBytes) {
        await reply
          .code(413)
          .send({ message: `Die Datei ist zu groß (höchstens ${formatByteSize(maxFileBytes)}).` })
        return
      }
      let filename: string
      try {
        filename = sanitizeFilename(decodeURIComponent(String(request.headers['x-filename'] ?? '')))
      } catch {
        await reply.code(400).send({ message: 'Ungültiger Dateiname.' })
        return
      }
      const contentType = normalizeContentType(request.headers['x-content-type'])

      const id = randomUUID()
      const dek = unwrapAccountKey(process.env.MASTER_KEY ?? '', account.wrapped_dek)
      const inserted = await insertUpload(pool, {
        id,
        accountId: account.id,
        filenameEnc: Buffer.from(
          encryptField(dek, filename, uploadFieldAad('filename', id)),
          'utf8',
        ),
        contentType,
        size: body.length,
        contentEnc: encryptBytes(dek, body, uploadFieldAad('content', id)),
        draftId: null,
      })
      if (!inserted) {
        await reply.code(429).send({ message: 'Zu viele nicht gesendete Anhänge.' })
        return
      }
      const result: UploadedAttachment = { id, filename, contentType, size: body.length }
      await reply.code(201).send(result)
    },
  )

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/messages/:id/attachments/copy',
    { onRequest: requireAuth },
    async (request, reply) => {
      const requestBody = request.body as { accountId?: unknown; includeInline?: unknown } | null
      const accountId = requestBody?.accountId
      const includeInline = requestBody?.includeInline === true
      const { rows } =
        typeof accountId === 'string' && UUID_RE.test(accountId)
          ? await pool.query<{ id: string; wrapped_dek: Buffer }>(
              'SELECT id, wrapped_dek FROM mail_account WHERE id = $1 AND user_id = $2',
              [accountId, request.auth!.userId],
            )
          : { rows: [] }
      const account = rows[0]
      if (!account) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
      // Shares the admission of upload bodies (heavier: weight 2).
      const release = tryAdmitUpload(COPY_ADMISSION_WEIGHT)
      if (!release) {
        await reply.code(429).header('retry-after', '2').send({ message: TOO_MANY_UPLOADS })
        return
      }
      try {
        const raw = await loadRaw(request, request.params.id)
        if (raw === 'missing') {
          await reply.code(404).send({ message: 'Nachricht nicht gefunden.' })
          return
        }
        if (!raw) {
          await reply
            .code(409)
            .send({ message: 'Der Inhalt dieser Nachricht ist noch nicht synchronisiert.' })
          return
        }
        let result: CopyAttachmentsResponse
        try {
          result = await copyAttachmentsToUploads(pool, raw, account, null, { includeInline })
        } catch (err) {
          if ((err as { code?: string }).code) throw err
          request.log.warn({ messageId: request.params.id }, 'raw message could not be parsed')
          await reply.code(422).send({ message: 'Die Anhänge konnten nicht gelesen werden.' })
          return
        }
        await reply.code(201).send(result)
      } finally {
        release()
      }
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/uploads/:id',
    { onRequest: requireAuth },
    async (request, reply) => {
      const { rowCount } = UUID_RE.test(request.params.id)
        ? await pool.query(
            `DELETE FROM attachment_upload u USING mail_account a
             WHERE u.id = $1 AND a.id = u.account_id AND a.user_id = $2
               AND u.outbox_id IS NULL`,
            [request.params.id, request.auth!.userId],
          )
        : { rowCount: 0 }
      if (!rowCount) {
        await reply.code(404).send({ message: 'Anhang nicht gefunden.' })
        return
      }
      await reply.code(204).send()
    },
  )
}
