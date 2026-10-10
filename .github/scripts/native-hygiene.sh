#!/usr/bin/env bash
# Native-app hygiene checks (docs/plans/step-9.md 9.16 and 2.14 "CI (9.16)"), run by the CI
# `check` job and runnable locally from the repo root:
#
#   bash .github/scripts/native-hygiene.sh
#
# Every searched path must exist, otherwise a rename would turn a check into a silent pass.
#
#   1. No signing material or Firebase config in git: no google-services.json,
#      GoogleService-Info.plist, *.p8 (APNs auth key), *.p12, *.jks, *.keystore,
#      *.mobileprovision, keystore.properties or AuthKey_*.* file, and no PEM private key body or
#      Google service-account JSON in any file's content. Run on the files git tracks plus the
#      untracked files a `git add -A` would pick up (locally that is what the next commit would
#      contain; on a CI checkout it is just the tracked set).
#   2. apps/mobile-web/src/platform never writes a token to localStorage/sessionStorage: every
#      non-test, non-comment line mentioning either must be listed verbatim (path + trimmed line)
#      in .github/scripts/native-storage-allowlist.txt (today: the launch-URL digest only).
#   3. apps/mobile-web/capacitor.config.ts sets `loggingBehavior: "none"` (exactly one
#      non-comment occurrence, with that value): Capacitor's debug logging prints plugin call
#      arguments (tokens, presigned URLs) into logcat / the Xcode console.
#   4. No console.log / console.debug in apps/mobile-web/src/platform/native (tests included).
#   5. Album sync background refresh (docs/plans/step-10.md 2.4): both iOS plists (Info.plist and
#      Info-Debug.plist) carry UIBackgroundModes with `fetch` and
#      BGTaskSchedulerPermittedIdentifiers with exactly the SYNC_BG_TASK_ID of
#      packages/shared/src/imports.ts (so the id the app registers is the one iOS permits).
#   6. The Photos permission prompt appears only on the album-sync enable path (step-10.md 10.14):
#      every non-test, non-comment line of apps/mobile-web/src naming `requestAuthorization`
#      is one of the six allow-listed lines below (the plugin interface, the manager method and
#      its single plugin call, the native facade, the one internal caller, and the setup
#      sheet's "Allow access" handler); `this.requestAuthorization(` occurs exactly once
#      (grep -c = 1) and inside `async enable(`, and the setup-sheet call sits in its `allow`
#      handler. On the native side PHPhotoLibrary.requestAuthorization occurs exactly once in
#      ios/App/App/*.swift, in TinyglowPhotoSync.swift.
#
# The merged Android manifest's forbidden-permission check needs a Gradle build and runs in the
# android-debug job (.github/scripts/check-android-manifest.mjs).
set -uo pipefail

fail=0
PLATFORM=apps/mobile-web/src/platform
NATIVE=apps/mobile-web/src/platform/native
CAP_CONFIG=apps/mobile-web/capacitor.config.ts
ALLOWLIST=.github/scripts/native-storage-allowlist.txt

for d in "$PLATFORM" "$NATIVE"; do
  [ -d "$d" ] || {
    echo "::error::$d is missing"
    fail=1
  }
done
for f in "$CAP_CONFIG" "$ALLOWLIST"; do
  [ -f "$f" ] || {
    echo "::error::$f is missing"
    fail=1
  }
done
[ "$fail" -eq 0 ] || exit 1

# 1a. Signing material / Firebase configs by file name.
what="no signing material, APNs key or Firebase config file in git"
files="$(git ls-files --cached --others --exclude-standard)" || {
  echo "::error::git ls-files failed"
  exit 1
}
bad="$(printf '%s\n' "$files" | grep -iE \
  '(^|/)(google-services\.json|GoogleService-Info\.plist|keystore\.properties|AuthKey_[^/]*)$|\.(p8|p12|pfx|jks|keystore|mobileprovision|provisionprofile)$' \
  || true)"
if [ -n "$bad" ]; then
  printf '%s\n' "$bad"
  echo "::error::$what (files above)"
  fail=1
else
  echo "ok: $what"
fi

# 1b. Key material by content: a PEM private-key header followed by a real (64-char) base64 line,
# literal or JSON/TS-escaped, or a Google service-account JSON. Test fixtures use short dummy
# bodies ("x", "AAAA") and generate real keys at runtime, so they do not match. pnpm-lock.yaml
# holds only integrity hashes. Only "path:line" is printed, never the matching text, so a leaked
# key does not end up in the CI log as well.
what="no PEM private key or service-account JSON in any file"
git grep --untracked -nIE \
  -e '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----(\\r)?(\\n)?[A-Za-z0-9+/]{64}' \
  -e '"type"[[:space:]]*:[[:space:]]*"service_account"' \
  -- . ':!pnpm-lock.yaml' | cut -d: -f1,2
