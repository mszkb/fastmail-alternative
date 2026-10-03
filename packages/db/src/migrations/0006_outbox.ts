import type { Migration } from '../migrate'

/**
 * Outbox for sending mail via SMTP (data model, roadmap 2.7).
 *
 * - `content_enc`: the composed message (from, to/cc/bcc, subject, plain
 *   text) as JSON, encrypted with the account DEK (AAD
 *   `outbox_message.content:<id>`). The worker builds the RFC 5322 message
 *   from it on every attempt; it is cleared once the message is sent and
 *   its copy in "Sent" is settled (stored, skipped or given up).
 * - `message_id_header`, `in_reply_to`, `references`: plaintext like in
 *   `message` (data model: technical threading headers, no readable
 *   content). The Message-ID is generated once by the api, so retries and
 *   the Sent copy carry the same id.
 * - `status`: queued | sending | sent | failed. `sent_at` is set as soon as
 *   the SMTP server accepted the message - never resent after that.
 * - `sent_copy`: pending | done | skipped | failed (APPEND to "Sent").
 * - `last_error_code`: stable machine code only (no server text, no content).
 */
export const migration0006 = {
  name: '0006_outbox',
  sql: /* sql */ `
    CREATE TABLE outbox_message (
      id                 uuid PRIMARY KEY,
      account_id         uuid NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
      identity_id        uuid REFERENCES identity (id) ON DELETE SET NULL,
      status             text NOT NULL DEFAULT 'queued',
      content_enc        bytea,
      message_id_header  text NOT NULL,
      in_reply_to        text,
      "references"       text[] NOT NULL DEFAULT '{}',
      attempts           integer NOT NULL DEFAULT 0,
      last_error_code    text,
      sent_copy          text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      sent_at            timestamptz
    );
    CREATE INDEX outbox_message_account_status_idx
      ON outbox_message (account_id, status, created_at DESC);
  `,
} satisfies Migration
