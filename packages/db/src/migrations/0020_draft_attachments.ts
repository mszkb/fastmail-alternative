import type { Migration } from '../migrate'

/**
 * Attachments in drafts (roadmap 5.3, #53).
 *
 * - `attachment_upload.draft_id`: an upload kept with a draft (set by
 *   `PUT /api/drafts/:id` via `attachmentIds`). Such uploads are not
 *   "stale" for the cleanup while the draft exists; they are deleted with
 *   the draft (ON DELETE CASCADE, the draft_sync job deletes the row after
 *   a discard). Sending the draft moves them to the outbox message
 *   (`outbox_id` set, `draft_id` cleared in the same transaction).
 *
 * Nullable column without default and a new partial index on a small table:
 * no table rewrite, safe on a populated database.
 */
export const migration0020 = {
  name: '0020_draft_attachments',
  sql: /* sql */ `
    ALTER TABLE attachment_upload
      ADD COLUMN IF NOT EXISTS draft_id uuid REFERENCES draft (id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS attachment_upload_draft_idx ON attachment_upload (draft_id)
      WHERE draft_id IS NOT NULL;
  `,
} satisfies Migration
