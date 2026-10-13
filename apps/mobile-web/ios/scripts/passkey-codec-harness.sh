#!/usr/bin/env bash
# Compiles ios/App/App/LLPasskeyCodec.swift with the host-side harness and runs it (macOS, Xcode CLT).
# No simulator, no Xcode project, ~5 s. Prints PASS/FAIL lines; exit 1 on any failure.
# Also asserts, by text, that both platform requests in TinyglowPasskeys.swift demand user
# verification (docs/plans/step-13.md decision g): the API rejects assertions without the UV flag.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
xcrun swiftc -O -module-name LLPasskeyHarness \
  "$HERE/../App/App/LLPasskeyCodec.swift" "$HERE/passkey-codec-harness/main.swift" -o "$OUT/harness"
"$OUT/harness"
n="$(grep -c 'userVerificationPreference = .required' "$HERE/../App/App/TinyglowPasskeys.swift")"
if [ "$n" -eq 2 ]; then
  echo "PASS TinyglowPasskeys.swift sets userVerificationPreference = .required on both requests"
else
  echo "FAIL TinyglowPasskeys.swift: expected 2 'userVerificationPreference = .required', found $n"
  exit 1
fi
