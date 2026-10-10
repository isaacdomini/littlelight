#!/usr/bin/env bash
# iOS native gate (docs/plans/step-9.md 2.15 "iOS gate", 4.5). Semi-automated: it drives the real
# app on ONE simulator (iPhone 17, iOS 26.4 runtime; it never downloads a runtime) and prints the
# manual checklist at the end for the orchestrator to tick.
#
#   docker compose -f docker-compose.dev.yml up -d --wait     # dev stack, fake AI
#   export PATH="$HOME/.cache/littlelight-pnpm/bin:$PATH"
#   pnpm e2e:native-ios
#
# Environment (all optional):
#   IOS_GATE_SKIP_BUILD=1     reuse apps/mobile-web/ios/DerivedData (skip sync + xcodebuild)
#   IOS_GATE_KEEP_BOOTED=1    do not shut the simulator down at the end
#   IOS_GATE_RESTART_API=0    do not restart the api first (it resets the in-memory sign-in throttle)
#   IOS_GATE_SIM_NAME / IOS_GATE_RUNTIME   defaults "iPhone 17" / com.apple.CoreSimulator.SimRuntime.iOS-26-4
#
# What is automated:
#   1. Static checks of the built .app: plutil -lint, PlistBuddy keys (usage strings, encryption
#      flag, ATS, URL scheme), PrivacyInfo.xcprivacy, entitlements (aps-environment, associated
#      domains; simulator builds carry them in the __TEXT,__entitlements section, not the signature).
#   2. Boot, install, launch; screenshots in e2e/native-results/ios/.
#   3. Deep links (`simctl openurl littlelight://...`): /s/<demo token> and /invite/<fresh token>.
#   4. Real UI sign-in as demo mom (OTP from Mailpit), relaunch still signed in.
#   5. Notification permission prompt + Settings -> Notifications flow, a push device row for the
#      signed-in user, `simctl push` of a photos_analyzed payload and a banner tap that must land on
#      Chat. simctl cannot grant notification permission or tap anything, and there is no
#      Simulator.app, so these use the XCUITest bundle in e2e/native/ios-uitest (it drives the app
#      and SpringBoard by bundle id; see the header of LLUITests.swift).
#   6. Log scan of the app's process for tokens, signed URLs and GPS.
# Exit 1 when an automated check fails (FAIL lines); the manual checklist is always printed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2
OUT="$ROOT/e2e/native-results/ios"
UITEST="$ROOT/e2e/native/ios-uitest"
UIDD="$ROOT/e2e/native-results/ios-uitest-dd"
BUNDLE_ID="com.tesarsoft.littlelight"
SIM_NAME="${IOS_GATE_SIM_NAME:-iPhone 17}"
RUNTIME="${IOS_GATE_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-4}"
SHARE_TOKEN="demo-grandparents-share-token"
MAILPIT="http://localhost:${MAILPIT_PORT:-8025}"
BASE="http://localhost:${WEB_PORT:-8080}"
DEMO_EMAIL="demo-mom@littlelight.local"
mkdir -p "${OUT:?}"
find "${OUT:?}" -maxdepth 1 -type f \( -name '*.png' -o -name '*.log' -o -name '*.txt' -o -name '*.xml' \) -delete

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
skip() { SKIP=$((SKIP+1)); printf 'SKIP  %s\n' "$*"; }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
step() { printf '\n==> %s\n' "$*"; }
die() { printf 'IOS GATE ERROR: %s\n' "$*" >&2; exit 2; }

command -v xcrun >/dev/null || die "xcrun not found: this gate needs macOS with Xcode"
command -v xcodebuild >/dev/null || die "xcodebuild not found"
curl -fsS -o /dev/null "$BASE/api/healthz" || die "dev stack is not reachable at $BASE (docker compose -f docker-compose.dev.yml up -d --wait)"

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
SIM_LIST="$(xcrun simctl list devices)"
grep "$UDID" <<<"$SIM_LIST" | grep -q Booted && SIM_WAS_BOOTED=1

cleanup() {
  if [ "${IOS_GATE_KEEP_BOOTED:-0}" != "1" ] && [ "$SIM_WAS_BOOTED" = "0" ]; then
    xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
    echo "simulator shut down"
  fi
}
trap cleanup EXIT

