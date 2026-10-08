#!/bin/sh
# One-time move of a docker compose installation from the former Node
# backend (api, worker, PostgreSQL) to the PHP backend with MariaDB
# (ADR-0013, #110, docs/operations/migration.md). Run it once after
# checking out a version without the Node backend, from anywhere inside
# the checkout:
#
#   ./scripts/migrate-to-php.sh           # move the data
#   ./scripts/migrate-to-php.sh --reset   # empty MariaDB first (after a failed run)
#
# Steps: stop the old containers -> build the new images -> start MariaDB
# and the old PostgreSQL (volume postgres-data, only read) -> apply the
# MySQL migrations and import every table (bin/import-postgres.php; it
# decrypts all credentials and subjects as a check of the MASTER_KEY) ->
# hand the mail-data volume to the php user -> start the new stack.
#
# The old PostgreSQL volume is never changed: until it is deleted by hand,
# going back to the previous version (git checkout of the old commit,
# `docker compose up -d`) still works.
set -eu

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
MARKER="$BACKUP_DIR/migrated-to-php"
RESET=0
[ "${1:-}" = "--reset" ] && RESET=1

say() { echo "migrate-to-php: $*"; }
fail() {
  echo "migrate-to-php: $*" >&2
  exit 1
}

[ -f .env ] || fail "no .env in $PWD - run this in the checkout of the existing installation"
env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }
[ -n "$(env_value MASTER_KEY)" ] || fail "MASTER_KEY missing in .env (the one of the old installation is needed)"
[ -n "$(env_value POSTGRES_PASSWORD)" ] || fail "POSTGRES_PASSWORD missing in .env (needed to read the old database)"
[ -f "$MARKER" ] && fail "already moved ($MARKER exists) - nothing to do"

# MariaDB password: kept if present, otherwise generated once.
if [ -z "$(env_value MARIADB_PASSWORD)" ]; then
  printf '\n# Added by scripts/migrate-to-php.sh\nMARIADB_PASSWORD=%s\n' \
    "$(openssl rand 24 | base64 | tr '+/' '-_' | tr -d '=\n')" >>.env
  say "MARIADB_PASSWORD added to .env"
fi

PROJECT="$(docker compose config | sed -n 's/^name: *//p' | tr -d "\"'")"
[ -n "$PROJECT" ] || fail "cannot determine the compose project name"
docker volume inspect "${PROJECT}_postgres-data" >/dev/null 2>&1 ||
  fail "volume ${PROJECT}_postgres-data not found - nothing to move (fresh install: docker compose up -d)"

say "1/6 stop the old containers (volumes stay)"
docker compose --profile migration down --remove-orphans

if [ "$RESET" = 1 ]; then
  say "--reset: removing the MariaDB volume ${PROJECT}_mariadb-data"
  docker volume rm "${PROJECT}_mariadb-data" >/dev/null 2>&1 || true
fi

say "2/6 build the images"
docker compose --profile migration build php web pg-import

say "3/6 start MariaDB and the old PostgreSQL"
docker compose --profile migration up -d --wait mariadb postgres-legacy

say "4/6 import (migrations, all tables, decryption check)"
if ! docker compose --profile migration run --rm --no-deps pg-import; then
  docker compose --profile migration stop postgres-legacy >/dev/null
  fail "import failed - nothing is lost, the old data is untouched. Fix the cause (log above), then: $0 --reset"
fi
docker compose --profile migration rm -sf postgres-legacy >/dev/null

say "5/6 hand mail-data to the php user"
# Files were written by the Node user (uid 1000); php-fpm and the worker
# run as www-data. Root inside the container (rootless Docker: the host user).
docker compose run --rm --no-deps --user root php chown -R www-data:www-data /data/mail

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
date -u +%Y-%m-%dT%H:%M:%SZ >"$MARKER"

say "6/6 start and wait for health checks"
docker compose up -d --wait --remove-orphans ||
  fail "services did not become healthy - check 'docker compose logs php worker'"

say "done. Check login, accounts and mails, then create a first backup: ./scripts/backup.sh"
say "after that the old database can go: docker volume rm ${PROJECT}_postgres-data"
say "(and POSTGRES_* in .env are no longer needed)"
