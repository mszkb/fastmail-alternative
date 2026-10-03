/**
 * Response shapes of the mail read API (roadmap 2.3), shared by api and web.
 * All human-readable fields are decrypted server-side for the logged-in user.
 */

export interface MailPerson {
  name: string
  address: string
}

export interface MessageFlags {
  seen: boolean
  flagged: boolean
  answered: boolean
}

/** One folder in tree (pre-)order; `depth` 0 = top level. */
export interface FolderSummary {
  id: string
  name: string
  path: string
  delimiter: string | null
  parentId: string | null
  depth: number
  specialUse: string | null
  unreadCount: number
  total: number
}

/** `GET /api/accounts/:id/folders` */
export interface FolderListResponse {
  folders: FolderSummary[]
}

export interface MessageListItem {
  id: string
  subject: string
  from: MailPerson | null
  date: string
  snippet: string
  flags: MessageFlags
  hasAttachments: boolean
  /** Conversation (roadmap 2.5); null until the worker has threaded the message. */
  threadId: string | null
  /** Messages in the conversation across all folders of the account (1 = single). */
  threadCount: number
}

/** `GET /api/folders/:id/messages` - `nextCursor` is null on the last page. */
export interface MessageListResponse {
  messages: MessageListItem[]
  nextCursor: string | null
}

/** `GET /api/messages/:id` - plain text body; the HTML body comes from MessageHtmlResponse. */
export interface MessageDetail {
  id: string
  accountId: string
  folderIds: string[]
  subject: string
  from: MailPerson | null
  to: MailPerson[]
  cc: MailPerson[]
  /** Reply-To header; empty when the message has none (reply goes to From). */
  replyTo: MailPerson[]
  date: string
  flags: MessageFlags
  hasAttachments: boolean
  /** Message-ID header (angle brackets); null when the message has none. */
  messageId: string | null
  /** References header (Message-IDs, oldest first). */
  references: string[]
  /** null while the body has not been downloaded by the sync worker yet. */
  text: string | null
  /** Conversation (roadmap 2.5); null until the worker has threaded the message. */
  threadId: string | null
}

/**
 * `GET /api/messages/:id/html?remote=0|1` - sanitized HTML body (roadmap
 * 2.9). Render only in a sandboxed iframe (no scripts, no same-origin) with
 * a restrictive CSP. Remote images are removed unless `remote=1`.
 */
export interface MessageHtmlResponse {
  /** null when the message has no HTML part or its body is not synced yet (use `text`). */
  html: string | null
  /** True when remote images/backgrounds were removed (loadable with `remote=1`). */
  remoteContentBlocked: boolean
}

/**
 * `GET /api/threads/:id` - all messages of a conversation across the
 * account's folders (e.g. including Sent), oldest first. `subject` is the
 * subject of the newest message.
 */
export interface ThreadDetail {
  id: string
  accountId: string
  subject: string
  messages: MessageDetail[]
}

/** User-facing message actions (roadmap 2.4). */
export type MessageAction = 'read' | 'unread' | 'flag' | 'unflag' | 'archive' | 'delete' | 'move'

export const MESSAGE_ACTIONS: readonly MessageAction[] = [
  'read',
  'unread',
  'flag',
  'unflag',
  'archive',
  'delete',
  'move',
]

/** Upper bound of messages per action request. */
export const MAX_MESSAGE_ACTION_BATCH = 100

/**
 * `POST /api/messages/actions` - applies an action to messages of ONE folder
 * (the folder the list shows; message ids as returned by the list/detail).
 * `targetFolderId` is required for `move` and must belong to the same
 * account. `delete` moves to Trash, or deletes permanently inside Trash.
 */
export interface MessageActionRequest {
  folderId: string
  messageIds: string[]
  action: MessageAction
  targetFolderId?: string
}

export interface MessageActionResponse {
  /** Number of message locations changed locally (write-back is queued). */
  updated: number
}

/** IMAP-level operation of a message_action write-back job. */
export type MessageActionOperation = 'read' | 'unread' | 'flag' | 'unflag' | 'move' | 'expunge'

/**
 * Payload of the `message_action` job (ids only, never content). `items`
 * pairs each source UID with the local location (placeholder in the target
 * folder for moves) and message id.
 */
export interface MessageActionJobPayload {
  operation: MessageActionOperation
  folderId: string
  uidvalidity: string
  items: { uid: number; locationId: string; messageId: string }[]
  targetFolderId?: string
}

