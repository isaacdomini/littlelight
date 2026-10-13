#!/bin/bash
# App Store screenshots (6.9", 1320x2868) from the real app on the iOS Simulator.
#
#   export PATH="$HOME/.cache/littlelight-pnpm/bin:$PATH"
#   docker compose -f docker-compose.dev.yml up -d --wait      # dev stack with the demo family
#   apps/mobile-web/scripts/store-screenshots-ios.sh           # or: pnpm --filter @tinyglow/mobile-web store:screenshots:ios
#
# Env: IOS_SHOT_SIM_NAME (default "iPhone 17 Pro Max"), IOS_SHOT_RUNTIME (default iOS 26.4),
#      IOS_SHOT_SKIP_BUILD=1 (reuse ios/DerivedData). Never downloads a runtime.
# Builds the app ad-hoc signed, installs it, signs in as demo-mom through the real UI (code read
# from Mailpit), drives the tabs with the XCUITest bundle in e2e/native/ios-uitest and captures with
# `simctl io screenshot`. Light mode, clean status bar (9:41, full battery). Shuts the simulator
# down and deletes DerivedData at the end.
set -uo pipefail

MOBILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$MOBILE/../.." && pwd)"
cd "$ROOT" || exit 2
OUT="$MOBILE/fastlane/screenshots/en-US"
RAW="$MOBILE/store/captioned/ios"
WORK="$(mktemp -d /tmp/tinyglow-ios-shots.XXXXXX)"
UITEST="$ROOT/e2e/native/ios-uitest"
UIDD="$WORK/uitest-dd"
APP="$MOBILE/ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app"
BUNDLE_ID="app.tinyglow"
SIM_NAME="${IOS_SHOT_SIM_NAME:-iPhone 17 Pro Max}"
RUNTIME="${IOS_SHOT_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-4}"
MAILPIT="http://localhost:${MAILPIT_PORT:-8025}"
die() { echo "store-screenshots-ios: $*" >&2; exit 1; }

curl -fsS -o /dev/null "http://localhost:${WEB_PORT:-8080}/api/healthz" || die "dev stack not reachable"
FREE_KB=$(df -k / | awk 'NR==2{print $4}'); [ "$FREE_KB" -gt 8000000 ] || die "less than 8 GB free"

UDID="$(xcrun simctl list devices -j | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8")).devices[process.argv[1]] ?? [];
  const m = d.find((x) => x.name === process.argv[2] && x.isAvailable);
  if (m) console.log(m.udid);' "$RUNTIME" "$SIM_NAME")"
[ -n "$UDID" ] || die "no available '$SIM_NAME' on $RUNTIME (nothing is downloaded)"

cleanup() {
  xcrun simctl status_bar "$UDID" clear >/dev/null 2>&1
  xcrun simctl shutdown "$UDID" >/dev/null 2>&1
  rm -rf "$MOBILE/ios/DerivedData" "$WORK"
}
trap cleanup EXIT

pnpm exec tsx "$MOBILE/scripts/store-prep.ts" || die "demo prep failed"

if [ "${IOS_SHOT_SKIP_BUILD:-}" != 1 ]; then
  pnpm --filter @tinyglow/mobile-web native:sync:ios >"$WORK/sync.log" 2>&1 || die "native:sync:ios failed ($WORK/sync.log)"
  pnpm --filter @tinyglow/mobile-web ios:build:sim >"$WORK/build.log" 2>&1 || { tail -20 "$WORK/build.log"; die "ios:build:sim failed"; }
fi
xcodebuild -project "$UITEST/LLUITests.xcodeproj" -scheme LLUITests -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$UIDD" build-for-testing >"$WORK/uitest-build.log" 2>&1 || die "UI test bundle did not build"

xcrun simctl boot "$UDID" >/dev/null 2>&1
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
xcrun simctl ui "$UDID" appearance light
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1
xcrun simctl install "$UDID" "$APP" || die "install failed"

# ut <TestName> [VAR=value ...]
ut() {
  local name=$1; shift
  local envs=(); for kv in "$@"; do envs+=("TEST_RUNNER_${kv}"); done
  env ${envs[@]+"${envs[@]}"} TEST_RUNNER_LL_OUT="$WORK" TEST_RUNNER_LL_MAILPIT="$MAILPIT" \
    xcodebuild -project "$UITEST/LLUITests.xcodeproj" -scheme LLUITests \
      -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$UIDD" \
      test-without-building -only-testing:"LLUITests/LLUITests/$name" >"$WORK/$name.log" 2>&1
  grep -q "^Test Suite 'Selected tests' passed" "$WORK/$name.log" || { echo "  UI step failed: $name $*" >&2; [ -n "${IOS_SHOT_DEBUG_DIR:-}" ] && xcrun simctl io "$UDID" screenshot "$IOS_SHOT_DEBUG_DIR/fail-$name.png" >/dev/null 2>&1; grep -E "error|XCTAssert" "$WORK/$name.log" | head -5 >&2; return 1; }
}
tab() { ut testTapText "LL_TAP=$1" || exit 1; sleep "${2:-4}"; }
relaunch() { xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1; xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null; sleep 5; }
shot() { # file
  sleep 1
  xcrun simctl io "$UDID" screenshot "$OUT/$1" >/dev/null 2>&1 || die "screenshot $1"
  echo "  fastlane/screenshots/en-US/$1"
}

rm -rf "$OUT" "$RAW"; mkdir -p "$OUT" "$RAW"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null; sleep 4
ut testSignOut || die "could not reach the signed-out state"
ut testSignIn "LL_EMAIL=demo-mom@tinyglow.local" || die "demo-mom sign-in failed"
relaunch

tab Timeline 5;                                  shot 01-timeline.png
# the filter chips and the demo video tile push the first-steps tile to the fold: scroll it into view
ut testDragUp "LL_FROM=0.80" "LL_TO=0.68" || true; sleep 2
# a taller screen scrolls further on the same drag: if the tile is above, drag back down and retry
for _ in 1 2 3; do
  ut testTapText "LL_TAP=toward Dad" && break
  ut testDragUp "LL_FROM=0.45" "LL_TO=0.65" || true; sleep 2
done
[ -f "$WORK/testTapText.log" ] && grep -q "^Test Suite 'Selected tests' passed" "$WORK/testTapText.log" || exit 1
sleep 4
shot 02-viewer.png
relaunch
tab Milestones 5;                                shot 03-milestones.png
tab Family 5;                                    shot 04-family.png
tab Upload 4;                                    shot 05-upload.png
tab Chat 4
# the real model words its answer differently each time: wait on the question bubble, then give the answer and photo time to render
ut testAsk "LL_ASK=Show me her first steps" "LL_EXPECT=Show me her first steps" || exit 1; sleep 20; shot 06-chat.png
tab Milestones 4; tab Growth 4;                  shot 07-growth.png
ut testOpenPhotoImport || exit 1; sleep 3;       shot 08-album-sync.png

# framed copies with a caption (store/captioned/ios); the raw files stay in fastlane/screenshots
pnpm exec tsx "$MOBILE/scripts/store-caption.ts" "$OUT" "$RAW" 1320 2868