shot() { xcrun simctl io "$UDID" screenshot "$OUT/$1.png" >/dev/null 2>&1 || true; }

# run one XCUITest: uitest <TestName> [VAR=value ...]; log in $OUT/uitest-<name>.log.
# xcodebuild occasionally lingers after the test finished, so the result is read from the log and a
# watchdog kills it after UITEST_TIMEOUT seconds (default 150; a test's own waits are shorter).
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
    [ "$waited" -gt "${UITEST_TIMEOUT:-150}" ] && break
    sleep 1
  done
  kill "$xpid" 2>/dev/null; wait "$xpid" 2>/dev/null
  grep -q "^Test Suite 'Selected tests' passed" "$log"
}
relaunch() { xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true; xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null; sleep 5; }

# ---- 1. build and static checks ----------------------------------------------------------------
if [ "${IOS_GATE_SKIP_BUILD:-0}" != "1" ]; then
  step "1. sync + ad-hoc signed simulator build (ios:build:sim)"
  pnpm --filter @littlelight/mobile-web native:sync:ios >"$OUT/build-sync.log" 2>&1 || { tail -20 "$OUT/build-sync.log"; die "native:sync:ios failed"; }
  pnpm --filter @littlelight/mobile-web ios:build:sim >"$OUT/build.log" 2>&1 || { tail -30 "$OUT/build.log"; die "ios:build:sim failed (see $OUT/build.log)"; }
fi
APP="$(find "$ROOT/apps/mobile-web/ios/DerivedData" -name 'App.app' -path '*Debug-iphonesimulator*' -not -path '*Intermediates*' 2>/dev/null | head -1)"
[ -n "$APP" ] || die "App.app not found under apps/mobile-web/ios/DerivedData (run without IOS_GATE_SKIP_BUILD)"

step "1a. Info.plist, PrivacyInfo.xcprivacy, entitlements"
PB=/usr/libexec/PlistBuddy
check "plutil -lint Info.plist" plutil -lint "$APP/Info.plist"
check "plutil -lint PrivacyInfo.xcprivacy (source)" plutil -lint apps/mobile-web/ios/App/App/PrivacyInfo.xcprivacy
check "PrivacyInfo.xcprivacy is in the built app" test -f "$APP/PrivacyInfo.xcprivacy"
[ "$("$PB" -c 'Print :ITSAppUsesNonExemptEncryption' "$APP/Info.plist" 2>/dev/null)" = "false" ] && pass "ITSAppUsesNonExemptEncryption = false" || fail "ITSAppUsesNonExemptEncryption is not false"
[ "$("$PB" -c 'Print :CFBundleIdentifier' "$APP/Info.plist" 2>/dev/null)" = "$BUNDLE_ID" ] && pass "bundle id $BUNDLE_ID" || fail "bundle id is not $BUNDLE_ID"
for k in NSPhotoLibraryUsageDescription NSPhotoLibraryAddUsageDescription NSCameraUsageDescription; do
  v="$("$PB" -c "Print :$k" "$APP/Info.plist" 2>/dev/null)"
  [ "${#v}" -ge 20 ] && pass "$k is set" || fail "$k missing or too short"
done
for k in NSLocationWhenInUseUsageDescription NSLocationAlwaysUsageDescription NSMicrophoneUsageDescription NSContactsUsageDescription NSUserTrackingUsageDescription; do
  "$PB" -c "Print :$k" "$APP/Info.plist" >/dev/null 2>&1 && fail "$k is declared (the app must not ask for it)" || pass "$k is not declared"
