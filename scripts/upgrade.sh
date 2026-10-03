#!/bin/sh
# Upgrade the docker compose deployment to a new version (roadmap 6.5,
# docs/operations/upgrade.md). Run from anywhere inside the checkout:
#
#   ./scripts/upgrade.sh            # fast-forward the current branch
#   ./scripts/upgrade.sh v1.2.0     # switch to a tag/branch/commit
#
# Steps: encrypted backup with the OLD version -> update the checkout ->
# build the new images (old containers keep running) -> start them and wait
# until all health checks pass. The api applies pending migrations on
# startup (forward-only). The previous commit is written to
# backups/upgrade-previous-ref for a rollback (see the docs).
set -eu

cd "$(dirname "$0")/.."
TARGET="${1:-}"
BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "upgrade: local changes in the checkout - commit or stash them first" >&2
  exit 1
fi

PREVIOUS="$(git rev-parse HEAD)"
echo "upgrade: current version $(git describe --tags --always)"

echo "upgrade: 1/4 backup"
./scripts/backup.sh
mkdir -p "$BACKUP_DIR"
echo "$PREVIOUS" > "$BACKUP_DIR/upgrade-previous-ref"

echo "upgrade: 2/4 update checkout"
git fetch --tags origin
if [ -n "$TARGET" ]; then
  git checkout --quiet "$TARGET"
else
  git pull --ff-only --quiet
fi
echo "upgrade: new version $(git describe --tags --always)"

echo "upgrade: 3/4 build images"
docker compose build

echo "upgrade: 4/4 start (migrations run in the api) and wait for health checks"
if ! docker compose up -d --wait; then
  echo "upgrade: services did not become healthy - check 'docker compose logs api worker'" >&2
  echo "upgrade: rollback: see docs/operations/upgrade.md (previous ref: $PREVIOUS)" >&2
  exit 1
fi

docker image prune -f >/dev/null
echo "upgrade: done"
