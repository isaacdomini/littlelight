#!/usr/bin/env bash
# Dev-stack smoke test (docs/plans/step-1.md section 4; step-2 additions: db-init, non-superuser
# app connections, seeded-family RLS spot checks; step-3 additions: OTP through the API, cookie
# session, GoTrue not reachable from the browser). Run from anywhere; operates on the repo root.
#
#   bash e2e/smoke/dev-stack.sh              bring the stack up (if needed) and check it
#   SMOKE_TEARDOWN=1 bash e2e/smoke/dev-stack.sh   also `down -v` on exit (pass or fail)
#   SMOKE_SKIP_UP=1  bash e2e/smoke/dev-stack.sh   assume the stack is already running
#   SMOKE_SKIP_STORAGE_STOP=1                      skip the stop-storage -> 503 check
#
# Exits non-zero on the first failure.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
DC=(docker compose -f docker-compose.dev.yml)
TMP="$(mktemp -d)"
BASE="${SMOKE_BASE_URL:-http://localhost:8080}"
MAIL="${SMOKE_MAILPIT_URL:-http://localhost:8025}"
API_DIRECT="${SMOKE_API_URL:-http://localhost:3000}"

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'SMOKE FAIL: %s\n' "$*" >&2; exit 1; }

on_exit() {
  local code=$?
  rm -rf "$TMP"
  if [ "$code" -ne 0 ]; then
    echo "--- smoke failed (exit $code); recent compose logs ---" >&2
    "${DC[@]}" logs --tail=40 2>&1 >&2 || true
  fi
  # Always leave storage running so a failed run does not wedge the stack.
  "${DC[@]}" start storage >/dev/null 2>&1 || true
  if [ "${SMOKE_TEARDOWN:-0}" = "1" ]; then
    echo "--- tearing down (SMOKE_TEARDOWN=1) ---"
    "${DC[@]}" down -v >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap on_exit EXIT

json() { # json <js-expression-over-j>  (reads JSON on stdin)
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=('"$1"');process.stdout.write(String(v??""))})'
}

wait_for() { # wait_for <seconds> <description> <command...>
  local secs=$1 desc=$2; shift 2
  local end=$((SECONDS + secs))
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$end" ] || fail "timed out after ${secs}s waiting for: $desc"
    sleep 2
  done
}

if [ "${SMOKE_SKIP_UP:-0}" != "1" ]; then
  step "1. docker compose up -d --build --wait"
  "${DC[@]}" up -d --build --wait
fi

step "1. every service healthy; one-shots exited 0"
PS_JSON="$("${DC[@]}" ps -a --format json)"
printf '%s' "$PS_JSON" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const t=s.trim();
  const rows=t.startsWith("[")?JSON.parse(t):t.split("\n").filter(Boolean).map(l=>JSON.parse(l));
  const by=Object.fromEntries(rows.map(r=>[r.Service,r]));
  const bad=[];
  for(const n of ["db","auth","storage","mail","api","worker","web"]){
    const r=by[n];
    if(!r||r.State!=="running"||r.Health!=="healthy") bad.push(`${n}: ${r?`${r.State}/${r.Health||"-"}`:"missing"}`);
  }
  for(const n of ["db-init","migrate","storage-init"]){
    const r=by[n];
    if(!r||r.State!=="exited"||r.ExitCode!==0) bad.push(`${n}: ${r?`${r.State}/exit ${r.ExitCode}`:"missing"}`);
  }
  if(bad.length){console.error("unhealthy services:\n  "+bad.join("\n  "));process.exit(1)}
  console.log("all services healthy; db-init, migrate and storage-init exited 0");
});' || fail "service state check"

step "2. web app loads at $BASE"
curl -fsS "$BASE/" | grep -q '<div id="root">' || fail "$BASE/ did not serve the app shell"

step "3. proxies: /api/healthz, /auth/health; GoTrue's other endpoints are not browser-reachable"
curl -fsS "$BASE/api/healthz" | grep -q '"status":"ok"' || fail "$BASE/api/healthz not ok"
curl -fsS -o /dev/null "$BASE/auth/health" || fail "$BASE/auth/health not 200"
# The API is GoTrue's only client for codes, verification and sign-out (docs/plans/step-3.md 2.1):
# the proxy exposes /auth/health, /auth/authorize and /auth/callback and 404s the rest.
for path in otp verify token logout signup user admin/users; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/$path" -H 'content-type: application/json' -d '{}')"
  [ "$code" = "404" ] || fail "POST $BASE/auth/$path answered $code, expected 404 (GoTrue must not be browser-reachable)"
done

