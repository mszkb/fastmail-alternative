#!/bin/sh
# Encrypted backup of the docker compose deployment (roadmap 6.2,
# docs/operations/backup-restore.md). Run from the project directory, e.g.
# via cron. Writes backups/fma-backup-<timestamp>.fmabk and deletes backups
# older than BACKUP_KEEP_DAYS (default 14).
#
# bin/console holds the runner lock while it reads (jobs pause, running ones
# are awaited), so database and mail-data match; the worker is stopped as
# well and started again in any case. The MASTER_KEY is never part of the
# backup - keep a copy of .env (or of `docker compose exec php php
# bin/secrets.php export` when it was generated, #164) somewhere else!
set -eu

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
# BACKUP_KEEP_DAYS: from the environment, else from .env, else 14.
KEEP_DAYS="${BACKUP_KEEP_DAYS:-$(sed -n 's/^BACKUP_KEEP_DAYS=//p' .env 2>/dev/null | tail -n 1)}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

docker compose stop worker
trap 'docker compose start worker' EXIT

# --user root: in rootless Docker container root is the host user, so the
# backup file belongs to the operator and mail-data is readable.
# BACKUP_KEEP_DAYS=0: retention is done below, so the pre-upgrade backup
# recorded for a rollback is never deleted.
docker compose run --rm --no-deps --user root -e BACKUP_KEEP_DAYS=0 -v "$BACKUP_DIR:/backups" php \
  php bin/console backup create --out=/backups

# Never delete the pre-upgrade backup recorded for a rollback (upgrade.sh).
RECORDED="$(sed -n 's/^PREVIOUS_BACKUP=//p' "$BACKUP_DIR/upgrade-previous" 2>/dev/null || true)"
find "$BACKUP_DIR" -maxdepth 1 -name 'fma-backup-*.fmabk' ! -name "$(basename "${RECORDED:-none}")" \
  -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'fma-backup-*.fmabk.partial' -delete
