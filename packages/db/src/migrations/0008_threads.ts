import type { Migration } from '../migrate'

/**
 * Threads (data model, roadmap 2.5).
 *
 * - `thread`: one conversation per account; `last_message_at` is the date of
 *   its newest message.
 * - `message.thread_id`: assigned by the worker after the sync (see
 *   apps/worker/src/threading.ts); NULL until then. Threads merge when a
 *   message connects two of them (e.g. a parent arriving after its child).
 * - `message.subject_hash`: HMAC (key derived from the account DEK) of the
 *   normalized subject, only for the subject fallback - never plaintext.
 * - Indexes serve the candidate lookup: Message-ID (existing unique index),
 *   References (GIN), In-Reply-To and subject hash per account.
 */
export const migration0008 = {
  name: '0008_threads',
  sql: /* sql */ `
    CREATE TABLE thread (
      id               uuid PRIMARY KEY,
      account_id       uuid NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
      last_message_at  timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX thread_account_idx ON thread (account_id, last_message_at DESC);

    ALTER TABLE message
      ADD COLUMN thread_id uuid REFERENCES thread (id) ON DELETE SET NULL,
      ADD COLUMN subject_hash bytea;
    CREATE INDEX message_thread_idx ON message (thread_id);
    CREATE INDEX message_unthreaded_idx ON message (account_id) WHERE thread_id IS NULL;
    CREATE INDEX message_account_in_reply_to_idx ON message (account_id, in_reply_to)
      WHERE in_reply_to IS NOT NULL;
    CREATE INDEX message_account_subject_hash_idx ON message (account_id, subject_hash)
      WHERE subject_hash IS NOT NULL;
    CREATE INDEX message_references_idx ON message USING gin ("references");
  `,
} satisfies Migration
