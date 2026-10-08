-- Final schema of the former Node backend (packages/db migrations 0001-21),
-- frozen when the Node backend was removed (#110). Only used by
-- tests/Integration/PostgresImportTest.php to build a PostgreSQL database
-- like the one an existing installation has. Do not edit.

-- 0001_users_devices_sessions
CREATE EXTENSION IF NOT EXISTS citext;

    CREATE TABLE "user" (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email                  citext NOT NULL UNIQUE,
      password_hash          text NOT NULL,
      totp_secret_enc        bytea,
      unified_inbox_enabled  boolean NOT NULL DEFAULT false,
      created_at             timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE device (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id          uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      name             text NOT NULL,
      platform         text NOT NULL,
      installation_id  uuid NOT NULL UNIQUE,
      last_seen_at     timestamptz,
      revoked_at       timestamptz
    );

    CREATE TABLE session (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id   uuid NOT NULL REFERENCES device (id) ON DELETE CASCADE,
      token_hash  bytea NOT NULL UNIQUE,
      expires_at  timestamptz NOT NULL,
      rotated_at  timestamptz
    );
    CREATE INDEX session_expires_at_idx ON session (expires_at);

    CREATE TABLE push_subscription (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id       uuid NOT NULL REFERENCES device (id) ON DELETE CASCADE,
      transport       text NOT NULL,
      endpoint        text NOT NULL,
      keys_enc        bytea NOT NULL,
      failure_count   integer NOT NULL DEFAULT 0,
      disabled_at     timestamptz
    );
    CREATE INDEX push_subscription_active_idx
      ON push_subscription (device_id) WHERE disabled_at IS NULL;

-- 0002_mail_accounts
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

-- 0003_jobs_folders
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

-- 0004_messages
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

-- 0005_message_actions
CREATE SEQUENCE message_location_placeholder_seq;

-- 0006_outbox
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

-- 0007_message_metadata_version
ALTER TABLE message ADD COLUMN metadata_version integer NOT NULL DEFAULT 1;

-- 0008_threads
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

-- 0009_account_health
ALTER TABLE mail_account ADD COLUMN last_error_code text;
    CREATE INDEX job_account_running_idx ON job (account_id) WHERE state = 'running';

-- 0010_push
ALTER TABLE "user" ADD COLUMN wrapped_dek bytea, ADD COLUMN key_id text;

    ALTER TABLE push_subscription
      ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN last_success_at timestamptz;
    CREATE UNIQUE INDEX push_subscription_endpoint_key ON push_subscription (endpoint);

-- 0011_folder_roles
ALTER TABLE folder ADD COLUMN special_use_detected text;
    ALTER TABLE folder ADD COLUMN special_use_override text;
    UPDATE folder SET special_use_detected = special_use;

-- 0012_default_identity
ALTER TABLE mail_account ADD COLUMN default_identity_id uuid;
    DELETE FROM identity a USING identity b
      WHERE a.account_id = b.account_id
        AND lower(a.email_address) = lower(b.email_address)
        AND a.id > b.id;
    CREATE UNIQUE INDEX identity_account_address_idx ON identity (account_id, lower(email_address));

-- 0013_message_body_skip
ALTER TABLE message_body ALTER COLUMN storage_ref DROP NOT NULL;
    ALTER TABLE message_body ADD COLUMN skip_reason text;

-- 0014_folder_selectable
ALTER TABLE folder ADD COLUMN selectable boolean NOT NULL DEFAULT true;

-- 0015_outbox_client_id
ALTER TABLE outbox_message ADD COLUMN client_id uuid;
    CREATE UNIQUE INDEX outbox_message_client_id_idx
      ON outbox_message (account_id, client_id) WHERE client_id IS NOT NULL;

-- 0016_drafts
CREATE TABLE draft (
      id                  uuid PRIMARY KEY,
      account_id          uuid NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
      identity_id         uuid REFERENCES identity (id) ON DELETE SET NULL,
      content_enc         bytea,
      in_reply_to         text,
      "references"        text[] NOT NULL DEFAULT '{}',
      version             integer NOT NULL DEFAULT 1,
      imap_version        integer NOT NULL DEFAULT 0,
      message_id_header   text,
      source_folder_id    uuid REFERENCES folder (id) ON DELETE SET NULL,
      source_uidvalidity  bigint,
      source_uid          bigint,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      deleted_at          timestamptz
    );
    CREATE INDEX draft_account_idx ON draft (account_id, updated_at DESC)
      WHERE deleted_at IS NULL;
    CREATE INDEX draft_message_id_idx ON draft (account_id, message_id_header)
      WHERE deleted_at IS NULL;

-- 0017_attachment_uploads
CREATE TABLE attachment_upload (
      id            uuid PRIMARY KEY,
      account_id    uuid NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
      outbox_id     uuid REFERENCES outbox_message (id) ON DELETE CASCADE,
      filename_enc  bytea NOT NULL,
      content_type  text NOT NULL,
      size_bytes    integer NOT NULL,
      content_enc   bytea NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX attachment_upload_account_idx ON attachment_upload (account_id, created_at);
    CREATE INDEX attachment_upload_outbox_idx ON attachment_upload (outbox_id)
      WHERE outbox_id IS NOT NULL;

-- 0018_cleanup_indexes
CREATE INDEX IF NOT EXISTS message_location_message_idx ON message_location (message_id);

-- 0019_outbox_attachment_count
ALTER TABLE outbox_message
      ADD COLUMN IF NOT EXISTS attachment_count integer NOT NULL DEFAULT 0;

-- 0020_draft_attachments
ALTER TABLE attachment_upload
      ADD COLUMN IF NOT EXISTS draft_id uuid REFERENCES draft (id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS attachment_upload_draft_idx ON attachment_upload (draft_id)
      WHERE draft_id IS NOT NULL;

-- 0021_draft_keep_source
ALTER TABLE draft ADD COLUMN IF NOT EXISTS keep_source boolean NOT NULL DEFAULT false;
