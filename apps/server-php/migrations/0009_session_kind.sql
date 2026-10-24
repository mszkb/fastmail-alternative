-- Device-bound bearer tokens for native clients (#138, ADR-0004, ADR-0015):
-- a session is either a browser session ('cookie', token in fma_session,
-- rotated every 24 h) or a native app token ('bearer', sent as
-- Authorization: Bearer, never rotated, expires after 90 days without use).
-- A token is only accepted the way it was issued. Like every session token,
-- only its SHA-256 is stored.
--
-- MySQL 8 has no ADD COLUMN IF NOT EXISTS: the ALTER only runs while the
-- column is missing, so a re-run after a failure is safe.

SET @fma_session_kind = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE session
       ADD COLUMN kind VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT ''cookie''',
    'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session' AND COLUMN_NAME = 'kind'
);
PREPARE fma_stmt FROM @fma_session_kind;
EXECUTE fma_stmt;
DEALLOCATE PREPARE fma_stmt;
