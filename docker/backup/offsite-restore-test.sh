#!/usr/bin/env bash
# Monthly proof that the OFF-SITE copy restores (PRD "Compose requirements": test a restore
# monthly). Runs on the production HOST (cron line in offsite-backup.sh). Steps:
#   1. restic restore the latest snapshot into a scratch directory
#   2. start a throwaway MinIO (same image/credentials as production) on the restored data,
#      with no published ports, and count objects in S3_BUCKET; compare with the live bucket
#   3. run restore-test.sh against the newest restored pg_dump
# Never touches the live database or STORAGE_PATH. The scratch dir is deleted on exit.
#
# Reads /etc/tinyglow/offsite.env (see offsite-backup.sh) and the stack's .env for
# S3_ROOT_USER / S3_ROOT_PASSWORD (MinIO root: the restored data's IAM store belongs to it) /
# S3_BUCKET / MINIO_IMAGE / MC_IMAGE.
#   APP_DIR=/srv/tinyglow/app docker/backup/offsite-restore-test.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
OFFSITE_ENV="${OFFSITE_ENV:-/etc/tinyglow/offsite.env}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1}"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:0.8.7-pg17}"
SCRATCH_PARENT="${SCRATCH_PARENT:-/var/tmp}"

log() { printf '%s offsite-restore-test: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

set -a
# shellcheck disable=SC1090
. "$OFFSITE_ENV"
# shellcheck disable=SC1091
. "$APP_DIR/.env"
set +a
: "${RESTIC_REPOSITORY:?}" "${RESTIC_PASSWORD:?}" "${S3_ROOT_USER:?}" "${S3_ROOT_PASSWORD:?}" "${S3_BUCKET:?}"
MINIO_IMAGE="${MINIO_IMAGE:-pgsty/minio:RELEASE.2026-08-04T00-00-00Z}"
MC_IMAGE="${MC_IMAGE:-pgsty/mc:RELEASE.2026-09-16T00-00-00Z}"

SCRATCH="$(mktemp -d "$SCRATCH_PARENT/tinyglow-restore.XXXXXX")"
NET="tinyglow-restore-$$"
MINIO_C="tinyglow-restore-minio-$$"
cleanup() {
  docker rm -f "$MINIO_C" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

log "restoring latest snapshot into $SCRATCH"
docker run --rm \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
  -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY \
  -v tinyglow-restic-cache:/root/.cache/restic \
  -v "$SCRATCH:/restore" \
  "$RESTIC_IMAGE" restore latest --tag tinyglow --target /restore

[ -d "$SCRATCH/data/storage" ] || { log "FAIL snapshot has no /data/storage"; exit 1; }
[ -d "$SCRATCH/data/backups" ] || { log "FAIL snapshot has no /data/backups"; exit 1; }

# --- Storage: boot MinIO on the restored copy (internal network only) -------
docker network create --internal "$NET" >/dev/null
docker run -d --name "$MINIO_C" --network "$NET" --network-alias minio \
  -e MINIO_ROOT_USER="$S3_ROOT_USER" -e MINIO_ROOT_PASSWORD="$S3_ROOT_PASSWORD" \
  -v "$SCRATCH/data/storage:/data" "$MINIO_IMAGE" server /data >/dev/null
for _ in $(seq 1 60); do
  docker exec "$MINIO_C" curl -fsS -o /dev/null http://127.0.0.1:9000/minio/health/live 2>/dev/null && break
  sleep 2
done

count_objects() { # network, endpoint
  docker run --rm --network "$1" -e S3_ROOT_USER -e S3_ROOT_PASSWORD -e S3_BUCKET -e EP="$2" \
    --entrypoint /bin/sh "$MC_IMAGE" -c \
    'mc alias set x "$EP" "$S3_ROOT_USER" "$S3_ROOT_PASSWORD" >/dev/null && mc ls --recursive "x/$S3_BUCKET" | wc -l'
}
restored="$(count_objects "$NET" http://minio:9000)"
log "restored bucket $S3_BUCKET: $restored objects"

live_net="$(docker network ls --format '{{.Name}}' | grep -x 'tinyglow_default' || true)"
if [ -n "$live_net" ]; then
  live="$(count_objects "$live_net" http://storage:9000)"
  log "live bucket $S3_BUCKET: $live objects"
  # The snapshot is up to ~a day old; allow uploads since then but flag a large shortfall.
  if [ "$live" -gt 0 ] && [ $((restored * 100 / live)) -lt 90 ]; then
    log "FAIL restored copy has under 90% of live objects"
    exit 1
  fi
fi

# --- Database: run the regular restore test on the restored dumps --------
docker run --rm \
  -v "$SCRATCH/data/backups:/backups:ro" \
  -v "$APP_DIR/docker/backup:/scripts:ro" \
  --entrypoint bash "$PG_IMAGE" /scripts/restore-test.sh

log "PASS off-site copy restores (storage + database)"
