#!/usr/bin/env bash
# Web image CSP header check (docs/plans/review-fixes.md 2.11 "CSP, report-only first", D9, R.4
# done-when; task R.13). Run by the CI `images` job on the freshly built web image and runnable
# locally from the repo root on any build of it:
#
#   docker build -f apps/mobile-web/Dockerfile --target prod -t littlelight-web:ci .
#   bash .github/scripts/check-web-csp.sh littlelight-web:ci
#
# Starts the image three times on 127.0.0.1:${CSP_CHECK_PORT:-18080} (standalone: nginx resolves
# its upstreams per request, so no api/auth container is needed) and reads the headers with
# `curl -sI` for `/` and for a share page `/s/x` (which re-declares its headers, nginx would
# otherwise drop the server-level CSP there):
#   1. no CSP variables              => exactly one Content-Security-Policy-Report-Only header
#                                       (the default) and no enforcing header
#   2. WEB_CSP_HEADER=…-Report-Only,  => report-only, with S3_PUBLIC_ENDPOINT substituted into
#      S3_PUBLIC_ENDPOINT, WEB_CSP_       img-src and connect-src and the extra origin into
#      CONNECT_EXTRA set                  connect-src
#   3. WEB_CSP_HEADER=Content-        => exactly one enforcing Content-Security-Policy header and
#      Security-Policy                    no report-only one
# Every case: no literal `${` left by the template renderer, `frame-ancestors 'none'` present,
# and `/s/x` also sends `Referrer-Policy: no-referrer`.
set -euo pipefail

img="${1:-}"
[ -n "$img" ] || {
  echo "usage: check-web-csp.sh <web-image>" >&2
  exit 2
}
port="${CSP_CHECK_PORT:-18080}"
name="ll-csp-check-$$"
S3=http://localhost:9000
EXTRA=https://o1.ingest.example.invalid
fail=0

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

err() {
  echo "::error::$*"
  fail=1
}

# start <env args...>: run the image and wait for /healthz.
start() {
  cleanup
  docker run -d --name "$name" -p "127.0.0.1:$port:80" "$@" "$img" >/dev/null
  for _ in $(seq 1 30); do
    curl -fs -o /dev/null "http://127.0.0.1:$port/healthz" && return 0
    sleep 1
  done
  docker logs "$name" 2>&1 | tail -n 50
  echo "::error::web image did not answer /healthz on 127.0.0.1:$port"
  exit 1
}

# check <case> <expected header name> <absent header name> [must-contain...]
check() {
  local label="$1" want="$2" absent="$3"
  shift 3
  local path headers lines n
  for path in / /s/x; do
    headers="$(curl -sI "http://127.0.0.1:$port$path" | tr -d '\r')"
    lines="$(grep -i "^$want:" <<<"$headers" || true)"
    n="$(grep -c . <<<"$lines" || true)"
    [ "$n" -eq 1 ] || err "$label $path: expected exactly one '$want' header, got $n"
    if grep -qi "^$absent:" <<<"$headers"; then err "$label $path: unexpected '$absent' header"; fi
    # A literal "${" means envsubst left a variable unrendered.
    # shellcheck disable=SC2016
    case "$lines" in *'${'*) err "$label $path: unrendered \${...} in the CSP" ;; esac
    grep -q "frame-ancestors 'none'" <<<"$lines" || err "$label $path: frame-ancestors 'none' missing"
    for needle in "$@"; do
      grep -qF -- "$needle" <<<"$lines" || err "$label $path: CSP lacks '$needle'"
    done
    if [ "$path" = /s/x ]; then
      grep -qi '^referrer-policy: no-referrer$' <<<"$headers" \
        || err "$label $path: Referrer-Policy: no-referrer missing"
    fi
    echo "$label $path: ${lines:0:160}..."
  done
}

RO=Content-Security-Policy-Report-Only
EN=Content-Security-Policy

start
check "default" "$RO" "$EN"

start -e WEB_CSP_HEADER="$RO" -e S3_PUBLIC_ENDPOINT="$S3" -e WEB_CSP_CONNECT_EXTRA="$EXTRA"
check "report-only" "$RO" "$EN" "img-src 'self' data: blob: $S3;" "connect-src 'self' $S3 $EXTRA;"

start -e WEB_CSP_HEADER="$EN" -e S3_PUBLIC_ENDPOINT="$S3"
check "enforcing" "$EN" "$RO" "connect-src 'self' $S3"

[ "$fail" -eq 0 ] || exit 1
echo "web CSP OK: report-only by default, enforcing when WEB_CSP_HEADER=$EN"
