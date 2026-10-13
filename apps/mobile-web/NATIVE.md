# Native builds (Capacitor)

App id `app.tinyglow` (permanent), name Tinyglow, iPhone only for v1.
The native shells are `ios/` (Swift Package Manager, no CocoaPods) and `android/`.
Config: `capacitor.config.ts` (`loggingBehavior: "none"` must stay: debug logging would print tokens
and presigned URLs).

## Build and run

All commands from the repo root with the pnpm on PATH (`export PATH="$HOME/.cache/littlelight-pnpm/bin:$PATH"`).

- Sync web build into both shells: `pnpm --filter @tinyglow/mobile-web native:sync`
  (or `native:sync:ios` / `native:sync:android`). `VITE_API_URL` defaults to `http://localhost:8080`;
  `VITE_DEEPLINK_DEV_SCHEME=1` by default (debug scheme on).
- iOS (macOS, Xcode): `pnpm --filter @tinyglow/mobile-web ios:build:sim`, or open
  `ios/App/App.xcodeproj`. Needs an iOS Simulator runtime to run. The script builds **ad-hoc signed**
  (`CODE_SIGN_IDENTITY="-" CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES`, no team, no
  certificate). Do not use `CODE_SIGNING_ALLOWED=NO`: an unsigned app drops its entitlements and the
  simulator then cannot test push registration or Associated Domains. Install and launch:
  `xcrun simctl install booted ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app`
  then `xcrun simctl launch booted app.tinyglow`.
- Android: Gradle needs **JDK 21**. Do not change the global default or pin it in the repo:
  `JAVA_HOME=<path to JDK 21> pnpm --filter @tinyglow/mobile-web android:build:debug`
  (runs `assembleDebug`; also try `./gradlew lintDebug` in `android/`). SDK at `~/Library/Android/sdk`
  (platform 36, build-tools 35 are enough).
- Release builds use `native:build:release` (requires `VITE_API_URL=https://...`, refuses live-reload
  and mixed-content flags).

## Uploads (in-house uploader)

Photo and video bytes are uploaded by our own `TinyglowUploader` Capacitor plugin, not a third-party
one (`@capgo/capacitor-uploader` was removed). It does a raw-body `PUT` of a byte range of a file to a
presigned URL (no multipart, no extra headers) and reports `progress`, `done` and `error` events.

### Plugin interface (`TinyglowUploader`, both platforms)

```ts
upload(opts: {
  url: string;        // presigned UploadPart URL (http/https)
  path: string;       // file:// URI or path (iOS, Android); content:// URI also works on Android
  offset?: number;    // first byte of the part, default 0
  length?: number;    // bytes in the part, default "to the end of the file"
  wifiOnly?: boolean; // iOS: the no-cellular background session; Android: UNMETERED constraint
}): Promise<{ id: string }>;
cancel(opts: { id: string }): Promise<void>;
pendingParts(): Promise<{ count: number }>;   // iOS: part copies still on disk; Android: always 0
// events
"progress" { id, sent, total }   // total = the part's length
"done"     { id, status }        // HTTP status of the PUT
"error"    { id, message }       // "network:<NSURLError code>" (iOS) | "network" | "cancelled" | "file-unreadable" | "bad-range"
// upload() rejections: bad-args, file-unreadable, bad-range (offset/length leave the file),
//                      no-space (iOS: not enough free space for the part copy), part-write (iOS)
```

One `upload()` call is one part; the JS upload manager (`src/lib/upload/manager.ts`, step 12.8)
splits a file with `partSize` from the api (`UPLOAD_PART_BYTES`, 16 MiB; `partCount = ceil(bytes /
16 MiB)`, at most 128) and calls `upload` per part with `offset = (n - 1) * partSize`,
`length = min(partSize, bytes - offset)`. A single-part file (`offset` 0, `length` = size, or both
omitted) is sent straight from the source on both platforms, exactly as before step 12. Resume after a
kill: the manager asks the api for `uploadedPartNumbers` (`GET …/parts`) and re-sends only the
missing parts; the plugin keeps no part table of its own. Q6: the manager passes `wifiOnly: true`
for items above `VIDEO_LARGE_FILE_BYTES` (50 MiB) unless the parent flips that upload's "Use
cellular" switch ("Videos over 50 MB upload on Wi-Fi. Use cellular for this one.").

