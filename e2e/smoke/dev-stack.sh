#!/usr/bin/env bash
# Dev-stack smoke test (docs/plans/step-1.md section 4; step-2 additions: db-init, non-superuser
# app connections, seeded-family RLS spot checks; step-3 additions: OTP through the API, cookie
# session, GoTrue not reachable from the browser). Run from anywhere; operates on the repo root.
#
#   bash e2e/smoke/dev-stack.sh              bring the stack up (if needed) and check it
#   SMOKE_TEARDOWN=1 bash e2e/smoke/dev-stack.sh   also `down -v` on exit (pass or fail)
#   SMOKE_SKIP_UP=1  bash e2e/smoke/dev-stack.sh   assume the stack is already running
#   SMOKE_SKIP_STORAGE_STOP=1                      skip the stop-storage -> 503 check
#   SMOKE_NGINX_PORT=18081                         host port of the throwaway nginx used for the /s/ header check (step 8)
#
# Exits non-zero on the first failure.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
DC=(docker compose -f docker-compose.dev.yml)
TMP="$(mktemp -d)"
BASE="${SMOKE_BASE_URL:-http://localhost:${WEB_PORT:-8080}}"
MAIL="${SMOKE_MAILPIT_URL:-http://localhost:${MAILPIT_PORT:-8025}}"
API_DIRECT="${SMOKE_API_URL:-http://localhost:${API_PORT:-3000}}"

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
SHELL_HTML="$(curl -fsS "$BASE/" || true)"
grep -q '<div id="root">' <<<"$SHELL_HTML" || fail "$BASE/ did not serve the app shell"

step "3. proxies: /api/healthz, /auth/health; GoTrue's other endpoints are not browser-reachable"
HEALTHZ="$(curl -fsS "$BASE/api/healthz" || true)"
grep -q '"status":"ok"' <<<"$HEALTHZ" || fail "$BASE/api/healthz not ok"
curl -fsS -o /dev/null "$BASE/auth/health" || fail "$BASE/auth/health not 200"
# The API is GoTrue's only client for codes, verification and sign-out (docs/plans/step-3.md 2.1):
# the proxy exposes /auth/health, /auth/authorize and /auth/callback and 404s the rest.
for path in otp verify token logout signup user admin/users; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/$path" -H 'content-type: application/json' -d '{}')"
  [ "$code" = "404" ] || fail "POST $BASE/auth/$path answered $code, expected 404 (GoTrue must not be browser-reachable)"
done

step "3a. database: all 17 migrations applied"
MIGS="$("${DC[@]}" exec -T db psql -U postgres -d littlelight -At -c "select count(*) from public.pgmigrations")"
[ "$MIGS" = "17" ] || fail "expected 17 applied migrations, found $MIGS"

# Step 5: the perf baby is optional (dev-only `pnpm perf:seed`); when it is there it must be intact.
PERF_PHOTOS="$("${DC[@]}" exec -T db psql -U postgres -d littlelight -At -c "select count(*) from public.photos where baby_id='00000000-0000-4000-8000-000000000900'")"
if [ "$PERF_PHOTOS" != "0" ]; then
  [ "$PERF_PHOTOS" = "10000" ] || fail "perf baby is partly seeded ($PERF_PHOTOS photos, expected 10000); rerun pnpm perf:seed"
  echo "perf baby present: 10000 photos"
else
  echo "perf baby not seeded (optional)"
fi

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
MSG_TEXT="$(json '(j.Text||"")+" "+(j.HTML||"")' <<<"$MSG")"
grep -Eq '(^|[^0-9])[0-9]{6}([^0-9]|$)' <<<"$MSG_TEXT" \
  || fail "email body has no 6-digit code"
MSG_HTML="$(json 'j.HTML' <<<"$MSG")"
CODE="$(grep -Eo '>[0-9]{6}<' <<<"$MSG_HTML" | sed -n '1{s/[<>]//g;p;}' || true)"
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
grep -qx 'littlelight_api|littlelight-api' <<<"$CONNS" \
  || fail "no littlelight-api session as littlelight_api in pg_stat_activity"
