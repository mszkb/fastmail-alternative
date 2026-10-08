-- Request state shared by all PHP requests (ADR-0013): rate limits,
-- login lockout and metrics counters. Times are unix seconds.

CREATE TABLE IF NOT EXISTS rate_limit (
  bucket       VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip           VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  window_start BIGINT NOT NULL,
  hits         INT UNSIGNED NOT NULL,
  PRIMARY KEY (bucket, ip, window_start),
  KEY rate_limit_window_idx (window_start)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS login_lockout (
  ip           VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  fails        INT UNSIGNED NOT NULL,
  window_start BIGINT NOT NULL,
  locked_until BIGINT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS metric_counter (
  name  VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  value DOUBLE NOT NULL
) ENGINE=InnoDB;
