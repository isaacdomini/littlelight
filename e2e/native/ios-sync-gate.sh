#!/usr/bin/env bash
# iOS album-sync gate (docs/plans/step-10.md 2.12, 4.4). Drives the real app on ONE simulator
# (iPhone 17, iOS 26.4 runtime; it never downloads a runtime) and checks, against the dev stack,
# that an Apple Photos album syncs into Maya's album with its metadata, incrementally, without
# duplicates, and that pause, stop and sign-out behave. Background refresh cannot be driven from a
# shell: it is a printed manual line.
#
#   docker compose -f docker-compose.dev.yml up -d --wait     # dev stack, fake AI
#   export PATH="$HOME/.cache/littlelight-pnpm/bin:$PATH"
#   pnpm e2e:native-ios-sync
#
# Environment (all optional):
#   IOS_GATE_SKIP_BUILD=1       reuse apps/mobile-web/ios/DerivedData (skip sync + xcodebuild)
#   IOS_GATE_KEEP_BOOTED=1      do not shut the simulator down at the end
#   IOS_GATE_RESTART_API=0      do not restart the api first (resets the in-memory sign-in throttle)
#   IOS_SYNC_KEEP_DERIVED=1     keep the DerivedData folders (default: delete them at the end)
#   IOS_GATE_SIM_NAME / IOS_GATE_RUNTIME   defaults "iPhone 17" / com.apple.CoreSimulator.SimRuntime.iOS-26-4
#
# How: `simctl addmedia` fills the camera roll; the XCUITest runner (e2e/native/ios-uitest, granted
# Photos access by `simctl privacy grant`) uses PhotoKit to create/fill/shrink a user album, taps
# SpringBoard's "Allow Full Access" alert and drives the app by its accessibility labels. API and
# database work lives in e2e/native/ios-sync-helper.ts. Everything the run imported into Maya's
# album is removed again at the end (photos, objects, sync rows, audit rows), the simulator is shut
# down and DerivedData is deleted.
# Exit 1 when an automated check fails (FAIL lines); the manual checklist is always printed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2
OUT="$ROOT/e2e/native-results/ios-sync"
UITEST="$ROOT/e2e/native/ios-uitest"
UIDD="$ROOT/e2e/native-results/ios-uitest-dd"
APPDD="$ROOT/apps/mobile-web/ios/DerivedData"
BUNDLE_ID="com.tesarsoft.littlelight"
RUNNER_ID="com.tesarsoft.lluitests.xctrunner"
SIM_NAME="${IOS_GATE_SIM_NAME:-iPhone 17}"
RUNTIME="${IOS_GATE_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-4}"
MAILPIT="http://localhost:${MAILPIT_PORT:-8025}"
BASE="http://localhost:${WEB_PORT:-8080}"
DEMO_EMAIL="demo-mom@littlelight.local"
MAYA="00000000-0000-4000-8000-000000000100"
ALBUM="LL Sync Test"
FX="$ROOT/e2e/fixtures"
mkdir -p "${OUT:?}"
find "${OUT:?}" -maxdepth 1 -type f \( -name '*.png' -o -name '*.log' -o -name '*.txt' -o -name '*.xml' -o -name '*.json' \) -delete

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
skip() { SKIP=$((SKIP+1)); printf 'SKIP  %s\n' "$*"; }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
step() { printf '\n==> %s\n' "$*"; }
die() { printf 'IOS SYNC GATE ERROR: %s\n' "$*" >&2; exit 2; }
PSQL() { docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d littlelight -Atc "$1"; }
helper() { pnpm --silent exec tsx e2e/native/ios-sync-helper.ts "$@"; }

command -v xcrun >/dev/null || die "xcrun not found: this gate needs macOS with Xcode"
command -v xcodebuild >/dev/null || die "xcodebuild not found"
curl -fsS -o /dev/null "$BASE/api/healthz" || die "dev stack is not reachable at $BASE (docker compose -f docker-compose.dev.yml up -d --wait)"
[ "$(PSQL "select count(*) from babies where id='$MAYA'" 2>/dev/null)" = "1" ] || die "not the seeded dev database (Maya is missing): refusing to run"