/** Sending (roadmap 2.7): outbox status of a message handed to the SMTP worker. */
export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed'

/** Copy in the "Sent" folder: skipped for providers that store it themselves (Gmail) or without a Sent folder. */
export type SentCopyStatus = 'pending' | 'done' | 'skipped' | 'failed'

/** Limits of `POST /api/outbox` (also usable for client-side validation). */
export const OUTBOX_LIMITS = {
  /** to + cc + bcc together. */
  maxRecipients: 100,
  maxSubjectLength: 998,
  /** Plain text body, in characters. */
  maxTextLength: 500_000,
  maxReferences: 100,
  maxNameLength: 200,
} as const

/**
 * Pragmatic address check (no quoted local parts, no IP literals): one `@`,
 * no whitespace, no characters with a special meaning in address headers.
 */
const ADDRESS_RE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]+$/

export function isValidEmailAddress(address: string): boolean {
  return address.length <= 320 && ADDRESS_RE.test(address)
}

/**
 * `POST /api/outbox` - sends a plain-text message (HTML and attachments
 * follow later). Recipients are plain addresses or `{ name, address }`.
 * `identityId` defaults to the account's default identity.
 * `inReplyTo`/`references` are Message-IDs in angle brackets.
 */
export interface SendMessageRequest {
  accountId: string
  identityId?: string
  to: (string | MailPerson)[]
  cc?: (string | MailPerson)[]
  bcc?: (string | MailPerson)[]
  subject: string
  text: string
  inReplyTo?: string
  references?: string[]
}

/** Stable error codes of a failed send; `message` carries the German text. */
export type OutboxErrorCode =
  | 'AUTH_FAILED'
  | 'SMTP_REJECTED'
  | 'SMTP_TEMPORARY'
  | 'HOST_NOT_FOUND'
  | 'BLOCKED_HOST'
  | 'CONNECTION_REFUSED'
  | 'TIMEOUT'
  | 'TLS_ERROR'
  | 'UNKNOWN'

export const OUTBOX_ERROR_MESSAGES: Record<OutboxErrorCode, string> = {
  AUTH_FAILED: 'Der SMTP-Server hat die Zugangsdaten abgelehnt.',
  SMTP_REJECTED: 'Der SMTP-Server hat die Nachricht abgelehnt (z. B. Empfänger unbekannt).',
  SMTP_TEMPORARY: 'Der SMTP-Server ist vorübergehend nicht bereit. Neuer Versuch folgt.',
  HOST_NOT_FOUND: 'SMTP-Server nicht gefunden - bitte Hostnamen prüfen.',
  BLOCKED_HOST: 'Interner SMTP-Host ist blockiert (SSRF-Schutz).',
  CONNECTION_REFUSED: 'Verbindung zum SMTP-Server abgelehnt - Host/Port prüfen.',
  TIMEOUT: 'Zeitüberschreitung beim Verbinden mit dem SMTP-Server.',
  TLS_ERROR: 'TLS-Fehler - Zertifikat des SMTP-Servers konnte nicht verifiziert werden.',
  UNKNOWN: 'Versand fehlgeschlagen.',
}

/** `GET /api/outbox/:id`, entries of `GET /api/accounts/:id/outbox`. */
export interface OutboxMessage {
  id: string
  accountId: string
  identityId: string | null
  status: OutboxStatus
  /** Decrypted content; null once the message is sent and its Sent copy settled. */
  subject: string | null
  from: MailPerson | null
  to: MailPerson[]
  cc: MailPerson[]
  bcc: MailPerson[]
  /** Message-ID header (angle brackets), generated once at submission. */
  messageId: string
  attempts: number
  /** Last error (also while a retry is pending); null after success. */
  error: { code: OutboxErrorCode; message: string } | null
  sentCopy: SentCopyStatus | null
  createdAt: string
  sentAt: string | null
}

/** `GET /api/accounts/:id/outbox` - queued, sending and failed messages, newest first. */
export interface OutboxListResponse {
  messages: OutboxMessage[]
}

/** Payload of the `send_message` job (ids only). */
export interface SendMessageJobPayload {
  outboxId: string
}

/** Encrypted content of an outbox message (JSON in `outbox_message.content_enc`). */
export interface OutboxContent {
  from: MailPerson
  to: MailPerson[]
  cc: MailPerson[]
  bcc: MailPerson[]
  subject: string
  text: string
}
