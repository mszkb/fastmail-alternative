import type { Migration } from '../migrate'

/**
 * Message actions (roadmap 2.4): optimistic moves.
 *
 * When the user moves a message (move/archive/delete to Trash), the API
 * moves its message_location to the target folder right away, before the
 * IMAP server has assigned the new UID. Such placeholder locations use
 * uidvalidity 0 and a negative uid from this sequence (unique per folder),
 * until the message_action job learns the real UID (COPYUID) or the next
 * message_sync of the target folder replaces them.
 */
export const migration0005 = {
  name: '0005_message_actions',
  sql: /* sql */ `
    CREATE SEQUENCE message_location_placeholder_seq;
  `,
} satisfies Migration