- iOS (`ios/App/App/TinyglowUploader.swift`, `LLPartFile.swift`): background `URLSession`s
  (`app.tinyglow.upload`, `app.tinyglow.upload.wifi`), so uploads continue after the app is
  suspended and the system can relaunch the app to deliver results. A background upload task needs a
  file body, so a ranged part is first copied (1 MiB chunks, protected until first unlock) to
  `Caches/ll-uploads/parts/<task id>.part`; the copy is deleted in `didCompleteWithError` (success,
  failure or cancel), and `load()` sweeps copies whose task the sessions no longer know (plus anything
  older than a day). Peak scratch use is one 16 MiB copy per in-flight part, never the whole video.
  The copy is refused with `no-space` when the volume has less than `length + 64 MiB` free.
  `sh ios/scripts/part-file-harness.sh` runs the slicing/deletion harness on the host (no simulator).
- Android (`TinyglowUploaderPlugin.java`, `UploadWorker.java`, `ByteRange.java`): one WorkManager
  request per part (expedited, promoted to a visible `dataSync` foreground service, notification
  "Uploading photos and videos" with no count, because a count would count parts). The worker seeks
  the source (`RandomAccessFile` for files, a positioned descriptor or `skipFully` for `content://`)
  and streams exactly `length` bytes with `setFixedLengthStreamingMode`: no copy, nothing to delete.
  A source that ends early fails with `file-unreadable` (no retry); network errors retry twice.
  `./gradlew testDebugUnitTest --tests 'app.tinyglow.uploader.*'` runs `ByteRangeTest`.
- Presigned URLs carry a signature: neither side logs URLs or paths. The web layer is
  `src/platform/native/nativeUploader.ts`.
- After changing plugin dependencies run `pnpm --filter @tinyglow/mobile-web native:sync` so
  `ios/App/CapApp-SPM/Package.swift` and `android/app/capacitor.build.gradle` match.

### Picking videos (`@capawesome/capacitor-file-picker`)

The JS picker should call `FilePicker.pickMedia({ limit, readData: false, skipTranscoding: true })`
instead of `pickImages` when videos are allowed. Verified in the 8.1.0 sources: iOS uses
`PHPickerViewController` with `preferredAssetRepresentationMode = .current` (the original HEVC
`.mov` as shot, no re-encode) and reads `duration` with `AVAsset` (whole seconds, rounded); Android
uses the system Photo Picker (`PickVisualMedia.ImageAndVideo`, no `READ_MEDIA_*` permission) and
`MediaMetadataRetriever` for `duration` (seconds). Each `PickedFile` carries `name`, `size`,
`mimeType` (`video/quicktime` or `video/mp4`), `duration`; multiply by 1000 for the `durationMs`
hint, or read it precisely from a `<video>` element on `convertFileSrc(path)`. Q5: a Live Photo picked
this way is an image item and uploads its HEIC only. Note for the JS side: the plugin already copies
the picked movie into its own temp dir; `copyIntoUploadCache` makes a second copy. For videos prefer
`Filesystem.rename` (a move) into `ll-uploads`, so a 2 GB clip never needs 4 GB of free space.
No new permission on either platform; `Info.plist` strings say "photos and videos".

## Icons and splash

