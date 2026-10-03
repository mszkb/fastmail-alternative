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
 * - `DELETE /api/uploads/:id` removes an upload not yet attached to a
 *   message. `POST /api/outbox` attaches uploads via `attachmentIds`
 *   (see ./outbox), the worker deletes them after sending.
 *
 * File names are mail content: never logged, encrypted at rest.
 */
import { randomUUID } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { MailParser, type AttachmentStream, type MessageText } from 'mailparser'
import { encryptBytes, encryptField, unwrapAccountKey, uploadFieldAad } from '@fma/crypto'
import {
  ATTACHMENT_LIMIT_DEFAULTS,
  contentDisposition,
  formatByteSize,
  isInlineSafeType,
  normalizeContentType,
  sanitizeFilename,
  type MessageAttachment,
  type MessageAttachmentListResponse,
  type UploadedAttachment,
} from '@fma/shared'
import { requireAuth } from '../auth/routes'
import { readRaw, slices } from './message-html'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Uploads not yet attached to a message, per account (bounded until cleanup, #55). */
const MAX_PENDING_UPLOADS = 100
const ATTACHMENT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"

function envBytes(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
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

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  /** Decrypted raw mail of an owned message; null = not found / not stored. */
  async function loadRaw(
    request: FastifyRequest,
    messageId: string,
  ): Promise<Buffer | 'missing' | null> {
    if (!UUID_RE.test(messageId)) return 'missing'
    const { rows } = await pool.query<{ wrapped_dek: Buffer; storage_ref: string | null }>(
      `SELECT a.wrapped_dek, mb.storage_ref
       FROM message m
       JOIN mail_account a ON a.id = m.account_id
       LEFT JOIN message_body mb ON mb.message_id = m.id
       WHERE m.id = $1 AND a.user_id = $2`,
      [messageId, request.auth!.userId],
    )
    const row = rows[0]
    if (!row) return 'missing'
    if (!row.storage_ref) return null
    const dek = unwrapAccountKey(process.env.MASTER_KEY ?? '', row.wrapped_dek)
    return readRaw(request.log, dek, messageId, row.storage_ref)
  }

  app.get<{ Params: { id: string } }>(
    '/api/messages/:id/attachments',
    { preHandler: requireAuth },
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
    { preHandler: requireAuth },
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

  app.post<{ Params: { id: string }; Body: Buffer }>(
    '/api/accounts/:id/uploads',
    {
      preHandler: requireAuth,
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
      const accountId = request.params.id
      const { rows: accounts } = UUID_RE.test(accountId)
        ? await pool.query<{ id: string; wrapped_dek: Buffer }>(
            'SELECT id, wrapped_dek FROM mail_account WHERE id = $1 AND user_id = $2',
            [accountId, request.auth!.userId],
          )
        : { rows: [] }
      const account = accounts[0]
      if (!account) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
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

      const { rows: pending } = await pool.query<{ count: string }>(
        `SELECT count(*) FROM attachment_upload WHERE account_id = $1 AND outbox_id IS NULL`,
        [account.id],
      )
      if (Number(pending[0]?.count ?? 0) >= MAX_PENDING_UPLOADS) {
        await reply.code(429).send({ message: 'Zu viele nicht gesendete Anhänge.' })
        return
      }

      const id = randomUUID()
      const dek = unwrapAccountKey(process.env.MASTER_KEY ?? '', account.wrapped_dek)
      await pool.query(
        `INSERT INTO attachment_upload
           (id, account_id, filename_enc, content_type, size_bytes, content_enc)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          account.id,
          Buffer.from(encryptField(dek, filename, uploadFieldAad('filename', id)), 'utf8'),
          contentType,
          body.length,
          encryptBytes(dek, body, uploadFieldAad('content', id)),
        ],
      )
      const result: UploadedAttachment = { id, filename, contentType, size: body.length }
      await reply.code(201).send(result)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/uploads/:id',
    { preHandler: requireAuth },
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