grep -qx 'littlelight_worker|littlelight-worker' <<<"$CONNS" \
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
grep -qx 'stranger_photos=0' <<<"$OUT" || fail "a stranger can see photos: $OUT"
OUT="$("${APSQL[@]}" -c "begin; set local role authenticated; $(claims "$NANNY") delete from photos; rollback;" 2>&1 || true)"
grep -q 'permission denied for table photos' <<<"$OUT" || fail "contributor DELETE FROM photos was not denied: $OUT"
OUT="$("${APSQL[@]}" -c "begin; set local role viewer; $(claims "$VIEWER") select 'shared=' || count(*) from shared_photos; select 'photos=' || count(*) from photos; rollback;" 2>&1 || true)"
grep -qx 'shared=4' <<<"$OUT" || fail "viewer does not see exactly 4 shared_photos: $OUT"
grep -qx 'photos=4' <<<"$OUT" || fail "viewer does not see exactly 4 photos: $OUT"
OUT="$("${APSQL[@]}" -c "begin; set local role viewer; $(claims "$VIEWER") select count(*) from photo_exif; rollback;" 2>&1 || true)"
grep -q 'permission denied for table photo_exif' <<<"$OUT" || fail "viewer can read photo_exif: $OUT"
OUT="$("${APSQL[@]}" -c "select count(*) from photos" 2>&1 || true)"
grep -q 'permission denied' <<<"$OUT" || fail "littlelight_api outside SET ROLE can read photos: $OUT"
TABLES="$("${PSQL[@]}" -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname<>'pgmigrations' and not (c.relrowsecurity and c.relforcerowsecurity)")"
[ "$TABLES" = "0" ] || fail "$TABLES public table(s) without ENABLE+FORCE row level security"
echo "RLS spot checks passed"

step "5d. step 4: least-privilege MinIO service accounts, worker queues and disk gauge"
API_KEY="$("${DC[@]}" exec -T api printenv S3_ACCESS_KEY | tr -d '\r')"
[ "$API_KEY" = "littlelight-api" ] || fail "api S3_ACCESS_KEY is '$API_KEY', expected littlelight-api (not the root user)"
WORKER_KEY="$("${DC[@]}" exec -T worker printenv S3_ACCESS_KEY | tr -d '\r')"
[ "$WORKER_KEY" = "littlelight-worker" ] || fail "worker S3_ACCESS_KEY is '$WORKER_KEY', expected littlelight-worker"
WLOG="$("${DC[@]}" logs worker 2>&1)"
grep -q 'queues ready' <<<"$WLOG" || fail "worker log has no 'queues ready'"
grep -q 'CSAM matching disabled' <<<"$WLOG" || fail "worker log has no 'CSAM matching disabled'"
grep -q 'diskUsedPct' <<<"$WLOG" || fail "worker log has no diskUsedPct (disk gauge)"
LEAK="$("${DC[@]}" logs api worker 2>&1 | grep -Eci 'X-Amz-Signature|GPSLatitude|"latitude"' || true)"
[ "$LEAK" = "0" ] || fail "$LEAK api/worker log line(s) mention signed-URL signatures or GPS"
echo "api/worker use their own MinIO service accounts; worker queues ready; logs clean"


step "5e. step 6: AI wiring (queues line, provider line), seeded bath description, paid-tier gate, no keys in clients"
# step 6 added 2 queues (10), step 7/8 more (12), step 9 push.notify (13): the boot line carries the total
grep -Eq 'queues: 13' <<<"$WLOG" || fail "worker log does not show 13 queues"
W_KEY="$("${DC[@]}" exec -T worker printenv OPENAI_API_KEY | tr -d '\r' || true)"
W_PROVIDER="$("${DC[@]}" exec -T worker printenv VISION_PROVIDER | tr -d '\r' || true)"
if [ -z "$W_KEY" ] && [ "$W_PROVIDER" != "fake" ]; then
  grep -q 'AI disabled: OPENAI_API_KEY not set' <<<"$WLOG" || fail "worker log has no 'AI disabled: OPENAI_API_KEY not set' (no key configured)"
