#!/bin/sh
# Verifies every listing text is within the store limits. Run from apps/mobile-web.
set -eu
cd "$(dirname "$0")/.."
M=fastlane/metadata
fail=0
check() { # file limit
  n=$(wc -m < "$1" | tr -d ' ')
  n=$((n - 1))                       # trailing newline
  if [ "$n" -gt "$2" ]; then echo "TOO LONG $1: $n > $2"; fail=1; else echo "ok $1: $n/$2"; fi
}
check $M/en-US/name.txt 30
check $M/en-US/subtitle.txt 30
check $M/en-US/keywords.txt 100
check $M/en-US/promotional_text.txt 170
check $M/en-US/description.txt 4000
check $M/en-US/release_notes.txt 4000
check $M/review_information/notes.txt 4000
check $M/android/en-US/title.txt 30
check $M/android/en-US/short_description.txt 80
check $M/android/en-US/full_description.txt 4000
check $M/android/en-US/changelogs/1.txt 500
exit $fail
