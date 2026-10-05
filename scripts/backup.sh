#!/bin/sh
# Encrypted backup of the docker compose deployment (roadmap 6.2,
# docs/operations/backup-restore.md). Run from the project directory, e.g.
# via cron. Writes backups/fma-backup-<timestamp>.fmabk and deletes backups
# older than BACKUP_KEEP_DAYS (default 14).
#
# The worker is stopped during the backup so database and mail-data match;
# it is started again in any case. The MASTER_KEY is never part of the
# backup - keep a copy of .env somewhere else!
set -eu

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

docker compose stop worker
trap 'docker compose start worker' EXIT

# --user root: in rootless Docker container root is the host user, so the
# backup file belongs to the operator and mail-data is readable.
docker compose run --rm --user root -v "$BACKUP_DIR:/backups" worker \
  node dist/backup.js create /backups

# Never delete the pre-upgrade backup recorded for a rollback (upgrade.sh).
RECORDED="$(sed -n 's/^PREVIOUS_BACKUP=//p' "$BACKUP_DIR/upgrade-previous" 2>/dev/null || true)"
find "$BACKUP_DIR" -maxdepth 1 -name 'fma-backup-*.fmabk' ! -name "$(basename "${RECORDED:-none}")" \
  -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'fma-backup-*.fmabk.partial' -delete