else
  grep -Eq 'AI enabled: provider=(openai|anthropic|fake) vision=' <<<"$WLOG" || fail "a provider is configured but the worker log has no 'AI enabled' line"
fi
for name in web migrate; do
  K="$("${DC[@]}" exec -T "$name" printenv OPENAI_API_KEY 2>/dev/null | tr -d '\r' || true)"
  [ -z "$K" ] || fail "$name has OPENAI_API_KEY set (only the worker and the api may hold a provider key)"
done
[ "$("${PSQL[@]}" -c "select count(*) from ai_batch_items i join babies b on b.id=i.baby_id where b.plan='free'")" = "0" ] \
  || fail "a free-tier baby has ai_batch_items"
[ "$("${PSQL[@]}" -c "select count(*) from photo_ai a join photos p on p.id=a.photo_id join babies b on b.id=p.baby_id where b.plan='free'")" = "0" ] \
  || fail "photo_ai rows exist for a free-tier baby"
# demo-mom reads the seeded bath photo: ready, flagged, raw output for the admin, nothing private
MOM_EMAIL="demo-mom@littlelight.local"
MOM_JAR="$TMP/mom.jar"
curl -fsS -o /dev/null -X POST "$BASE/api/auth/otp" -H 'content-type: application/json' -H 'X-Littlelight-Client: web' -d "{\"email\":\"$MOM_EMAIL\"}" || fail "demo-mom OTP request failed"
MOM_CODE=""
for _ in $(seq 1 30); do
  MID="$(curl -fsS "$MAIL/api/v1/search?query=to:$MOM_EMAIL" | json 'j.messages?.[0]?.ID')" || true
  if [ -n "$MID" ]; then
    MOM_CODE="$(curl -fsS "$MAIL/api/v1/message/$MID" | json 'j.HTML' | grep -Eo '>[0-9]{6}<' | sed -n '1{s/[<>]//g;p;}' || true)"
    [ -n "$MOM_CODE" ] && break
  fi
  sleep 1
done
[ -n "$MOM_CODE" ] || fail "no sign-in code for demo-mom"
curl -fsS -o /dev/null -c "$MOM_JAR" -X POST "$BASE/api/auth/verify" -H 'content-type: application/json' -H 'X-Littlelight-Client: web' \
  -d "{\"email\":\"$MOM_EMAIL\",\"code\":\"$MOM_CODE\"}" || fail "demo-mom verify failed"
# a freshly seeded family has not accepted the current Terms yet: accept them like the app would
MOM_ME="$(curl -fsS -b "$MOM_JAR" "$BASE/api/me")" || fail "GET /api/me as demo-mom failed"
if [ "$(printf '%s' "$MOM_ME" | json 'j.consent.ok')" != "true" ]; then
  curl -fsS -o /dev/null -b "$MOM_JAR" -X POST "$BASE/api/me/consent" -H 'content-type: application/json' -H 'X-Littlelight-Client: web' \
    -d "{\"termsVersion\":\"$(printf '%s' "$MOM_ME" | json 'j.consent.requiredTermsVersion')\",\"privacyVersion\":\"$(printf '%s' "$MOM_ME" | json 'j.consent.requiredPrivacyVersion')\",\"isAdult\":true}" \
    || fail "demo-mom consent failed"
