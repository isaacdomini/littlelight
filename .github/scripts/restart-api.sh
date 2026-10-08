#!/usr/bin/env bash
# Reset the API's in-memory rate limits on the running dev stack (CI dev-stack-smoke job).
#
# The sign-in-code limit is in memory, 30 per hour per IP (docs/plans/step-3.md 2.9), and every
# CI request comes from the same IP, so the job restarts api between suites that sign in
# (smoke -> Playwright e2e -> upload gate -> perf gate). `up --no-deps --no-recreate --wait` only waits for
# api to be healthy again (no one-shot re-runs), then the web proxy is polled because that is
# the path the browser and the gate use.
#
#   bash .github/scripts/restart-api.sh        (from the repo root; WEB_PORT honoured)
set -euo pipefail

DC=(docker compose -f docker-compose.dev.yml)
URL="http://localhost:${WEB_PORT:-8080}/api/healthz"

"${DC[@]}" restart api
"${DC[@]}" up -d --no-deps --no-recreate --wait --wait-timeout 180 api
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "$URL" && exit 0
  sleep 2
done
echo "::error::api not reachable through $URL after restart"
exit 1