# ---- simulator: iPhone 17 on the iOS 26.4 runtime; never download anything ----------------------
UDID="$(xcrun simctl list devices -j | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s).devices[process.argv[1]]||[];
  const d=j.find(x=>x.name===process.argv[2]&&x.isAvailable);
  process.stdout.write(d?d.udid:"");
})' "$RUNTIME" "$SIM_NAME")"
[ -n "$UDID" ] || die "no available \"$SIM_NAME\" on $RUNTIME. This gate never downloads a runtime: install it from Xcode > Settings > Components, then rerun."
echo "simulator: $SIM_NAME ($UDID)"
SIM_WAS_BOOTED=0
grep "$UDID" <<<"$(xcrun simctl list devices)" | grep -q Booted && SIM_WAS_BOOTED=1

RESTORED=0
restore_all() {
  if [ "$RESTORED" = "0" ] && [ -f "$OUT/baseline.json" ]; then
    RESTORED=1
    helper restore >"$OUT/restore.log" 2>&1 && echo "restored Maya's album ($(tail -1 "$OUT/restore.log"))" || echo "WARNING: restore failed, see $OUT/restore.log"
  fi
}
cleanup() {
  restore_all
  if [ "${IOS_GATE_KEEP_BOOTED:-0}" != "1" ] && [ "$SIM_WAS_BOOTED" = "0" ]; then
    xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
    echo "simulator shut down"
  fi
  if [ "${IOS_SYNC_KEEP_DERIVED:-0}" != "1" ]; then
    rm -rf "$UIDD" "$APPDD"
    echo "DerivedData deleted"
  fi
}
trap cleanup EXIT

shot() { xcrun simctl io "$UDID" screenshot "$OUT/$1.png" >/dev/null 2>&1 || true; }

# uitest <TestName> [VAR=value ...]: one XCUITest; log in $OUT/uitest-<name>.log. The result is read
# from the log and a watchdog kills xcodebuild after UITEST_TIMEOUT seconds (default 200).
uitest() {
  local name=$1; shift
  local envs=()
  for kv in "$@"; do envs+=("TEST_RUNNER_${kv}"); done
  local log="$OUT/uitest-$name.log"
  env ${envs[@]+"${envs[@]}"} TEST_RUNNER_LL_OUT="$OUT" TEST_RUNNER_LL_MAILPIT="$MAILPIT" \
    xcodebuild -project "$UITEST/LLUITests.xcodeproj" -scheme LLUITests \
      -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$UIDD" \
      test-without-building -only-testing:"LLUITests/LLUITests/$name" >"$log" 2>&1 &
  local xpid=$! waited=0
  while kill -0 "$xpid" 2>/dev/null; do
    if grep -qE "^(\*\* TEST (EXECUTE )?(SUCCEEDED|FAILED) \*\*|Test Suite 'Selected tests' (passed|failed))" "$log" 2>/dev/null; then sleep 2; break; fi
    waited=$((waited+1))
    [ "$waited" -gt "${UITEST_TIMEOUT:-200}" ] && break
    sleep 1
  done
  kill "$xpid" 2>/dev/null; wait "$xpid" 2>/dev/null
  grep -q "^Test Suite 'Selected tests' passed" "$log"
}
relaunch() { xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true; xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null; sleep 5; }
# wait_sql "<select>" "<expected>" [seconds]: poll until the single value matches.
wait_sql() {
  local sql=$1 want=$2 secs=${3:-60} got=""
  for _ in $(seq 1 "$secs"); do
    got="$(PSQL "$sql" 2>/dev/null)"
    [ "$got" = "$want" ] && return 0
    sleep 1
  done
  LAST_GOT="$got"
  return 1
}
src_row() { PSQL "select imported_count||'|'||duplicate_count||'|'||failed_count||'|'||paused||'|'||coalesce(last_trigger,'')||'|'||coalesce(last_error,'') from import_sources where baby_id='$MAYA'"; }
photo_count() { PSQL "select count(*) from photos where baby_id='$MAYA' and created_at > '$SYNC_START'"; }