fi
BATH="$(curl -fsS -b "$MOM_JAR" "$BASE/api/photos/00000000-0000-4000-8000-000000000304")" || fail "GET bath photo failed"
[ "$(printf '%s' "$BATH" | json 'j.ai.status')" = "ready" ] || fail "bath photo ai.status is not ready: $BATH"
[ "$(printf '%s' "$BATH" | json 'j.isSensitive')" = "true" ] || fail "bath photo is not sensitive"
[ "$(printf '%s' "$BATH" | json 'j.ai.description.sensitive_content.includes("bath")')" = "true" ] || fail "bath flag missing from the description"
[ "$(printf '%s' "$BATH" | json 'j.ai.raw!==null')" = "true" ] || fail "admin does not get ai.raw"
grep -Eqi 'latitude|longitude|raw_json|analysis\.jpg' <<<"$BATH" && fail "bath photo response leaks GPS/raw_json/analysis key"
echo "AI wiring and seeded description ok"

step "5f. step 7: search and chat (paid, admin-only), search rows only for paid babies, no secrets in logs"
MAYA_ID="00000000-0000-4000-8000-000000000100"
SEARCH="$(curl -fsS -b "$MOM_JAR" "$BASE/api/babies/$MAYA_ID/search?q=bath")" || fail "GET search as demo-mom failed"
[ "$(printf '%s' "$SEARCH" | json 'j.photos[0]?.id')" = "00000000-0000-4000-8000-000000000304" ] || fail "q=bath did not rank the bath photo first: $SEARCH"
# JSON keys of the hidden document / coordinates / vectors, or a long numeric array (a vector);
# the legitimate "degraded":"no_embeddings" label must not trip it
LEAK_RE='"(search_text|embedding|latitude|longitude|raw_json)"|(-?[0-9]+\.[0-9]+,){8,}'
grep -Eq "$LEAK_RE" <<<"$SEARCH" && fail "search response leaks the document, GPS or a vector"
curl -fsS -o /dev/null -b "$MOM_JAR" "$BASE/api/babies/$MAYA_ID/search/facets" || fail "GET search facets failed"
CHAT_CODE="$(curl -s -o "$TMP/chat.json" -w '%{http_code}' -b "$MOM_JAR" -X POST "$BASE/api/babies/$MAYA_ID/chat/messages" -H 'content-type: application/json' -H 'accept: application/json' -H 'X-Littlelight-Client: web' \
  -d '{"text":"Show me bath time photos"}')"
CHAT="$(cat "$TMP/chat.json")"
if [ "$(printf '%s' "$SEARCH" | json 'j.degraded')" = "no_embeddings" ]; then
  # zero-setup stack (no key, no fake provider): keyword search still works, chat says it is not configured
  [ "$CHAT_CODE" = "409" ] || fail "no provider: chat should answer 409 (not configured), got $CHAT_CODE: $CHAT"
  grep -q 'not configured' <<<"$CHAT" || fail "no provider: chat 409 does not say it is not configured: $CHAT"
  echo "no provider configured: keyword search ranks the bath photo, chat answers 'not configured'"
else
  [ "$CHAT_CODE" = "200" ] || fail "POST chat message as demo-mom answered $CHAT_CODE: $CHAT"
  [ "$(printf '%s' "$CHAT" | json 'j.message.citations.photoIds.includes("00000000-0000-4000-8000-000000000304")')" = "true" ] || fail "chat answer does not cite the bath photo: $CHAT"
  grep -Eq '\[photo:' <<<"$CHAT" && fail "chat answer carries a citation marker"
fi
curl -fsS -o /dev/null -b "$MOM_JAR" -X DELETE "$BASE/api/babies/$MAYA_ID/chat/thread" -H 'X-Littlelight-Client: web' || fail "DELETE chat thread failed"
[ "$("${PSQL[@]}" -c "select count(*) from photo_search s join babies b on b.id=s.baby_id where b.deleted_at is null and not baby_ai_enabled(b.id)")" = "0" ] \
  || fail "photo_search rows exist for a live baby without the entitlement (trashed babies keep theirs until the purge)"
