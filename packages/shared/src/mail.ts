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
}

/** `GET /api/folders/:id/messages` - `nextCursor` is null on the last page. */
export interface MessageListResponse {
  messages: MessageListItem[]
  nextCursor: string | null
}

/** `GET /api/messages/:id` - plain text only (HTML rendering follows in 2.9). */
export interface MessageDetail {
  id: string
  accountId: string
  folderIds: string[]
  subject: string
  from: MailPerson | null
  to: MailPerson[]
  cc: MailPerson[]
  date: string
  flags: MessageFlags
  hasAttachments: boolean
  /** null while the body has not been downloaded by the sync worker yet. */
  text: string | null
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
