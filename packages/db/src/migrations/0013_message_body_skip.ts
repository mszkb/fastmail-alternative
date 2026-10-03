import type { Migration } from '../migrate'

/**
 * Skipped bodies (review fix, issue #28): message_sync stores a marker row
 * for bodies it does not keep (over the size limit, empty) instead of
 * downloading them again on every run. Such rows have no storage_ref and
 * a skip_reason ('too_large' | 'empty').
 */
export const migration0013 = {
  name: '0013_message_body_skip',
  sql: /* sql */ `
    ALTER TABLE message_body ALTER COLUMN storage_ref DROP NOT NULL;
    ALTER TABLE message_body ADD COLUMN skip_reason text;
  `,
} satisfies Migration