Sources are `resources/*.svg` (coral #E8836B, dark #F0957F, per docs/DESIGN.md). Regenerate every
iOS (light, dark, tinted 1024 px; light and dark splash) and Android (adaptive, monochrome, legacy,
round, notification, splash icon, Play Store icon) image with
`pnpm --filter @tinyglow/mobile-web native:assets`; the output is deterministic. Edit the SVGs,
never the PNGs. Colour resources are in `android/app/src/main/res/values{,-night}/colors.xml`.

## Store drafts

Listing text is in `fastlane/metadata/` (fastlane is not installed; text files only), privacy and
review drafts in `store/`. `sh store/check-limits.sh` checks the character limits.

## Testing notifications and permission prompts

- iOS: the system permission alert and notification banners are outside the app's web view, so
  tapping them needs **XCUITest** (an XCTest UI test target using `XCUIApplication` and
  `XCUIApplication(bundleIdentifier: "com.apple.springboard")` for the alert's "Allow" button and for
  banner taps). `simctl` can deliver a payload (`xcrun simctl push booted app.tinyglow
  payload.apns`) but cannot tap anything. The e2e native gate will add the test target.
- Android: `adb shell pm grant app.tinyglow android.permission.POST_NOTIFICATIONS` skips
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
`tinyglow.app` (not `/signin/callback`). A `tinyglow://` scheme exists for testing:
iOS `Info-Debug.plist` (Debug configuration only; the JS router ignores it unless built with `VITE_DEEPLINK_DEV_SCHEME=1`); Android
debug source set only.

- `xcrun simctl openurl booted tinyglow://s/<token>`
- `adb shell am start -W -a android.intent.action.VIEW -d tinyglow://s/<token>`

## Placeholders to replace later (need store accounts)

- `public/.well-known/apple-app-site-association`: replace `APPLE_TEAM_ID` (both the `applinks` and
  the `webcredentials` entry).
- `public/.well-known/assetlinks.json`: replace `PLAY_APP_SIGNING_SHA256` and `UPLOAD_KEY_SHA256` in
  both statements (`handle_all_urls` and `get_login_creds`).
  `npx tsx scripts/check-association.ts` lists what remains.
- Passkeys (step 13, Part B): `GOTRUE_WEBAUTHN_RP_ORIGINS` needs one `android:apk-key-hash:…` per
  signing key, computed from the same certificates (see "Passkeys" above). Nothing in the repo holds
  these values.
- iOS signing: set `DEVELOPMENT_TEAM` in Xcode (empty in the repo). `aps-environment` is
  `development`; the release export sets production. Associated Domains only work once signed.
- Android push: put Firebase `google-services.json` in `android/app/` (git-ignored); the Google
  services plugin applies only when it exists.
- Android release signing: `android/keystore.properties` (git-ignored) with `storeFile`,
  `storePassword`, `keyAlias`, `keyPassword`. Without it release tasks fail with a message.

## Album sync (PhotoKit)

iPhone only, parents only (the JS side decides). Plugin `TinyglowPhotoSync`
(`ios/App/App/TinyglowPhotoSync.swift`, JS bridge `src/platform/native/photoSync.ts`). Calls:
`authorizationStatus`, `requestAuthorization` (the only call that shows the Photos prompt, run only
when a parent taps Set up), `listAlbums` (user albums only), `listPendingAssets`, `exportAssets`,
`discardFiles`, `recordOutcomes`, `ledgerSummary`, `resetLedger`, `conditions`,
`scheduleBackgroundRefresh`, `completeBackgroundTask`, and events `backgroundSync` and
`backgroundSyncExpired`. It asks for full Photos access because reading an album's originals with
EXIF and GPS needs it; only the chosen album is read and nothing is ever deleted.

- Videos (step 12): album enumeration and counts include `mediaType == .video`.
  `listPendingAssets` items carry `kind: "photo" | "video"`, `durationMs` (from `PHAsset.duration`)
  and `size` (bytes of the original resource, a hint that can be `null` for an iCloud-only asset), so
  the JS lane applies the plan's limits (`videoLimitsFor(plan)`) **before** exporting and records
  `too_large` / `too_long` through `recordOutcomes` (ledger codes `l` / `t`, counted in `skipped`,
  excluded from `listPendingAssets` unless `includeLimitSkipped: true`, which a plan upgrade should
  pass once). `exportAssets` writes the `PHAssetResourceType.video` resource (the original container
  as shot, HEVC kept, `isNetworkAccessAllowed`; never `.fullSizeVideo`, the edited rendition) and
  returns `kind`, `durationMs`, `mime` (`video/quicktime` | `video/mp4`), `size`, `sha256`,
  `takenAt`. A Live Photo stays an image: `.photo` only, the paired video is not uploaded (Q5). The
  JS lane should export one video at a time and keep sync Wi-Fi-only for them.

- Ledger: `Application Support/ll-sync/<sha256(albumId)>.json` records each asset outcome so nothing
  is imported twice. No paths, names, URLs or identifiers are logged.
- Export directory: originals are written to `Caches/ll-sync-export`, **not** `ll-uploads`. The
  upload cleanup (`cleanup.ts`) sweeps `ll-uploads` for finished uploads; sharing it would let that
  sweep delete files the sync still needs, and `discardFiles` refuses anything outside
  `ll-sync-export`. Both directories are excluded from backup.
- Wi-Fi session: the uploader has a second background `URLSession`
  (`app.tinyglow.upload.wifi`, `allowsCellularAccess = false`). Sync uploads pass
  `wifiOnly: true` unless the parent allows cellular. iCloud original downloads follow the system
  cellular setting and are not controlled by the app.
- Background refresh: `BGAppRefreshTask` id `app.tinyglow.sync` (listed in
  `BGTaskSchedulerPermittedIdentifiers`). iOS decides when it runs, often never, so launch,
  foreground and Sync now are the real triggers. The simulator cannot fire it from the shell. Run
  the app from Xcode, pause, and at the LLDB prompt enter:
  `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"app.tinyglow.sync"]`
  then resume. Treat this as a manual check; unit tests cover the JS path.
- XCUITest: the Photos alert is a system alert, so the e2e test taps it through
  `XCUIApplication(bundleIdentifier: "com.apple.springboard")` and presses **Allow Full Access**
  (not "Limited Access"; the app sets `PHPhotoLibraryPreventAutomaticLimitedAccessAlert`).
  `simctl privacy booted grant photos app.tinyglow` is a shortcut that skips the alert.

## Video upload live check (step 12, task 12.9)

`ios/scripts/video-upload-check.sh` holds the mechanical parts of "a 55 MiB HEVC MOV uploads in 4
ranged background parts, the part copies are deleted, the upload survives backgrounding":

1. `sh ios/scripts/video-upload-check.sh clip`: ffmpeg renders a 40 s 1080p30 HEVC (`hvc1`) test
   pattern with an AAC tone into `${TMPDIR}/tinyglow-video-check/clip-60mb.mov` and rescales the
   bitrate until the file is in (48 MiB, 64 MiB], i.e. exactly four 16 MiB parts (no real child, no
   speech; never committed).
2. `pnpm --filter @tinyglow/mobile-web ios:build:sim`, then `… video-upload-check.sh prepare`: boots
   the iPhone 17 (iOS 26.4) simulator, installs the app, `simctl addmedia` the clip, launches.
3. Drive the app: sign in as demo mom, Upload tab, Choose photos, pick the clip, press Home while it
   is uploading, wait a minute, come back. Manual, or XCUITest (the e2e bundle in
   `e2e/native/ios-uitest`, test-engineer's): `testSignIn`, then a new `testPickVideoAndBackground`
   that taps "Choose photos", selects the newest video cell of the PHPicker (an out-of-process remote
   view; address it through the app's own element tree, which XCUITest merges since iOS 16, and fall
   back to a coordinate tap on the first cell), taps Add, waits for the progress bar, then
   `XCUIDevice.shared.press(.home)`, `sleep(60)`, `app.activate()` and waits for the tile.
4. `… video-upload-check.sh verify`: `Library/Caches/ll-uploads/parts` contains no `*.part`; the
   app's unified log has no `X-Amz-Signature`, upload path or bearer token; with `LL_SESSION`,
   `LL_FILE`, `LL_TOKEN` it also checks `GET /api/uploads/:s/files/:f/parts` reports
   `uploadedPartNumbers = [1,2,3,4]` (or, once completed, the photo row has `media_kind = 'video'`).
5. `… video-upload-check.sh clean` shuts the simulator down and deletes the clip. Delete
   `ios/DerivedData` afterwards (disk).

Needs the api's video registration (backend 12.4) on the dev stack; do not run it while the api and
worker are busy on the real AI provider.

## Google import on devices

Google Photos import connects a Google account, then uses Google's own picker. Google refuses OAuth
and the picker inside embedded web views, so the app opens them with `@capacitor/browser`
(SFSafariViewController on iOS, Custom Tabs on Android) and re-checks the connection and batch status on `browserFinished` / `resume` (there is no deep link; the
`/import/google/connected` page tells the user to return to the app). Do not
swap this for an in-app WebView or a `window.open`. The server keeps an encrypted refresh token;
downloads keep the capture date but Google removes the location. Android has no photo auto-sync and no
media permission. For local development with the fake Google server run
`adb reverse tcp:18099 tcp:18099 (the fake Google host port, `GOOGLE_FAKE_PORT`)` on the Android emulator (iOS Simulator shares the host network).

## Passkeys (`TinyglowPasskeys`, step 13)

Passkeys are an addition to the email code, which stays primary (docs/plans/step-13.md). The WebView
origin (`capacitor://localhost`, `https://localhost`) can never be a WebAuthn origin, so native uses the
platform passkey APIs through our own plugin with the relying party `tinyglow.app`. The JSON in and
out is the W3C form the API speaks (`packages/shared/src/api/auth.ts`
`publicKeyCredentialJsonSchema`), so `lib/passkeys.ts` (frontend, 13.5) branches only on platform.

### Plugin interface (`TinyglowPasskeys`, both platforms)

```ts
interface TinyglowPasskeysPlugin {
  /** iOS: iOS 16+ and the embedded provisioning profile grants webcredentials:tinyglow.app
   *  (device builds signed with the Team ID; simulator and ad-hoc builds: false, no OS call).
   *  Android: Android 9+ (passkeys need API 28 and Google Play services). */
  available(): Promise<{ available: boolean }>;
  /** options = PublicKeyCredentialCreationOptionsJSON from POST /api/me/passkeys/options
   *  (`response.options`). Returns the PublicKeyCredential JSON for POST /api/me/passkeys. */
  create(args: { options: Record<string, unknown> }): Promise<{ credential: PublicKeyCredentialJsonInput }>;
  /** options = PublicKeyCredentialRequestOptionsJSON from POST /api/auth/passkey/options.
   *  preferImmediatelyAvailable: true for the explicit button (no "no passkey here" sheet; the
   *  plugin reports `cancelled` instead). Returns the JSON for POST /api/auth/passkey/verify. */
  get(args: { options: Record<string, unknown>; preferImmediatelyAvailable?: boolean }): Promise<{ credential: PublicKeyCredentialJsonInput }>;
}
```

Register it on the JS side with `registerPlugin<TinyglowPasskeysPlugin>("TinyglowPasskeys")` (no web
implementation: the web uses `navigator.credentials` directly). Rejections carry `err.code` (and the
same string as the message; nothing from the OS is forwarded):

| code | meaning | JS should |
| --- | --- | --- |
| `cancelled` | the user dismissed the sheet; iOS with `preferImmediatelyAvailable` and no passkey; Android DOM `NotAllowedError` (includes timeouts) | do nothing |
| `not_available` | iOS < 16; Android < 9 or no credential provider / Play services | hide the passkey option |
| `not_configured` | the options name another RP than `tinyglow.app` (dev stack: `GOTRUE_WEBAUTHN_RP_ID=localhost`), or the app is not associated with the domain yet (no Team ID / AASA not served; Android `SecurityError`, i.e. the apk-key-hash origin or `assetlinks` `get_login_creds` is missing) | "Passkeys are not available in this build", keep the email code |
| `failed` | malformed options, authenticator error, no passkey on this device (Android `NoCredentialException`), a ceremony already running | "Couldn't use a passkey. Use the email code." |

Credential JSON: `{ id, rawId, type: "public-key", response: { clientDataJSON, attestationObject |
authenticatorData, signature, userHandle }, authenticatorAttachment, clientExtensionResults }`,
every binary field base64url **without padding**; `transports: ["internal"]` on iOS registrations;
`clientExtensionResults` is `{}` on iOS and whatever Credential Manager reports on Android.

Decisions carried by both plugins (step-13.md 0.1 g, h):

- GoTrue's registration `options.user.id` is the base64url of the 36-char UUID string. iOS decodes it
  to bytes for `createCredentialRegistrationRequest(challenge:name:userID:)`; Android validates it as
  base64url and sends the options through. Neither interprets or logs it. The assertion's
  `userHandle` is returned verbatim so GoTrue can match the user.
- User verification is **required**: `userVerificationPreference = .required` on both iOS requests;
  Android rewrites `authenticatorSelection.userVerification` / `userVerification` to `"required"`
  before calling Credential Manager. The API rejects assertions without the UV flag.
- The RP id is a build-time constant equal to the production host (`LLPasskeyCodec.relyingPartyId`,
  `PasskeyJson.RP_ID`); options for any other RP are rejected with `not_configured`. Passkeys cannot
  be exercised against the dev stack from a device or simulator (the RP id must match a served AASA /
  assetlinks); the iOS e2e gate stubs the plugin.

Files: `ios/App/App/TinyglowPasskeys.swift` (plugin, `ASAuthorizationPlatformPublicKeyCredentialProvider`,
`ASAuthorizationController`), `ios/App/App/LLPasskeyCodec.swift` (Foundation-only mapping),
`android/app/src/main/java/app/tinyglow/passkeys/TinyglowPasskeysPlugin.java` (Credential Manager:
`androidx.credentials:credentials` + `credentials-play-services-auth`, `androidxCredentialsVersion` in
`variables.gradle`) and `PasskeyJson.java` (org.json mapping).

Tests (no device, no simulator):

- `sh ios/scripts/passkey-codec-harness.sh`: compiles `LLPasskeyCodec.swift` with the harness on the
  host (base64url, `user.id` pass-through, credential JSON shape, `userHandle` verbatim, RP check,
  provisioning-profile reader) and asserts the two `.required` lines in the plugin.
- `JAVA_HOME=<jdk 21> ./gradlew testDebugUnitTest --tests 'app.tinyglow.passkeys.*'` in `android/`
  runs `PasskeyJsonTest` (UV forced on both requests, `user.id` untouched, `userHandle` verbatim,
  exact schema keys, base64url validation and unpadding).

### Entitlement and association files

- iOS: `App.entitlements` has `webcredentials:tinyglow.app` next to `applinks:tinyglow.app`. The
  Debug configuration signs with `App-Debug.entitlements` (`CODE_SIGN_ENTITLEMENTS` in the project):
  the same list plus `webcredentials:tinyglow.app?mode=developer`, which lets a development-signed
  build read the AASA directly instead of through Apple's CDN (so a change is visible at once; the
  device needs Settings > Developer > Associated Domains Development on). Release carries no
  developer-mode entry. Both files must stay identical otherwise.
- `public/.well-known/apple-app-site-association` gains `"webcredentials": { "apps":
  ["APPLE_TEAM_ID.app.tinyglow"] }`; `assetlinks.json` gains a second statement
  `delegate_permission/common.get_login_creds` for `app.tinyglow` with the same fingerprints. Both
  are copied into the native `public` folders by `cap sync` (git-ignored there) and are served by
  nginx with `application/json`. `npx tsx scripts/check-association.ts` lists the placeholders.
- Android origin at GoTrue: a native passkey's `clientDataJSON.origin` is
  `android:apk-key-hash:<base64url(sha256(signing certificate))>`, so `GOTRUE_WEBAUTHN_RP_ORIGINS`
  must list one entry **per signing key** (debug, upload, Play App Signing; GoTrue puts no cap on the
  list). Compute it from a keystore:

  ```sh
  keytool -exportcert -alias <alias> -keystore <keystore> -storepass <pw> \
    | openssl sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '='
  # debug key: alias androiddebugkey, keystore ~/.android/debug.keystore, password android
  # Play App Signing: Play Console > Setup > App signing > App signing key certificate (SHA-256, hex)
  #   -> echo '<hex>' | xxd -r -p | openssl base64 | tr '+/' '-_' | tr -d '='
  ```

  The 43-character result goes into `GOTRUE_WEBAUTHN_RP_ORIGINS` as `android:apk-key-hash:<value>`.
  `assetlinks.json` wants the same certificates as colon-separated **hex** SHA-256 fingerprints
  (`keytool -list -v`), so the two files are derived from one set of certificates.
- Permissions: `credentials-play-services-auth` pulls `androidx.biometric`, which adds the
  install-time (non-runtime) `USE_BIOMETRIC` and `USE_FINGERPRINT` permissions to the merged manifest.
  That is exactly what passkey user verification uses; `check-android-manifest.mjs` allows them.
  Nothing else changes in either manifest and no new `Info.plist` key or `PrivacyInfo.xcprivacy`
  data type is needed (a passkey's public key is an account credential; the private key never leaves
  the OS).

### Device verification (Part B; needs Team ID, signing certificates, production deploy)

1. Deploy `/.well-known/apple-app-site-association` (Team ID filled in) and `assetlinks.json`
   (hex fingerprints filled in) to `https://tinyglow.app`; `curl -sI
   https://tinyglow.app/.well-known/apple-app-site-association | grep -i content-type` must say
   `application/json`. On `auth`: `GOTRUE_PASSKEY_ENABLED=true`, `GOTRUE_WEBAUTHN_RP_ID=tinyglow.app`,
   `GOTRUE_WEBAUTHN_RP_ORIGINS=https://tinyglow.app,android:apk-key-hash:<debug>,android:apk-key-hash:<upload>,android:apk-key-hash:<play>`;
   on `api`: `AUTH_PASSKEYS_ENABLED=true`. Restart both.
2. iOS (iPhone on iOS 16+): set `DEVELOPMENT_TEAM` in Xcode, build Debug to the device
   (`?mode=developer` is active), turn on Settings > Developer > Associated Domains Development.
   Expected: `available()` is true (`strings App.app/App | grep webcredentials` shows the
   entitlement; the device build has `embedded.mobileprovision`). Sign in with the email code, accept
   the "Add a passkey" card, Face ID / Touch ID prompt, Settings shows the passkey. Sign out, "Sign in
   with a passkey", pick it, signed in without a code. Settings > remove the passkey (fresh sign-in
   gate). A failure with "not associated with domain" in Console.app (`swcd`) means the AASA is not
   served or the Team ID is wrong; the plugin reports `not_configured`.
