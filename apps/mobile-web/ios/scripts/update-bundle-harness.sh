#!/usr/bin/env bash
# Live updates (docs/plans/step-14.md 2.7, task 14.7): compiles ios/App/App/LLUpdateBundle.swift +
# LLUpdateKeys.swift with the host-side harness and runs it twice (macOS, Xcode CLT; no simulator,
# no Xcode project, ~10 s):
#   1. -D DEBUG (as the Debug app): content id, path/base-URL rules, signature + tamper, parsing,
#      minNativeBuild, launch/stage/rollback state machine, staging, pruning.
#   2. without DEBUG (as the Release app): the dev key is not trusted, and the compiled binary does
#      not contain the dev SPKI.
# Vectors: update-bundle-harness/vectors.fixture.json (dev-signed) and, when present,
# e2e/ota/vectors.json (written by the OTA gate, task 14.10).
# Then text checks: no print/NSLog/os_log in the updater sources, dev key only under #if DEBUG.
# Prints PASS/FAIL lines; exit 1 on any failure. On a non-macOS host it prints SKIP and exits 0.
set -euo pipefail
if [ "$(uname -s)" != "Darwin" ]; then
  echo "SKIP update-bundle-harness: needs macOS (swiftc + CryptoKit)"
  exit 0
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/../App/App"
REPO="$(cd "$HERE/../../../.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

VECTORS=("$HERE/update-bundle-harness/vectors.fixture.json")
if [ -f "$REPO/e2e/ota/vectors.json" ]; then VECTORS+=("$REPO/e2e/ota/vectors.json"); fi

SRCS=("$APP/LLUpdateBundle.swift" "$APP/LLUpdateKeys.swift" "$HERE/update-bundle-harness/main.swift")
xcrun swiftc -O -D DEBUG -module-name LLUpdateHarness "${SRCS[@]}" -o "$OUT/harness-debug"
xcrun swiftc -O -module-name LLUpdateHarness "${SRCS[@]}" -o "$OUT/harness-release"
"$OUT/harness-debug" "${VECTORS[@]}"
"$OUT/harness-release" "${VECTORS[@]}"

fail=0
DEV_SPKI="$(sed -n 's/.*static let devSpkiBase64 = "\([^"]*\)".*/\1/p' "$APP/LLUpdateKeys.swift")"
if [ -n "$DEV_SPKI" ] && ! strings "$OUT/harness-release" | grep -qF "$DEV_SPKI" && strings "$OUT/harness-debug" | grep -qF "$DEV_SPKI"; then
  echo "PASS release-compiled updater does not contain the dev SPKI (debug-compiled does)"
else
  echo "FAIL dev SPKI presence: expected only in the DEBUG compile"; fail=1
fi
# The dev key literal and its uses must sit between '#if DEBUG' and '#endif'.
if awk '/#if DEBUG/{d=1} /#endif/{d=0} /devSpkiBase64|devKeyId/{ if(!d){ bad=1 } } END{ exit bad }' "$APP/LLUpdateKeys.swift" \
   && ! grep -n 'devSpkiBase64\|devKeyId' "$APP/LLUpdateBundle.swift" "$APP/TinyglowUpdater.swift" >/dev/null; then
  echo "PASS dev key referenced only inside #if DEBUG (LLUpdateKeys.swift)"
else
  echo "FAIL dev key referenced outside #if DEBUG"; fail=1
fi
if grep -nE '\b(print|NSLog|os_log|debugPrint|CAPLog\.print)\(|Logger\(' "$APP/LLUpdateBundle.swift" "$APP/LLUpdateKeys.swift" "$APP/TinyglowUpdater.swift"; then
  echo "FAIL logging call in the updater sources (outcomes go to JS only)"; fail=1
else
  echo "PASS no logging calls in the updater sources"
fi
exit "$fail"
