import type { Migration } from '../migrate'

/**
 * Cleanup (roadmap 5.5): index on message_location.message_id.
 *
 * The cleanup job looks for messages without any location (folder deleted
 * on the provider, interrupted UIDVALIDITY resync), and deleting a message
 * cascades to its locations - both are lookups by message_id, which had no
 * index (only folder_id/uid). Index only: no table rewrite, safe on a
 * populated database (plain CREATE INDEX, the table is moderate in size).
 */
export const migration0018 = {
  name: '0018_cleanup_indexes',
  sql: /* sql */ `
    CREATE INDEX IF NOT EXISTS message_location_message_idx ON message_location (message_id);
  `,
} satisfies Migration
