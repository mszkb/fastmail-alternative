import type { Migration } from '../migrate'

/**
 * Idempotent sending (roadmap 4.6, offline queue): `client_id` is a UUID
 * the client generates once per composed message. A replayed or retried
 * POST /api/outbox with the same id returns the existing entry instead of
 * sending the message twice. Unique per account; NULL for requests without
 * an id (older clients).
 */
export const migration0015 = {
  name: '0015_outbox_client_id',
  sql: /* sql */ `
    ALTER TABLE outbox_message ADD COLUMN client_id uuid;
    CREATE UNIQUE INDEX outbox_message_client_id_idx
      ON outbox_message (account_id, client_id) WHERE client_id IS NOT NULL;
  `,
} satisfies Migration
