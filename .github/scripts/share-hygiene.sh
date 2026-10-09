#!/usr/bin/env bash
# Sharing hygiene greps (docs/plans/step-8.md 2.11 "CI (8.12)" and 4.5), run by the CI `check`
# job and runnable locally from the repo root:
#
#   bash .github/scripts/share-hygiene.sh
#
# Every searched folder must exist, otherwise a rename would turn a check into a silent pass.
#
#   1. service_role in the sharing module: exactly two `withServiceRole` call sites, both in
#      apps/api/src/sharing/viewer-session.ts (the token exchange and the viewer sign-out). The
#      parent share-link routes run as the signed-in user under RLS and must never use it.
#      *.test.ts files (which may name it, e.g. in mocks or assertions) and comment lines are
#      not counted.
#   2. The auto-sharer never touches location or private text: no `gps_lat_enc`, `gps_lng_enc`,
#      `decrypt_coord`, `dataKey`, `.note` or `.people` anywhere in apps/worker/src/sharing
#      (tests included). grep exits 0 on a match (fail), 1 on no match (pass), 2 on an error.
#
# "No token/passcode in logs" is proven at runtime, not here: the sentinel integration test
# (docs/plans/step-8.md 8.10), the share gate's log scan, and the CI log grep after the gate.
set -uo pipefail

fail=0
SHARING_API=apps/api/src/sharing
SHARING_WORKER=apps/worker/src/sharing
EXPECTED_FILE="$SHARING_API/viewer-session.ts"

for d in "$SHARING_API" "$SHARING_WORKER"; do
  [ -d "$d" ] || {
    echo "::error::$d is missing"
    fail=1
  }
done
[ -f "$EXPECTED_FILE" ] || {
  echo "::error::$EXPECTED_FILE is missing"
  fail=1
}
[ "$fail" -eq 0 ] || exit 1

# 1. withServiceRole call sites (non-test, non-comment lines).
what="withServiceRole in $SHARING_API: exactly 2 call sites, both in $EXPECTED_FILE"
hits="$(grep -rn --exclude='*.test.ts' 'withServiceRole' "$SHARING_API")"
rc=$?
if [ "$rc" -gt 1 ]; then
  echo "::error::grep failed (exit $rc) while checking: $what"
  fail=1
else
  code_hits="$(printf '%s\n' "$hits" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|/\*|\*)' | grep -v '^$' || true)"
  count="$(printf '%s\n' "$code_hits" | grep -c . || true)"
  elsewhere="$(printf '%s\n' "$code_hits" | grep -v "^$EXPECTED_FILE:" | grep -v '^$' || true)"
  if [ "$count" -ne 2 ] || [ -n "$elsewhere" ]; then
    printf '%s\n' "$code_hits"
    echo "::error::$what (found $count; matches above)"
    fail=1
  else
    echo "ok: $what"
  fi
fi

# 2. No location / private-text access in the auto-sharer.
what="no gps_lat_enc, gps_lng_enc, decrypt_coord, dataKey, .note or .people in $SHARING_WORKER"
grep -rnE 'gps_lat_enc|gps_lng_enc|decrypt_coord|dataKey|\.note\b|\.people\b' "$SHARING_WORKER"
rc=$?
case "$rc" in
  1) echo "ok: $what" ;;
  0)
    echo "::error::$what (matches above)"
    fail=1
    ;;
  *)
    echo "::error::grep failed (exit $rc) while checking: $what"
    fail=1
    ;;
esac

exit "$fail"