3. Android (phone with Google Play services, Android 9+, screen lock set): install the debug build
   whose key hash is in `RP_ORIGINS`. Verify the statement:
   `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://tinyglow.app&relation=delegate_permission/common.get_login_creds`
   must list `app.tinyglow` with the certificate. Then the same enrol / sign out / sign in / remove
   loop. A `SecurityError` (`not_configured`) means the origin is missing at GoTrue or the
   `assetlinks` statement does not match the installed APK's certificate; `not_available` means no
   Play services or no screen lock.
4. Record both runs in `docs/PROGRESS.md`; only then add the listing line (`store/README.md`, P5).

## Live updates (`TinyglowUpdater`, step 14)

The installed apps pick up a new web build without a store release (`docs/plans/step-14.md`). The
store build keeps its bundled web (`public/`) as the fallback; the api hands out a manifest signed
with ECDSA P-256 (`GET /api/app-update/manifest`), the plugin verifies it with a key compiled into
the app, downloads only the files it does not already have, checks every file's sha256 and size,
and the new bundle runs from the **next cold launch** (or `applyNow()`). No third-party updater,
no new permission (Android uses `INTERNET` and the `ACCESS_NETWORK_STATE` WorkManager already merges in).

**Rule: bump `minNativeBuild.<platform>` in `apps/mobile-web/app-update.json` in the same commit
that adds or changes a native plugin method (or permission, SDK, Capacitor version) the web calls.**
The value is the iOS `CFBundleVersion` / Android `versionCode` of the first store build that has
the change; older shells then get `native_too_old` and keep their bundled web. The release lanes
bump the build numbers. Any native change still needs a store release.