# ---- 1. build -------------------------------------------------------------------------------------
if [ "${IOS_GATE_SKIP_BUILD:-0}" != "1" ]; then
  step "1. sync + ad-hoc signed simulator build (ios:build:sim)"
  pnpm --filter @littlelight/mobile-web native:sync:ios >"$OUT/build-sync.log" 2>&1 || { tail -20 "$OUT/build-sync.log"; die "native:sync:ios failed"; }
  pnpm --filter @littlelight/mobile-web ios:build:sim >"$OUT/build.log" 2>&1 || { tail -30 "$OUT/build.log"; die "ios:build:sim failed (see $OUT/build.log)"; }
fi
APP="$(find "$APPDD" -name 'App.app' -path '*Debug-iphonesimulator*' -not -path '*Intermediates*' 2>/dev/null | head -1)"
[ -n "$APP" ] || die "App.app not found under $APPDD (run without IOS_GATE_SKIP_BUILD)"
PB=/usr/libexec/PlistBuddy
step "1a. the built app declares what album sync needs and nothing more"
v="$("$PB" -c 'Print :NSPhotoLibraryUsageDescription' "$APP/Info.plist" 2>/dev/null)"
grep -qi "album" <<<"$v" && pass "NSPhotoLibraryUsageDescription mentions the album sync" || fail "usage string does not mention album sync"
"$PB" -c 'Print :BGTaskSchedulerPermittedIdentifiers' "$APP/Info.plist" 2>/dev/null | grep -q 'com.tesarsoft.littlelight.sync' && pass "BGTaskSchedulerPermittedIdentifiers has the sync task" || fail "BGTaskSchedulerPermittedIdentifiers missing"
"$PB" -c 'Print :UIBackgroundModes' "$APP/Info.plist" 2>/dev/null | grep -q 'fetch' && pass "UIBackgroundModes has fetch" || fail "UIBackgroundModes missing fetch"
"$PB" -c 'Print :NSLocationWhenInUseUsageDescription' "$APP/Info.plist" >/dev/null 2>&1 && fail "the app declares a location permission" || pass "no location permission declared (GPS comes from the file)"

# ---- 2. simulator, runner, library --------------------------------------------------------------------
step "2. boot, install, grant the runner Photos access, seed the library"
[ "${IOS_GATE_RESTART_API:-1}" = "1" ] && bash .github/scripts/restart-api.sh >/dev/null 2>&1
helper prepare >"$OUT/prepare.log" 2>&1 || { cat "$OUT/prepare.log"; die "could not record the baseline"; }
# A clean library every run: Photos de-duplicates addmedia of a file it already holds, which would make
# "the newest 5 photos" ambiguous on a second run. This simulator is only used by the gates.
xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
xcrun simctl erase "$UDID" >/dev/null 2>&1 || die "could not erase the simulator"
# a fresh simulator connects the Mac keyboard, which leaves the on-screen one hidden and makes typeText fail
# (a running Simulator process caches the preference, so quit it first)
osascript -e 'tell application "Simulator" to quit' >/dev/null 2>&1 || true
pkill -x Simulator >/dev/null 2>&1 || true
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false >/dev/null 2>&1
xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
if ! xcodebuild -project "$UITEST/LLUITests.xcodeproj" -scheme LLUITests -destination "platform=iOS Simulator,id=$UDID" \
     -derivedDataPath "$UIDD" build-for-testing >"$OUT/uitest-build.log" 2>&1; then
  tail -20 "$OUT/uitest-build.log"; die "the XCUITest bundle did not build"
