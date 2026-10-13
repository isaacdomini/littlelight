#!/usr/bin/env bash
# Live-update hygiene (docs/plans/step-14.md 2.9 "CI", 5.3; task 14.11), run by the CI `check`
# job and runnable locally from the repo root (no install, no Docker needed):
#
#   bash .github/scripts/app-update-hygiene.sh
#
# Static checks (.github/scripts/app-update-hygiene.mjs, full rules in its header):
#   a. APP_UPDATE_PUBLIC_KEYS prod/dev (keyId + SPKI) identical in packages/shared/src/app-update.ts,
#      LLUpdateKeys.swift and UpdateKeys.java; EC P-256; no placeholder; prod != dev;
#   b. the dev SPKI ships only inside `#if DEBUG` (Swift) / `if (BuildConfig.DEBUG)` (Android main);
#   c. no EC private-key material (PKCS#8 / SEC1, base64 or hex) in any repo file except
#      .env.dev's APP_UPDATE_SIGNING_KEY_BASE64 line;
#   d. APP_UPDATE_SIGNING_KEY_BASE64 empty in .env.example; in .env.dev the dev key, whose public
#      half is APP_UPDATE_PUBLIC_KEYS.dev (and never prod);
#   e. no api logger call names a signature, manifestJson or key; apps/api/src/app-update logs
#      outcome/status/stale/platform/keyId only, no console; telemetry scrubs them;
#   f. no print/NSLog/os_log/Log.*/System.out/console in the updater sources (Swift, Java, TS);
#   g. no @capgo/*, @ionic-enterprise/*, capacitor-updater or appflow dependency;
#   h. mobile-web build / native:build / native:build:release end with the manifest step;
#   i. app-update.json parses and minNativeBuild <= the shells' build numbers;
#   j. every VITE_* flag in apps/mobile-web/src is on the OTA build-flag allow-list.
#
# Negative test (each rule fails when provoked): copy the tree without node_modules, plant one
# violation per rule, and run `node .github/scripts/app-update-hygiene.mjs --root <copy>`; the
# copy has no .git, so rule c walks it instead of asking git.
#
# The log-side counterpart runs in the dev-stack job: the OTA gate's api log tap is scanned with
# .github/scripts/scan-logs-for-secrets.mjs --app-update (no signature, manifest body, key
# material, app-update query or URL). The web image's served manifest is checked in the images
# job (.github/scripts/check-web-app-update.sh).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(pwd)"

echo "-- static"
node "$HERE/app-update-hygiene.mjs" --root "$ROOT"