### Plugin interface (`TinyglowUpdater`, both platforms)

```ts
interface TinyglowUpdaterPlugin {
  /** Shell + bundle facts for the UI and for the manifest query. */
  info(): Promise<{
    nativeVersion: string;          // CFBundleShortVersionString / versionName
    nativeBuild: number;            // CFBundleVersion / versionCode (0 if unreadable)
    builtinVersion: string;         // content id of public/app-update/manifest.json ("unknown" if missing)
    currentVersion: string;         // what this WebView runs: builtinVersion or the active OTA bundle
    currentSource: "builtin" | "ota";
    stagedVersion: string | null;   // applies on next launch; equals builtinVersion when the server went back to the bundled web
    androidPushConfigured: boolean; // Android: google-services resources (google_app_id) present; iOS: always true
  }>;
  /** Verify the signed manifest, download the missing files, stage the bundle. Never rejects for
   *  network or verification problems (only "bad-args" when a field is missing). Can take minutes. */
  stage(args: { manifestJson: string; signature: string; keyId: string }): Promise<{
    outcome: "staged" | "up_to_date" | "already_staged" | "native_too_old" | "wifi_required"
           | "constrained" | "no_space" | "network" | "verify_failed" | "rejected";
    version?: string;  // the manifest's version (absent for verify_failed)
    bytes?: number;    // bytes that had to / would have to download (0 for up_to_date, already_staged, staged builtin)
  }>;
  /** JS booted: cancels the watchdog, marks the running bundle good. Call on every launch. */
  notifyAppReady(): Promise<void>;
  /** Reload into the staged bundle now (no-op when nothing is staged). The JS side checks idle first. */
  applyNow(): Promise<void>;
  /** Back to the bundled web ("Reset app files"); deletes every OTA bundle. Failed versions stay refused. */
  reset(): Promise<void>;
}
```