fi
RUNNER_APP="$(find "$UIDD/Build/Products" -maxdepth 2 -name 'LLUITests-Runner.app' | head -1)"
[ -n "$RUNNER_APP" ] || die "LLUITests-Runner.app not found under $UIDD"
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$APP" && pass "installed $BUNDLE_ID (fresh)" || fail "simctl install"
xcrun simctl install "$UDID" "$RUNNER_APP" >/dev/null 2>&1
xcrun simctl privacy "$UDID" reset photos "$BUNDLE_ID" >/dev/null 2>&1
xcrun simctl privacy "$UDID" grant photos "$RUNNER_ID" >/dev/null 2>&1 && pass "the UI-test runner may use PhotoKit" || fail "simctl privacy grant photos $RUNNER_ID"

# 1 GPS HEIC, 1 HEIC with a time zone offset, 1 plain HEIC, 2 JPEG
xcrun simctl addmedia "$UDID" \
  "$FX/heic/gps-640x480.heic" "$FX/heic/datetime-tz.heic" "$FX/heic/plain-640x480.heic" \
  "$FX/bakeoff-sample/sample-1-gradient.jpg" "$FX/bakeoff-sample/sample-2-blocks.jpg" >"$OUT/addmedia.log" 2>&1 \
  && pass "seeded the camera roll with 3 HEIC and 2 JPEG" || fail "simctl addmedia"
sleep 3
if uitest testCreateAlbum "LL_ALBUM=$ALBUM" "LL_ALBUM_COUNT=5" "LL_ALBUM_RESET=1"; then
  [ "$(cat "$OUT/album-count.txt" 2>/dev/null)" = "5" ] && pass "created the Photos album \"$ALBUM\" with 5 photos" || fail "the album does not hold 5 photos ($(cat "$OUT/album-count.txt" 2>/dev/null))"
else
  fail "could not create the Photos album (see uitest-testCreateAlbum.log)"
fi

