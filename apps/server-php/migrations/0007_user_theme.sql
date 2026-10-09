-- Installable themes (#126): theme files a user uploaded, validated by the
-- server (ThemeValidator). Declarative JSON only (colors, rem sizes, layout
-- choices); which theme is active is chosen per device in the client.

CREATE TABLE IF NOT EXISTS user_theme (
  user_id       CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  theme_id      VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name          VARCHAR(255) NOT NULL,
  version       VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content       TEXT NOT NULL,
  installed_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, theme_id),
  CONSTRAINT user_theme_user_fk FOREIGN KEY (user_id) REFERENCES `user` (id) ON DELETE CASCADE
) ENGINE=InnoDB;
