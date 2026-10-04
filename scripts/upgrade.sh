#!/bin/sh
# Upgrade the docker compose deployment to a new version (roadmap 6.5,
# docs/operations/upgrade.md). Run from anywhere inside the checkout:
#
#   ./scripts/upgrade.sh            # fast-forward the current branch
#   ./scripts/upgrade.sh v1.2.0     # switch to a tag/branch/commit
#
# Steps: resolve the target (must be a successor of the current commit; a
# downgrade is a rollback, see the docs) -> encrypted backup with the OLD
# version -> update the checkout -> build the new images (old containers
# keep running) -> start them and wait until all health checks pass. The
# api applies pending migrations on startup (forward-only). The previous
# commit and the path of the backup are written to backups/upgrade-previous
# for a rollback (kept on a re-run after a failed build).
set -eu

cd "$(dirname "$0")/.."
TARGET="${1:-}"
BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
RECORD="$BACKUP_DIR/upgrade-previous"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "upgrade: local changes in the checkout - commit or stash them first" >&2
  exit 1
fi

PREVIOUS="$(git rev-parse HEAD)"
echo "upgrade: current version $(git describe --tags --always)"

echo "upgrade: 1/5 resolve target"
git fetch --tags origin
BRANCH=""
if [ -z "$TARGET" ]; then
  TARGET_COMMIT="$(git rev-parse --verify --quiet '@{u}^{commit}')" || {
    echo "upgrade: no upstream branch (detached HEAD?) - pass a target, e.g. ./scripts/upgrade.sh v1.3.0" >&2
    exit 1
  }
elif git show-ref --verify --quiet "refs/remotes/origin/$TARGET"; then
  # A branch: use the remote state, not a possibly stale local branch.
  BRANCH="$TARGET"
  TARGET_COMMIT="$(git rev-parse "refs/remotes/origin/$TARGET^{commit}")"
else
  TARGET_COMMIT="$(git rev-parse --verify --quiet "$TARGET^{commit}")" || {
    echo "upgrade: unknown target '$TARGET'" >&2
    exit 1
  }
fi
if ! git merge-base --is-ancestor "$PREVIOUS" "$TARGET_COMMIT"; then
  echo "upgrade: target $TARGET_COMMIT is not a successor of the current commit $PREVIOUS" >&2
  echo "upgrade: a downgrade needs the backup of the old version - see 'Rollback' in docs/operations/upgrade.md" >&2
  exit 1
fi

echo "upgrade: 2/5 backup"
./scripts/backup.sh
BACKUP_FILE="$(ls -1t "$BACKUP_DIR"/fma-backup-*.fmabk 2>/dev/null | head -n 1)"
if [ -z "$BACKUP_FILE" ]; then
  echo "upgrade: backup file not found in $BACKUP_DIR" >&2
  exit 1
fi

# Re-run after a failed build/start (HEAD already is the target): keep the
# record of the run that left the old version - its backup is the one
# taken before any migration of the new version ran.
RECORDED_TARGET="$(sed -n 's/^UPGRADE_TARGET=//p' "$RECORD" 2>/dev/null || true)"
if [ "$PREVIOUS" = "$TARGET_COMMIT" ] && [ "$RECORDED_TARGET" = "$TARGET_COMMIT" ]; then
  echo "upgrade: already on the target - keeping $RECORD"
else
  mkdir -p "$BACKUP_DIR"
  printf 'PREVIOUS_REF=%s\nPREVIOUS_BACKUP=%s\nUPGRADE_TARGET=%s\n' \
    "$PREVIOUS" "$BACKUP_FILE" "$TARGET_COMMIT" > "$RECORD"
fi
ROLLBACK_REF="$(sed -n 's/^PREVIOUS_REF=//p' "$RECORD")"
ROLLBACK_BACKUP="$(sed -n 's/^PREVIOUS_BACKUP=//p' "$RECORD")"

on_exit() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "upgrade: FAILED - rollback: see 'Rollback' in docs/operations/upgrade.md" >&2
    echo "upgrade:   previous commit: $ROLLBACK_REF" >&2
    echo "upgrade:   backup before the upgrade: $ROLLBACK_BACKUP" >&2
    echo "upgrade:   (both recorded in $RECORD)" >&2
  fi
}
trap on_exit EXIT

echo "upgrade: 3/5 update checkout"
if [ -n "$BRANCH" ]; then
  git checkout --quiet "$BRANCH"
  git merge --ff-only --quiet "$TARGET_COMMIT"
elif [ -n "$TARGET" ]; then
  git checkout --quiet "$TARGET_COMMIT"
else
  git merge --ff-only --quiet "$TARGET_COMMIT"
fi
if [ "$(git rev-parse HEAD)" != "$TARGET_COMMIT" ]; then
  echo "upgrade: checkout is not at the target $TARGET_COMMIT" >&2
  exit 1
fi
echo "upgrade: new version $(git describe --tags --always)"

echo "upgrade: 4/5 build images"
docker compose build

echo "upgrade: 5/5 start (migrations run in the api) and wait for health checks"
if ! docker compose up -d --wait; then
  echo "upgrade: services did not become healthy - check 'docker compose logs api worker'" >&2
  exit 1
fi

docker image prune -f >/dev/null
echo "upgrade: done"
