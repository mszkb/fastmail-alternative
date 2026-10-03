/**
 * Attachments (roadmap 5.3): response shapes and the delivery policy shared
 * by api and web.
 *
 * Received attachments are derived on demand from the encrypted raw mail
 * (like the HTML view); nothing about them is stored in plain text.
 * Attachments to send are uploaded first (encrypted at rest), then referenced
 * by id in `POST /api/outbox`.
 */

/** One attachment of a received message (`GET /api/messages/:id/attachments`). */
export interface MessageAttachment {
  /** Position among the message's attachments (download: `.../attachments/:index`). */
  index: number
  /** Decoded file name; a neutral fallback when the mail has none. */
  filename: string
  /** MIME type as declared by the sender (lower case, never trusted for display). */
  contentType: string
  /** Decoded size in bytes. */
  size: number
  /** Referenced from the HTML body (cid:) - usually shown there, not in the list. */
  inline: boolean
}

export interface MessageAttachmentListResponse {
  attachments: MessageAttachment[]
}

/** An uploaded attachment waiting to be sent (`POST /api/accounts/:id/uploads`). */
export interface UploadedAttachment {
  id: string
  filename: string
  contentType: string
  size: number
}

/** Default limits (bytes); the api reads overrides from the environment. */
export const ATTACHMENT_LIMIT_DEFAULTS = {
  /** One uploaded file (`MAX_ATTACHMENT_BYTES`). */
  maxFileBytes: 10 * 1024 * 1024,
  /**
   * All attachments of one message together (`MAX_ATTACHMENTS_TOTAL_BYTES`).
   * Base64 adds a third, so 14 MB stay below the default raw mail limit of
   * 20 MB and the copy in "Sent" is still stored completely.
   */
  maxTotalBytes: 14 * 1024 * 1024,
  /** Attachments per message. */
  maxCount: 20,
} as const

/** Longest accepted file name (characters). */
export const MAX_ATTACHMENT_FILENAME_LENGTH = 255

/**
 * Types a browser may render inline without running code: raster images,
 * plain text (served with nosniff and a sandbox CSP). Everything
 * else - HTML, SVG, XML, JavaScript, PDF, unknown types - is always
 * downloaded.
 */
const INLINE_SAFE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'text/plain',
])

const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/

/** Normalizes a declared MIME type; invalid or missing -> application/octet-stream. */
export function normalizeContentType(value: unknown): string {
  if (typeof value !== 'string') return 'application/octet-stream'
  const type = value.split(';')[0]!.trim().toLowerCase()
  if (type === 'image/jpg') return 'image/jpeg'
  return MIME_TYPE_RE.test(type) ? type : 'application/octet-stream'
}

/** True when the type may be shown inline (with nosniff + sandbox CSP). */
export function isInlineSafeType(contentType: string): boolean {
  return INLINE_SAFE_TYPES.has(normalizeContentType(contentType))
}

/**
 * Cleans a file name for storage and the Content-Disposition header: no
 * path parts, no control characters, bounded length; empty -> fallback.
 */
export function sanitizeFilename(value: unknown, fallback = 'anhang'): string {
  const raw = typeof value === 'string' ? value : ''
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"]+/g, '')
    .trim()
    .replace(/^\.+$/, '')
  const name = cleaned || fallback
  return name.length > MAX_ATTACHMENT_FILENAME_LENGTH
    ? name.slice(0, MAX_ATTACHMENT_FILENAME_LENGTH)
    : name
}

/**
 * Content-Disposition header value with an ASCII fallback and the RFC 5987
 * UTF-8 `filename*` parameter.
 */
export function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const name = sanitizeFilename(filename)
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_')
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** Human-readable size (German format), e.g. "1,4 MB". */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const text = value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace('.', ',')
  return `${text} ${units[unit]}`
}