step "3a. database: all 10 migrations applied"
MIGS="$("${DC[@]}" exec -T db psql -U postgres -d littlelight -At -c "select count(*) from public.pgmigrations")"
[ "$MIGS" = "10" ] || fail "expected 10 applied migrations, found $MIGS"

step "4. sign-in code: POST /api/auth/otp is a generic 202; the code arrives in Mailpit"
EMAIL="smoke-$(date +%s)-$RANDOM@example.com"
OTP_CODE="$(curl -s -o "$TMP/otp.json" -w '%{http_code}' -X POST "$BASE/api/auth/otp" \
  -H 'content-type: application/json' -H 'X-Littlelight-Client: web' \
  -d "{\"email\":\"$EMAIL\"}")"
[ "$OTP_CODE" = "202" ] || fail "POST /api/auth/otp answered $OTP_CODE, expected 202"
grep -q '"ok":true' "$TMP/otp.json" || fail "POST /api/auth/otp body is not {\"ok\":true}: $(cat "$TMP/otp.json")"
ID=""
for _ in $(seq 1 30); do
  ID="$(curl -fsS "$MAIL/api/v1/search?query=to:$EMAIL" | json 'j.messages?.[0]?.ID')" || true
  [ -n "$ID" ] && break
  sleep 1
done
[ -n "$ID" ] || fail "no email for $EMAIL appeared in Mailpit"
MSG="$(curl -fsS "$MAIL/api/v1/message/$ID")"
printf '%s' "$MSG" | json '(j.Text||"")+" "+(j.HTML||"")' | grep -Eq '(^|[^0-9])[0-9]{6}([^0-9]|$)' \
  || fail "email body has no 6-digit code"
CODE="$(printf '%s' "$MSG" | json 'j.HTML' | grep -Eo '>[0-9]{6}<' | head -n1 | tr -d '<>')"
[ -n "$CODE" ] || fail "no >NNNNNN< code in the email HTML"
echo "OTP email received"

step "4a. POST /api/auth/verify sets httpOnly session cookies; GET /api/me is 200; no cookie is 401"
JAR="$TMP/cookies.txt"
HDRS="$TMP/verify-headers.txt"
VCODE="$(curl -s -o "$TMP/verify.json" -D "$HDRS" -c "$JAR" -w '%{http_code}' -X POST "$BASE/api/auth/verify" \
  -H 'content-type: application/json' -H 'X-Littlelight-Client: web' \
  -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}")"
[ "$VCODE" = "200" ] || fail "POST /api/auth/verify answered $VCODE: $(cat "$TMP/verify.json")"
grep -qi '^set-cookie: ll_access=.*HttpOnly' "$HDRS" || fail "verify did not set an httpOnly ll_access cookie"
grep -qi '^set-cookie: ll_refresh=.*HttpOnly' "$HDRS" || fail "verify did not set an httpOnly ll_refresh cookie"
grep -qi 'path=/api/auth' "$HDRS" || fail "ll_refresh cookie is not scoped to /api/auth"
grep -q 'accessToken\|refreshToken' "$TMP/verify.json" && fail "verify returned tokens in a web response body"
ME="$(curl -fsS -b "$JAR" "$BASE/api/me")" || fail "GET /api/me with the session cookie failed"
[ "$(printf '%s' "$ME" | json 'j.user.email')" = "$EMAIL" ] || fail "GET /api/me did not return the signed-in user: $ME"
NOAUTH="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/me")"
[ "$NOAUTH" = "401" ] || fail "GET /api/me without a cookie answered $NOAUTH, expected 401"
echo "signed in as $EMAIL"

step "5. worker heartbeat is fresh with storage_ok"
HB="$("${DC[@]}" exec -T db psql -U postgres -d littlelight -At -c \
  "select count(*) from worker_heartbeats where storage_ok and now()-last_seen_at < interval '30 seconds'")"
[ "${HB:-0}" -ge 1 ] || fail "no fresh worker heartbeat with storage_ok = true"
echo "fresh heartbeat rows: $HB"

step "5a. api and worker connect as their own roles, never as the superuser"
PSQL=("${DC[@]}" exec -T db psql -U postgres -d littlelight -At -F '|')
CONNS="$("${PSQL[@]}" -c \
  "select distinct usename||'|'||regexp_replace(application_name, ':.*$', '') from pg_stat_activity where application_name like 'littlelight-%' order by 1")"
echo "$CONNS"
printf '%s\n' "$CONNS" | grep -qx 'littlelight_api|littlelight-api' \
  || fail "no littlelight-api session as littlelight_api in pg_stat_activity"
printf '%s\n' "$CONNS" | grep -qx 'littlelight_worker|littlelight-worker' \
  || fail "no littlelight-worker session as littlelight_worker in pg_stat_activity"