done
"$PB" -c 'Print :NSAppTransportSecurity:NSAllowsArbitraryLoads' "$APP/Info.plist" 2>/dev/null | grep -qi true && fail "ATS allows arbitrary loads" || pass "ATS: no arbitrary loads"
# The Debug product is built from App/Info-Debug.plist (debug.xcconfig); Release from App/Info.plist
# (release.xcconfig), which has neither key (review-fixes D17). The built Debug bundle names its
# plist Info.plist whichever source it came from, so the reads above and below stay on $APP.
"$PB" -c 'Print :CFBundleURLTypes' "$APP/Info.plist" 2>/dev/null | grep -q "littlelight" && pass "debug URL scheme littlelight:// registered (Debug build)" || fail "no littlelight:// URL scheme in the Debug build"
"$PB" -c 'Print :NSAppTransportSecurity:NSAllowsLocalNetworking' "$APP/Info.plist" 2>/dev/null | grep -qi true && pass "ATS: local networking allowed (Debug build)" || fail "ATS NSAllowsLocalNetworking missing from the Debug build"
SRC=apps/mobile-web/ios/App/App
check "plutil -lint Info-Debug.plist (source)" plutil -lint "$SRC/Info-Debug.plist"
check "plutil -lint Info.plist (source, Release)" plutil -lint "$SRC/Info.plist"
for k in CFBundleURLTypes NSAppTransportSecurity; do
  "$PB" -c "Print :$k" "$SRC/Info.plist" >/dev/null 2>&1 && fail "release Info.plist declares $k (debug-only)" || pass "release Info.plist has no $k"
  "$PB" -c "Print :$k" "$SRC/Info-Debug.plist" >/dev/null 2>&1 && pass "Info-Debug.plist declares $k" || fail "Info-Debug.plist is missing $k"
done
grep -q 'App/Info-Debug.plist' apps/mobile-web/ios/debug.xcconfig && pass "debug.xcconfig points at Info-Debug.plist" || fail "debug.xcconfig does not use Info-Debug.plist"
grep -q 'App/Info.plist' apps/mobile-web/ios/release.xcconfig && ! grep -q 'Info-Debug' apps/mobile-web/ios/release.xcconfig && pass "release.xcconfig points at Info.plist" || fail "release.xcconfig does not use Info.plist"
check "pnpm check:ios-plists (Info-Debug.plist = Info.plist + the two debug keys)" pnpm --filter @littlelight/mobile-web check:ios-plists
"$PB" -c 'Print :NSPrivacyTracking' "$APP/PrivacyInfo.xcprivacy" 2>/dev/null | grep -qi false && pass "PrivacyInfo: NSPrivacyTracking = false" || fail "PrivacyInfo: NSPrivacyTracking is not false"
ENT="$(otool -arch x86_64 -s __TEXT __entitlements "$APP/App" 2>/dev/null | awk 'NR>2{$1="";print}' | tr -d ' \n' | xxd -r -p 2>/dev/null)"
printf '%s' "$ENT" > "$OUT/entitlements.xml"
{ grep -q '<key>aps-environment</key>' <<<"$ENT" && grep -q '<string>development</string>' <<<"$ENT"; } && pass "entitlement aps-environment = development" || fail "entitlement aps-environment missing (is the build ad-hoc signed with entitlements?)"
grep -q 'applinks:littlelight.tesarsoft.com' <<<"$ENT" && pass "entitlement associated domain applinks:littlelight.tesarsoft.com" || fail "associated domain entitlement missing"
CS="$(codesign -dv "$APP" 2>&1)"
grep -q 'Signature=adhoc' <<<"$CS" && pass "ad-hoc signature (background URLSession needs one)" || fail "app is not ad-hoc signed"

# ---- 2. boot, install, launch -----------------------------------------------------------------
step "2. boot, install, launch"
[ "${IOS_GATE_RESTART_API:-1}" = "1" ] && bash .github/scripts/restart-api.sh >/dev/null 2>&1
pkill -x Simulator >/dev/null 2>&1 || true
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false >/dev/null 2>&1
xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
if ! xcodebuild -project "$UITEST/LLUITests.xcodeproj" -scheme LLUITests -destination "platform=iOS Simulator,id=$UDID" \
     -derivedDataPath "$UIDD" build-for-testing >"$OUT/uitest-build.log" 2>&1; then
  tail -20 "$OUT/uitest-build.log"; die "the XCUITest bundle did not build"
fi
xcrun simctl install "$UDID" "$APP" && pass "installed $BUNDLE_ID" || fail "simctl install"
PID="$(xcrun simctl launch "$UDID" "$BUNDLE_ID" 2>/dev/null | awk -F': ' '{print $2}')"
sleep 6
{ [ -n "$PID" ] && xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -q "$BUNDLE_ID"; } && pass "launched (pid $PID)" || fail "app did not launch"
shot 01-launch

