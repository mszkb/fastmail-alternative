import type { Migration } from '../migrate'

/**
 * Metadata version of a message (backfill after the address bug).
 *
 * Messages synced before the fix stored From/To/Cc as empty lists and no
 * Reply-To/References. Existing rows get version 1; the message sync writes
 * the current version on insert and re-derives the metadata of outdated
 * rows in bounded batches (from the stored raw mail, else from IMAP).
 */
export const migration0007 = {
  name: '0007_message_metadata_version',
  sql: /* sql */ `
    ALTER TABLE message ADD COLUMN metadata_version integer NOT NULL DEFAULT 1;
  `,
} satisfies Migration