SUPER="$("${PSQL[@]}" -c \
  "select count(*) from pg_stat_activity where usename = 'postgres' and application_name like 'littlelight-%' and application_name not in ('littlelight-seed')")"
[ "$SUPER" = "0" ] || fail "$SUPER api/worker session(s) are connected as the postgres superuser"
# Any non-local client connected as postgres would be an app container using the wrong URL
# (psql here goes through the unix socket; migrate/db-init have exited).
REMOTE="$("${PSQL[@]}" -c \
  "select count(*) from pg_stat_activity where usename = 'postgres' and client_addr is not null and application_name not in ('littlelight-seed')")"
[ "$REMOTE" = "0" ] || fail "$REMOTE remote session(s) connected as postgres (an app uses the superuser URL?)"

step "5b. seeded demo family: RLS spot checks as littlelight_api (plan step 2 section 4)"
APSQL=("${DC[@]}" exec -T -e PGPASSWORD=dev db psql -h 127.0.0.1 -U littlelight_api -d littlelight -At -v ON_ERROR_STOP=0)
claims() { printf "select set_config('request.jwt.claims','%s',true);" "$1"; }
STRANGER='{"sub":"00000000-0000-4000-8000-0000000000ff","role":"authenticated"}'
NANNY='{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}'
VIEWER='{"role":"viewer","share_link_id":"00000000-0000-4000-8000-000000000200"}'
OUT="$("${APSQL[@]}" -c "begin; set local role authenticated; $(claims "$STRANGER") select 'stranger_photos=' || count(*) from photos; rollback;" 2>&1 || true)"
printf '%s\n' "$OUT" | grep -qx 'stranger_photos=0' || fail "a stranger can see photos: $OUT"
OUT="$("${APSQL[@]}" -c "begin; set local role authenticated; $(claims "$NANNY") delete from photos; rollback;" 2>&1 || true)"
printf '%s\n' "$OUT" | grep -q 'permission denied for table photos' || fail "contributor DELETE FROM photos was not denied: $OUT"
OUT="$("${APSQL[@]}" -c "begin; set local role viewer; $(claims "$VIEWER") select 'shared=' || count(*) from shared_photos; select 'photos=' || count(*) from photos; rollback;" 2>&1 || true)"
printf '%s\n' "$OUT" | grep -qx 'shared=3' || fail "viewer does not see exactly 3 shared_photos: $OUT"
printf '%s\n' "$OUT" | grep -qx 'photos=3' || fail "viewer does not see exactly 3 photos: $OUT"
OUT="$("${APSQL[@]}" -c "begin; set local role viewer; $(claims "$VIEWER") select count(*) from photo_exif; rollback;" 2>&1 || true)"
printf '%s\n' "$OUT" | grep -q 'permission denied for table photo_exif' || fail "viewer can read photo_exif: $OUT"
OUT="$("${APSQL[@]}" -c "select count(*) from photos" 2>&1 || true)"
printf '%s\n' "$OUT" | grep -q 'permission denied' || fail "littlelight_api outside SET ROLE can read photos: $OUT"
TABLES="$("${PSQL[@]}" -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname<>'pgmigrations' and not (c.relrowsecurity and c.relforcerowsecurity)")"
[ "$TABLES" = "0" ] || fail "$TABLES public table(s) without ENABLE+FORCE row level security"
echo "RLS spot checks passed"

if [ "${SMOKE_SKIP_STORAGE_STOP:-0}" != "1" ]; then
  step "5c. stopping storage degrades the api (503) and the worker (unhealthy)"
  "${DC[@]}" stop storage >/dev/null
  code_is_503() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$API_DIRECT/healthz")" = "503" ]; }
  wait_for 60 "api /healthz to return 503" code_is_503
  worker_unhealthy() {
    "${DC[@]}" ps worker --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=s.trim();const r=t.startsWith("[")?JSON.parse(t)[0]:JSON.parse(t.split("\n")[0]);process.exit(r.Health==="unhealthy"?0:1)})'
  }
  wait_for 90 "worker to become unhealthy" worker_unhealthy
  "${DC[@]}" start storage >/dev/null
  code_is_200() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$API_DIRECT/healthz")" = "200" ]; }
  wait_for 60 "api /healthz to recover to 200" code_is_200
  worker_healthy() { ! worker_unhealthy && "${DC[@]}" ps worker --format json | grep -q '"Health":"healthy"'; }
  wait_for 90 "worker to recover to healthy" worker_healthy
  echo "storage stop/start behaved as expected"
fi

step "SMOKE PASSED"
