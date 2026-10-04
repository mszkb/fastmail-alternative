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
  /** Manually assigned role (roadmap 3.3); null = automatic detection. */
  specialUseOverride: string | null
  /** false: container without messages (IMAP \Noselect, e.g. "[Gmail]"). */
  selectable: boolean
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
  /**
   * Envelope recipients (Delivered-To/X-Original-To, lower-case): picks the
   * sender identity of a reply when To/Cc do not name one (roadmap 3.6).
   */
  deliveredTo: string[]
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
 * `POST /api/outbox` - sends a plain-text message, optionally with
 * attachments uploaded before (HTML follows later). Recipients are plain addresses or `{ name, address }`.
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
  /**
   * Client-generated UUID (roadmap 4.6): a repeated request with the same
   * id (offline queue replay, retry after a timeout) returns the message
   * queued the first time instead of sending it again.
   */
  clientId?: string
  /**
   * Draft this message was written in (roadmap 2.8): it is deleted with
   * the send (also its copy in the IMAP Drafts folder). Unknown ids are
   * ignored, so a replayed send never fails because of its draft.
   */
  draftId?: string
  /**
   * Uploaded attachments (`POST /api/accounts/:id/uploads`, roadmap 5.3) of
   * the same account, in order. Each upload can be sent once; it is deleted
   * after the message settled.
   */
  attachmentIds?: string[]
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
  | 'ATTACHMENT_MISSING'
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
  ATTACHMENT_MISSING:
    'Ein Anhang ist nicht mehr vorhanden - bitte die Nachricht neu schreiben und den Anhang erneut hinzufügen.',
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

/**
 * Choices for the sync period offered in the account settings: a number of
 * days before today (converted to an absolute `syncSince` date on save),
 * null = all messages.
 */
