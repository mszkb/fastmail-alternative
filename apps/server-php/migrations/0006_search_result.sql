-- Global search across accounts (#121, ADR-0006 addendum): the UID lists of
-- one provider search, kept for a few minutes so that later pages of the
-- result need no new IMAP SEARCH. Only ids and UIDs - never the search
-- terms, never message content. Runtime state: not in backups; expired rows
-- are removed by the next search and by the cleanup job.

CREATE TABLE IF NOT EXISTS search_result (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at  BIGINT NOT NULL,
  streams     MEDIUMTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  KEY search_result_expires_idx (expires_at),
  CONSTRAINT search_result_user_fk FOREIGN KEY (user_id) REFERENCES `user` (id) ON DELETE CASCADE
) ENGINE=InnoDB;