[ "$("${PSQL[@]}" -c "select count(*) from ai_spend s join babies b on b.id=s.baby_id where b.plan='free'")" = "0" ] \
  || fail "ai_spend rows exist for a free-tier baby"
LOGS_NOW="$("${DC[@]}" logs --no-color --since 10m api worker 2>&1 || true)"
grep -Eqi 'Note from parent|Show me bath time photos|X-Amz-Signature|latitude' <<<"$LOGS_NOW" && fail "api/worker logs carry a search document, a chat question, a signed URL or a coordinate"
echo "search, chat, tier gates and log hygiene ok"

step "5g. step 8: sharing: viewer endpoints need a cookie; expired/revoked/unknown links are 410; nginx /s/ headers"
VB() { curl -s -o "$TMP/v.json" -w '%{http_code}' "$@"; }
for p in album photos; do
  C="$(VB "$BASE/api/share/$p")"
  [ "$C" = "401" ] || fail "GET /api/share/$p without a viewer cookie answered $C, expected 401"
done
C="$(VB -X POST "$BASE/api/share/photos/urls" -H 'content-type: application/json' -H 'X-Littlelight-Client: web' -d '{"ids":["00000000-0000-4000-8000-000000000301"],"kind":"thumb"}')"
[ "$C" = "401" ] || fail "POST /api/share/photos/urls without a cookie answered $C, expected 401"
C="$(VB -X POST "$BASE/api/share/session" -H 'content-type: application/json' -H 'X-Littlelight-Client: web' -d '{"token":"unknown-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}')"
[ "$C" = "410" ] || fail "exchanging an unknown token answered $C, expected 410"
grep -q '"share_link_expired"' "$TMP/v.json" || fail "unknown token body is not share_link_expired: $(cat "$TMP/v.json")"
C="$(VB "$BASE/api/babies/$MAYA_ID/share-links")"
[ "$C" = "401" ] || fail "GET share-links without a parent session answered $C, expected 401"
# demo-mom: create a link, open it as a viewer, prove the viewer cookie opens no parent route, revoke it
LINK="$(curl -fsS -b "$MOM_JAR" -X POST "$BASE/api/babies/$MAYA_ID/share-links" -H 'content-type: application/json' -H 'X-Littlelight-Client: web' -d '{"name":"smoke link"}')" || fail "demo-mom could not create a share link"
LINK_ID="$(printf '%s' "$LINK" | json 'j.link.id')"
LINK_TOKEN="$(printf '%s' "$LINK" | json 'j.url.split("/").pop()')"
VJAR="$TMP/viewer.jar"
C="$(curl -s -o "$TMP/v.json" -w '%{http_code}' -c "$VJAR" -X POST "$BASE/api/share/session" -H 'content-type: application/json' -H 'X-Littlelight-Client: web' -d "{\"token\":\"$LINK_TOKEN\"}")"
[ "$C" = "200" ] || fail "exchanging a fresh link answered $C: $(cat "$TMP/v.json")"
C="$(VB -b "$VJAR" "$BASE/api/share/album")"
[ "$C" = "200" ] || fail "viewer album with the cookie answered $C"
C="$(VB -b "$VJAR" "$BASE/api/me")"
[ "$C" = "401" ] || fail "a viewer cookie opened a parent route (GET /api/me answered $C)"
C="$(VB -b "$VJAR" "$BASE/api/babies/$MAYA_ID/chat/messages" -X POST -H 'content-type: application/json' -H 'X-Littlelight-Client: web' -d '{"text":"hi"}')"
case "$C" in 401|403) ;; *) fail "a viewer cookie reached chat (answered $C)";; esac
curl -fsS -o /dev/null -b "$MOM_JAR" -X POST "$BASE/api/share-links/$LINK_ID/revoke" -H 'content-type: application/json' -H 'X-Littlelight-Client: web' -d '{}' || fail "revoke failed"
C="$(VB -b "$VJAR" "$BASE/api/share/album")"
[ "$C" = "410" ] || fail "revoked link: open viewer session answered $C, expected 410"
C="$(VB -X POST "$BASE/api/share/session" -H 'content-type: application/json' -H 'X-Littlelight-Client: web' -d "{\"token\":\"$LINK_TOKEN\"}")"
[ "$C" = "410" ] || fail "revoked link: exchange answered $C, expected 410"
curl -fsS -o /dev/null -b "$MOM_JAR" -X DELETE "$BASE/api/share-links/$LINK_ID" -H 'X-Littlelight-Client: web' || fail "delete of the smoke link failed"
# The dev web is Vite (no nginx): the /s/ headers are checked on the production nginx config
# itself, served by a throwaway nginx container with a stub shell (nothing else is touched).
NGX_NAME="ll-smoke-nginx-$$"
NGX_PORT="${SMOKE_NGINX_PORT:-18081}"
mkdir -p "$TMP/html"
echo '<!doctype html><html><head></head><body><div id="root"></div></body></html>' > "$TMP/html/index.html"
if docker run -d --rm --name "$NGX_NAME" -p "127.0.0.1:$NGX_PORT:80" \
     -v "$ROOT/docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro" \
     -v "$TMP/html:/usr/share/nginx/html:ro" nginx:1.28-alpine >/dev/null 2>&1; then
  ngx_up() { curl -fsS -o /dev/null "http://127.0.0.1:$NGX_PORT/s/probe"; }
  wait_for 20 "throwaway nginx" ngx_up
  H="$(curl -sI "http://127.0.0.1:$NGX_PORT/s/abcdefghijklmnopqrstuv")"
  docker rm -f "$NGX_NAME" >/dev/null 2>&1 || true
  grep -qi '^referrer-policy: no-referrer' <<<"$H" || fail "nginx /s/ has no 'Referrer-Policy: no-referrer': $H"
  grep -qi '^cache-control: no-store' <<<"$H" || fail "nginx /s/ has no 'Cache-Control: no-store': $H"
  grep -Eqi '^x-robots-tag: noindex' <<<"$H" || fail "nginx /s/ has no 'X-Robots-Tag: noindex': $H"
  grep -qi '^x-frame-options: DENY' <<<"$H" || fail "nginx /s/ lost X-Frame-Options (add_header inheritance)"
  echo "nginx /s/ sends no-referrer, no-store and noindex"