`stage()` order: signature (`keyId` selects the key: `prod-2026-10` always, `dev` in Debug builds
only) → strict parse (`schema` 1, ≤ 2000 files, ≤ 64 MiB, paths relative without `..`/empty/`.`
segments, NUL or backslash, no excluded prefix, `index.html` listed, unique paths, `version` = content
id of `files`, `baseUrl` rules) → anything failing so far is `verify_failed` → `minNativeBuild` →
`native_too_old` → previously failed version → `rejected` → equals what runs now → `up_to_date`
(and drops a pending switch) → equals staged → `already_staged` → equals the bundled web →
staged with 0 bytes (switch back to builtin at next launch) → otherwise plan: files whose sha256
exists locally (bundled `public/`, current/previous/staged bundle) are copied, the rest download.
Network policy only when bytes > 0: Low Data Mode / Data Saver (metered), Low Power / power save,
thermal serious+ → `constrained`; offline → `network`; metered and > 2 MiB → `wifi_required`. Free
space must be ≥ bundle size + 64 MiB (`no_space`). Downloads: foreground, 4 in flight, 20 s per file,
`Accept-Encoding: identity`, URL = `baseUrl + "/" + encodeURIComponent(each segment)`. A wrong hash or
size is `verify_failed`, a transport error `network`; either deletes the temp dir.

