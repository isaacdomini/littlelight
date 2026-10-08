#!/usr/bin/env bash
# Nightly logical backup of the Littlelight database (production `backup` service).
#
# Runs inside the pgvector/pgvector image (same Postgres major as `db`). Every night at
# BACKUP_HOUR (container TZ) it writes, into /backups (= BACKUP_PATH on the host):
#   littlelight-<UTC stamp>.dump        pg_dump custom format (compressed, pg_restore-able)
#   littlelight-<UTC stamp>.roles.sql   pg_dumpall --roles-only (supabase_auth_admin, anon, ...)
#   littlelight-<UTC stamp>.sha256      checksums of both
# Files are written as *.partial and renamed only after `pg_restore --list` reads the archive.
# Anything older than BACKUP_RETENTION_DAYS (default 35) is deleted.
# A dump runs at start-up when none is younger than 20 hours.
#
# Restore test: docker/backup/restore-test.sh (run monthly, see that file).
# Off-site copy of BACKUP_PATH and STORAGE_PATH: docker/backup/offsite-backup.sh (host cron).
#
# Contents are sensitive (all family data, role password hashes): umask 077.
set -uo pipefail
umask 077

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
PGDATABASE="${PGDATABASE:-littlelight}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-35}"
BACKUP_HOUR="${BACKUP_HOUR:-3}"
DIR="${BACKUP_DIR:-/backups}"
export PGDATABASE

log() { printf '%s pg-backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

trap 'log "stopping"; exit 0' TERM INT

run_backup() {
  local stamp base
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  base="$DIR/littlelight-$stamp"

  until pg_isready -q; do
    log "waiting for $PGHOST"
    sleep 5
  done

  rm -f "$DIR"/littlelight-*.partial

  log "dumping $PGDATABASE"
  if ! pg_dump --format=custom --compress=6 --no-password --file "$base.dump.partial" "$PGDATABASE"; then
    log "ERROR: pg_dump failed"
    rm -f "$base.dump.partial"
    return 1
  fi
  if ! pg_restore --list "$base.dump.partial" >/dev/null; then
    log "ERROR: archive unreadable by pg_restore"
    rm -f "$base.dump.partial"
    return 1
  fi
  if ! pg_dumpall --roles-only --no-password --file "$base.roles.sql.partial"; then
    log "ERROR: pg_dumpall --roles-only failed"
    rm -f "$base.dump.partial" "$base.roles.sql.partial"
    return 1
  fi

  mv "$base.dump.partial" "$base.dump"
  mv "$base.roles.sql.partial" "$base.roles.sql"
  (cd "$DIR" && sha256sum "$(basename "$base.dump")" "$(basename "$base.roles.sql")" >"$(basename "$base.sha256")")

  log "ok: $(basename "$base.dump") ($(du -h "$base.dump" | cut -f1))"

  find "$DIR" -maxdepth 1 -type f -name 'littlelight-*' -mtime +"$RETENTION_DAYS" -print -delete |
    while read -r f; do log "pruned $(basename "$f")"; done
  return 0
}

seconds_until_next_run() {
  local now next
  now="$(date +%s)"
  next="$(date -d "today ${BACKUP_HOUR}:00" +%s)"
  if [ "$next" -le "$now" ]; then
    next="$(date -d "tomorrow ${BACKUP_HOUR}:00" +%s)"
  fi
  echo $((next - now))
}

mkdir -p "$DIR"

if [ -z "$(find "$DIR" -maxdepth 1 -name 'littlelight-*.dump' -mmin -1200 2>/dev/null)" ]; then
  log "no dump younger than 20h; running one now"
  run_backup || log "will retry at the next scheduled run"
fi

while true; do
  wait_s="$(seconds_until_next_run)"
  log "next dump in ${wait_s}s (${BACKUP_HOUR}:00 ${TZ:-UTC})"
  sleep "$wait_s" &
  wait $!
  attempts=0
  until run_backup; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 3 ]; then
      log "ERROR: giving up until tomorrow (healthcheck will report unhealthy after 26h)"
      break
    fi
    sleep 600 &
    wait $!
  done
done