# one album photo is already in Littlelight (another device uploaded it)
if helper upload "$FX/heic/plain-640x480.heic" image/heic >"$OUT/preupload.log" 2>&1; then pass "plain-640x480.heic is already in Maya's album (cross-device duplicate)"; else fail "pre-upload failed (see preupload.log)"; fi
SYNC_START="$(PSQL "select to_char(now() at time zone 'utc','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")"
M0="$(PSQL "select count(*) from import_sources where baby_id='$MAYA'")"
[ "$M0" = "0" ] && pass "no album sync exists yet for Maya" || fail "Maya already has $M0 sync row(s)"

# ---- 3. sign in; the permission prompt must not appear before the user asks ------------------------------
step "3. sign in as demo mom"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null 2>&1; sleep 6
uitest testSignOut >/dev/null 2>&1
if uitest testSignIn "LL_EMAIL=$DEMO_EMAIL" && uitest testExpectText "LL_EXPECT=Ask about"; then pass "OTP sign-in as demo mom"; else fail "UI sign-in failed (see uitest-testSignIn.log)"; fi
shot 01-signed-in
UID_MOM="$(PSQL "select id from auth.users where email='$DEMO_EMAIL'")"

# ---- 4. turn sync on: the Photos prompt appears HERE, not earlier ---------------------------------------------
step "4. Settings > Photo import > Set up > Allow Full Access > album > Start syncing"
if uitest testEnableSync "LL_ALBUM=$ALBUM" "LL_EXPECT=4 imported" "LL_TIMEOUT=150"; then pass "sync turned on; the card shows \"4 imported\""; else fail "could not turn sync on / no \"4 imported\" (see uitest-testEnableSync.log, 02-sync-on.png)"; fi
shot 02-sync-on
row="$(src_row)"
[ "$row" = "4|1|0|false|manual|" ] || [ "$row" = "4|1|0|f|manual|" ] && pass "import_sources: imported 4, duplicate 1, failed 0, not paused, trigger manual" || fail "import_sources row is \"$row\" (want 4|1|0|f|manual|)"

NEW="$(photo_count)"
[ "$NEW" = "4" ] && pass "4 new photos in Maya's album" || fail "$NEW new photos (want 4)"
OWN="$(PSQL "select count(*) from photos where baby_id='$MAYA' and created_at > '$SYNC_START' and uploaded_by='$UID_MOM' and approval='approved' and approved_by='$UID_MOM'")"
[ "$OWN" = "4" ] && pass "all 4 uploaded by mom, approved by mom (parents' own photos need no approval)" || fail "$OWN of 4 are mom's approved photos"
MIMES="$(PSQL "select string_agg(mime, ',' order by mime) from photos where baby_id='$MAYA' and created_at > '$SYNC_START'")"
[ "$MIMES" = "image/heic,image/heic,image/jpeg,image/jpeg" ] && pass "originals kept as they were: 2 HEIC and 2 JPEG" || fail "mimes are $MIMES"
wait_sql "select count(*) from photos where baby_id='$MAYA' and created_at > '$SYNC_START' and status <> 'uploaded'" 4 90 && pass "all 4 were ingested by the worker" || fail "ingest did not finish (${LAST_GOT:-?}/4)"

# EXIF: date + offset of the datetime-tz fixture, GPS of the gps fixture (encrypted), Home label rules
TZ_SIZE="$(stat -f%z "$FX/heic/datetime-tz.heic")"; GPS_SIZE="$(stat -f%z "$FX/heic/gps-640x480.heic")"
EXPECT="$(helper expected-exif "$FX/heic/datetime-tz.heic" 2>/dev/null)"
GOT="$(PSQL "select to_char(e.taken_at at time zone 'utc','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')||'|'||e.tz_offset_minutes from photo_exif e join photos p on p.id=e.photo_id where p.baby_id='$MAYA' and p.created_at > '$SYNC_START' and p.bytes=$TZ_SIZE")"
[ -n "$EXPECT" ] && [ "$GOT" = "$EXPECT" ] && pass "the EXIF capture date and UTC offset survived the sync ($GOT)" || fail "EXIF date/offset: got \"$GOT\", want \"$EXPECT\""
GPSROW="$(PSQL "select (e.gps_lat_enc is not null)::text||'|'||coalesce(e.place_label,'') from photo_exif e join photos p on p.id=e.photo_id where p.baby_id='$MAYA' and p.created_at > '$SYNC_START' and p.bytes=$GPS_SIZE")"
case "$GPSROW" in "true|"|"true|Home") pass "the GPS fixture kept its (encrypted) coordinates, no place name leaked ($GPSROW)";; *) fail "GPS fixture row is \"$GPSROW\"";; esac
IDS="$(PSQL "select id from photos where baby_id='$MAYA' and created_at > '$SYNC_START'" | tr '\n' ' ')"
# shellcheck disable=SC2086
helper derivatives-clean $IDS >"$OUT/derivatives.log" 2>&1 && pass "thumbnails and display images carry no EXIF or GPS" || fail "a derivative carries metadata ($(tail -1 "$OUT/derivatives.log"))"

# ---- 5. incremental ------------------------------------------------------------------------------------------------
step "5. a new photo in the album is picked up on return to the app"
xcrun simctl addmedia "$UDID" "$FX/bakeoff-sample/sample-3-stripes.jpg" >/dev/null 2>&1; sleep 2
uitest testCreateAlbum "LL_ALBUM=$ALBUM" "LL_ALBUM_COUNT=1" && pass "added the new photo to the album" || fail "could not add the new photo to the album"
# a resume within SYNC_MIN_INTERVAL_SEC (60 s) of the last run does nothing, by design
sleep 65
uitest testBackgroundResume
if wait_sql "select imported_count from import_sources where baby_id='$MAYA'" 5 75 && [ "$(photo_count)" = "5" ]; then pass "resume imported exactly one more (5 imported, 5 photos)"; else fail "incremental sync: imported_count ${LAST_GOT:-?}, photos $(photo_count)"; fi
shot 03-incremental

