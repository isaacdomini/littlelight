# Native builds (Capacitor)

App id `com.tesarsoft.littlelight` (permanent), name Littlelight, iPhone only for v1.
The native shells are `ios/` (Swift Package Manager, no CocoaPods) and `android/`.
Config: `capacitor.config.ts` (`loggingBehavior: "none"` must stay: debug logging would print tokens
and presigned URLs).

## Build and run

All commands from the repo root with the pnpm on PATH (`export PATH="$HOME/.cache/littlelight-pnpm/bin:$PATH"`).

- Sync web build into both shells: `pnpm --filter @littlelight/mobile-web native:sync`
  (or `native:sync:ios` / `native:sync:android`). `VITE_API_URL` defaults to `http://localhost:8080`;
  `VITE_DEEPLINK_DEV_SCHEME=1` by default (debug scheme on).
- iOS (macOS, Xcode): `pnpm --filter @littlelight/mobile-web ios:build:sim`, or open
  `ios/App/App.xcodeproj`. Needs an iOS Simulator runtime to run. The script builds **ad-hoc signed**
  (`CODE_SIGN_IDENTITY="-" CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES`, no team, no
  certificate). Do not use `CODE_SIGNING_ALLOWED=NO`: an unsigned app drops its entitlements and the
  simulator then cannot test push registration or Associated Domains. Install and launch:
  `xcrun simctl install booted ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app`
  then `xcrun simctl launch booted com.tesarsoft.littlelight`.
- Android: Gradle needs **JDK 21**. Do not change the global default or pin it in the repo:
  `JAVA_HOME=<path to JDK 21> pnpm --filter @littlelight/mobile-web android:build:debug`
  (runs `assembleDebug`; also try `./gradlew lintDebug` in `android/`). SDK at `~/Library/Android/sdk`
  (platform 36, build-tools 35 are enough).
- Release builds use `native:build:release` (requires `VITE_API_URL=https://...`, refuses live-reload
  and mixed-content flags).

## Uploads (in-house uploader)

Photo bytes are uploaded by our own `LittlelightUploader` Capacitor plugin, not a third-party one
(`@capgo/capacitor-uploader` was removed). It does a raw-body `PUT` of the file to a presigned URL
(no multipart, no extra headers) and reports `progress`, `done` and `error` events.

- iOS: `ios/App/App/LittlelightUploader.swift`, a background `URLSession`
  (`com.tesarsoft.littlelight.upload`), so uploads continue after the app is suspended and the system
  can relaunch the app to deliver results.
- Android: `LittlelightUploaderPlugin.java` and `UploadWorker.java` (expedited WorkManager work
  promoted to a visible `dataSync` foreground service, "Uploading N photos").
- Presigned URLs carry a signature: neither side logs URLs or paths. The web layer is
  `src/platform/native/nativeUploader.ts`.
- After changing plugin dependencies run `pnpm --filter @littlelight/mobile-web native:sync` so
  `ios/App/CapApp-SPM/Package.swift` and `android/app/capacitor.build.gradle` match.

## Icons and splash