else
  echo "WARNING: could not start a throwaway nginx:1.28-alpine (image missing and no network?); /s/ header check skipped"
fi
SHARE_LEAK="$("${DC[@]}" logs --no-color --since 10m api web 2>&1 | grep -cF -e "$LINK_TOKEN" || true)"
[ "$SHARE_LEAK" = "0" ] || fail "the share token appears in api/web logs ($SHARE_LEAK line(s))"
echo "sharing: viewer endpoints, 410 pages, parent isolation and log hygiene ok"

step "5h. step 9: native transport: association files, CORS from the app origins, push device route, demo media"
AASA_H="$(curl -sI "$BASE/.well-known/apple-app-site-association")"
grep -qi '^content-type: application/json' <<<"$AASA_H" || fail "apple-app-site-association is not served as application/json: $AASA_H"
AASA="$(curl -fsS "$BASE/.well-known/apple-app-site-association")" || fail "no apple-app-site-association"
[ "$(printf '%s' "$AASA" | json 'j.applinks.details[0].components.map(c=>c["/"]).join(",")')" = "/invite/*,/s/*,/signin/native*" ] \
  || fail "AASA components are not /invite/*, /s/*, /signin/native*: $AASA"
[ "$(curl -fsS "$BASE/.well-known/assetlinks.json" | json 'j[0].target.package_name')" = "com.tesarsoft.littlelight" ] \
  || fail "assetlinks.json package_name is not com.tesarsoft.littlelight"
