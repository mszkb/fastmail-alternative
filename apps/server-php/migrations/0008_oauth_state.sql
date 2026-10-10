-- Pending OAuth sign-ins (#36, ADR-0011): one row from "start" until the
-- provider redirects back to /api/oauth/callback, at most 10 minutes. Only
-- the SHA-256 of the random state is stored; the PKCE verifier is derived
-- from the state (OAuthFlow), tokens never land here. The callback arrives
-- without the session cookie (SameSite=Strict on a cross-site redirect), so
-- the row also says whose sign-in it is. Not part of backups (runtime state).

CREATE TABLE IF NOT EXISTS oauth_state (
  state_hash  BINARY(32) NOT NULL PRIMARY KEY,
  user_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider    VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY oauth_state_created_idx (created_at),
  CONSTRAINT oauth_state_user_fk FOREIGN KEY (user_id) REFERENCES `user` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
