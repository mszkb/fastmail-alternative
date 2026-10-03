import type { Migration } from '../migrate'

/**
 * Job queue (ADR-0003: simple table, SKIP LOCKED) and IMAP folders
 * (data model, roadmap 2.2 step 1).
 *
 * - job.payload contains ONLY ids, never content; last_error is redacted
 *   before storing (DoD: no sensitive data in logs/errors).
 * - folder: one row per IMAP mailbox; sync state (uidvalidity, uidnext,
 *   highestmodseq) lives per folder. A uidvalidity change discards
 *   message_location rows (handled in the message sync step).
 */
export const migration0003 = {
  name: '0003_jobs_folders',
  sql: /* sql */ `
    CREATE TABLE job (
      id          bigserial PRIMARY KEY,
      type        text NOT NULL,
      account_id  uuid REFERENCES mail_account (id) ON DELETE CASCADE,
      payload     jsonb NOT NULL DEFAULT '{}',
      state       text NOT NULL DEFAULT 'queued',
      attempts    integer NOT NULL DEFAULT 0,
      run_at      timestamptz NOT NULL DEFAULT now(),
      locked_at   timestamptz,
      last_error  text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX job_state_run_at_idx ON job (state, run_at);
    CREATE INDEX job_account_idx ON job (account_id);

    CREATE TABLE folder (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id      uuid NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
      path            text NOT NULL,
      delimiter       text,
      special_use     text,
      uidvalidity     bigint,
      uidnext         bigint,
      highestmodseq   bigint,
      unread_count    integer NOT NULL DEFAULT 0,
      last_synced_at  timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, path)
    );
    CREATE INDEX folder_account_idx ON folder (account_id);
  `,
} satisfies Migration
