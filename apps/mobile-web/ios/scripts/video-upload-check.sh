#!/usr/bin/env bash
# Live check for step 12 task 12.9 (docs/plans/step-12.md 2.9, 3 "12.9 Native", 4.5):
# "the iOS simulator uploads a ~60 MB MOV in 4 ranged background parts, the part copies are
# deleted, and the upload survives backgrounding".
#
# Do NOT run against the dev stack until the api registers videos (backend 12.4) and the
# orchestrator asks for it. Nothing here touches the stack except the final `verify` curl.
#
#   sh apps/mobile-web/ios/scripts/video-upload-check.sh clip      # make the test clip (ffmpeg, ~30 s)
#   sh apps/mobile-web/ios/scripts/video-upload-check.sh prepare   # boot sim, install the built app, add the clip
#   ... pick the clip in the app and background it (manual or XCUITest, see NATIVE.md) ...
#   sh apps/mobile-web/ios/scripts/video-upload-check.sh verify    # parts dir empty, no signed URLs in logs
#   sh apps/mobile-web/ios/scripts/video-upload-check.sh clean     # shut the simulator down, remove the clip
#
# Environment: IOS_GATE_SIM_NAME (iPhone 17), IOS_GATE_RUNTIME (com.apple.CoreSimulator.SimRuntime.iOS-26-4),
# LL_CLIP_DIR (${TMPDIR:-/tmp}/tinyglow-video-check), LL_APP (ios/DerivedData/.../App.app),
# LL_SESSION + LL_FILE + LL_TOKEN (optional: verify also asks the api for uploadedPartNumbers),
# LL_API (http://localhost:8080).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
MW="$ROOT/apps/mobile-web"
BUNDLE_ID="app.tinyglow"
SIM_NAME="${IOS_GATE_SIM_NAME:-iPhone 17}"
RUNTIME="${IOS_GATE_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-4}"
CLIP_DIR="${LL_CLIP_DIR:-${TMPDIR:-/tmp}/tinyglow-video-check}"
CLIP="$CLIP_DIR/clip-60mb.mov"
APP="${LL_APP:-$MW/ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app}"
API="${LL_API:-http://localhost:8080}"
MIB=$((1024 * 1024))
# 4 parts of 16 MiB: the clip must be > 48 MiB and <= 64 MiB (partCount = ceil(bytes / 16 MiB)).
MIN_BYTES=$((48 * MIB + 1)); MAX_BYTES=$((64 * MIB))

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
die() { printf 'VIDEO CHECK ERROR: %s\n' "$*" >&2; exit 2; }

udid() {
  xcrun simctl list devices -j | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s).devices[process.argv[1]]||[];
  const d=j.find(x=>x.name===process.argv[2]&&x.isAvailable);
  process.stdout.write(d?d.udid:"");
})' "$RUNTIME" "$SIM_NAME"
}

make_clip() {
  command -v ffmpeg >/dev/null || die "ffmpeg not found (brew install ffmpeg)"
  mkdir -p "$CLIP_DIR"
  rm -f "$CLIP"
  # 40 s (under the free plan's 60 s), 1080p30 HEVC (hvc1, what an iPhone shoots) + AAC tone.
  # Synthetic test pattern: no real child, no speech. videotoolbox on Apple silicon, libx265 elsewhere.
  local enc="hevc_videotoolbox"
  ffmpeg -hide_banner -loglevel error -encoders 2>/dev/null | grep -q hevc_videotoolbox || enc="libx265"
  # Encoders undershoot the target on synthetic content, so aim at 56 MiB and rescale the bitrate
  # from the measured size (up to three passes).
  local target=$((56 * MIB)) kbps=11000 bytes=0 attempt
  for attempt in 1 2 3; do
    ffmpeg -hide_banner -loglevel error -y \
      -f lavfi -i "testsrc2=size=1920x1080:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
      -t 40 -c:v "$enc" -b:v "${kbps}k" -maxrate "${kbps}k" -bufsize "$((kbps * 2))k" -tag:v hvc1 -pix_fmt yuv420p \
      -c:a aac -b:a 128k -movflags +faststart -metadata creation_time="2026-03-14T10:15:00Z" \
      "$CLIP" || die "ffmpeg failed"
    bytes=$(stat -f %z "$CLIP")
    if [ "$bytes" -ge "$MIN_BYTES" ] && [ "$bytes" -le "$MAX_BYTES" ]; then break; fi
    kbps=$((kbps * target / bytes))
  done
  printf 'clip: %s (%d bytes, %d MiB, encoder %s, %d pass(es))\n' "$CLIP" "$bytes" "$((bytes / MIB))" "$enc" "$attempt"
  if [ "$bytes" -ge "$MIN_BYTES" ] && [ "$bytes" -le "$MAX_BYTES" ]; then
    pass "clip is 48 MiB < size <= 64 MiB (4 parts of 16 MiB)"
  else
    fail "clip size $bytes is outside (48 MiB, 64 MiB] after 3 passes"
  fi
  ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height:format=duration -of default=nw=1 "$CLIP"
}

