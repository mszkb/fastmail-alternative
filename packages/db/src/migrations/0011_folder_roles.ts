import type { Migration } from '../migrate'

/**
 * Folder roles (roadmap 3.3): `special_use` stays the effective role used
 * by actions (archive/trash/sent), now resolved from
 * - `special_use_detected`: written by folder_sync (SPECIAL-USE attribute
 *   or name heuristic), and
 * - `special_use_override`: the user's manual choice, never touched by the
 *   sync.
 * Existing rows keep their role as the detected one.
 */
export const migration0011 = {
  name: '0011_folder_roles',
  sql: /* sql */ `
    ALTER TABLE folder ADD COLUMN special_use_detected text;
    ALTER TABLE folder ADD COLUMN special_use_override text;
    UPDATE folder SET special_use_detected = special_use;
  `,
} satisfies Migration
