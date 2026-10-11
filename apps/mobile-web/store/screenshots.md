# Screenshots (captured in 9.17)

Capture the demo family (Maya's illustrated photos) only. Never real photos. Light mode.
iPhone only for v1, so no iPad set.

| Store | Size (px) | Device |
| --- | --- | --- |
| App Store 6.9" (required) | 1320 x 2868 | iPhone 17 Pro Max / 16 Pro Max simulator |
| App Store 6.5" (required if no 6.9 set is accepted for older devices) | 1284 x 2778 | iPhone 14 Plus simulator |
| Google Play phone | 1080 x 1920 up to 1440 x 2880 (16:9 to 9:16, 2 to 8 images) | Pixel emulator |
| Play feature graphic | 1024 x 500 | made from `resources/` mark on coral |

Screens, in order: 1. Timeline by age. 2. Full-screen viewer with details. 3. Search results
("beach in June"). 4. Chat answer with photos. 5. Share link sheet (private, expires). 6. Upload
picker.

Commands: `xcrun simctl io booted screenshot out.png`; `adb exec-out screencap -p > out.png`.
Hide the status-bar clock oddities with `xcrun simctl status_bar booted override --time 9:41`.
Do not advertise pricing or purchase in screenshot captions.

## Generated assets (regenerate with one command)

```sh
export PATH="$HOME/.cache/littlelight-pnpm/bin:$PATH"
docker compose -f docker-compose.dev.yml up -d --wait
pnpm --filter @tinyglow/mobile-web store:screenshots          # Android set, then iOS set
# or one platform: store:screenshots:android | store:screenshots:ios
```

The Android script restarts nothing but spends one demo-mom sign-in code (5 per hour per email); if
it is throttled, `docker compose -f docker-compose.dev.yml restart api` first. Both runs call
`scripts/store-prep.ts`, which approves the seed's two pending photos and clears the chat thread
(API as demo-mom; `pnpm db:seed` restores the original state).

| Output | Path | Size |
| --- | --- | --- |
| iOS 6.9" (NOT GENERATED YET: needs 8 GB free disk; raw, 8 shots: timeline, viewer, milestones, family, upload, chat, growth, album sync) | `fastlane/screenshots/en-US/NN-name.png` | 1320 x 2868 |
| Play phone (raw, 7 shots, same order minus album sync) | `fastlane/metadata/android/en-US/images/phoneScreenshots/NN-name.png` | 1080 x 2400 |
| Play feature graphic | `fastlane/metadata/android/en-US/images/featureGraphic.png` | 1024 x 500 |
| Optional captioned copies (coral accent, no plan or price wording) | `store/captioned/ios/`, `store/captioned/android/` | same sizes |

- iOS: real app on the iPhone 17 Pro Max simulator (iOS 26.4), light mode, status bar 9:41 /
  full battery, signed in as demo-mom through the real UI (`scripts/store-screenshots-ios.sh`; uses
  the `testDragUp` helper in `e2e/native/ios-uitest`). Needs 8 GB free disk; deletes DerivedData and
  shuts the simulator down afterwards.
- Android: the Pixel emulator cannot run on this Mac, so the same web UI is rendered with Playwright
  at 360 x 800 css px, device scale 3 (exactly 1080 x 2400), with the Capacitor shell forced to
  `android` (`scripts/store-screenshots-android.ts`). No status bar is drawn.
- 6.5" (1284 x 2778): not produced. Apple's screenshot specifications list 6.5" only as "required if
  screenshots for iPhone with Dynamic Island (large display) aren't provided"; the 1320 x 2868 set is
  in that group. Re-check the page when submitting.
- The chat shot comes from the dev stack's fake model (a canned "Here are 2 photos that match."
  line over a real search). Re-capture it against a real-model stack before submitting if the wording
  matters.
- Upload to the stores: fastlane `deliver` picks up `fastlane/screenshots` once `skip_screenshots` is
  turned off in `fastlane/Fastfile`; Play images are read from `metadata/android` by `supply`.
