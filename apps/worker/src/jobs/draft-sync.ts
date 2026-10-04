/**
 * draft_sync job (roadmap 2.8): mirrors a server-side draft into the
 * account's IMAP Drafts folder (special_use 'drafts'), so other mail
 * clients see it, and removes it again once it is discarded or sent.
 *
 * - Upload (draft newer than its last upload, `imap_version < version`):
 *   APPEND the RFC 5322 message with \Draft \Seen, then delete every older
 *   copy of this draft by UID: found via the Message-ID, which carries the
 *   draft id (`<draft id>.<version>@domain`, IMAP SEARCH HEADER matches
 *   substrings) - this also catches copies left over by a crash between
 *   APPEND and the database update - plus the original copy of a draft
 *   that was written in another client (`source_*`) - unless `keep_source`
 *   is set (not all of its attachments could be copied when it was opened):
 *   then the original stays, so its attachments are never lost. A new
 *   Message-ID per version keeps the message sync from reusing stale metadata.
 * - Delete (`deleted_at` set): remove all copies, then delete the row.
 * - Attachments kept with the draft (roadmap 5.3) are part of the copy,
 *   built like the sent message (../uploads).
 * - Without a Drafts folder the draft stays server-only.
 * - Coalescing: the api enqueues one job per burst of autosaves (see
 *   enqueueDraftSync); a save during the upload enqueues the next job.
 *   Jobs of one account never run in parallel (job runner), so the upload
 *   and a later delete cannot interleave.
 * - Afterwards a message_sync of the folder updates the local list.
 *
 * Never logged: content, addresses, folder names.
 */
import { ImapFlow } from 'imapflow'
import MailComposer from 'nodemailer/lib/mail-composer'
import type { Pool } from '@fma/db'
import { decryptField, draftContentAad } from '@fma/crypto'
import { parseAddressList, type DraftContent, type MailPerson } from '@fma/shared'
import { loadAccountContext, type AccountContext } from '../accounts'
import { closeOnJobAbort } from '../job-context'
import { imapTransportOptions } from '@fma/shared/mail-transport'
import { enqueueMessageSync } from '../scheduler'
import { composerAttachments, loadUploads, type OutgoingAttachment } from '../uploads'

const CONNECT_TIMEOUT_MS = 15_000

export type DraftSyncOutcome =
  'uploaded' | 'removed' | 'up_to_date' | 'no_drafts_folder' | 'missing'

interface DraftRow {
  id: string
  identity_id: string | null
  content_enc: Buffer | null
  in_reply_to: string | null
  references: string[]
  version: number
  imap_version: number
  updated_at: Date
  deleted_at: Date | null
  source_folder_id: string | null
  source_uidvalidity: string | null
  source_uid: string | null
  keep_source: boolean
}

interface FolderRef {
  id: string
  path: string
}

/** SSRF check + mandatory STARTTLS, then a not yet connected client. */
async function connect(ctx: AccountContext): Promise<ImapFlow> {
  return new ImapFlow({
    ...(await imapTransportOptions(ctx.imap)),
    auth: { user: ctx.imap.user, pass: ctx.imap.password },
    logger: false,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  })
}

/** Message-ID of one uploaded version; the draft id makes all versions findable. */
export function draftMessageId(draftId: string, version: number, fromAddress: string): string {
  const domain = fromAddress.split('@').pop() || 'localhost'
  return `<${draftId}.${version}@${domain}>`
}

/** Sender of the copy: the draft's identity, else the default one, else the account. */
async function senderOf(pool: Pool, ctx: AccountContext, row: DraftRow): Promise<MailPerson> {
  const { rows } = await pool.query<{ name: string; email_address: string }>(
    `SELECT i.name, i.email_address
     FROM identity i JOIN mail_account a ON a.id = i.account_id
     WHERE i.account_id = $1 AND (i.id = $2 OR $2::uuid IS NULL)
     ORDER BY (i.id = a.default_identity_id) DESC, i.email_address LIMIT 1`,
    [ctx.accountId, row.identity_id],
  )
  const identity = rows[0]
  return identity
    ? { name: identity.name.replace(/[\r\n]+/g, ' '), address: identity.email_address }
    : { name: '', address: ctx.emailAddress }
}

