import type { Migration } from '../migrate'

/**
 * Attachments (roadmap 5.3): number of uploads bound to an outbox message.
 *
 * The worker compares it with the uploads it finds before sending: a
 * missing upload (e.g. removed by a concurrent cleanup) fails the message
 * for good instead of sending it silently without the attachment.
 * Constant default: no table rewrite (PostgreSQL >= 11), existing rows get
 * 0 = "no check", which keeps them valid.
 */
export const migration0019 = {
  name: '0019_outbox_attachment_count',
  sql: /* sql */ `
    ALTER TABLE outbox_message
      ADD COLUMN IF NOT EXISTS attachment_count integer NOT NULL DEFAULT 0;
  `,
} satisfies Migration
