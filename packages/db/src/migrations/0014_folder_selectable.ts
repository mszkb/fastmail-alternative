import type { Migration } from '../migrate'

/**
 * Non-selectable mailboxes (review fix): LIST flags \Noselect/\NonExistent
 * (e.g. Gmail's "[Gmail]" parent) mark containers that hold no messages.
 * folder_sync stores them for the tree but message_sync skips them.
 */
export const migration0014 = {
  name: '0014_folder_selectable',
  sql: /* sql */ `
    ALTER TABLE folder ADD COLUMN selectable boolean NOT NULL DEFAULT true;
  `,
} satisfies Migration
