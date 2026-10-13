#!/usr/bin/env bash
# Passkey hygiene (docs/plans/step-13.md 2.7 "passkey-hygiene.sh", 2.4; task 13.8), run by the CI
# `check` job and runnable locally from the repo root (no install, no Docker needed):
#
#   bash .github/scripts/passkey-hygiene.sh
#
# Static checks (.github/scripts/passkey-hygiene.mjs, header there):
#   a. apps/api/src/auth/passkeys.ts and webauthn.ts log only { outcome | status | code |
#      error_code | context | err: safeErrorLog(…) } plus fixed messages; no console.*;
#   b. no logger call anywhere in apps/api/src names a WebAuthn credential field
#      (clientDataJSON, attestationObject, authenticatorData, signature, rawId, userHandle),
#      a challenge / challengeId, a credential, or the request body / headers;
#   c. apps/api/src/app.ts redacts req.body.credential, req.body.challengeId and the wildcard
#      paths for every credential field and the challenge id;
#   d. AUTH_PASSKEYS_ENABLED defaults false in docker-compose.yml and true in
#      docker-compose.dev.yml, feeding GoTrue (GOTRUE_PASSKEY_ENABLED) and the api alike;
#   e. docker/nginx/default.conf still forwards only GET /auth/health|authorize|callback and
#      POST /auth/callback to GoTrue (every /auth/passkeys/* path is 404 for browsers).
# The log-side counterpart runs in the dev-stack job: the passkey gate's api/worker/auth log tap is
# scanned with .github/scripts/scan-logs-for-secrets.mjs (webauthn-field pattern, --pii).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(pwd)"

echo "-- static"
node "$HERE/passkey-hygiene.mjs" --root "$ROOT"