# ---- 3. signed out + deep links ----------------------------------------------------------------
step "3. deep links (signed out; the app may still be signed in from a previous run, so sign out first)"
uitest testSignOut && pass "signed out (via the UI; the app wipes stale Keychain items on a fresh install, covered in step 4)" || fail "could not reach the signed-out state (see uitest-testSignOut.log)"
shot 02-signed-out

xcrun simctl openurl "$UDID" "littlelight://s/$SHARE_TOKEN"
if uitest testExpectText "LL_EXPECT=s album"; then pass "littlelight://s/<token> opens the shared album"; else fail "littlelight://s/<token> did not show the shared album (title \"<name>'s album\"); see 03-share-link.png"; fi
shot 03-share-link
# "Done" leaves the shared album for the app's own start page and must not bounce back into it.
if uitest testShareDone; then pass "share viewer: Done lands on the start page without bouncing back"; else fail "share viewer: Done did not stay on the start page (see uitest-testShareDone.log)"; fi
shot 03b-share-done

relaunch
INVITE_TOKEN="$(pnpm --silent exec tsx e2e/native/invite-link.ts 2>"$OUT/invite.err")"
if [ "${#INVITE_TOKEN}" = "43" ]; then
  xcrun simctl openurl "$UDID" "littlelight://invite/$INVITE_TOKEN"
  if uitest testExpectText "LL_EXPECT=invited to an album"; then pass "littlelight://invite/<token> opens the invite sign-in page"; else fail "littlelight://invite/<token> did not show the invite page; see 04-invite-link.png"; fi
  shot 04-invite-link
else
  fail "could not create an invite token (see $OUT/invite.err)"
fi
relaunch

# ---- 4. sign in, relaunch ----------------------------------------------------------------------
step "4. OTP sign-in through the real UI, relaunch"
if uitest testSignIn "LL_EMAIL=$DEMO_EMAIL" && uitest testExpectText "LL_EXPECT=Ask about"; then pass "OTP sign-in as demo mom lands on Chat"; else fail "UI sign-in failed (see uitest-testSignIn.log)"; fi
shot 05-signed-in
relaunch
if uitest testExpectText "LL_EXPECT=Ask about"; then pass "relaunch: still signed in (Keychain)"; else fail "relaunch: not signed in"; fi
shot 06-relaunched
# A fresh install must not inherit the previous install's Keychain session (iOS keeps Keychain items
# across uninstall; the app wipes them on first launch of a new install, flag ll.installed.v1).
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1
xcrun simctl install "$UDID" "$APP" >/dev/null 2>&1
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null 2>&1
sleep 5
if uitest testExpectText "LL_EXPECT=Welcome to Littlelight"; then pass "uninstall + reinstall: back at the Welcome step (no session survived)"; else fail "uninstall + reinstall: still signed in (Keychain survived the uninstall)"; fi
shot 06b-reinstalled
# sign in again for the notification steps
if uitest testSignIn "LL_EMAIL=$DEMO_EMAIL" && uitest testExpectText "LL_EXPECT=Ask about"; then pass "signed in again after the reinstall"; else fail "sign-in after reinstall failed (see uitest-testSignIn.log)"; fi

# ---- 5. notifications -----------------------------------------------------------------------------
step "5. notification permission, device registration, push + banner tap"
PSQL() { docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d littlelight -Atc "$1"; }
UID_MOM="$(PSQL "select id from auth.users where email='$DEMO_EMAIL'")"
ENABLED=0
if uitest testEnablePush; then
  pass "Settings > Notifications > Turn on > system prompt > Allow"
  ENABLED=1
else
  fail "could not turn notifications on in the app (see uitest-testEnablePush.log and 07-notifications.png)"
fi
shot 07-notifications
if [ "$ENABLED" = "1" ]; then
  sleep 3
  DEV_AFTER="$(PSQL "select count(*) from push_devices where user_id='$UID_MOM' and provider='apns' and disabled_at is null")"
  [ "$DEV_AFTER" -ge 1 ] && pass "an enabled APNs device row exists for the signed-in user" || fail "no push device row after enabling"
fi
cat > "$OUT/payload.apns" <<JSON
{"aps":{"alert":{"title":"Littlelight","body":"3 new photos are ready to search."},"sound":"default"},
 "ll":{"kind":"photos_analyzed","babyId":"00000000-0000-4000-8000-000000000100"}}