# ---- 6. removal never deletes ---------------------------------------------------------------------------------------------------
step "6. removing a photo from the album deletes nothing from Littlelight"
BEFORE="$(src_row)"
uitest testRemoveFromAlbum "LL_ALBUM=$ALBUM" "LL_ALBUM_REMOVE_COUNT=1" && pass "removed one photo from the Photos album" || fail "could not remove a photo from the album"
sleep 40
uitest testBackgroundResume
sleep 20
[ "$(photo_count)" = "5" ] && [ "$(src_row)" = "$BEFORE" ] && pass "photos and counters unchanged after removal" || fail "removal changed something: photos $(photo_count), row $(src_row) (was $BEFORE)"

# ---- 7. re-adding the same photo is not imported again ----------------------------------------------------------------------------------
step "7. the same photo added back is not imported twice"
uitest testCreateAlbum "LL_ALBUM=$ALBUM" "LL_ALBUM_COUNT=1" && pass "re-added the removed photo" || fail "could not re-add"
sleep 40
uitest testBackgroundResume
sleep 20
[ "$(photo_count)" = "5" ] && [ "$(src_row)" = "$BEFORE" ] && pass "no second photo row, counters unchanged (ledger hit)" || fail "re-add imported again: photos $(photo_count), row $(src_row) (was $BEFORE)"

# ---- 8. pause / resume -------------------------------------------------------------------------------------------------------------------
step "8. pause blocks sync; resume (and Sync now) imports what waited"
xcrun simctl addmedia "$UDID" "$FX/heic/portrait-480x640.heic" >/dev/null 2>&1; sleep 2
if uitest testTapText "LL_TAP=Pause" "LL_EXPECT=Paused"; then pass "Pause: the card says Paused"; else fail "Pause did not show Paused (see uitest-testTapText.log)"; fi
uitest testCreateAlbum "LL_ALBUM=$ALBUM" "LL_ALBUM_COUNT=1"
uitest testBackgroundResume
sleep 15
[ "$(photo_count)" = "5" ] && [ "$(PSQL "select paused from import_sources where baby_id='$MAYA'")" = "t" ] && pass "while paused nothing is imported" || fail "paused sync imported (photos $(photo_count))"
if uitest testTapText "LL_TAP=Resume" "LL_EXPECT=Up to date"; then pass "Resume: the card shows Up to date"; else fail "Resume did not show Up to date"; fi
uitest testTapText "LL_TAP=Sync now" >/dev/null 2>&1
if wait_sql "select imported_count from import_sources where baby_id='$MAYA'" 6 75 && [ "$(photo_count)" = "6" ]; then pass "after Resume: 6 imported, 6 photos"; else fail "after Resume: imported_count ${LAST_GOT:-?}, photos $(photo_count)"; fi
shot 04-resumed

# ---- 9. relaunch ---------------------------------------------------------------------------------------------------------------------------
step "9. relaunch keeps the setup"
relaunch
if uitest testOpenPhotoImport && uitest testExpectText "LL_EXPECT=Up to date"; then pass "relaunch: the card shows the album and Up to date"; else fail "relaunch: the card lost its setup (see 05-relaunch.png)"; fi
shot 05-relaunch
sleep 5
TRIG="$(PSQL "select last_trigger from import_sources where baby_id='$MAYA'")"
case "$TRIG" in launch|manual) pass "last_trigger is $TRIG after the relaunch (a run within 60 s of the last one is skipped)";; *) fail "unexpected last_trigger \"$TRIG\"";; esac

