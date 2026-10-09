-- Device-bound tokens for native clients (#138, ADR-0004): a session is
-- either a browser session ('web', cookie, rotated every 24 h) or a
-- native app token ('native', Authorization: Bearer, not rotated). Both
-- store only the SHA-256 of the token. Safe to re-run.

SET @fma_session_client = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE session ADD COLUMN client VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'web'",
    'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session' AND COLUMN_NAME = 'client'
);
PREPARE fma_stmt FROM @fma_session_client;
EXECUTE fma_stmt;
DEALLOCATE PREPARE fma_stmt;
