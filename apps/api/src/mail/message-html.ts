/**
 * Sanitized HTML body of a message (roadmap 2.9):
 * GET /api/messages/:id/html?remote=0|1
 *
 * - The HTML part is extracted on demand from the encrypted raw source the
 *   worker stores in the mail-data volume (mounted read-only into the api),
 *   decrypted with the account DEK. Nothing is cached or logged.
 * - Inline images (cid:) are embedded as data: URLs (raster images only,
 *   size-limited); remote images are removed unless remote=1 (see
 *   ./html-sanitizer for the full policy).
 * - Bounded memory: the raw mail is parsed as a stream; attachment
 *   contents are drained, never buffered, except inline images within the
 *   data: URL limits (the api runs with a small memory limit).
 * - Responses are `Cache-Control: no-store` (mail content).
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { MailParser, type AttachmentStream, type MessageText } from 'mailparser'
import { decryptBytes, messageFieldAad, unwrapAccountKey } from '@fma/crypto'
import type { MessageHtmlResponse } from '@fma/shared'
import { requireAuth } from '../auth/routes'
import { MAX_DATA_URL_LENGTH, sanitizeMailHtml } from './html-sanitizer'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INLINE_IMAGE_TYPES = new Set([
  'image/png',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/bmp',
  'image/avif',
])
/** Upper bound for all inline images of one message together (base64 bytes). */
const MAX_INLINE_TOTAL = 15 * 1024 * 1024

function mailDataDir(): string {
  return process.env.MAIL_DATA_DIR ?? '/app/mail-data'
}

/** 64 KiB views of a buffer (no copies) to stream it into a parser. */
function* slices(buf: Buffer): Generator<Buffer> {
  for (let i = 0; i < buf.length; i += 64 * 1024) yield buf.subarray(i, i + 64 * 1024)
}

/** Decoded bytes of an inline image whose data: URL stays within the limit. */
const MAX_INLINE_IMAGE_BYTES = Math.floor((MAX_DATA_URL_LENGTH * 3) / 4)

export interface ParsedHtml {
  html: string | null
  /** Content-ID -> data: URL for inline raster images (cid: references). */
  inlineImages: Map<string, string>
}

/**
 * Extracts the HTML part and inline raster images of a raw mail. Unlike
 * simpleParser (which buffers every attachment), attachment streams are
 * drained and dropped unless they are an inline image within the limits.
 */
export function parseMailHtml(raw: Buffer): Promise<ParsedHtml> {
  return new Promise((resolve, reject) => {
    const parser = new MailParser({
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipTextLinks: true,
      skipImageLinks: true,
    })
    let html: string | null = null
    const inlineImages = new Map<string, string>()
    let total = 0

    const collectImage = (attachment: AttachmentStream, cid: string, type: string): void => {
      const chunks: Buffer[] = []
      let size = 0
      attachment.content.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size <= MAX_INLINE_IMAGE_BYTES) chunks.push(chunk)
        else chunks.length = 0 // too large: keep draining, drop the content
      })
      attachment.content.on('end', () => {
        if (size <= MAX_INLINE_IMAGE_BYTES) {
          const url = `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`
          if (url.length <= MAX_DATA_URL_LENGTH && total + url.length <= MAX_INLINE_TOTAL) {
            total += url.length
            inlineImages.set(cid, url)
          }
        }
        attachment.release()
      })
    }

    parser.on('data', (data: AttachmentStream | MessageText) => {
      if (data.type === 'text') {
        if (typeof data.html === 'string') html = data.html
        return
      }
      const cid = data.contentId?.replace(/^<|>$/g, '').trim().toLowerCase()
      const type = data.contentType?.toLowerCase()
      if (cid && type && INLINE_IMAGE_TYPES.has(type)) {
        collectImage(data, cid, type)
      } else {
        // Drain (a released but unread stream would still buffer).
        ;(data.content as Readable).resume()
        data.release()
      }
    })
    parser.once('error', reject)
    parser.once('end', () => resolve({ html, inlineImages }))
    // Fed in slices with backpressure: writing the whole buffer at once lets
    // the parser queue all decoded chunks before they are consumed.
    Readable.from(slices(raw)).pipe(parser)
  })
}

/**
 * Reads and decrypts the raw source. Returns null when the file is missing,
 * outside the volume or cannot be decrypted (logged without content).
 */
async function readRaw(
  log: FastifyBaseLogger,
  dek: Buffer,
  messageId: string,
  storageRef: string,
): Promise<Buffer | null> {
  const root = path.resolve(mailDataDir())
  const file = path.resolve(root, storageRef)
  if (!file.startsWith(root + path.sep)) return null // never leave the volume
  try {
    return decryptBytes(dek, await readFile(file), messageFieldAad('body', messageId))
  } catch (err) {
    log.warn(
      { messageId, code: (err as NodeJS.ErrnoException).code ?? 'decrypt' },
      'raw message could not be read',
    )
    return null
  }
}

export async function messageHtmlRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  app.get<{ Params: { id: string }; Querystring: { remote?: string } }>(
    '/api/messages/:id/html',
    { preHandler: requireAuth },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store')
      const messageId = request.params.id
      if (!UUID_RE.test(messageId)) {
        await reply.code(404).send({ message: 'Nachricht nicht gefunden.' })
        return
      }
      const { rows } = await pool.query<{ wrapped_dek: Buffer; storage_ref: string | null }>(
        `SELECT a.wrapped_dek, mb.storage_ref
         FROM message m
         JOIN mail_account a ON a.id = m.account_id
         LEFT JOIN message_body mb ON mb.message_id = m.id
         WHERE m.id = $1 AND a.user_id = $2`,
        [messageId, request.auth!.userId],
      )
      const row = rows[0]
      if (!row) {
        await reply.code(404).send({ message: 'Nachricht nicht gefunden.' })
        return
      }

      const empty: MessageHtmlResponse = { html: null, remoteContentBlocked: false }
      if (!row.storage_ref) {
        await reply.send(empty)
        return
      }
      const dek = unwrapAccountKey(process.env.MASTER_KEY ?? '', row.wrapped_dek)
      const raw = await readRaw(request.log, dek, messageId, row.storage_ref)
      if (!raw) {
        await reply.send(empty)
        return
      }

      // cid: links are resolved by the sanitizer (raster images only).
      let parsed: ParsedHtml
      try {
        parsed = await parseMailHtml(raw)
      } catch {
        request.log.warn({ messageId }, 'raw message could not be parsed')
        await reply.send(empty)
        return
      }
      if (!parsed.html) {
        await reply.send(empty)
        return
      }

      const result = sanitizeMailHtml(parsed.html, {
        allowRemote: request.query.remote === '1',
        inlineImages: parsed.inlineImages,
      })
      const body: MessageHtmlResponse = result
      await reply.send(body)
    },
  )
}
