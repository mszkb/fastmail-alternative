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