rc=${PIPESTATUS[0]}
# A key spread over real lines: the header alone on a line, then a 64-char base64 line.
pem_hits="$(git grep --untracked -lIE -e '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----[[:space:]]*$' -- . 2>/dev/null || true)"
pem_real=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if grep -A1 -E -- '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----[[:space:]]*$' "$f" | grep -qE '^[A-Za-z0-9+/]{64}$'; then
    echo "$f"
    pem_real=1
  fi
done <<<"$pem_hits"
case "$rc" in
  0 | 1)
    if [ "$rc" -eq 0 ] || [ -n "$pem_real" ]; then
      echo "::error::$what (locations above)"
      fail=1
    else
      echo "ok: $what"
    fi
    ;;
  *)
    echo "::error::git grep failed (exit $rc) while checking: $what"
    fail=1
    ;;
esac

# 2. localStorage / sessionStorage in the platform layer: only allow-listed lines.
what="no localStorage/sessionStorage use in $PLATFORM outside $ALLOWLIST"
hits="$(grep -rnE --exclude='*.test.ts' --exclude='*.test.tsx' 'localStorage|sessionStorage' "$PLATFORM")"
rc=$?
if [ "$rc" -gt 1 ]; then
  echo "::error::grep failed (exit $rc) while checking: $what"
  fail=1
else
  # Drop comment lines (//, /*, * continuation), then normalise to "path: trimmed line".
  code_hits="$(printf '%s\n' "$hits" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|/\*|\*)' | grep -v '^$' \
    | sed -E 's/^([^:]+):[0-9]+:[[:space:]]*/\1: /; s/[[:space:]]+$//' || true)"
  allowed="$(grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST" | sed -E 's/[[:space:]]+$//' || true)"
  unlisted=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if ! printf '%s\n' "$allowed" | grep -qxF -- "$line"; then
      unlisted="$unlisted$line"$'\n'
    fi
  done <<<"$code_hits"
  if [ -n "$unlisted" ]; then
    printf '%s' "$unlisted"
    echo "::error::$what (lines above; tokens belong in the secure store, never web storage)"
    fail=1
  else
    echo "ok: $what"
  fi
fi

# 3. loggingBehavior "none".
what="$CAP_CONFIG sets loggingBehavior: \"none\" exactly once"
lines="$(grep -nE 'loggingBehavior' "$CAP_CONFIG" | grep -vE '^[0-9]+:[[:space:]]*(//|/\*|\*)' || true)"
count="$(printf '%s\n' "$lines" | grep -c . || true)"
if [ "$count" -eq 1 ] && printf '%s\n' "$lines" | grep -qE 'loggingBehavior:[[:space:]]*"none",?[[:space:]]*$'; then
  echo "ok: $what"
else
  printf '%s\n' "$lines"
  echo "::error::$what (found $count non-comment line(s), above)"
  fail=1
fi

# 4. No console.log / console.debug in the native platform code.
what="no console.log or console.debug in $NATIVE"
grep -rnE 'console\.(log|debug)' "$NATIVE"
rc=$?
case "$rc" in
  1) echo "ok: $what" ;;
  0)
    echo "::error::$what (matches above)"
    fail=1
    ;;
  *)
    echo "::error::grep failed (exit $rc) while checking: $what"
    fail=1
    ;;
esac

