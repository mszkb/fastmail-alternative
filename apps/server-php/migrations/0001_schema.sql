-- Schema for MySQL 8 / MariaDB 10.6+ (ADR-0013, #98): the state of the
-- PostgreSQL migrations 0001-0021 in packages/db/src/migrations, ported in
-- one step (no MySQL installation predates this). Existing installations
-- move their data over with the PostgreSQL -> MySQL migration (#108).
--
-- Mapping (details: docs/architecture/data-model.md, "MySQL/MariaDB"):
-- - uuid            -> CHAR(36) ascii_bin, lowercase with hyphens (part of the encryption AAD)
-- - timestamptz     -> DATETIME(6), always UTC (the connection pins time_zone = '+00:00')
-- - bytea           -> BLOB types; short binary keys (hashes) -> BINARY/VARBINARY
-- - text[]          -> join tables where queried (flags, message references), JSON otherwise
-- - jsonb           -> JSON;  bigserial -> BIGINT AUTO_INCREMENT;  sequence -> sequence_counter
-- - citext / lower() unique -> generated *_lower column with a unique index
-- - partial indexes -> plain indexes (MySQL allows several NULLs in a unique index)
-- Header values compared byte-wise (Message-ID, In-Reply-To, references) are VARBINARY,
-- like PostgreSQL text equality.
--
-- Every statement is idempotent (IF NOT EXISTS): MySQL commits DDL implicitly,
-- so a failed run can be repeated.

CREATE TABLE IF NOT EXISTS `user` (
  id                    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  email                 VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  -- citext: case-insensitive uniqueness, lookups use email_lower = LOWER(?)
  email_lower           VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin AS (LOWER(email)) STORED,
  password_hash         TEXT NOT NULL,
  totp_secret_enc       BLOB NULL,
  unified_inbox_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  wrapped_dek           BLOB NULL,
  key_id                VARCHAR(255) NULL,
  created_at            DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY user_email_key (email_lower)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device (
  id              CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name            TEXT NOT NULL,
  platform        VARCHAR(64) NOT NULL,
  installation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  last_seen_at    DATETIME(6) NULL,
  revoked_at      DATETIME(6) NULL,
  UNIQUE KEY device_installation_id_key (installation_id),
  CONSTRAINT device_user_fk FOREIGN KEY (user_id) REFERENCES `user` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session (
  id         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  device_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- SHA-256 of the session token
  token_hash VARBINARY(64) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  rotated_at DATETIME(6) NULL,
  UNIQUE KEY session_token_hash_key (token_hash),
  KEY session_expires_at_idx (expires_at),
  CONSTRAINT session_device_fk FOREIGN KEY (device_id) REFERENCES device (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS push_subscription (
  id              CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  device_id       CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transport       VARCHAR(16) NOT NULL,
  endpoint        TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- endpoints can exceed the index key length: unique via their SHA-256
  endpoint_hash   BINARY(32) AS (UNHEX(SHA2(endpoint, 256))) STORED,
  keys_enc        BLOB NOT NULL,
  failure_count   INT NOT NULL DEFAULT 0,
  disabled_at     DATETIME(6) NULL,
  created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_success_at DATETIME(6) NULL,
  UNIQUE KEY push_subscription_endpoint_key (endpoint_hash),
  KEY push_subscription_active_idx (device_id, disabled_at),
  CONSTRAINT push_subscription_device_fk FOREIGN KEY (device_id) REFERENCES device (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mail_account (
  id                  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sort_order          INT NOT NULL DEFAULT 0,
  display_name        TEXT NOT NULL,
  email_address       VARCHAR(320) NOT NULL,
  imap_host           VARCHAR(255) NOT NULL,
  imap_port           INT NOT NULL,
  smtp_host           VARCHAR(255) NOT NULL,
  smtp_port           INT NOT NULL,
  wrapped_dek         BLOB NOT NULL,
  key_id              VARCHAR(255) NOT NULL,
  credential_kind     VARCHAR(16) NOT NULL DEFAULT 'password',
  oauth_provider      VARCHAR(32) NULL,
  sync_since          DATETIME(6) NULL,
  credential_enc      BLOB NOT NULL,
  status              VARCHAR(16) NOT NULL DEFAULT 'ok',
  error_count         INT NOT NULL DEFAULT 0,
  next_retry_at       DATETIME(6) NULL,
  last_sync_at        DATETIME(6) NULL,
  -- text[] in PostgreSQL; only read and written as a whole
  capabilities        JSON NOT NULL DEFAULT ('[]'),
  created_at          DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_error_code     VARCHAR(64) NULL,
  default_identity_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  KEY mail_account_user_sort_idx (user_id, sort_order, created_at),
  KEY mail_account_status_retry_idx (status, next_retry_at),
  CONSTRAINT mail_account_user_fk FOREIGN KEY (user_id) REFERENCES `user` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity (
  id                  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  account_id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name                TEXT NOT NULL,
  email_address       VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  email_address_lower VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin AS (LOWER(email_address)) STORED,
  signature           TEXT NULL,
  KEY identity_account_idx (account_id),
  UNIQUE KEY identity_account_address_idx (account_id, email_address_lower),
  CONSTRAINT identity_account_fk FOREIGN KEY (account_id) REFERENCES mail_account (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS job (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type       VARCHAR(64) NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  payload    JSON NOT NULL DEFAULT ('{}'),
  state      VARCHAR(16) NOT NULL DEFAULT 'queued',
  attempts   INT NOT NULL DEFAULT 0,
  run_at     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  locked_at  DATETIME(6) NULL,
  last_error TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY job_state_run_at_idx (state, run_at),
  -- also replaces the partial index job_account_running_idx (WHERE state = 'running')
  KEY job_account_idx (account_id, state),
  CONSTRAINT job_account_fk FOREIGN KEY (account_id) REFERENCES mail_account (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS folder (
  id                   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  account_id           CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  path                 VARCHAR(700) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  delimiter            VARCHAR(8) NULL,
  special_use          VARCHAR(32) NULL,
  uidvalidity          BIGINT NULL,
  uidnext              BIGINT NULL,
  highestmodseq        BIGINT UNSIGNED NULL,
  unread_count         INT NOT NULL DEFAULT 0,
  last_synced_at       DATETIME(6) NULL,
  created_at           DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  special_use_detected VARCHAR(32) NULL,
  special_use_override VARCHAR(32) NULL,
  selectable           BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE KEY folder_account_path_key (account_id, path),
  CONSTRAINT folder_account_fk FOREIGN KEY (account_id) REFERENCES mail_account (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS thread (
  id              CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  account_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  last_message_at DATETIME(6) NULL,
  created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY thread_account_idx (account_id, last_message_at DESC),
  CONSTRAINT thread_account_fk FOREIGN KEY (account_id) REFERENCES mail_account (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message (
  id                CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  account_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  message_id_header VARBINARY(998) NOT NULL,
  in_reply_to       VARBINARY(998) NULL,
  -- ordered list for reading; overlap queries use message_reference
  `references`      JSON NOT NULL DEFAULT ('[]'),
  subject_enc       BLOB NOT NULL,
  from_enc          BLOB NOT NULL,
  recipients_enc    MEDIUMBLOB NOT NULL,
  snippet_enc       BLOB NOT NULL,
  sent_at           DATETIME(6) NULL,
  received_at       DATETIME(6) NULL,
  size_bytes        INT NOT NULL DEFAULT 0,
  has_attachments   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  metadata_version  INT NOT NULL DEFAULT 1,
  thread_id         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  -- HMAC-SHA256 of the normalized subject (threading fallback)
  subject_hash      VARBINARY(32) NULL,
  UNIQUE KEY message_account_message_id_idx (account_id, message_id_header),
  KEY message_account_created_idx (account_id, created_at DESC),
  KEY message_thread_idx (thread_id),
  -- replaces the partial index message_unthreaded_idx (WHERE thread_id IS NULL)
  KEY message_account_thread_idx (account_id, thread_id),
  KEY message_account_in_reply_to_idx (account_id, in_reply_to(255)),
  KEY message_account_subject_hash_idx (account_id, subject_hash),
  CONSTRAINT message_account_fk FOREIGN KEY (account_id) REFERENCES mail_account (id) ON DELETE CASCADE,
  CONSTRAINT message_thread_fk FOREIGN KEY (thread_id) REFERENCES thread (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Replaces message."references" && $refs (GIN index): one row per reference.
CREATE TABLE IF NOT EXISTS message_reference (
  message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  position   SMALLINT UNSIGNED NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ref        VARBINARY(998) NOT NULL,
  PRIMARY KEY (message_id, position),
  KEY message_reference_account_ref_idx (account_id, ref(255)),
  CONSTRAINT message_reference_message_fk FOREIGN KEY (message_id) REFERENCES message (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_location (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  message_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  folder_id   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  uidvalidity BIGINT NOT NULL,
  uid         BIGINT NOT NULL,
  modseq      BIGINT UNSIGNED NULL,
  UNIQUE KEY message_location_unique_idx (folder_id, uidvalidity, uid),
  KEY message_location_message_idx (message_id),
  CONSTRAINT message_location_message_fk FOREIGN KEY (message_id) REFERENCES message (id) ON DELETE CASCADE,
  CONSTRAINT message_location_folder_fk FOREIGN KEY (folder_id) REFERENCES folder (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Replaces message_location.flags text[] (array_append/array_remove/ANY):
-- one row per IMAP flag; "unread" = no row with flag '\Seen'.
CREATE TABLE IF NOT EXISTS message_flag (
  location_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  flag        VARBINARY(255) NOT NULL,
  PRIMARY KEY (location_id, flag),
  KEY message_flag_flag_idx (flag, location_id),
  CONSTRAINT message_flag_location_fk FOREIGN KEY (location_id) REFERENCES message_location (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_body (
  message_id         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  storage_ref        VARCHAR(255) NULL,
  html_sanitized_enc LONGBLOB NULL,
  text_plain_enc     LONGBLOB NULL,
  fetched_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  skip_reason        VARCHAR(64) NULL,
  CONSTRAINT message_body_message_fk FOREIGN KEY (message_id) REFERENCES message (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Replaces the sequence message_location_placeholder_seq (negative placeholder
-- UIDs after a local move): UPDATE ... SET value = LAST_INSERT_ID(value + 1).
CREATE TABLE IF NOT EXISTS sequence_counter (
  name  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  value BIGINT NOT NULL
) ENGINE=InnoDB;

INSERT IGNORE INTO sequence_counter (name, value) VALUES ('message_location_placeholder', 0);

CREATE TABLE IF NOT EXISTS outbox_message (
  id                CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  account_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_id       CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'queued',
  content_enc       LONGBLOB NULL,
  message_id_header VARBINARY(998) NOT NULL,
  in_reply_to       VARBINARY(998) NULL,
  `references`      JSON NOT NULL DEFAULT ('[]'),
  attempts          INT NOT NULL DEFAULT 0,
  last_error_code   VARCHAR(64) NULL,
  sent_copy         VARCHAR(32) NULL,
  created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  sent_at           DATETIME(6) NULL,
  client_id         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  attachment_count  INT NOT NULL DEFAULT 0,
  KEY outbox_message_account_status_idx (account_id, status, created_at DESC),
  -- several NULLs are allowed in a unique index: same as the partial index
  UNIQUE KEY outbox_message_client_id_idx (account_id, client_id),
  CONSTRAINT outbox_message_account_fk FOREIGN KEY (account_id) REFERENCES mail_account (id) ON DELETE CASCADE,
  CONSTRAINT outbox_message_identity_fk FOREIGN KEY (identity_id) REFERENCES identity (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS draft (
  id                 CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  account_id         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  content_enc        LONGBLOB NULL,
  in_reply_to        VARBINARY(998) NULL,
  `references`       JSON NOT NULL DEFAULT ('[]'),
  version            INT NOT NULL DEFAULT 1,
  imap_version       INT NOT NULL DEFAULT 0,
  message_id_header  VARBINARY(998) NULL,
  source_folder_id   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_uidvalidity BIGINT NULL,
  source_uid         BIGINT NULL,
  created_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at         DATETIME(6) NULL,
  keep_source        BOOLEAN NOT NULL DEFAULT FALSE,
  KEY draft_account_idx (account_id, deleted_at, updated_at DESC),
  KEY draft_message_id_idx (account_id, message_id_header(255)),
  CONSTRAINT draft_account_fk FOREIGN KEY (account_id) REFERENCES mail_account (id) ON DELETE CASCADE,
  CONSTRAINT draft_identity_fk FOREIGN KEY (identity_id) REFERENCES identity (id) ON DELETE SET NULL,
  CONSTRAINT draft_source_folder_fk FOREIGN KEY (source_folder_id) REFERENCES folder (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attachment_upload (
  id           CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  account_id   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outbox_id    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  filename_enc BLOB NOT NULL,
  content_type VARCHAR(255) NOT NULL,
  size_bytes   INT NOT NULL,
  content_enc  LONGBLOB NOT NULL,
  created_at   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  draft_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  KEY attachment_upload_account_idx (account_id, created_at),
  KEY attachment_upload_outbox_idx (outbox_id),
  KEY attachment_upload_draft_idx (draft_id),
  CONSTRAINT attachment_upload_account_fk FOREIGN KEY (account_id) REFERENCES mail_account (id) ON DELETE CASCADE,
  CONSTRAINT attachment_upload_outbox_fk FOREIGN KEY (outbox_id) REFERENCES outbox_message (id) ON DELETE CASCADE,
  CONSTRAINT attachment_upload_draft_fk FOREIGN KEY (draft_id) REFERENCES draft (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