# CORS preflight through the web proxy (:8080): the two app origins are allowed, without credentials
for ORIGIN in 'capacitor://localhost' 'https://localhost'; do
  PH="$(curl -si -X OPTIONS "$BASE/api/me" -H "origin: $ORIGIN" -H 'access-control-request-method: GET' \
    -H 'access-control-request-headers: authorization,x-littlelight-client')"
  grep -qi "^access-control-allow-origin: $ORIGIN" <<<"$PH" || fail "preflight from $ORIGIN has no matching allow-origin: $PH"
  grep -qi 'access-control-allow-credentials' <<<"$PH" && fail "preflight from $ORIGIN carries Access-Control-Allow-Credentials"
done
EVIL="$(curl -si -X OPTIONS "$BASE/api/me" -H 'origin: https://evil.example' -H 'access-control-request-method: GET' | grep -ci '^access-control-allow-origin' || true)"
[ "$EVIL" = "0" ] || fail "preflight from a foreign origin got an allow-origin header"
# an allowed origin without the native client header is refused (csrf), not served
C="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/otp" -H 'origin: https://localhost' -H 'content-type: application/json' -d '{"email":"x@example.com"}')"
[ "$C" = "403" ] || fail "an app origin without X-Littlelight-Client answered $C, expected 403"

# native sign-in (bearer tokens in the body, no cookie), then the push device route
N_EMAIL="smoke-native-$(date +%s)-$RANDOM@example.com"
NH='X-Littlelight-Client: native'
curl -fsS -o /dev/null -X POST "$BASE/api/auth/otp" -H 'content-type: application/json' -H "$NH" -d "{\"email\":\"$N_EMAIL\"}" || fail "native OTP request failed"
N_CODE=""
for _ in $(seq 1 30); do
  NID="$(curl -fsS "$MAIL/api/v1/search?query=to:$N_EMAIL" | json 'j.messages?.[0]?.ID')" || true
  if [ -n "$NID" ]; then
    N_CODE="$(curl -fsS "$MAIL/api/v1/message/$NID" | json 'j.HTML' | grep -Eo '>[0-9]{6}<' | sed -n '1{s/[<>]//g;p;}' || true)"
    [ -n "$N_CODE" ] && break
  fi
  sleep 1
done
[ -n "$N_CODE" ] || fail "no native sign-in code arrived"
curl -s -D "$TMP/n-headers.txt" -o "$TMP/n-verify.json" -X POST "$BASE/api/auth/verify" -H 'content-type: application/json' -H "$NH" \
  -d "{\"email\":\"$N_EMAIL\",\"code\":\"$N_CODE\"}" >/dev/null
grep -qi '^set-cookie' "$TMP/n-headers.txt" && fail "native verify set a cookie"
N_TOK="$(json 'j.tokens.accessToken' <"$TMP/n-verify.json")"
[ -n "$N_TOK" ] || fail "native verify returned no tokens.accessToken"
N_ME="$(curl -fsS "$BASE/api/me" -H "$NH" -H "authorization: Bearer $N_TOK")" || fail "GET /api/me with a bearer token failed"
if [ "$(printf '%s' "$N_ME" | json 'j.consent.ok')" != "true" ]; then
  curl -fsS -o /dev/null -X POST "$BASE/api/me/consent" -H "$NH" -H "authorization: Bearer $N_TOK" -H 'content-type: application/json' \
    -d "{\"termsVersion\":\"$(printf '%s' "$N_ME" | json 'j.consent.requiredTermsVersion')\",\"privacyVersion\":\"$(printf '%s' "$N_ME" | json 'j.consent.requiredPrivacyVersion')\",\"isAdult\":true}" \
    || fail "native consent failed"
