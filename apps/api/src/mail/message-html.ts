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
 * - Responses are `Cache-Control: no-store` (mail content).
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { simpleParser, type Attachment } from 'mailparser'
import { decryptField, messageFieldAad, unwrapAccountKey } from '@fma/crypto'
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

/** Content-ID -> data: URL for inline raster images (cid: references). */
export function inlineImageMap(attachments: Attachment[]): Map<string, string> {
  const map = new Map<string, string>()
  let total = 0
  for (const attachment of attachments) {
    const cid = attachment.contentId?.replace(/^<|>$/g, '').toLowerCase()
    const type = attachment.contentType?.toLowerCase()
    if (!cid || !type || !INLINE_IMAGE_TYPES.has(type)) continue
    const url = `data:${type};base64,${attachment.content.toString('base64')}`
    if (url.length > MAX_DATA_URL_LENGTH || total + url.length > MAX_INLINE_TOTAL) continue
    total += url.length
    map.set(cid, url)
  }
  return map
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
    const envelope = (await readFile(file)).toString('utf8')
    return Buffer.from(decryptField(dek, envelope, messageFieldAad('body', messageId)), 'latin1')
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

      let html: string | false
      let attachments: Attachment[]
      try {
        const parsed = await simpleParser(raw, {
          // cid: links are resolved by the sanitizer (raster images only).
          keepCidLinks: true,
          skipTextToHtml: true,
          skipTextLinks: true,
          skipImageLinks: true,
        })
        html = parsed.html
        attachments = parsed.attachments
      } catch {
        request.log.warn({ messageId }, 'raw message could not be parsed')
        await reply.send(empty)
        return
      }
      if (!html) {
        await reply.send(empty)
        return
      }

      const result = sanitizeMailHtml(html, {
        allowRemote: request.query.remote === '1',
        inlineImages: inlineImageMap(attachments),
      })
      const body: MessageHtmlResponse = result
      await reply.send(body)
    },
  )
}
