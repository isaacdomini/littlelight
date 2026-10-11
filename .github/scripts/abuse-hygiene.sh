#!/usr/bin/env bash
# Free-tier abuse hygiene (docs/plans/step-11.md 2.10 "abuse-hygiene.sh", family model; tasks
# 11.7, 11.7b), run by the CI `check` job after `pnpm install` and runnable locally from the repo root:
#
#   bash .github/scripts/abuse-hygiene.sh
#
#   1. Static checks (.github/scripts/abuse-hygiene.mjs, header there):
#      a. the family_starts DDL has no email / user-agent / raw-IP column (ip_hash is a 32-byte
#         bytea digest);
#      c. the vendored disposable-domain list ships its CC0 LICENSE.txt;
#      d. no email, IP, IP hash or token reaches a logger call in apps/api/src/auth/
#         family-guards.ts, session.ts, routes.ts, ip-hash.ts, apps/api/src/routes/babies.ts
#         (and context.ts);
#      e. no sha256 / phash join (no cross-account photo comparison) in the abuse report.
#   2. (b) apps/api/src/auth/disposable/blocklist.generated.ts equals a fresh
#      `pnpm --filter @tinyglow/api disposable:build` (deterministic output from the vendored
#      .conf). The committed file is restored afterwards, so a local run never leaves the tree
#      changed; on a mismatch the first differing lines are shown and the fix is to run the
#      build and commit the result.
#
# Each part reports on its own; the script exits 1 if any failed.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(pwd)"
GEN="apps/api/src/auth/disposable/blocklist.generated.ts"
fail=0

echo "-- static"
node "$HERE/abuse-hygiene.mjs" --root "$ROOT" || fail=1

echo "-- generated disposable-domain list is current"
what="$GEN equals a fresh disposable:build"
if [ ! -f "$GEN" ]; then
  echo "::error::$GEN is missing"
  fail=1
elif ! command -v pnpm >/dev/null 2>&1; then
  echo "::error::pnpm is not on PATH (needed for disposable:build)"
  fail=1
else
  tmp="$(mktemp -d)"
  cp "$GEN" "$tmp/committed.ts"
  # Put the committed file back whatever happens below (also on Ctrl-C).
  trap 'cp "$tmp/committed.ts" "$ROOT/$GEN" 2>/dev/null; rm -rf "$tmp"' EXIT
  if ! pnpm --silent --filter @tinyglow/api run disposable:build >"$tmp/build.log" 2>&1; then
    tail -n 20 "$tmp/build.log"
    echo "::error::disposable:build failed (output above)"
    fail=1
  elif ! cmp -s "$tmp/committed.ts" "$GEN"; then
    diff "$tmp/committed.ts" "$GEN" | head -n 20
    echo "::error::$what: it does not (first differences above; run pnpm --filter @tinyglow/api disposable:build and commit)"
    fail=1
  else
    echo "ok: $what"
  fi
fi

exit "$fail"