export const SYNC_SINCE_CHOICES: ReadonlyArray<{ days: number | null; label: string }> = [
  { days: null, label: 'Alle' },
  { days: 30, label: '30 Tage' },
  { days: 90, label: '90 Tage' },
  { days: 365, label: '1 Jahr' },
]

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DD` (UTC) of a date. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * UTC midnight of a `YYYY-MM-DD` day, for binding to the timestamptz column
 * `mail_account.sync_since`. Binding the bare day string would let Postgres
 * interpret it in the session TimeZone (east of UTC: previous UTC day).
 */
export function utcMidnight(day: string): Date
export function utcMidnight(day: string | null): Date | null
export function utcMidnight(day: string | null): Date | null {
  return day === null ? null : new Date(`${day}T00:00:00.000Z`)
}

/** `YYYY-MM-DD` of the day `days` days before `now` (UTC). */
export function syncSinceFromDays(days: number, now: Date = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  date.setUTCDate(date.getUTCDate() - days)
  return isoDay(date)
}

/**
 * Validates a `syncSince` input (roadmap 2.2, #28): null (no limit) or a
 * calendar day `YYYY-MM-DD` between 1970-01-01 and today (UTC; one day of
 * slack for clients east of UTC). IMAP SEARCH SINCE compares days only, so
 * a time of day carries no meaning. Returns undefined when invalid.
 */
export function parseSyncSince(value: unknown, now: Date = new Date()): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const match = ISO_DAY_RE.exec(value)
  if (!match) return undefined
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  // Rejects impossible days like 2026-02-30 (Date.UTC rolls them over).
  if (Number.isNaN(date.getTime()) || isoDay(date) !== value) return undefined
  if (date.getTime() < 0) return undefined
  if (value > syncSinceFromDays(-1, now)) return undefined
  return value
}

/** One mail account as the api lists it (never credentials or keys). */
export interface AccountSummary {
  id: string
  displayName: string
  emailAddress: string
  imap: { host: string; port: number }
  smtp: { host: string; port: number }
  status: AccountStatus
  /** Last connection error (machine code only), null when healthy. */
  lastErrorCode: AccountErrorCode | null
  /** Next automatic connection attempt while the circuit is open. */
  nextRetryAt: string | null
  capabilities: string[]
  sortOrder: number
  lastSyncAt: string | null
  /**
   * Sync limit (roadmap 2.2, #28), `YYYY-MM-DD`: the message sync only
   * fetches messages whose IMAP internal date is on or after this day;
   * null = no limit. "Load older messages" ignores it.
   */
  syncSince: string | null
  /**
   * Unread messages in the INBOX (special-use `inbox`) - the number shown in
   * the account switcher, computed like the folder counts.
   */
  unreadCount: number
  /**
   * A folder/message sync of the account is queued (and eligible) or
   * running; clients poll briefly until it is done (roadmap 4.5).
   */
  syncing: boolean
}

/** `GET /api/accounts` */
export interface AccountListResponse {
  accounts: AccountSummary[]
}

/**
 * Account health (roadmap 3.4): `auth_error` waits for new credentials,
 * `unreachable` retries automatically with backoff (circuit breaker).
 */
export type AccountStatus = 'ok' | 'auth_error' | 'unreachable' | 'disabled'

/** Stable connection error codes of an account (worker, roadmap 3.4). */
export type AccountErrorCode =
  | 'AUTH_FAILED'
  | 'HOST_NOT_FOUND'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_LOST'
  | 'TIMEOUT'
  | 'TLS_ERROR'
  | 'BLOCKED_HOST'
  | 'JOB_TIMEOUT'
  /** Imported account (roadmap 4.7): the export never contains passwords. */
  | 'CREDENTIALS_REQUIRED'
  /** Provider throttling or too many connections (roadmap 3.5): backoff. */
  | 'RATE_LIMITED'

export const ACCOUNT_ERROR_MESSAGES: Record<AccountErrorCode, string> = {
  AUTH_FAILED: 'Der Mailserver hat die Zugangsdaten abgelehnt.',
  HOST_NOT_FOUND: 'Der Mailserver wurde nicht gefunden – bitte Hostnamen prüfen.',
  CONNECTION_REFUSED: 'Der Mailserver hat die Verbindung abgelehnt – Host und Port prüfen.',
  CONNECTION_LOST: 'Die Verbindung zum Mailserver ist abgebrochen.',
  TIMEOUT: 'Der Mailserver antwortet nicht (Zeitüberschreitung).',
  TLS_ERROR: 'TLS-Fehler – das Zertifikat des Mailservers konnte nicht verifiziert werden.',
  BLOCKED_HOST: 'Interner Host ist blockiert (SSRF-Schutz).',
  JOB_TIMEOUT: 'Der Mailserver hat zu lange gebraucht; der Abgleich wurde abgebrochen.',
  CREDENTIALS_REQUIRED: 'Das Konto wurde importiert – das Passwort muss neu eingegeben werden.',
  RATE_LIMITED:
    'Der Mailanbieter bremst gerade (zu viele Verbindungen oder Anfragen); der Abgleich pausiert kurz.',
}

export interface AccountStatusInfo {
  /** Short label for the badge. */
  label: string
  /** German explanation for the user. */
  description: string
  /** Label of the button that opens the account settings, if helpful. */
  action: string | null
}

/** Status explanation for the UI; null for a healthy account. */
export function accountStatusInfo(
  account: Pick<AccountSummary, 'status' | 'lastErrorCode'>,
): AccountStatusInfo | null {
  const reason = account.lastErrorCode ? ACCOUNT_ERROR_MESSAGES[account.lastErrorCode] : ''
  switch (account.status) {
    case 'auth_error':
      return {
        label:
          account.lastErrorCode === 'CREDENTIALS_REQUIRED'
            ? 'Passwort fehlt'
            : 'Anmeldung fehlgeschlagen',
        description:
          `${reason || ACCOUNT_ERROR_MESSAGES.AUTH_FAILED} Der Abgleich dieses Kontos ist ` +
          'angehalten, bis die Zugangsdaten aktualisiert sind. Andere Konten sind nicht betroffen.',
        action: 'Zugangsdaten aktualisieren',
      }
    case 'unreachable':
      return {
        label: 'Server nicht erreichbar',
        description:
          `${reason || 'Der Mailserver ist nicht erreichbar.'} Neue Versuche erfolgen ` +
          'automatisch in wachsenden Abständen. Andere Konten sind nicht betroffen.',
        action: 'Verbindungsdaten prüfen',
      }
    case 'disabled':
      return {
        label: 'Deaktiviert',
        description: 'Dieses Konto wird nicht abgeglichen.',
        action: null,
      }
    default:
      return null
  }
}

/**
 * Why a sync request (roadmap 4.5) did not enqueue a job: the account is
 * disabled or needs new credentials, its circuit breaker is open, a sync is
 * already queued/running, or the last one was requested too recently.
 */
export type SyncSkipReason = 'disabled' | 'auth_error' | 'backoff' | 'pending' | 'rate_limited'

export interface SyncRequestResult {
  accountId: string
  queued: boolean
  reason: SyncSkipReason | null
}

/** `POST /api/sync` (all accounts) */
export interface SyncAllResponse {
  accounts: SyncRequestResult[]
}
