#!/usr/bin/env sh
# Regenerates the committed video fixtures (docs/plans/step-12.md task 12.10) with ffmpeg
# (libx264 + libx265 needed; `brew install ffmpeg` or the worker image). Synthetic content only
# (`testsrc` patterns, a sine tone); the location tag is a synthetic coordinate. Each file must
# stay under 2 MB. Run from anywhere: `sh e2e/fixtures/video/generate.sh`.
set -eu
cd "$(dirname "$0")"
FF="${FFMPEG_PATH:-ffmpeg}"
common="-v error -hide_banner -nostdin -y"

# 1. H.264 1080p 5 s MP4 (the remux path), creation_time in UTC.
$FF $common -f lavfi -i "testsrc=size=1920x1080:rate=30" -f lavfi -i "sine=frequency=330:sample_rate=48000" \
  -t 5 -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 30 -c:a aac -b:a 64k \
  -metadata creation_time=2026-06-01T08:00:00.000000Z -f mp4 h264-1080p-5s.mp4

# 2. HEVC 720p 5 s MOV with QuickTime location + creationdate + make/model tags (synthetic GPS).
$FF $common -f lavfi -i "testsrc=size=1280x720:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 5 -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p -preset ultrafast -crf 32 -c:a aac -b:a 64k \
  -metadata "com.apple.quicktime.location.ISO6709=+37.3349-122.0090+000.000/" \
  -metadata "com.apple.quicktime.creationdate=2026-07-12T10:30:00+0200" \
  -metadata "com.apple.quicktime.make=Apple" -metadata "com.apple.quicktime.model=iPhone 16" \
  -movflags +use_metadata_tags -f mov hevc-5s.mov

# 3. HDR10 (PQ) HEVC 3 s MOV, 640x360 10-bit.
$FF $common -f lavfi -i "testsrc=size=640x360:rate=30" -t 3 -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p10le \
  -preset ultrafast -crf 30 -an -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -x265-params "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:log-level=none" -f mov hevc-hdr-3s.mov

# 4. 90° rotation side data (a phone's display matrix) over a 640x360 clip.
$FF $common -f lavfi -i "testsrc=size=640x360:rate=30" -t 3 -c:v libx264 -pix_fmt yuv420p -preset ultrafast -an -f mp4 plain-360.tmp.mp4
$FF $common -display_rotation 90 -i plain-360.tmp.mp4 -c copy -f mp4 rotated-90.mp4
rm -f plain-360.tmp.mp4

# 5. 70 s tiny clip (over the free 60 s limit, under every size cap).
$FF $common -f lavfi -i "testsrc=size=160x120:rate=5" -t 70 -c:v libx264 -pix_fmt yuv420p -preset ultrafast -an -f mp4 h264-70s-tiny.mp4

# 6. Audio only (an MP4-family container with no video stream).
$FF $common -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 2 -c:a aac -b:a 64k -f ipod audio-only.m4a

# 7. JPEG bytes renamed .mp4 (the sniff is the truth).
$FF $common -f lavfi -i "testsrc=size=64x48:rate=1" -frames:v 1 -f image2 -c:v mjpeg fake.mp4

ls -la *.mp4 *.mov *.m4a
