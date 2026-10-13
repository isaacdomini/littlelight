#!/usr/bin/env bash
# Web image live-update manifest check (docs/plans/step-14.md 2.5, 2.9 "images", 4.2; task
# 14.11). Run by the CI `images` job on the freshly built web image and runnable locally from the
# repo root on any build of it:
#
#   docker build -f apps/mobile-web/Dockerfile --target prod \
#     --build-arg VITE_API_URL=https://example.test -t tinyglow-web:ci .
#   bash .github/scripts/check-web-app-update.sh tinyglow-web:ci [expected VITE_API_URL]
#
# Starts the image standalone on 127.0.0.1:${APP_UPDATE_CHECK_PORT:-18081} and asserts:
#   1. GET /app-update/manifest.json: 200, Content-Type application/json, Cache-Control no-cache
#      (nginx `expires -1`), the server-level security headers still present (X-Content-Type-
#      Options nosniff), and the body passes .github/scripts/check-web-app-update.mjs: valid
#      manifest, content id == version, index.html listed, nothing under app-update/,
#      .well-known/ or email-templates/, every listed file served with the listed sha256 and size
#      (Accept-Encoding: identity), and, when the second argument is given, that origin baked
#      into a listed .js file (VITE_API_URL, D10).
#   2. /app-update/x and /app-update/nope.json: 404, not the SPA shell (no "<!doctype html").
# A local build without Docker: node .github/scripts/check-web-app-update.mjs --dist
# apps/mobile-web/dist (manifest rules and file hashes only; no nginx).
set -euo pipefail

img="${1:-}"
api_url="${2:-}"
[ -n "$img" ] || {
  echo "usage: check-web-app-update.sh <web-image> [expected VITE_API_URL]" >&2
  exit 2
}
HERE="$(cd "$(dirname "$0")" && pwd)"
port="${APP_UPDATE_CHECK_PORT:-18081}"
name="ll-app-update-check-$$"
base="http://127.0.0.1:$port"
fail=0

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
err() {
  echo "::error::$*"
  fail=1
}

docker run -d --name "$name" -p "127.0.0.1:$port:80" "$img" >/dev/null
for _ in $(seq 1 30); do
  curl -fs -o /dev/null "$base/healthz" && break
  sleep 1
done
curl -fs -o /dev/null "$base/healthz" || {
  docker logs "$name" 2>&1 | tail -n 50
  echo "::error::web image did not answer /healthz on 127.0.0.1:$port"
  exit 1
}

# 1. Headers of the manifest.
headers="$(curl -s -D - -o /dev/null -H 'Accept-Encoding: identity' "$base/app-update/manifest.json" | tr -d '\r')"
status="$(head -n1 <<<"$headers" | awk '{print $2}')"
[ "$status" = 200 ] || err "/app-update/manifest.json: HTTP $status (expected 200)"
grep -qiE '^content-type: application/json' <<<"$headers" || err "/app-update/manifest.json: Content-Type is not application/json"
cc="$(grep -ci '^cache-control:' <<<"$headers" || true)"
[ "$cc" -eq 1 ] || err "/app-update/manifest.json: expected exactly one Cache-Control header, got $cc"
grep -qiE '^cache-control: no-cache$' <<<"$headers" || err "/app-update/manifest.json: Cache-Control is not 'no-cache'"
grep -qiE '^x-content-type-options: nosniff$' <<<"$headers" || err "/app-update/manifest.json: server-level security headers dropped"
echo "/app-update/manifest.json: $status, $(grep -i '^cache-control:' <<<"$headers" || echo 'no Cache-Control')"

# 1b. Body + every listed file.
if [ -n "$api_url" ]; then
  node "$HERE/check-web-app-update.mjs" --base-url "$base" --expect-text "$api_url" || fail=1
else
  node "$HERE/check-web-app-update.mjs" --base-url "$base" || fail=1
fi

# 2. Nothing else under /app-update/, and no SPA fallback there.
for p in /app-update/x /app-update/nope.json; do
  body="$(curl -s -o - -w '\n%{http_code}' "$base$p")"
  code="$(tail -n1 <<<"$body")"
  [ "$code" = 404 ] || err "$p: HTTP $code (expected 404)"
  if grep -qi '<!doctype html' <<<"$body" && grep -qi 'id="root"' <<<"$body"; then
    err "$p: answered with the SPA shell"
  fi
  echo "$p -> $code"
done

[ "$fail" -eq 0 ] || exit 1
echo "ok: web image serves a valid live-update manifest (no-cache) and 404s the rest of /app-update/"