Sources are `resources/*.svg` (coral #E8836B, dark #F0957F, per docs/DESIGN.md). Regenerate every
iOS (light, dark, tinted 1024 px; light and dark splash) and Android (adaptive, monochrome, legacy,
round, notification, splash icon, Play Store icon) image with
`pnpm --filter @littlelight/mobile-web native:assets`; the output is deterministic. Edit the SVGs,
never the PNGs. Colour resources are in `android/app/src/main/res/values{,-night}/colors.xml`.

## Store drafts

Listing text is in `fastlane/metadata/` (fastlane is not installed; text files only), privacy and
review drafts in `store/`. `sh store/check-limits.sh` checks the character limits.

## Testing notifications and permission prompts

- iOS: the system permission alert and notification banners are outside the app's web view, so
  tapping them needs **XCUITest** (an XCTest UI test target using `XCUIApplication` and
  `XCUIApplication(bundleIdentifier: "com.apple.springboard")` for the alert's "Allow" button and for
  banner taps). `simctl` can deliver a payload (`xcrun simctl push booted com.tesarsoft.littlelight
  payload.apns`) but cannot tap anything. The e2e native gate will add the test target.
- Android: `adb shell pm grant com.tesarsoft.littlelight android.permission.POST_NOTIFICATIONS` skips
  the prompt; tap the notification with `adb shell input` or UI Automator.

## Android emulator

The emulator needs hardware acceleration (Hypervisor.framework, HVF, on Apple silicon macOS). It must
run **outside any sandbox** (a sandboxed shell has no HVF and the emulator will not boot). Start it
from a normal terminal: `~/Library/Android/sdk/emulator/emulator -avd <name>`, then
`adb install android/app/build/outputs/apk/debug/app-debug.apk`.

## Dev networking

- iOS Simulator shares the host network: `http://localhost:8080` and `:9000` work as signed.
  `NSAllowsLocalNetworking` is on; no arbitrary loads.
- Android emulator: `adb reverse tcp:8080 tcp:8080 && adb reverse tcp:9000 tcp:9000`.
  Debug builds allow cleartext to localhost, 127.0.0.1 and 10.0.2.2 only; release is HTTPS only.
  The WebView origin is `https://localhost`, so an `http://` API is mixed content: build with
  `CAP_DEV_MIXED_CONTENT=1` before `cap sync` for local dev. Never for release.

## Deep links

Universal Links / App Links claim only `/invite/*`, `/s/*`, `/signin/native` on
`littlelight.tesarsoft.com` (not `/signin/callback`). A `littlelight://` scheme exists for testing:
iOS Info.plist (the JS router ignores it unless built with `VITE_DEEPLINK_DEV_SCHEME=1`); Android
debug source set only.

- `xcrun simctl openurl booted littlelight://s/<token>`
- `adb shell am start -W -a android.intent.action.VIEW -d littlelight://s/<token>`

## Placeholders to replace later (need store accounts)

- `public/.well-known/apple-app-site-association`: replace `APPLE_TEAM_ID`.
- `public/.well-known/assetlinks.json`: replace `PLAY_APP_SIGNING_SHA256` and `UPLOAD_KEY_SHA256`.
  `npx tsx scripts/check-association.ts` lists what remains.
- iOS signing: set `DEVELOPMENT_TEAM` in Xcode (empty in the repo). `aps-environment` is
  `development`; the release export sets production. Associated Domains only work once signed.
- Android push: put Firebase `google-services.json` in `android/app/` (git-ignored); the Google
  services plugin applies only when it exists.
- Android release signing: `android/keystore.properties` (git-ignored) with `storeFile`,
  `storePassword`, `keyAlias`, `keyPassword`. Without it release tasks fail with a message.

## Pitfalls

Three iOS bugs have already been fixed. Do not reintroduce them.

1. **Never resolve a promise with a Capacitor plugin object**, for example
   `async () => (await import(...)).PushNotifications`. Plugins are Proxies that answer every property,
   including `then`, so the promise treats the plugin as a thenable and never settles. Wrap it instead and
   return `{ PN }` or `{ uploader }`.
2. **`App.getLaunchUrl()` returns the same URL for the whole process**, on iOS (`lastURL`) and on Android
   (`getIntentUri`). The app therefore handles a launch URL once per WebView session. sessionStorage keeps a
   32-bit digest of it, never the URL. This is what stops a hard navigate (`location.assign`) to `/s/...`
   from looping.
3. **Fresh-install Keychain wipe.** iOS Keychain items survive an uninstall. `FreshInstall.wipeKeychainIfNeeded`
   runs first in `AppDelegate`'s `didFinishLaunching`. It wipes the app's Keychain when the UserDefaults flag
   `ll.installed.v1` is missing, and it waits for protected data to be available first. Upgrading from a
   build that predates the flag signs the user out once. Android needs nothing: uninstall wipes app data and
   backups are off.

Also note that `pushPermission()` and `enablePush()` have 5 s timeout fallbacks, so a stalled native call
cannot hang the UI. Keep them when refactoring.

## Privacy notes

- Android: no media/location permissions (system Photo Picker); manifest removes them explicitly;
  backups and device transfer disabled. iOS: `PrivacyInfo.xcprivacy` declares collected data
  (no tracking); WebKit and `Caches/ll-*` are excluded from backup at launch.
- `Info.plist` strings: photo library (read and add) and camera only.
