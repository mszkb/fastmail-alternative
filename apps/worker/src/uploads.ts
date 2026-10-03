/**
 * Uploaded attachments (roadmap 5.3) as MailComposer attachments - shared by
 * send_message (bound to an outbox message) and draft_sync (kept with a
 * draft), so the IMAP Drafts copy carries the same MIME as the sent mail.
 *
 * File names are mail content: decrypted only in memory, never logged.
 */
import type { Pool } from '@fma/db'
import { decryptBytes, decryptField, uploadFieldAad } from '@fma/crypto'

/** A decrypted upload. */
export interface OutgoingAttachment {
  filename: string
  contentType: string
  content: Buffer
}

/** Decrypts the uploads bound to an outbox message or kept with a draft, in upload order. */
export async function loadUploads(
  pool: Pool,
  dek: Buffer,
  owner: { outboxId: string } | { draftId: string },
): Promise<OutgoingAttachment[]> {
  const byOutbox = 'outboxId' in owner
  const { rows } = await pool.query<{
    id: string
    filename_enc: Buffer
    content_type: string
    content_enc: Buffer
  }>(
    `SELECT id, filename_enc, content_type, content_enc FROM attachment_upload
     WHERE ${byOutbox ? 'outbox_id = $1' : 'draft_id = $1 AND outbox_id IS NULL'}
     ORDER BY created_at, id`,
    [byOutbox ? owner.outboxId : owner.draftId],
  )
  return rows.map((upload) => ({
    filename: decryptField(
      dek,
      upload.filename_enc.toString('utf8'),
      uploadFieldAad('filename', upload.id),
    ),
    contentType: upload.content_type,
    content: decryptBytes(dek, upload.content_enc, uploadFieldAad('content', upload.id)),
  }))
}

/** MailComposer `attachments` option (no file or URL access). */
export function composerAttachments(
  attachments: OutgoingAttachment[],
): { filename: string; contentType: string; content: Buffer }[] {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    content: attachment.content,
  }))
}
