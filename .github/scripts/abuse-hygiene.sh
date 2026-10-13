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
# pnpm: the first that actually runs (`--version` succeeds), not merely the first on PATH:
# $PNPM_BIN (a command, e.g. "node /path/to/pnpm.mjs"), then `pnpm`, then `corepack pnpm`, then
# the pnpm version of package.json "packageManager" from pnpm's own tool dir
# (${PNPM_HOME:-~/Library/pnpm or ~/.local/share/pnpm}/.tools/pnpm/<v>/node_modules/pnpm/bin/
# pnpm.mjs, run with node). A version-manager shim with no version selected (asdf: "No version
# is set for command pnpm") fails `--version` and is skipped. CI (pnpm/action-setup) always takes
# the plain `pnpm`.
#
# Each part reports on its own; the script exits 1 if any failed.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(pwd)"
GEN="apps/api/src/auth/disposable/blocklist.generated.ts"
fail=0

echo "-- static"
node "$HERE/abuse-hygiene.mjs" --root "$ROOT" || fail=1

# Sets PNPM (array) to the first pnpm command that runs; see the header.
resolve_pnpm() {
  local cand v home
  if [ -n "${PNPM_BIN:-}" ]; then
    read -r -a PNPM <<<"$PNPM_BIN"
    "${PNPM[@]}" --version >/dev/null 2>&1 && return 0
  fi
  for cand in "pnpm" "corepack pnpm"; do
    read -r -a PNPM <<<"$cand"
    command -v "${PNPM[0]}" >/dev/null 2>&1 && "${PNPM[@]}" --version >/dev/null 2>&1 && return 0
  done
  v="$(node -p 'String(require("./package.json").packageManager || "").replace(/^pnpm@/, "").split("+")[0]' 2>/dev/null)"
  for home in "${PNPM_HOME:-}" "$HOME/Library/pnpm" "$HOME/.local/share/pnpm"; do
    [ -n "$home" ] && [ -n "$v" ] || continue
    cand="$home/.tools/pnpm/$v/node_modules/pnpm/bin/pnpm.mjs"
    if [ -f "$cand" ]; then
      PNPM=(node "$cand")
      "${PNPM[@]}" --version >/dev/null 2>&1 && return 0
    fi
  done
  return 1
}

echo "-- generated disposable-domain list is current"
what="$GEN equals a fresh disposable:build"
if [ ! -f "$GEN" ]; then
  echo "::error::$GEN is missing"
  fail=1
elif ! resolve_pnpm; then
  echo "::error::no working pnpm (tried \$PNPM_BIN, pnpm, corepack pnpm, pnpm's tool dir; needed for disposable:build)"
  fail=1
else
  echo "pnpm: ${PNPM[*]} ($("${PNPM[@]}" --version 2>/dev/null))"
  tmp="$(mktemp -d)"
  cp "$GEN" "$tmp/committed.ts"
  # Put the committed file back whatever happens below (also on Ctrl-C).
  trap 'cp "$tmp/committed.ts" "$ROOT/$GEN" 2>/dev/null; rm -rf "$tmp"' EXIT
  if ! "${PNPM[@]}" --silent --filter @tinyglow/api run disposable:build >"$tmp/build.log" 2>&1; then
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
