import type { Migration } from '../migrate'

/**
 * Messages (data model, roadmap 2.2 step 2).
 *
 * - `message`: logical message, once per account, deduplicated via
 *   message_id_header (fallback: deterministic hash of date+size+subject
 *   HMAC formatted as a message id). Human-readable fields (subject, from,
 *   recipients, snippet) are encrypted with the account DEK.
 * - `message_location`: where a message physically lives on the IMAP
 *   server - (folder, uidvalidity, uid) unique; FLAGS live here, per IMAP
 *   mailbox semantics.
 * - `message_body`: encrypted raw RFC-822 source as a file in the
 *   mail-data volume (storage_ref) + decrypted-for-display text.
 * - Threading (thread_id, subject_hash) is added in a later step.
 */
export const migration0004 = {
  name: '0004_messages',
  sql: /* sql */ `
    CREATE TABLE message (
      id                 uuid PRIMARY KEY,
      account_id         uuid NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
      message_id_header  text NOT NULL,
      in_reply_to        text,
      "references"       text[] NOT NULL DEFAULT '{}',
      subject_enc        bytea NOT NULL,
      from_enc           bytea NOT NULL,
      recipients_enc     bytea NOT NULL,
      snippet_enc        bytea NOT NULL,
      sent_at            timestamptz,
      received_at        timestamptz,
      size_bytes         integer NOT NULL DEFAULT 0,
      has_attachments    boolean NOT NULL DEFAULT false,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX message_account_message_id_idx ON message (account_id, message_id_header);
    CREATE INDEX message_account_created_idx ON message (account_id, created_at DESC);

    CREATE TABLE message_location (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id   uuid NOT NULL REFERENCES message (id) ON DELETE CASCADE,
      folder_id    uuid NOT NULL REFERENCES folder (id) ON DELETE CASCADE,
      uidvalidity  bigint NOT NULL,
      uid          bigint NOT NULL,
      flags        text[] NOT NULL DEFAULT '{}',
      modseq       bigint
    );
    CREATE UNIQUE INDEX message_location_unique_idx
      ON message_location (folder_id, uidvalidity, uid);
    CREATE INDEX message_location_folder_idx ON message_location (folder_id);

    CREATE TABLE message_body (
      message_id          uuid PRIMARY KEY REFERENCES message (id) ON DELETE CASCADE,
      storage_ref         text NOT NULL,
      html_sanitized_enc  bytea,
      text_plain_enc      bytea,
      fetched_at          timestamptz NOT NULL DEFAULT now()
    );
  `,
} satisfies Migration
