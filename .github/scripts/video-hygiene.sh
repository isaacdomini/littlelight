#!/usr/bin/env bash
# Video hygiene (docs/plans/step-12.md 2.10 "video-hygiene.sh", 2.6; task 12.11), run by the CI
# `check` job and runnable locally from the repo root (no install, no Docker needed):
#
#   bash .github/scripts/video-hygiene.sh
#
# Static checks (.github/scripts/video-hygiene.mjs, header there):
#   a. no "http" anywhere in apps/worker/src/video (non-test files): ffmpeg/ffprobe get staged
#      local files only, never a URL;
#   b. apps/worker/src/video/ffmpeg.ts is the only spawn site under video/ and demo/, exports
#      assertLocalArgs, and runProcess() calls assertLocalArgs(args) before spawn(); everything
#      else runs binaries through runProcess();
#   c. logger calls in apps/worker/src/video carry ids, outcomes, counts, durations and booleans
#      only (no path, scratch, stderr, tag, coordinate / location, URL, make/model or text
#      values; err is errorCategory(…)); no console.*;
#   d. migration 22's jsonb_has_gps_keys matches location / ISO6709;
#   e. docker-compose.yml worker: mem_limit 3g, WORKER_SCRATCH_PATH bind at /scratch with
#      create_host_path: false, env WORKER_SCRATCH_PATH=/scratch;
#   f. .env.example sets WORKER_SCRATCH_PATH.
# The log-side counterpart runs in the dev-stack job: the video gate's api/worker log tap is
# scanned with .github/scripts/scan-logs-for-secrets.mjs (scratch-path, quicktime-location,
# presign and coordinate patterns, --pii).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(pwd)"

echo "-- static"
node "$HERE/video-hygiene.mjs" --root "$ROOT"