async function buildDraft(
  row: DraftRow,
  content: DraftContent,
  from: MailPerson,
  messageId: string,
  attachments: OutgoingAttachment[],
): Promise<Buffer> {
  // Only the valid addresses of the typed fields (a draft may be incomplete).
  const people = (value: string) => parseAddressList(value).people
  const composer = new MailComposer({
    attachments: composerAttachments(attachments),
    from,
    to: people(content.to),
    cc: people(content.cc),
    bcc: people(content.bcc),
    subject: content.subject,
    text: content.text,
    messageId,
    date: row.updated_at,
    inReplyTo: row.in_reply_to ?? undefined,
    references: row.references.length > 0 ? row.references : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  const node = composer.compile()
  node.keepBcc = true
  return node.build()
}

/** UIDs of all copies of the draft in the selected folder (any version). */
async function copiesOf(client: ImapFlow, draftId: string): Promise<number[]> {
  const uids = await client.search({ header: { 'message-id': draftId } }, { uid: true })
  return Array.isArray(uids) ? uids : []
}

async function deleteUids(client: ImapFlow, uids: number[]): Promise<void> {
  if (uids.length === 0) return
  await client.messageDelete(uids.join(','), { uid: true })
}

/** Deletes the source copy (a draft of another client) if it lives in another folder. */
async function removeSourceElsewhere(
  pool: Pool,
  client: ImapFlow,
  row: DraftRow,
  draftsFolderId: string | null,
): Promise<string | null> {
  if (
    row.keep_source ||
    !row.source_folder_id ||
    !row.source_uid ||
    row.source_folder_id === draftsFolderId
  ) {
    return null
  }
  const { rows } = await pool.query<{ path: string; uidvalidity: string | null }>(
    'SELECT path, uidvalidity FROM folder WHERE id = $1',
    [row.source_folder_id],
  )
  const folder = rows[0]
  if (!folder) return null
  const lock = await client.getMailboxLock(folder.path)
  try {
    const mailbox = client.mailbox
    // Stale UID after a UIDVALIDITY change: leave the message alone.
    if (mailbox && String(mailbox.uidValidity) === String(row.source_uidvalidity)) {
      await deleteUids(client, [Number(row.source_uid)])
    }
  } finally {
    lock.release()
  }
  return row.source_folder_id
}

export async function runDraftSync(
  pool: Pool,
  accountId: string,
  payload: Record<string, unknown>,
  context?: AccountContext,
): Promise<DraftSyncOutcome> {
  const draftId = typeof payload.draftId === 'string' ? payload.draftId : null
  if (!draftId) throw new Error('draft_sync job without draft id')

  const { rows } = await pool.query<DraftRow>(
    `SELECT id, identity_id, content_enc, in_reply_to, "references", version, imap_version,
            updated_at, deleted_at, source_folder_id, source_uidvalidity, source_uid,
            keep_source
     FROM draft WHERE id = $1 AND account_id = $2`,
    [draftId, accountId],
  )
  const row = rows[0]
  if (!row) return 'missing'
  if (!row.deleted_at && row.imap_version >= row.version) return 'up_to_date'

  const { rows: folders } = await pool.query<FolderRef>(
    `SELECT id, path FROM folder
     WHERE account_id = $1 AND special_use = 'drafts' AND selectable
     ORDER BY path LIMIT 1`,
    [accountId],
  )
  const drafts = folders[0] ?? null
  // keep_source: not all attachments of the source were copied - never
  // delete it (the user removes it in the Drafts folder when done).
  const hasSource = Boolean(row.source_folder_id && row.source_uid && !row.keep_source)

  // Without a Drafts folder nothing is uploaded; a source copy elsewhere is
  // only removed once the draft is discarded or sent.
  if (!drafts && (!hasSource || !row.deleted_at)) {
    if (row.deleted_at) {
      await pool.query('DELETE FROM draft WHERE id = $1 AND deleted_at IS NOT NULL', [row.id])
      return 'removed'
    }
    await pool.query('UPDATE draft SET imap_version = $2 WHERE id = $1', [row.id, row.version])
    return 'no_drafts_folder'
  }

  const ctx = context ?? (await loadAccountContext(pool, accountId, process.env.MASTER_KEY ?? ''))
  let upload: { raw: Buffer; messageId: string } | null = null
  if (!row.deleted_at && drafts) {
    if (!row.content_enc) throw new Error('draft without content')
    const content = JSON.parse(
      decryptField(ctx.dek, row.content_enc.toString('utf8'), draftContentAad(row.id)),
    ) as DraftContent
    const from = await senderOf(pool, ctx, row)
    const messageId = draftMessageId(row.id, row.version, from.address)
    const attachments = await loadUploads(pool, ctx.dek, { draftId: row.id })
    upload = { raw: await buildDraft(row, content, from, messageId, attachments), messageId }
  }

  const client = await connect(ctx)
  const unregister = closeOnJobAbort(() => client.close())
  const touched = new Set<string>()
  try {
    await client.connect()
    if (drafts) {
      if (upload) {
        await client.append(drafts.path, upload.raw, ['\\Draft', '\\Seen'], row.updated_at)
      }
      const lock = await client.getMailboxLock(drafts.path)
      try {
        const copies = await copiesOf(client, row.id)
        // The copy just uploaded is the newest one with this draft id.
        const keep = upload ? Math.max(0, ...copies) : 0
        const remove = copies.filter((uid) => uid !== keep)
        const mailbox = client.mailbox
        if (
          !row.keep_source &&
          row.source_uid &&
          row.source_folder_id === drafts.id &&
          mailbox &&
          String(mailbox.uidValidity) === String(row.source_uidvalidity)
        ) {
          remove.push(Number(row.source_uid))
        }
        await deleteUids(client, remove)
      } finally {
        lock.release()
      }
      touched.add(drafts.id)
    }
    const sourceFolder = await removeSourceElsewhere(pool, client, row, drafts?.id ?? null)
    if (sourceFolder) touched.add(sourceFolder)
  } finally {
    unregister()
    await client.logout().catch(() => client.close())
  }

  let outcome: DraftSyncOutcome
  if (row.deleted_at) {
    await pool.query('DELETE FROM draft WHERE id = $1 AND deleted_at IS NOT NULL', [row.id])
    outcome = 'removed'
  } else {
    // The source copy is gone now; later saves only replace our own copies.
    await pool.query(
      `UPDATE draft SET imap_version = GREATEST(imap_version, $2), message_id_header = $3,
         source_folder_id = NULL, source_uidvalidity = NULL, source_uid = NULL
       WHERE id = $1`,
      [row.id, row.version, upload?.messageId ?? null],
    )
    outcome = 'uploaded'
  }
  for (const folderId of touched) await enqueueMessageSync(pool, accountId, folderId)
  return outcome
}
