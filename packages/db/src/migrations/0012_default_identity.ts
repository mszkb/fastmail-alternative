import type { Migration } from '../migrate'

/**
 * Sender identities (roadmap 3.6): the user picks the default identity of
 * an account. NULL keeps the previous rule (identity matching the account
 * address). No FK: identity already cascades from mail_account, and the
 * api refuses to delete the default identity.
 * Identities are unique per account and address (case-insensitive).
 */
export const migration0012 = {
  name: '0012_default_identity',
  sql: /* sql */ `
    ALTER TABLE mail_account ADD COLUMN default_identity_id uuid;
    DELETE FROM identity a USING identity b
      WHERE a.account_id = b.account_id
        AND lower(a.email_address) = lower(b.email_address)
        AND a.id > b.id;
    CREATE UNIQUE INDEX identity_account_address_idx ON identity (account_id, lower(email_address));
  `,
} satisfies Migration
