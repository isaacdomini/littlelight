#!/usr/bin/env bash
# storage-init: idempotent MinIO bootstrap, run on every `up` by both compose files
# (docs/plans/step-4.md 2.11, D5, D6). Runs in the pgsty/mc image (bash + coreutils; no grep/sed).
#
#   1. bucket S3_BUCKET exists, versioning on
#   2. lifecycle = docker/minio/lifecycle.json, imported as the bucket's WHOLE lifecycle config
#      (noncurrent versions expire after 7 days, expired delete markers removed). `mc ilm import`
#      replaces the config, so re-runs never stack duplicate rules (`mc ilm rule add` would).
#   3. bucket-scoped IAM users for the app, each with exactly one policy:
#        S3_API_ACCESS_KEY    -> policy littlelight-api    (docker/minio/policy-api.json)
#        S3_WORKER_ACCESS_KEY -> policy littlelight-worker (docker/minio/policy-worker.json)
#      `${S3_BUCKET}` in the policy files is replaced with the bucket name. `mc admin user add`
#      on an existing user resets its secret, so rotating a secret is: edit it, re-run this.
#
# MinIO authorization quirks the api policy works around (verified with the AWS SDK against
# pgsty/minio RELEASE.2026-08-04, docs/plans/step-4.md R6):
#   - On a versioned bucket every GET/HEAD is also checked against s3:GetObjectVersion, so the
#     api policy cannot simply deny that action (signed thumb URLs would 403). It denies
#     s3:GetObject/s3:GetObjectVersion only when the request names a versionId instead.
#   - s3:ListBucket (needed for HeadBucket, i.e. the api/worker health checks) also grants
#     ListObjectVersions, and a Deny on s3:ListBucketVersions does not override it. The api can
#     therefore LIST version metadata (keys, version ids, sizes, dates) but cannot read, restore
#     or delete any version, delete any object, or change bucket versioning/lifecycle/policy.
#   - The explicit Deny on s3:DeleteObject/s3:DeleteObjectVersion keeps the api delete-free even
#     if a broader policy is ever attached to its user by mistake.
#
# The MinIO root credentials (S3_ROOT_USER / S3_ROOT_PASSWORD) are used here and by `storage`
# only; api and worker get their own keys. Secrets are never printed.
set -euo pipefail

S3_ENDPOINT="${S3_ENDPOINT:-http://storage:9000}"
MINIO_DIR="${MINIO_DIR:-/minio}"
: "${S3_ROOT_USER:?S3_ROOT_USER is required}" "${S3_ROOT_PASSWORD:?S3_ROOT_PASSWORD is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_API_ACCESS_KEY:?S3_API_ACCESS_KEY is required}" "${S3_API_SECRET_KEY:?S3_API_SECRET_KEY is required}"
: "${S3_WORKER_ACCESS_KEY:?S3_WORKER_ACCESS_KEY is required}" "${S3_WORKER_SECRET_KEY:?S3_WORKER_SECRET_KEY is required}"

log() { printf 'storage-init: %s\n' "$*"; }
die() { printf 'storage-init: ERROR %s\n' "$*" >&2; exit 1; }

# The bucket name is substituted into JSON policies: allow S3 bucket-name characters only.
[[ "$S3_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "S3_BUCKET must be a valid S3 bucket name"
# MinIO limits: access key 3-20 characters, secret key 8-40.
check_pair() { # label key secret
  [[ "$2" =~ ^[A-Za-z0-9._-]{3,20}$ ]] || die "$1 access key must be 3-20 characters of [A-Za-z0-9._-]"
  (( ${#3} >= 8 && ${#3} <= 40 )) || die "$1 secret key must be 8-40 characters"
}
check_pair api "$S3_API_ACCESS_KEY" "$S3_API_SECRET_KEY"
check_pair worker "$S3_WORKER_ACCESS_KEY" "$S3_WORKER_SECRET_KEY"
[[ "$S3_API_ACCESS_KEY" != "$S3_ROOT_USER" && "$S3_WORKER_ACCESS_KEY" != "$S3_ROOT_USER" ]] \
  || die "the api/worker access keys must differ from the MinIO root user"
[[ "$S3_API_ACCESS_KEY" != "$S3_WORKER_ACCESS_KEY" ]] || die "api and worker need different access keys"
[[ "$S3_API_SECRET_KEY" != "$S3_ROOT_PASSWORD" && "$S3_WORKER_SECRET_KEY" != "$S3_ROOT_PASSWORD" \
  && "$S3_API_SECRET_KEY" != "$S3_WORKER_SECRET_KEY" ]] || die "api, worker and root secrets must all differ"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MC_CONFIG_DIR="$TMP/mc"

mc alias set local "$S3_ENDPOINT" "$S3_ROOT_USER" "$S3_ROOT_PASSWORD" >/dev/null

# 1. Bucket + versioning.
mc mb --ignore-existing "local/$S3_BUCKET" >/dev/null
mc version enable "local/$S3_BUCKET" >/dev/null
log "bucket $S3_BUCKET ready, versioning enabled"

# 2. Lifecycle backstop (D6).
mc ilm import "local/$S3_BUCKET" <"$MINIO_DIR/lifecycle.json" >/dev/null
log "lifecycle imported (noncurrent versions expire after 7 days, expired delete markers removed)"

# 3. Service accounts (D5).
ensure_account() { # policy-name access-key secret-key policy-file
  local name=$1 key=$2 secret=$3 file=$4 tpl info
  tpl="$(<"$MINIO_DIR/$file")"
  # shellcheck disable=SC2016 # the literal placeholder ${S3_BUCKET} is the pattern
  printf '%s\n' "${tpl//'${S3_BUCKET}'/$S3_BUCKET}" >"$TMP/$name.json"
  mc admin policy create local "$name" "$TMP/$name.json" >/dev/null
  mc admin user add local "$key" "$secret" >/dev/null
  mc admin user enable local "$key" >/dev/null
  mc admin policy attach local "$name" --user "$key" >/dev/null 2>&1 || true
  # Least privilege: the user must end up with exactly this one policy, enabled.
  info="$(mc admin user info local "$key" --json)"
  [[ "$info" == *"\"policyName\":\"$name\""* ]] \
    || die "user for $name must have exactly policy $name attached (found: ${info#*policyName})"
  [[ "$info" == *'"userStatus":"enabled"'* ]] || die "user for $name is not enabled"
  log "user for $name ready (policy $name attached)"
}
ensure_account littlelight-api "$S3_API_ACCESS_KEY" "$S3_API_SECRET_KEY" policy-api.json
ensure_account littlelight-worker "$S3_WORKER_ACCESS_KEY" "$S3_WORKER_SECRET_KEY" policy-worker.json

log "done"