prepare() {
  [ -f "$CLIP" ] || die "no clip; run: $0 clip"
  [ -d "$APP" ] || die "no built app at $APP (pnpm --filter @tinyglow/mobile-web ios:build:sim)"
  local id; id="$(udid)"; [ -n "$id" ] || die "no available \"$SIM_NAME\" on $RUNTIME"
  xcrun simctl boot "$id" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$id" -b >/dev/null 2>&1 || true
  xcrun simctl install "$id" "$APP" || die "install failed"
  xcrun simctl addmedia "$id" "$CLIP" || die "addmedia failed"
  pass "simulator $SIM_NAME booted, app installed, clip added to the photo library"
  xcrun simctl launch "$id" "$BUNDLE_ID" >/dev/null 2>&1 || true
  cat <<EOF

Next (manual, or the XCUITest flow in NATIVE.md "Video upload live check"):
  1. Sign in (demo-mom@tinyglow.local, OTP from Mailpit) on a free-plan baby.
  2. Upload tab > Choose photos > pick the 40 s test clip. It is > 50 MB: the item shows
     "Videos over 50 MB upload on Wi-Fi" (the simulator is on Wi-Fi/ethernet, so it proceeds).
  3. As soon as progress starts: press Home (XCUIDevice.press(.home) or the Simulator menu), wait
     ~60 s, reopen the app. The item must finish, then show "Preparing video..." and play.
  4. Run: $0 verify   (optionally with LL_SESSION/LL_FILE/LL_TOKEN for the api part list)
EOF
}

verify() {
  local id; id="$(udid)"; [ -n "$id" ] || die "no simulator"
  local data; data="$(xcrun simctl get_app_container "$id" "$BUNDLE_ID" data 2>/dev/null)" || die "app not installed"
  local parts="$data/Library/Caches/ll-uploads/parts"
  if [ -d "$parts" ]; then
    local n; n=$(find "$parts" -type f -name '*.part' | wc -l | tr -d ' ')
    if [ "$n" = "0" ]; then pass "no part copies left in Caches/ll-uploads/parts"; else fail "$n part file(s) still in $parts"; fi
  else
    pass "parts directory absent or never created (no leftovers)"
  fi
  # The step-9 log rule: no presigned URL, path or token in the app's log. Two Apple framework
  # lines name the part file's own path (CFNetwork "BackgroundUploadTask ... issued sandbox
  # extension for file file://.../ll-uploads/parts/..." and CoreServicesInternal
  # "kExcludedFromBackupXattrName set on path"); they are the OS's, carry no URL or token, and
  # are excluded so the count only reflects what our code logs.
  local hits
  hits=$(xcrun simctl spawn "$id" log show --last 20m --predicate 'process == "App"' 2>/dev/null \
    | grep -v -E 'issued sandbox extension for file|kExcludedFromBackupXattrName set on path' \
    | grep -c -E 'X-Amz-Signature|ll-uploads/|Bearer |eyJ[A-Za-z0-9_-]{20,}' || true)
  if [ "${hits:-0}" = "0" ]; then pass "no signed URL, upload path or token in the app log"; else fail "$hits suspicious log line(s)"; fi
  if [ -n "${LL_SESSION:-}" ] && [ -n "${LL_FILE:-}" ] && [ -n "${LL_TOKEN:-}" ]; then
    local body; body=$(curl -fsS -H "authorization: Bearer $LL_TOKEN" -H 'x-tinyglow-client: ios' \
      "$API/api/uploads/$LL_SESSION/files/$LL_FILE/parts" 2>/dev/null)
    if printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.exit(JSON.stringify([...j.uploadedPartNumbers].sort())==="[1,2,3,4]"?0:1)})'; then
      pass "api reports uploadedPartNumbers [1,2,3,4]"
    else
      fail "api part list is not [1,2,3,4] (or the file already completed; then check the photo row instead)"
    fi
  else
    printf 'SKIP  api part list (set LL_SESSION, LL_FILE, LL_TOKEN)\n'
  fi
  xcrun simctl io "$id" screenshot "$CLIP_DIR/after-upload.png" >/dev/null 2>&1 && printf 'screenshot: %s\n' "$CLIP_DIR/after-upload.png"
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
  [ "$FAIL" = "0" ]
}

clean() {
  local id; id="$(udid)"
  if [ -n "$id" ]; then xcrun simctl shutdown "$id" >/dev/null 2>&1 || true; fi
  rm -rf "$CLIP_DIR"
  echo "simulator shut down, clip removed"
}

case "${1:-}" in
  clip) make_clip ;;
  prepare) prepare ;;
  verify) verify ;;
  clean) clean ;;
  *) sed -n 2,20p "$0"; exit 2 ;;
esac
