#!/usr/bin/env bash
# AI hygiene greps (docs/plans/step-6.md 4.4 and 2.10 "CI check"), run by the CI `check` job and
# runnable locally from the repo root:
#
#   bash .github/scripts/ai-hygiene.sh
#
# Each grep must find nothing. grep exits 0 on a match (fail), 1 on no match (pass) and 2 on an
# error such as a moved folder (fail), so only exit 1 passes. Every searched folder must exist,
# otherwise a rename would turn the check into a silent pass.
#
#   1. Provider key names never reach the client bundle or the shared package.
#   2. No provider SDK is imported or depended on anywhere (adapters use plain fetch, D2); the
#      lockfile is checked too, so a transitive or renamed import cannot sneak the SDK in.
#   3. The AI pipeline never touches the data encryption key (no `dataKey` in AI transactions).
set -uo pipefail

fail=0

# no_match <description> <grep args...>
no_match() {
  local what="$1"
  shift
  grep "$@"
  local rc=$?
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
}

for d in apps/mobile-web/src packages/shared/src apps/worker/src/ai apps packages; do
  [ -d "$d" ] || {
    echo "::error::$d is missing"
    fail=1
  }
done
[ -f pnpm-lock.yaml ] || {
  echo "::error::pnpm-lock.yaml is missing"
  fail=1
}
[ "$fail" -eq 0 ] || exit 1

no_match "provider key names are not in apps/mobile-web/src or packages/shared/src" \
  -rn 'OPENAI_API_KEY\|ANTHROPIC_API_KEY' apps/mobile-web/src packages/shared/src

no_match "no provider SDK import in apps/ or packages/" \
  -rnE --exclude-dir=node_modules --exclude-dir=dist \
  'from "openai"|from '"'"'openai'"'"'|require\("openai"\)|@anthropic-ai/sdk' apps packages

no_match "no provider SDK in pnpm-lock.yaml" \
  -nE "^  '?(openai|@anthropic-ai/sdk)@" pnpm-lock.yaml

no_match "no dataKey in apps/worker/src/ai" \
  -rn 'dataKey' apps/worker/src/ai

exit "$fail"