# 5. Background-refresh plist keys, both plists, id = SYNC_BG_TASK_ID.
SHARED_IMPORTS=packages/shared/src/imports.ts
IOS_APP=apps/mobile-web/ios/App/App
task_id="$(sed -nE 's/^export const SYNC_BG_TASK_ID = "([^"]+)";.*/\1/p' "$SHARED_IMPORTS" 2>/dev/null)"
if [ -z "$task_id" ]; then
  echo "::error::SYNC_BG_TASK_ID not found in $SHARED_IMPORTS"
  fail=1
fi
# plist_array <file> <key>: the <string> values of the array right after <key>KEY</key>, one per line.
plist_array() {
  awk -v key="<key>$2</key>" '
    index($0, key) { on = 1; next }
    on && /<\/array>|<array\/>/ { exit }
    on && /<key>/ { exit }
    on {
      rest = $0
      while (match(rest, /<string>[^<]*<\/string>/)) {
        print substr(rest, RSTART + 8, RLENGTH - 17)
        rest = substr(rest, RSTART + RLENGTH)
      }
    }
  ' "$1"
}
for plist in "$IOS_APP/Info.plist" "$IOS_APP/Info-Debug.plist"; do
  what="$plist: UIBackgroundModes has fetch, BGTaskSchedulerPermittedIdentifiers = [$task_id]"
  if [ ! -f "$plist" ]; then
    echo "::error::$plist is missing"
    fail=1
    continue
  fi
  modes="$(plist_array "$plist" UIBackgroundModes)"
  ids="$(plist_array "$plist" BGTaskSchedulerPermittedIdentifiers)"
  if [ -n "$task_id" ] && printf '%s\n' "$modes" | grep -qx 'fetch' && [ "$ids" = "$task_id" ]; then
    echo "ok: $what"
  else
    echo "  UIBackgroundModes: [$(printf '%s' "$modes" | tr '\n' ' ')] BGTaskSchedulerPermittedIdentifiers: [$(printf '%s' "$ids" | tr '\n' ' ')]"
    echo "::error::$what"
    fail=1
  fi
done

# 6. The Photos permission prompt: allow-listed call sites only (path: trimmed line).
PHOTO_SYNC_TS="$NATIVE/photoSync.ts"
SETUP_SHEET=apps/mobile-web/src/components/import/SetupSyncSheet.tsx
PROMPT_ALLOWED="$(cat <<'ALLOWED'
apps/mobile-web/src/platform/native/photoSync.ts: requestAuthorization(): Promise<{ status: AuthStatus }>;
apps/mobile-web/src/platform/native/photoSync.ts: async requestAuthorization(): Promise<AuthStatus> {
apps/mobile-web/src/platform/native/photoSync.ts: return (await p.requestAuthorization()).status;
apps/mobile-web/src/platform/native/photoSync.ts: if ((await this.requestAuthorization()) !== "authorized") {
apps/mobile-web/src/platform/native/photoSync.ts: requestAuthorization: () => call((p) => p.requestAuthorization()),
apps/mobile-web/src/components/import/SetupSyncSheet.tsx: apply(await photoSync.requestAuthorization());
ALLOWED
)"
what="requestAuthorization in apps/mobile-web/src only on the allow-listed lines (album-sync enable path)"
for f in "$PHOTO_SYNC_TS" "$SETUP_SHEET"; do
  [ -f "$f" ] || {
    echo "::error::$f is missing"
    fail=1
  }
done
hits="$(grep -rn --exclude='*.test.ts' --exclude='*.test.tsx' 'requestAuthorization' apps/mobile-web/src)"
rc=$?
if [ "$rc" -gt 1 ]; then
  echo "::error::grep failed (exit $rc) while checking: $what"
  fail=1
else
  code_hits="$(printf '%s\n' "$hits" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|/\*|\*)' | grep -v '^$' \
    | sed -E 's/^([^:]+):[0-9]+:[[:space:]]*/\1: /; s/[[:space:]]+$//' || true)"
  unlisted=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '%s\n' "$PROMPT_ALLOWED" | grep -qxF -- "$line" || unlisted="$unlisted$line"$'\n'
  done <<<"$code_hits"
  n_hits="$(printf '%s\n' "$code_hits" | grep -c . || true)"
  n_allowed="$(printf '%s\n' "$PROMPT_ALLOWED" | grep -c .)"
  if [ -n "$unlisted" ] || [ "$n_hits" -ne "$n_allowed" ]; then
    printf '%s' "$unlisted"
    echo "::error::$what (found $n_hits line(s), expected the $n_allowed allow-listed ones; unlisted above)"
    fail=1
  else
    echo "ok: $what"
  fi
fi
# The one internal caller sits in `async enable(` (nearest enclosing method header above it), and
# the setup sheet's call in its `allow` handler.
what="this.requestAuthorization( occurs once in $PHOTO_SYNC_TS, inside enable(); the sheet calls it from allow"
n_this="$(grep -c 'this\.requestAuthorization(' "$PHOTO_SYNC_TS" 2>/dev/null || true)"
in_enable="$(awk '
  /^  (async )?[A-Za-z_][A-Za-z0-9_]*(<[^>]*>)?\(/ && !/^  (if|for|while|switch|return|catch|await)[ (]/ { m = $0; sub(/^  (async )?/, "", m); sub(/[(<].*/, "", m); method = m }
  /this\.requestAuthorization\(/ { print method }
' "$PHOTO_SYNC_TS" 2>/dev/null)"
in_allow="$(awk '
  /^  const [A-Za-z_][A-Za-z0-9_]* = / { h = $0; sub(/^  const /, "", h); sub(/ = .*/, "", h); handler = h }
  /photoSync\.requestAuthorization\(/ { print handler }
' "$SETUP_SHEET" 2>/dev/null)"
if [ "$n_this" = "1" ] && [ "$in_enable" = "enable" ] && [ "$in_allow" = "allow" ]; then
  echo "ok: $what"
else
  echo "  this.requestAuthorization count: ${n_this:-0}, enclosing method: ${in_enable:-none}, sheet handler: ${in_allow:-none}"
  echo "::error::$what"
  fail=1
fi
what="PHPhotoLibrary.requestAuthorization exactly once in $IOS_APP/*.swift, in TinyglowPhotoSync.swift"
swift_hits="$(grep -nE 'PHPhotoLibrary\.requestAuthorization' "$IOS_APP"/*.swift | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//' || true)"
if [ "$(printf '%s\n' "$swift_hits" | grep -c .)" -eq 1 ] && printf '%s\n' "$swift_hits" | grep -q '/TinyglowPhotoSync\.swift:'; then
  echo "ok: $what"
else
  printf '%s\n' "$swift_hits" | cut -d: -f1,2
  echo "::error::$what"
  fail=1
fi

exit "$fail"
