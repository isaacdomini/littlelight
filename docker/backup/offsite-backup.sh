#!/usr/bin/env bash
# Nightly encrypted off-site copy of STORAGE_PATH (MinIO data = the photo library) and
# BACKUP_PATH (pg_dump archives) with restic (PRD "Compose requirements": off-site copy).
# Runs on the production HOST from cron; needs only Docker (restic runs from a pinned image).
#
# Setup (once, as root):
#   install -m 600 /dev/null /etc/tinyglow/offsite.env   # then fill it in:
#     RESTIC_REPOSITORY=s3:https://s3.<region>.backblazeb2.com/<bucket>/tinyglow
#     RESTIC_PASSWORD=<openssl rand -hex 32; store a copy OUTSIDE this server or the backup is useless>
#     AWS_ACCESS_KEY_ID=<B2 application key id, scoped to the bucket>
#     AWS_SECRET_ACCESS_KEY=<B2 application key>
#     STORAGE_PATH=/srv/tinyglow/storage                # same values as the stack's .env
#     BACKUP_PATH=/srv/tinyglow/backups
#   docker/backup/offsite-backup.sh --init                  # creates the restic repository
# Cron (after the 03:00 pg_dump; offsite.env path can be overridden with OFFSITE_ENV):
#   30 4 * * * root /srv/tinyglow/app/docker/backup/offsite-backup.sh >>/var/log/tinyglow-offsite.log 2>&1
#   0 5 1 * *  root /srv/tinyglow/app/docker/backup/offsite-restore-test.sh >>/var/log/tinyglow-offsite.log 2>&1
#
# Retention: 14 daily, 8 weekly, 12 monthly snapshots. Weekly `restic check` reads 5% of data.
# Note: MinIO stores objects in its own on-disk format (xl.meta + parts), so the copy is restored
# by pointing a MinIO server at it; offsite-restore-test.sh does exactly that.
set -euo pipefail

OFFSITE_ENV="${OFFSITE_ENV:-/etc/tinyglow/offsite.env}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1}"

log() { printf '%s offsite-backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

[ -r "$OFFSITE_ENV" ] || { log "missing $OFFSITE_ENV (see header)"; exit 1; }
set -a
# shellcheck disable=SC1090
. "$OFFSITE_ENV"
set +a
: "${RESTIC_REPOSITORY:?}" "${RESTIC_PASSWORD:?}" "${STORAGE_PATH:?}" "${BACKUP_PATH:?}"
[ -d "$STORAGE_PATH" ] || { log "STORAGE_PATH $STORAGE_PATH is not a directory"; exit 1; }
[ -d "$BACKUP_PATH" ] || { log "BACKUP_PATH $BACKUP_PATH is not a directory"; exit 1; }

# Secrets are passed by name (-e VAR) so they never appear in `ps` output.
restic() {
  docker run --rm -i \
    --hostname tinyglow \
    -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY \
    -v tinyglow-restic-cache:/root/.cache/restic \
    -v "$STORAGE_PATH:/data/storage:ro" \
    -v "$BACKUP_PATH:/data/backups:ro" \
    "$RESTIC_IMAGE" "$@"
}

if [ "${1:-}" = "--init" ]; then
  restic init
  log "repository initialised"
  exit 0
fi

log "backup start"
restic backup --tag tinyglow --one-file-system /data/storage /data/backups
restic forget --tag tinyglow --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
if [ "$(date +%u)" = 7 ]; then
  restic check --read-data-subset 5%
fi
log "backup ok"