# ---- 10. sign out ------------------------------------------------------------------------------------------------------------------------------
step "10. sign-out pauses the row and wipes the ledger and the upload cache"
DATA="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data 2>/dev/null)"
[ -n "$(ls "$DATA/Library/Application Support/ll-sync/" 2>/dev/null)" ] && pass "before sign-out the ledger exists" || skip "ledger directory not found before sign-out (it is written after the first outcomes)"
relaunch
uitest testSignOut && pass "signed out through the UI" || fail "sign-out failed"
sleep 3
row="$(src_row)"
case "$row" in *"|t|"*"|signed_out"|*"|true|"*"|signed_out") pass "import_sources: paused, last_error signed_out ($row)";; *) fail "after sign-out the row is \"$row\"";; esac
if ls "$DATA/Library/Application Support/ll-sync/"*.json >/dev/null 2>&1; then fail "the ledger survived sign-out"; else pass "no ledger file after sign-out"; fi
[ -z "$(ls -A "$DATA/Library/Caches/ll-uploads" 2>/dev/null)" ] && pass "Caches/ll-uploads is empty" || fail "files left in Caches/ll-uploads"
shot 06-signed-out

# ---- 11. logs ------------------------------------------------------------------------------------------------------------------------------------------
step "11. log scan (app process, api, worker)"
xcrun simctl spawn "$UDID" log show --last 40m --predicate 'process == "App"' >"$OUT/app-log.txt" 2>/dev/null || true
[ -s "$OUT/app-log.txt" ] && pass "app log captured ($(wc -l <"$OUT/app-log.txt" | tr -d ' ') lines)" || fail "empty app log (the scan would be vacuous)"
if grep -Eq 'll-uploads/|X-Amz-Signature|eyJ[A-Za-z0-9_-]{10,}|-?[0-9]{1,3}\.[0-9]{3,},\s*-?[0-9]{1,3}\.[0-9]{3,}|/var/mobile/Media' "$OUT/app-log.txt"; then
  fail "the app log has an upload path, signature, JWT, coordinate pair or library path"
else
  pass "the app log has no upload path, signature, JWT, coordinate pair or library path"
fi
grep -Eq 'ASSET|PHAsset|localIdentifier|IMG_[0-9]+|\.HEIC' "$OUT/app-log.txt" && fail "the app log names a PhotoKit asset or file" || pass "the app log names no PhotoKit asset or file"
docker compose -f docker-compose.dev.yml logs --no-color --since 40m api worker >"$OUT/server-log.txt" 2>/dev/null
if grep -Eq 'X-Amz-Signature|eyJ[A-Za-z0-9_-]{10,}|@littlelight\.local|-?[0-9]{1,3}\.[0-9]{4,}\s*,\s*-?[0-9]{1,3}\.[0-9]{4,}|47\.6062|ll-uploads' "$OUT/server-log.txt"; then
  fail "api/worker logs contain a signature, JWT, address, coordinate or upload path"
else
  pass "api/worker logs: no signature, JWT, address, coordinate or upload path"
fi

printf '\nautomated: %s passed, %s failed, %s skipped. Screenshots and logs: %s\n' "$PASS" "$FAIL" "$SKIP" "$OUT"

cat <<'CHECKLIST'

MANUAL CHECKLIST (docs/plans/step-10.md 4.4; a shell cannot do these)
  [ ] Background refresh: run the app under Xcode, pause, then in the debugger:
        e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"com.tesarsoft.littlelight.sync"]
      and resume: one batch imports and import_sources.last_trigger becomes 'background'.
  [ ] Wi-Fi only on a real phone: with Wi-Fi off and cellular on, the card says "Waiting for Wi-Fi"
      and nothing uploads; back on Wi-Fi it syncs (the simulator cannot fake cellular).
  [ ] iCloud originals: an album photo that is only in iCloud ("Optimize iPhone Storage") is
      downloaded and imported, not skipped (needs a real library).
  [ ] Limited access: choosing "Limit Access" in the Photos prompt shows the explanation and "I've changed it".
CHECKLIST

[ "$FAIL" = "0" ]
