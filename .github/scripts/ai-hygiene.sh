#!/usr/bin/env bash
# AI hygiene greps (docs/plans/step-6.md 4.4 and 2.10 "CI check"; docs/plans/step-7.md 2.11 "CI
# check" and 4.5), run by the CI `check` job and runnable locally from the repo root:
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
#   4. The api never names ANTHROPIC_API_KEY (step 7: the api holds OPENAI_API_KEY for chat and
#      query embeddings; the Anthropic fallback is a worker-only vision adapter). Where Compose
#      actually delivers each key is checked separately with canaries
#      (.github/scripts/check-compose-keys.mjs, CI `check` job "Validate Compose files").
#   5. `search_text` (the search document; it contains parent notes) never leaves the DB layer:
#      no code line in the shared API contracts, the chat module or the search module refers to
#      it (whole word, so `photo_search_text_candidates` is fine). Comments and *.test.ts files
#      (which assert its absence) are exempt.
#
# Question/answer text and documents in *logs* are checked at runtime, not here: smoke step 5f
# and the search gate grep the api/worker logs (docs/plans/step-7.md 4.5).
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

for d in apps/mobile-web/src packages/shared/src packages/shared/src/api apps/worker/src/ai \
  apps/api/src apps/api/src/chat apps/api/src/search apps packages; do
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

no_match "ANTHROPIC_API_KEY is not referenced by apps/api/src (worker-only key)" \
  -rn --exclude='*.test.ts' 'ANTHROPIC_API_KEY' apps/api/src

# 5: grep, then drop comment lines (`//`, `/*`, ` *`). Exit 1 from the first grep is the clean case.
search_text_hits="$(grep -rnw --exclude='*.test.ts' 'search_text' \
  packages/shared/src/api apps/api/src/chat apps/api/src/search)"
rc=$?
what="search_text is not used in packages/shared/src/api, apps/api/src/chat or apps/api/src/search"
if [ "$rc" -gt 1 ]; then
  echo "::error::grep failed (exit $rc) while checking: $what"
  fail=1
else
  code_hits="$(printf '%s\n' "$search_text_hits" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|/\*|\*)' | grep -v '^$' || true)"
  if [ -n "$code_hits" ]; then
    printf '%s\n' "$code_hits"
    echo "::error::$what (matches above)"
    fail=1
  else
    echo "ok: $what"
  fi
fi

exit "$fail"
