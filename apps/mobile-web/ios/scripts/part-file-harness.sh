#!/usr/bin/env bash
# Compiles ios/App/App/LLPartFile.swift with the host-side harness and runs it (macOS, Xcode CLT).
# No simulator, no Xcode project, ~5 s. Prints PASS/FAIL lines; exit 1 on any failure.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
xcrun swiftc -O -module-name LLPartHarness \
  "$HERE/../App/App/LLPartFile.swift" "$HERE/part-file-harness/main.swift" -o "$OUT/harness"
"$OUT/harness"