### Storage and launch

- iOS: `Library/NoCloud/ionic_built_snapshots/<version>/` (the exact place Capacitor maps its persisted
  `serverBasePath` to), excluded from backup in `AppDelegate`. Android: `filesDir/ll-updates/<version>/`.
  Each bundle holds its signed manifest at `app-update/manifest.json`. Temp: `tmp-<version>/` (deleted on
  failure; leftovers older than a day pruned). Kept: current + previous (+ staged until the next launch).
- `state.json` next to the bundles: `{ binary, current, staged, previous, good[], failed[] (≤ 20), attempts }`
  (version ids and counters only).
- Capacitor's own persisted path is the switch: iOS `KeyValueStore.standard["serverBasePath"]`,
  Android `SharedPreferences("CapWebViewSettings").serverBasePath`. The launch decision runs before
  Capacitor reads it: iOS `TinyglowViewController.instanceDescriptor()` → `LLUpdater.prepareLaunch()`;
  Android `TinyglowUpdaterPlugin.load()` (plugins load before `Bridge.loadWebView()`). It promotes a
  staged bundle, falls back when a bundle directory is missing, and on a **new native binary**
  (version name or build changed) deletes every bundle and starts on the bundled web (Capacitor
  clears its key then too).
- **Watchdog**: a bundle not yet in `good` gets 10 s from the first page load (fallback 25 s from
  plugin load) to call `notifyAppReady()`. Expiry while the app is in the foreground → the version
  joins `failed`, the WebView switches to the previous good bundle or the bundled web and reloads,
  and the bundle is deleted. A backgrounded app re-arms 10 s when it is active again. Kill
  protection: a bundle launched 4 times without `notifyAppReady()` is failed at launch.
