import type { Migration } from '../migrate'

/**
 * Attachments to send (roadmap 5.3).
 *
 * - `attachment_upload`: a file uploaded while composing, encrypted with the
 *   account DEK (file name: field envelope, AAD
 *   `attachment_upload.filename:<id>`; content: binary envelope, AAD
 *   `attachment_upload.content:<id>`). Stored in the database, not in the
 *   mail-data volume: the api mounts that volume read-only, and uploads are
 *   size-limited and short-lived.
 * - `outbox_id`: set when the upload is attached to a message in
 *   `POST /api/outbox` (once; ON DELETE CASCADE with the message). The
 *   worker deletes the uploads after the message settled.
 * - Received attachments need no table: they are derived on demand from the
 *   encrypted raw mail (like the HTML view), so existing mails work without
 *   a backfill.
 *
 * New table only: safe on a populated database.
 */
export const migration0017 = {
  name: '0017_attachment_uploads',
  sql: /* sql */ `
    CREATE TABLE attachment_upload (
      id            uuid PRIMARY KEY,
      account_id    uuid NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
      outbox_id     uuid REFERENCES outbox_message (id) ON DELETE CASCADE,
      filename_enc  bytea NOT NULL,
      content_type  text NOT NULL,
      size_bytes    integer NOT NULL,
      content_enc   bytea NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX attachment_upload_account_idx ON attachment_upload (account_id, created_at);
    CREATE INDEX attachment_upload_outbox_idx ON attachment_upload (outbox_id)
      WHERE outbox_id IS NOT NULL;
  `,
} satisfies Migration
