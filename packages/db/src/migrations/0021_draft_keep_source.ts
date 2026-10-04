import type { Migration } from '../migrate'

/**
 * Keep the source copy of a draft opened from another client (#53).
 *
 * `draft.keep_source`: not all attachments of the other client's draft could
 * be copied into uploads (limits, raw mail not stored, parse error, too many
 * copies running). The draft_sync job then never deletes the source copy in
 * the IMAP Drafts folder, so the attachments are not lost with the first
 * upload of the edited version.
 *
 * NOT NULL with a constant default: no table rewrite, safe on a populated
 * database.
 */
export const migration0021 = {
  name: '0021_draft_keep_source',
  sql: /* sql */ `
    ALTER TABLE draft ADD COLUMN IF NOT EXISTS keep_source boolean NOT NULL DEFAULT false;
  `,
} satisfies Migration