JSON
if [ "$ENABLED" = "1" ]; then
  uitest testTapBanner "LL_BANNER=ready to search" &
  TAP_PID=$!
  sleep 15
  xcrun simctl push "$UDID" "$BUNDLE_ID" "$OUT/payload.apns" >"$OUT/simctl-push.log" 2>&1 && pass "simctl push delivered a photos_analyzed payload" || fail "simctl push failed"
  if wait "$TAP_PID"; then
    pass "banner tapped"
    uitest testExpectText "LL_EXPECT=Ask about" && pass "banner tap opened the app on Chat" || fail "banner tap did not land on Chat"
  else
    fail "banner not shown / not tapped (see uitest-testTapBanner.log)"
  fi
  shot 08-after-banner
else
  xcrun simctl push "$UDID" "$BUNDLE_ID" "$OUT/payload.apns" >"$OUT/simctl-push.log" 2>&1 && pass "simctl push accepted the payload (nothing is shown without permission)" || fail "simctl push failed"
  skip "banner tap: needs notification permission (previous step failed)"
fi

# ---- 6. logs ------------------------------------------------------------------------------------------
step "6. log scan (process App)"
xcrun simctl spawn "$UDID" log show --last 30m --predicate 'process == "App"' >"$OUT/app-log.txt" 2>/dev/null || true
[ -s "$OUT/app-log.txt" ] && pass "app log captured ($(wc -l <"$OUT/app-log.txt" | tr -d ' ') lines)" || fail "empty app log (scan would be vacuous)"
# the UI-test automation logs the accessibility tree (labels only); secrets must still be absent
i=0
for pat in "eyJ[A-Za-z0-9_-]{10,}" "X-Amz-Signature" "token_hash" "$SHARE_TOKEN" "${INVITE_TOKEN:-__none__}" "latitude" "GPSLatitude"; do
  i=$((i+1))
  case $i in 1) label="a JWT (eyJ...)";; 2) label="X-Amz-Signature";; 3) label="token_hash";; 4) label="the demo share token";; 5) label="the invite token";; 6) label="latitude";; *) label="GPSLatitude";; esac
  if grep -Eq -- "$pat" "$OUT/app-log.txt"; then fail "app log contains $label"; else pass "app log does not contain $label"; fi
done
LEAKS="$(docker compose -f docker-compose.dev.yml logs --no-color --since 30m api worker 2>/dev/null | grep -Ec 'X-Amz-Signature|eyJ[A-Za-z0-9_-]{20,}' || true)"
[ "$LEAKS" = "0" ] && pass "api/worker logs: no JWT or signed URL" || fail "api/worker logs contain $LEAKS JWT/signed-URL line(s)"

# ---- 7. leave the app signed out ---------------------------------------------------------------------------
step "7. sign out again (also proves sign-out works)"
relaunch
uitest testSignOut && pass "signed out at the end" || fail "final sign-out failed"
if [ "$ENABLED" = "1" ]; then
  [ "$(PSQL "select count(*) from push_devices where user_id='$UID_MOM' and disabled_at is null")" = "0" ] && pass "sign-out removed the push device row" || fail "push device row survived sign-out"
fi
shot 09-end

printf '\nautomated: %s passed, %s failed, %s skipped. Screenshots and logs: %s\n' "$PASS" "$FAIL" "$SKIP" "$OUT"

cat <<'CHECKLIST'

MANUAL CHECKLIST (docs/plans/step-9.md 4.5; tick each on the simulator or a device)
  [ ] OTP sign-in: the code field offers the one-time-code autofill.
  [ ] Relaunch while signed in: still signed in (automated above; confirm no flash of the welcome page).
  [ ] Pick 3 photos in the system picker, press Home while they upload: uploads finish in the
      background and the app shows "3 uploaded" when reopened.
  [ ] Push tap routing: a photos_analyzed notification opens Chat; a share_viewed one opens Family.
  [ ] Share sheet: Family > share link > system share sheet opens with the link.
  [ ] Download > Save Image: the system prompt shows the NSPhotoLibraryAddUsageDescription text.
  [ ] Settings > Account > Delete account is reachable.
  [ ] Dark mode and safe areas (notch, home indicator) look right on every screen.
CHECKLIST

[ "$FAIL" = "0" ]