fi
PUSH_TOKEN="$(openssl rand -hex 32)"
PUSH_BODY="{\"platform\":\"ios\",\"provider\":\"apns\",\"token\":\"$PUSH_TOKEN\",\"appVersion\":\"1.0.0\"}"
C="$(curl -s -o "$TMP/push.json" -w '%{http_code}' -X POST "$BASE/api/me/push-devices" -H "$NH" -H "authorization: Bearer $N_TOK" -H 'content-type: application/json' -d "$PUSH_BODY")"
[ "$C" = "201" ] || fail "POST /api/me/push-devices (native) answered $C: $(cat "$TMP/push.json")"
grep -qF "$PUSH_TOKEN" "$TMP/push.json" && fail "the push device response echoes the device token"
C="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/me/push-devices" -H 'X-Littlelight-Client: web' -H "authorization: Bearer $N_TOK" -H 'content-type: application/json' -d "$PUSH_BODY")"
[ "$C" = "400" ] || fail "POST /api/me/push-devices as the web client answered $C, expected 400"
C="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/me/push-devices" -H "$NH" -H "authorization: Bearer $N_TOK" -H 'content-type: application/json' \
  -d "{\"platform\":\"ios\",\"provider\":\"fcm\",\"token\":\"$PUSH_TOKEN\",\"appVersion\":\"1.0.0\"}")"
[ "$C" = "400" ] || fail "an iOS device registered with provider fcm answered $C, expected 400"
C="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/me/push-devices/current" -H "$NH" -H "authorization: Bearer $N_TOK")"
[ "$C" = "204" ] || fail "DELETE /api/me/push-devices/current answered $C, expected 204"
[ "$("${PSQL[@]}" -c "select count(*) from push_devices d join auth.users u on u.id=d.user_id where u.email='$N_EMAIL'")" = "0" ] \
  || fail "the smoke user's push device row survived DELETE .../current"
PLOG="$("${DC[@]}" logs --no-color --since 10m api worker 2>&1 || true)"
grep -qF "$PUSH_TOKEN" <<<"$PLOG" && fail "the device token appears in api/worker logs"
grep -qF "$N_TOK" <<<"$PLOG" && fail "the native bearer token appears in api/worker logs"

# demo family media: every demo photo has real thumbnails (200 image/jpeg), not placeholders
DEMO_IDS='["00000000-0000-4000-8000-000000000301","00000000-0000-4000-8000-000000000302","00000000-0000-4000-8000-000000000303","00000000-0000-4000-8000-000000000304","00000000-0000-4000-8000-000000000305","00000000-0000-4000-8000-000000000306","00000000-0000-4000-8000-000000000307","00000000-0000-4000-8000-000000000308","00000000-0000-4000-8000-000000000309","00000000-0000-4000-8000-000000000310","00000000-0000-4000-8000-000000000311","00000000-0000-4000-8000-000000000312"]'
DEMO_URLS="$(curl -fsS -b "$MOM_JAR" -X POST "$BASE/api/babies/$MAYA_ID/photos/urls" -H 'content-type: application/json' -H 'X-Littlelight-Client: web' -d "{\"photoIds\":$DEMO_IDS}")" \
  || fail "POST photos/urls for the demo photos failed"
for u in $(printf '%s' "$DEMO_URLS" | json 'Object.values(j.urls).map(x=>x.thumbUrl).join(" ")'); do
  THUMB="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$u")"
  [ "$THUMB" = "200 image/jpeg" ] || fail "a demo thumbnail answered '$THUMB', expected '200 image/jpeg'"
done
[ "$(printf '%s' "$DEMO_URLS" | json 'Object.keys(j.urls).length')" = "12" ] || fail "expected thumbnail URLs for 12 demo photos"
echo "association files, CORS, native sign-in, push device route and 12 demo thumbnails ok"

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
  worker_healthy() { ! worker_unhealthy && grep -q '"Health":"healthy"' <<<"$("${DC[@]}" ps worker --format json)"; }
  wait_for 90 "worker to recover to healthy" worker_healthy
  echo "storage stop/start behaved as expected"
fi

step "SMOKE PASSED"
