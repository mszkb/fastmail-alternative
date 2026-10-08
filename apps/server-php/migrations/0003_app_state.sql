-- Small key/value state of the PHP backend, e.g. the hash of a generated
-- first-run setup code.

CREATE TABLE IF NOT EXISTS app_state (
  name  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
) ENGINE=InnoDB;
