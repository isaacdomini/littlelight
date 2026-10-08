#!/usr/bin/env bash
# Prove a Littlelight database backup restores. Run monthly (PRD "Compose requirements").
#
# Runs INSIDE the pgvector/pgvector image: it initdb's a throwaway cluster in /tmp, applies the
# roles file, pg_restores the dump with --exit-on-error, then sanity-checks the result. Nothing
# touches the live database.
#
# Production (newest dump in BACKUP_PATH):
#   docker compose run --rm --no-deps --entrypoint bash backup /scripts/restore-test.sh
# A specific dump:
#   docker compose run --rm --no-deps --entrypoint bash backup /scripts/restore-test.sh \
#     /backups/littlelight-20261008T030000Z.dump
# Any folder of dumps (e.g. one restored from the off-site copy):
#   docker run --rm -v /path/to/dumps:/backups:ro -v "$PWD/docker/backup:/scripts:ro" \
#     --entrypoint bash pgvector/pgvector:0.8.7-pg17 /scripts/restore-test.sh
#
# Exit 0 = restorable. Prints table counts only, never row contents.
set -euo pipefail

DIR="${BACKUP_DIR:-/backups}"
DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  DUMP="$(find "$DIR" -maxdepth 1 -name 'littlelight-*.dump' | sort | tail -n 1)"
fi
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "restore-test: no dump found in $DIR" >&2; exit 1; }

base="${DUMP%.dump}"
ROLES="$base.roles.sql"
SUMS="$base.sha256"

log() { printf 'restore-test: %s\n' "$*"; }
log "dump: $(basename "$DUMP")"

if [ -f "$SUMS" ]; then
  (cd "$(dirname "$DUMP")" && sha256sum -c --quiet "$(basename "$SUMS")") || { log "FAIL checksum mismatch"; exit 1; }
  log "checksums ok"
else
  log "WARN: no .sha256 next to the dump; skipping checksum"
fi

WORK="$(mktemp -d /tmp/restore-test.XXXXXX)"
PGDATA_T="$WORK/data"
SOCK="$WORK/sock"
mkdir -p "$PGDATA_T" "$SOCK"
chown -R postgres:postgres "$WORK"

as_pg() { if [ "$(id -u)" = 0 ]; then gosu postgres "$@"; else "$@"; fi; }
cleanup() { as_pg pg_ctl -D "$PGDATA_T" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

as_pg initdb -D "$PGDATA_T" -U postgres --auth=trust >/dev/null
as_pg pg_ctl -D "$PGDATA_T" -w -o "-c listen_addresses='' -c unix_socket_directories=$SOCK" -l "$WORK/pg.log" start >/dev/null

# Clients run as the invoking user against the throwaway socket with trust auth.
export PGHOST="$SOCK" PGUSER=postgres
unset PGPASSWORD PGDATABASE

if [ -f "$ROLES" ]; then
  # "role postgres already exists" is expected; everything else must apply.
  psql -q -X -d postgres -f "$ROLES" 2>&1 | grep -v 'role "postgres" already exists' || true
  log "roles applied"
else
  log "WARN: no roles file; restoring with --no-owner"
fi

createdb -T template0 littlelight
restore_flags=(--exit-on-error -d littlelight)
[ -f "$ROLES" ] || restore_flags+=(--no-owner --no-acl)
pg_restore "${restore_flags[@]}" "$DUMP"
log "pg_restore ok"

q() { psql -X -At -d littlelight -c "$1"; }
fail=0
check() { # name, sql, minimum
  local v; v="$(q "$2")"
  if [ "${v:-0}" -ge "$3" ]; then log "ok   $1 = $v"; else log "FAIL $1 = ${v:-?} (expected >= $3)"; fail=1; fi
}
check "extension vector"          "select count(*) from pg_extension where extname = 'vector'" 1
check "public tables"             "select count(*) from information_schema.tables where table_schema = 'public'" 1
check "applied migrations"        "select count(*) from public.pgmigrations" 1
check "auth (GoTrue) tables"      "select count(*) from information_schema.tables where table_schema = 'auth'" 1
check "auth.users readable"       "select 1 from (select count(*) from auth.users) s" 1
check "supabase_auth_admin role"  "select count(*) from pg_roles where rolname = 'supabase_auth_admin'" 1
log "auth.users rows: $(q 'select count(*) from auth.users')"

[ "$fail" = 0 ] && log "PASS $(basename "$DUMP") is restorable" || { log "FAILED"; exit 1; }