- Nothing logs (no URL, path, signature, manifest or file name); outcomes only travel to JS.

### Keys

`ios/App/App/LLUpdateKeys.swift` and `android/.../update/UpdateKeys.java` mirror
`APP_UPDATE_PUBLIC_KEYS` (`packages/shared/src/app-update.ts`). The dev key is only inside `#if DEBUG`
(Swift) / `if (BuildConfig.DEBUG)` (Java; `buildConfig = true` in `app/build.gradle`, javac drops the
constant-false block). Verified 2026-10-13: the Release simulator binary and the release
`UpdateKeys.class` do not contain the dev SPKI; Debug ones do. Rotation: add the new key here, ship
a store build, then switch the server.

### Tests (host-side, no simulator/emulator)

- iOS: `sh apps/mobile-web/ios/scripts/update-bundle-harness.sh` (macOS; SKIP elsewhere). Compiles
  `LLUpdateBundle.swift` + `LLUpdateKeys.swift` twice (with and without `-D DEBUG`), runs content id
  vectors, path/base-URL/URL rules, signature + tamper, parsing, network policy, the state machine,
  staging (reuse, tampered file, network failure), pruning; then checks the release compile lacks the
  dev SPKI and the updater sources have no logging calls.
- Android: `JAVA_HOME=<jdk 21> ./gradlew testDebugUnitTest --tests 'app.tinyglow.update.*'` (`UpdateBundleTest`).
- Vectors: `ios/scripts/update-bundle-harness/vectors.fixture.json` (= `android/app/src/test/resources/app/tinyglow/update/vectors.fixture.json`),
  dev-signed; both harnesses also run `e2e/ota/vectors.json` when it exists. Shape (only
  `manifestJson` and `signature` are required):
  `{ keyId, spkiBase64, manifestJson, signature, expectedVersion, files: { <path>: <base64 bytes> },
  tampered: { manifestJson, signature }, tamperedFile: { path, contentBase64 } }`. `files` must
  hold every listed file's bytes for the staging test (first vector file only).
- Device scenario (A → B → broken C → rollback → reset): `pnpm e2e:native-ios -- --ota` /
  `pnpm e2e:native-android -- --ota` (task 14.10).

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
- `Info.plist` strings: photo library (read and add) and camera only, worded "photos and videos". The
  read string is shown only when a parent turns on Album sync (full access); the regular upload uses
  the system picker. Android is unchanged: still no media or location permission.
- Passkeys (step 13) add no `Info.plist` string, no `PrivacyInfo.xcprivacy` data type and no runtime
  permission: the private key stays in the OS credential store (iCloud Keychain / Google Password
  Manager, the user's own sync), the server keeps only the public key and a name. Android's merged
  manifest gains the install-time `USE_BIOMETRIC` / `USE_FINGERPRINT` from `androidx.biometric`
  (passkey user verification); the plugin never logs options, credentials or OS error text.
- Videos add no permission, no `PrivacyInfo.xcprivacy` data type (a video is "Photos or Videos") and
  no manifest change (`READ_MEDIA_VIDEO` stays removed). The app never records video or audio and never
  asks for the microphone. Store copy: `store/data-safety.md` declares "Photos and videos > Videos",
  `store/privacy-nutrition-label.md` and the fastlane texts say "photos and short videos".

## iOS Debug-only surface

`ios/debug.xcconfig` sets `INFOPLIST_FILE = App/Info-Debug.plist` and `ios/release.xcconfig` sets
`App/Info.plist`. `Info-Debug.plist` is `Info.plist` plus exactly `NSAppTransportSecurity`
(`NSAllowsLocalNetworking`) and the `tinyglow://` `CFBundleURLTypes`, so Release builds carry
neither. `pnpm --filter @tinyglow/mobile-web check:ios-plists` enforces this; edit both plists
together. Likewise the Debug configuration signs with `App/App-Debug.entitlements`, which is
`App.entitlements` plus `webcredentials:tinyglow.app?mode=developer` (step 13); edit both together.
