import type { Migration } from '../migrate'

/**
 * Mail accounts and per-account identities (data model, roadmap 2.1).
 *
 * - `wrapped_dek`: per-account data key, wrapped with the instance master
 *   key (@fma/crypto); `key_id` = master key version (key rotation).
 * - `credential_enc`: IMAP/SMTP credentials, encrypted with the account DEK.
 *   NEVER selected in list/detail queries - always explicit column selects.
 * - `status`: ok | auth_error | unreachable | disabled (error isolation per
 *   account, roadmap 3.4).
 */
export const migration0002 = {
  name: '0002_mail_accounts',
  sql: /* sql */ `
    CREATE TABLE mail_account (
      id               uuid PRIMARY KEY,
      user_id          uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      sort_order       integer NOT NULL DEFAULT 0,
      display_name     text NOT NULL,
      email_address    text NOT NULL,
      imap_host        text NOT NULL,
      imap_port        integer NOT NULL,
      smtp_host        text NOT NULL,
      smtp_port        integer NOT NULL,
      wrapped_dek      bytea NOT NULL,
      key_id           text NOT NULL,
      credential_kind  text NOT NULL DEFAULT 'password',
      oauth_provider   text,
      sync_since       timestamptz,
      credential_enc   bytea NOT NULL,
      status           text NOT NULL DEFAULT 'ok',
      error_count      integer NOT NULL DEFAULT 0,
      next_retry_at    timestamptz,
      last_sync_at     timestamptz,
      capabilities     text[] NOT NULL DEFAULT '{}',
      created_at       timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX mail_account_user_sort_idx ON mail_account (user_id, sort_order, created_at);
    CREATE INDEX mail_account_status_retry_idx ON mail_account (status, next_retry_at);

    CREATE TABLE identity (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id    uuid NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
      name          text NOT NULL DEFAULT '',
      email_address text NOT NULL,
      signature     text
    );
    CREATE INDEX identity_account_idx ON identity (account_id);
  `,
} satisfies Migration
