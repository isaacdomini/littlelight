# Step 9 plan: Mobile release

Status: proposed (architect, 2026-10-09). PRD step: "Build handoff for Claude Code → Build order →
9. Mobile release: Capacitor iOS/Android builds, push, deep links (`/invite`, `/s`, auth callback),
store metadata, privacy manifest." Acceptance (verbatim): "Check: TestFlight and Play internal
builds install; invite and share links open the app."

PRD sections implemented: "Goals (v1)" 5 ("Ship to web, iOS App Store and Google Play from one
codebase (Capacitor)"); "Mobile and Capacitor" ("Frontend stack" (safe areas, haptics, native share
sheet, splash screen, adaptive icons), "Capacitor plugins" (every row except biometric lock, P2),
"App store requirements", "Responsive web"); "Accounts and authentication" ("Sign-in methods" (iOS/
Android columns), "Sign-up flow" step 2 (one-time-code autofill) and step 8 (permission primer, then
system photo picker), "Invites" ("The link opens the app if installed (Universal Links / App
Links), otherwise the web app"), "Sessions and tokens" (**Mobile:** Keychain/Keystore, never WebView
localStorage, 90 days), "Account deletion and recovery" (in-app deletion on native)); FR-2.1/FR-2.2
(camera roll, background upload on mobile); FR-2.3 (originals untouched, HEIC); "Non-functional
requirements → Privacy and child safety", "Compliance" (App Store privacy label, Play Data Safety,
no tracking SDKs), "Accessibility and UX" (dynamic type, VoiceOver/TalkBack, offline recent photos);
"Decisions to confirm before step 1 → Domain" (`/.well-known/apple-app-site-association` and
`/.well-known/assetlinks.json` served by the web container); "Compose requirements → Phones in dev";
"Risks" (app-store rejection: system picker, usage strings, demo account, AI disclosure).

`CLAUDE.md` clarifications applied: email 6-digit OTP is the primary sign-in on native; magic link
is web-only (native never relies on it); passwordless only; auth is self-hosted GoTrue reached
through the API (`/api/auth/*`), never supabase-js; storage is MinIO everywhere; share links 24 h,
viewers get no chat; AI is paid-tier only and free-tier photos are never sent to a model (this step
makes **no model call**; push "photos analyzed" only exists for Plus babies because only they get
`photo_ai` rows). User memory applied: no per-step reviewer pass (the **combined review of steps
1–9 runs after this step**, on Fable); cloudflared runs outside Compose; dev defaults to the fake AI
provider; every UI change gets the light/dark × phone/desktop screenshot check (`docs/DESIGN.md`).

What already exists (verified in the repo):
- `apps/mobile-web/src/platform/platform.ts` (`isNative()` returns `false`; `clientKind()`),
  `platform/tokenStore.ts` (`TokenStore {get,set,clear}`, web no-op, `setTokenStore()`),
  `platform/uploader.ts` (`Uploader.putPart(url, blob)`, `setUploader()`); `lib/api.ts` already
  sends `X-Tinyglow-Client: native` + `Authorization: Bearer` and refreshes with
  `{refreshToken}` in the body when `isNative()`; `lib/sse.ts`, `lib/shareApi.ts` and
  `components/SystemStatus.tsx` use relative `/api` / `/auth` URLs.
- API (step 3): native transport returns tokens in the body (no cookies) for `/auth/verify`,
  `/auth/refresh`, `/auth/pkce`, `/auth/id-token`; `/auth/id-token` implemented but providers are
  off; sessions list with `userAgentLabel()` (`packages/shared/src/auth.ts`); GoTrue session
  inactivity 90 d. Step 8: viewer exchange with `X-Tinyglow-Client: native` returns
  `viewerToken` in the body and viewer routes accept `Authorization: Bearer` (the native seam);
  pino already redacts `req.body.token`.
- Upload (step 4): resumable multipart, 16 MiB parts, presigned PUTs with no custom headers, the
  **server** completes via ListParts (the client never needs ETags), resume record keyed by
  SHA-256 + size in `localStorage` (no secrets in it).
- `apps/mobile-web/public/.well-known/apple-app-site-association` (`{"applinks":{"apps":[],
  "details":[]}}`) and `assetlinks.json` (`[]`); nginx serves both as `application/json`
  (`docker/nginx/default.conf`), the Vite plugin `aasaJson()` matches in dev.
- MinIO CORS: dev `*`; prod `${S3_CORS_ALLOW_ORIGIN:-${PUBLIC_URL}}` with a comment reserving the
  Capacitor origins for step 9. The API has **no CORS** today (same-origin only).
- Seeded demo family (dev only): 12 photo rows with **placeholder storage keys and no objects**
  (open issue from steps 4–8); `pnpm perf:seed` already renders images with sharp.
- `lib/imageCache.ts` (offline cache) already keys on a synthetic `https://` origin because the
  Cache API rejects `capacitor://`.

## 1. Goal

Ship the existing React/Ionic app as real iOS and Android apps from the same codebase, with
everything that needs no Apple/Google account built and proven now on the iOS Simulator and an
Android emulator, and a short, exact checklist for the parts that need the user's accounts
(TestFlight, Play internal testing, APNs/FCM, social sign-in, store listings). Concretely: Capacitor
projects for both platforms (bundle id `app.tinyglow`, D1) with plain-language
permission strings, an iOS privacy manifest, Android Photo Picker (no media permission), no-backup
rules for tokens and cached photos, splash and adaptive icons; a native platform layer that points
the bundled app at the API origin (`VITE_API_URL`), stores GoTrue access/refresh tokens only in the
Keychain/Keystore, signs in with the email 6-digit code (one-time-code autofill), and keeps sessions
90 days; deep links for `/invite/{token}`, `/s/{token}` and the native auth callback path through
Universal Links / App Links (association files with placeholder team id and certificate
fingerprint until the user provides them) plus a debug-only custom scheme for simulator testing;
share-link viewing inside the app through the step-8 bearer exchange; camera-roll selection of up
to 500 originals (HEIC kept) with uploads that continue when the app is backgrounded (native
URLSession / WorkManager uploader); opt-in push notifications ("photos ready to search", "someone
opened your shared album") with device registration, a provider-neutral sender (fake in dev, APNs and
FCM adapters tested against mock servers, live once keys exist), generic lock-screen text and no
personal data in payloads; real images for the seeded demo family and a store-review family
provisioning path; store listing drafts (fastlane metadata layout), App Store privacy label and Play
Data Safety drafts, review notes. The PRD acceptance check itself (TestFlight / Play internal builds
install; links open the app) is **user-blocked** and is listed with exact steps in section 5.2.

## 2. Interfaces first

### 2.1 Topology

```
iOS app  (WKWebView origin capacitor://localhost)  ┐  fetch ${VITE_API_URL}/api/*   X-Tinyglow-Client: native
Android  (WebView  origin https://localhost)       ┘  Authorization: Bearer <GoTrue access JWT>  (no cookies, CORS, 2.3)
   │  tokens ⇄ Keychain / Keystore (secure-storage plugin)           presigned PUT/GET ⇄ S3_PUBLIC_ENDPOINT (MinIO)
   │  background PUT of whole-file parts ⇄ native uploader (URLSession background / WorkManager)
   │  appUrlOpen https://tinyglow.app/{invite/…, s/…, signin/native…} ⇒ router path (2.4)
   │  push token ⇒ POST /api/me/push-devices                          APNs / FCM ⇐ worker push.notify (2.8)
dev:  iOS Simulator ⇒ http://localhost:8080 (+ :9000)   Android emulator ⇒ adb reverse tcp:8080 / tcp:9000 ⇒ localhost
prod: https://tinyglow.app (nginx ⇒ api)   https://files.tinyglow.app (MinIO)
```

No new server-side service. New client dependencies are listed in 2.2 and need approval (R1).
The server gains one migration (16), push routes, one worker queue (`push.notify`) and a
CORS allow-list for the two Capacitor origins.

### 2.2 App identity, toolchain, dependencies

| Item | Decision |
| --- | --- |
| Bundle id / applicationId | `app.tinyglow` (D1; permanent once published) |
| Display name | `Tinyglow` |
| Version | `1.0.0`, build `1` (iOS `CFBundleVersion`, Android `versionCode`), bumped by the release lanes |
| Capacitor | latest stable major (8.x at time of writing) past pnpm's release-age gate; iOS project uses **Swift Package Manager** (Capacitor 8 default; no CocoaPods/Ruby needed to build) |
| iOS | deployment target = Capacitor's default minimum; device family **iPhone only for v1** (D6); Xcode 27.0 |
| Android | `compileSdk`/`targetSdk` **36** (Play's requirement for new apps from 31 Aug 2026; confirm in Play Console), `minSdk` = Capacitor default; JDK 21 (asdf); Gradle wrapper from the Capacitor template |
| `capacitor.config.ts` | `appId`, `appName`, `webDir: "dist"`, `loggingBehavior: "none"` (**always**: Capacitor's debug logging prints plugin call arguments, which would put tokens and presigned URLs into logcat / the Xcode console), `appendUserAgent: "Tinyglow/<version>"`, `server.androidScheme: "https"`, `CapacitorHttp.enabled: false`, `CapacitorCookies.enabled: false`, `android.allowMixedContent` only when `CAP_DEV_MIXED_CONTENT=1` (R6), `server.url` only when `CAP_LIVE_RELOAD_URL` is set (dev live reload; the release scripts refuse to build with it set), plugin config for SplashScreen (`launchAutoHide: false`), Keyboard (`resize: "native"`), PushNotifications (`presentationOptions: ["alert","sound"]`) |

Client dependencies (added once, by 9.1; each needs orchestrator approval, R1):

| Package | Why (PRD row) |
| --- | --- |
| `@capacitor/core`, `@capacitor/ios`, `@capacitor/android`; dev `@capacitor/cli` | runtime + projects |
| `@capacitor/app` | deep links (`appUrlOpen`), back button, `resume` |
| `@capacitor/camera` | "Take a photo in-app" |
| `@capawesome/capacitor-file-picker` | "Pick many photos from library": returns **original files** by path (iOS PHPicker with `skipTranscoding: true` keeps HEIC; Android system Photo Picker, no permission). Chosen over `@capacitor/camera` `pickImages`, which re-encodes to JPEG (breaks FR-2.3/FR-6.1 "original kept untouched") (D7) |
| `@capacitor/filesystem` | read/copy picked files, write share/download temp files ("Read EXIF before upload" row) |
| `@capgo/capacitor-uploader` (tentative) | "Background, resumable upload" (URLSession / WorkManager). Must pass the 9.8 evaluation (raw-body PUT from a file path, no multipart, no extra signed headers, background on both OSes); otherwise 9.8 builds an in-house plugin with the 2.6 contract and 9.1 removes this dep (R2) |
| `@capacitor/push-notifications` | push (APNs token on iOS, FCM token on Android) |
| `@capacitor/share` | "Share link to family" + share/save a downloaded photo |
| `@aparajita/capacitor-secure-storage` | "Secure token storage" (Keychain / Android Keystore). Alternative if it fails 9.6's checks: `capacitor-secure-storage-plugin` (R1) |
| `@capacitor/splash-screen`, `@capacitor/status-bar`, `@capacitor/haptics`, `@capacitor/keyboard` | "Frontend stack": splash, safe areas/status bar style, haptics, keyboard resize |
| root dev `playwright` (same version as `@playwright/test`) | `_android` WebView automation for the Android gate (2.15); no new tool beyond Playwright |

Deferred to 9b (user-blocked, section 5.2): native Sign in with Apple / Google plugin
(`@capgo/capacitor-social-login` recommended) and `@capacitor/browser` (Android Apple web OAuth),
RevenueCat. Not added now (dead code without credentials).

Icons/splash are generated by an in-repo sharp script (sharp is already a root dev dependency), not
`@capacitor/assets`.

### 2.3 Native runtime contract (API origin, CORS, transport)

- **API origin**: `src/platform/apiBase.ts` → `apiUrl(path)` = `${VITE_API_URL}/api${path}` when
  `isNative()`, else `/api${path}` (web unchanged). Same for `authUrl()` (`/auth/health` only).
  `VITE_API_URL` is an origin (`http://localhost:8080` for simulator/emulator builds,
  `https://tinyglow.app` for release, a LAN IP for a physical phone per "Phones in
  dev"). Baked at build time; contains no secret. Every caller (`lib/api.ts`, `lib/sse.ts`,
  `lib/shareApi.ts`, `components/SystemStatus.tsx`) goes through it.
- **CORS (API, `apps/api/src/plugins/cors.ts`)**: only for `Origin` ∈ `NATIVE_APP_ORIGINS`
  (default `capacitor://localhost,https://localhost`). Preflight `OPTIONS` ⇒ 204 with
  `Access-Control-Allow-Origin: <origin>`, `-Methods: GET, POST, PUT, PATCH, DELETE`,
  `-Headers: authorization, content-type, accept, x-tinyglow-client`, `-Max-Age: 600`,
  `Vary: Origin`. Actual responses: `Access-Control-Allow-Origin`, `Vary: Origin`,
  `Access-Control-Expose-Headers: Retry-After`. **Never** `Access-Control-Allow-Credentials` (no
  cookie ever crosses origins). Headers are set with `reply.raw.setHeader` in an `onRequest` hook
  so the chat SSE route (which writes the raw response; ai-engineer-owned) carries them without
  any change to `apps/api/src/chat/**`. A request from a native origin must carry
  `X-Tinyglow-Client: native` (else 403 `csrf_rejected`, same code as step 3). Unknown origins
  get no CORS headers (browser blocks; server behaviour unchanged).
- **MinIO CORS** (`S3_CORS_ALLOW_ORIGIN`): production default becomes
  `${PUBLIC_URL},capacitor://localhost,https://localhost` (the foreground XHR part upload and
  `imageCache` fetches run from the WebView origin); dev stays `*`.
- **Transport**: native never uses cookies. The access token is attached by `lib/api.ts` (exists);
  the refresh token only travels in `POST /api/auth/refresh` bodies. Viewer (share-link) requests
  use the step-8 bearer viewer JWT held **in memory only** (2.7).
- **Dev networking** (no LAN IP needed): iOS Simulator shares the host network, so
  `http://localhost:8080` and presigned `http://localhost:9000` work as signed. Android emulator:
  `adb reverse tcp:8080 tcp:8080 && adb reverse tcp:9000 tcp:9000`, so `localhost` inside the
  emulator reaches the host and presigned URL hosts still match their signatures. Cleartext HTTP is
  allowed only for `localhost`/`127.0.0.1`/`10.0.2.2` in the Android **debug** network security
  config and via iOS `NSAllowsLocalNetworking`; release builds are HTTPS-only.

### 2.4 Deep links

| Path (host `tinyglow.app`) | App route | Notes |
| --- | --- | --- |
| `/invite/{token}` | `/invite/:token` (existing `InvitePage`) | PRD "Invites" |
| `/s/{token}` | `/s/:token` (existing `SharedAlbumPage`, native transport 2.7) | PRD "Share-link viewers" |
| `/signin/native` (+ `?code=` / `#…`) | `/signin/native` (new route; 9b uses it for Android Apple web OAuth PKCE) | the PRD's "auth callback". Deliberately **not** `/signin/callback`: the web OAuth and magic-link callback stays a web page, so a phone with the app installed never steals a web sign-in whose PKCE verifier lives in the browser (D8) |

- **AASA** (`public/.well-known/apple-app-site-association`, served as `application/json`):
  `{"applinks":{"details":[{"appIDs":["APPLE_TEAM_ID.app.tinyglow"],"components":[{"/":"/invite/*"},{"/":"/s/*"},{"/":"/signin/native*"}]}]}}`.
  `APPLE_TEAM_ID` is a literal placeholder until the user provides the team id (5.2).
- **assetlinks.json**: `[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"app.tinyglow","sha256_cert_fingerprints":["PLAY_APP_SIGNING_SHA256","UPLOAD_KEY_SHA256"]}}]`
  (placeholders until Play App Signing exists). `apps/mobile-web/scripts/check-association.ts`
  prints which placeholders remain (warning only; never fails the web build).
- **iOS**: `App.entitlements` `com.apple.developer.associated-domains =
  ["applinks:tinyglow.app"]` (works only once signed with the real team, R5).
- **Android**: one `VIEW` intent filter, `android:autoVerify="true"`, scheme `https`, host
  `tinyglow.app`, `pathPrefix` `/invite/`, `/s/`, `/signin/native`.
- **Debug scheme**: both apps also register `tinyglow://` so the simulator/emulator can test
  routing without association (`xcrun simctl openurl booted tinyglow://s/<t>`). The JS router
  honours custom-scheme URLs **only** when built with `VITE_DEEPLINK_DEV_SCHEME=1` (debug builds);
  release ignores them, so the scheme carries nothing worth intercepting.
- **JS rule** (`src/platform/native/deepLinks.ts`): `toAppPath(url): string | null` accepts only
  `https://<host in VITE_APP_LINK_HOSTS, default tinyglow.app>` (and the dev scheme
  when enabled) with a path matching `^/invite/[A-Za-z0-9_-]{20,128}$`, `^/s/[A-Za-z0-9_-]{22,64}$`
  or `^/signin/native$` (query/fragment kept only for `/signin/native`); anything else ⇒ `null`
  (ignored). The URL is never logged, stored or sent anywhere except as the in-app route.
- **Android emulator test without verification**: `adb shell pm set-app-links-user-selection
  --user 0 --package app.tinyglow true tinyglow.app` then
  `adb shell am start -W -a android.intent.action.VIEW -d https://tinyglow.app/s/<t>`
  (the OS routes to the app because the user-selection is granted; real verification needs the
  production file with the Play fingerprint, 5.2).

### 2.5 Native authentication

- **Email OTP (primary, now)**: unchanged screens; `CodeEntry` keeps
  `autocomplete="one-time-code"`, `inputmode="numeric"` (iOS Mail/Messages and Android autofill).
  `POST /api/auth/verify` with `X-Tinyglow-Client: native` returns `{tokens}`; the app stores
  them via `setTokenStore(secureTokenStore)` at startup.
- **Secure token store** (`src/platform/native/secureTokenStore.ts`): one entry `ll.session.v1`
  = JSON `{accessToken, refreshToken}`; iOS Keychain accessibility
  `afterFirstUnlockThisDeviceOnly` (not synced to iCloud Keychain, not restored to another
  device); Android Keystore-wrapped storage. If the plugin is unavailable or throws, the store is
  **memory-only** for that launch (the user signs in again) and never falls back to
  `localStorage`/`sessionStorage`/Preferences.
- **Session lifetime**: GoTrue inactivity 90 d (exists). On `App` `resume` and at launch the app
  calls the existing single-flight `refreshSession()` when the stored access token's `exp` is
  within 5 minutes (decoded locally, never logged).
- **Sign-out** (local, device, everywhere, account deletion): `DELETE /api/me/push-devices/current`
  (best effort) → existing sign-out call → `tokenStore.clear()` → `imageCache` cleared (exists).
- **Device label**: `appendUserAgent` adds `Tinyglow/<version>`; `userAgentLabel()` maps it to
  "Tinyglow app on iPhone" / "on iPad" / "on Android" in the Devices list.
- **Apple / Google on native**: hidden on native until 9b (the providers are disabled in
  `/api/auth/config` anyway). Rule for 9b, enforced in the client: on iOS, Google is shown only if
  Apple is also enabled (App Store guideline 4.8; PRD "Apple Sign-In mandatory on iOS when Google
  login exists"). Design for 9b is in 5.2.
- **Store review sign-in** (D4, conditional): reviewers cannot receive our OTP emails. Proposed:
  `REVIEW_ACCOUNT_EMAIL` + `REVIEW_ACCOUNT_CODE_HASH` (scrypt string, same format as step-8
  passcodes) on the api only, both unset by default ⇒ feature off. When set, `POST /auth/otp` for
  exactly that email sends nothing (still 202), and `POST /auth/verify` for that email accepts only
  a code matching the hash, then mints a session through GoTrue's admin
  `POST /admin/generate_link {type:"magiclink", email}` + `POST /verify {type:"magiclink",
  token_hash}` (no email sent). Same 5-per-10-min verify throttle; audit `auth.sign_in` with
  `metadata.method = "review"`; the account must only ever own the synthetic review family (2.11).

### 2.6 Native upload

- **Pick** (`src/platform/native/picker.ts`): `pickPhotos({ limit: 500 })` →
  `NativeFileRef[] = { path, name, mime, size }` via `FilePicker.pickImages({ limit, readData:
  false, skipTranscoding: true })`; `takePhoto()` via `@capacitor/camera` (`resultType: Uri`,
  `saveToGallery: false`, `quality: 100`). Both copy the result into
  `Caches/ll-uploads/<clientId>.<ext>` (persistent until the upload ends; deleted after
  `completed`/`failed`/`aborted` and on sign-out) because picker temp files can vanish while the
  app is suspended.
- **Into the existing manager**: `fileFromRef(ref)` → `File` built from
  `fetch(Capacitor.convertFileSrc(path))` (needed for the existing SHA-256 + EXIF hint + validate
  steps, one file at a time). `UploadManager` gets an optional `nativeRef` per item; nothing else
  in the pipeline changes (register, presign, server-side complete, resume by SHA-256).
- **Uploader contract** (`src/platform/uploader.ts`, extended, backwards compatible):

```ts
export interface NativeFileRef { path: string; name: string; mime: string; size: number }
export interface Uploader {
  putPart(url: string, blob: Blob, opts?: PutPartOptions): Promise<void>;          // unchanged (XHR on web)
  /** Native only: background PUT of the whole file as one part (file size <= part size). */
  putFile?(url: string, file: NativeFileRef, opts?: PutPartOptions): Promise<void>;
}
```

  The manager calls `putFile` when the item has a `nativeRef` and the file is a single part
  (≤ 16 MiB, nearly every photo); multi-part files use `putPart` with `Blob.slice` in the
  foreground (documented limitation, R2). Rejections reuse `PartUploadError(status)`.
- **Native uploader requirements** (9.8; whichever implementation): HTTP `PUT`, body = raw file
  bytes, no multipart encoding, no headers beyond what the OS adds (the presigned URL signs none);
  iOS background `URLSession` (`uploadTask(with:fromFile:)`), continues when the app is suspended;
  Android WorkManager (expedited / foreground `dataSync` with an "Uploading N photos" notification
  where required); progress events; resolves with the HTTP status; never logs URLs (they carry
  `X-Amz-Signature`). If the in-house plugin is needed, its bridge is `TinyglowUploader`:
  `upload({ url, path }) → { id }`, `cancel({ id })`, events `progress { id, sent, total }`,
  `done { id, status }`, `error { id, message }`.
- **Background semantics**: JS does prep/hash/register in the foreground (the screen says "Keep
  the app open until photos are queued; uploads continue in the background after that"). PUTs run
  natively; when the app resumes, pending promises resolve and the manager calls `complete` as
  today. If the OS killed the app, the existing resume record + `GET …/parts` (ListParts) shows
  which files already reached storage; the user re-picks only the rest (same as web reload).
  FR-2.6 auto-backup (P2) is out of scope.
- **Privacy**: the client never logs paths, EXIF, GPS or URLs. Android's Photo Picker redacts GPS
  from picked images (D9); iOS keeps it (the server encrypts it, step 4).

### 2.7 Share-link viewing in the app

`lib/shareApi.ts` on native: `POST /api/share/session` with `X-Tinyglow-Client: native` ⇒
`viewerToken` kept **in a module variable only** (never stored), sent as `Authorization: Bearer` on
`/api/share/*`. On 401/410 it re-runs the exchange once (covers a renewed link: the step-8 seam
"native clients re-run the exchange after a renew"), then shows `share-expired`. The PWA manifest
link and install prompt are skipped on native. The share sheet (`ShareUrlSheet`) uses
`@capacitor/share` on native. Viewer downloads and admin original downloads on native: fetch the
signed URL → write to `Caches/ll-share/` → `Share.share({ files: [uri] })` (user picks "Save
Image"; temp file deleted after the sheet closes).

### 2.8 Push notifications

**Kinds** (PRD "Capacitor plugins": "23 photos analyzed", "Grandma viewed the album"):

| Kind | Trigger | Recipients | Text (fixed, English, i18n key on device unused) | Data |
| --- | --- | --- | --- | --- |
| `photos_analyzed` | worker `photo.reindex` jobs with `reason: "ai"` ⇒ enqueue per baby | admins of a **Plus** baby with the pref on | title "Tinyglow", body "{n} new photos are ready to search." (n = 1 ⇒ "1 new photo is ready to search.") | `{kind, babyId}` |
| `share_viewed` | API viewer exchange that **creates a new viewer session** (not a reused cookie/bearer) | admins of the link's baby with the pref on | title "Tinyglow", body "Someone opened your shared album." | `{kind, babyId, shareLinkId}` |

No baby name, link name, caption, count of sensitive photos or any parent text ever goes to
Apple/Google (D10). Contributors get no push. Tap routing: `photos_analyzed` ⇒ select `babyId`,
open Chat (home); `share_viewed` ⇒ select `babyId`, open Family.

**Opt-in**: nothing is requested at launch. Settings → Notifications (native only) has "Turn on
notifications" and two toggles (prefs on `profiles`); after the first completed upload a one-time
primer offers it. iOS `requestPermissions()`, Android 13+ `POST_NOTIFICATIONS`. Android push
registration runs only when built with `VITE_PUSH_ANDROID=1` (requires `google-services.json`,
5.2); otherwise the toggle reads "Notifications are not available in this build".

**API (backend-engineer, `apps/api/src/routes/push.ts`)**

| Method, path | Guards | Request → Response | Behaviour |
| --- | --- | --- | --- |
| `POST /me/push-devices` | Auth, Consent, `X-Tinyglow-Client: native` (else 400 `validation_failed` "Notifications are only available in the app") | `pushDeviceRegisterRequest` → 201 `pushDeviceResponse` | in-memory throttle 20/h/user ⇒ 429; `SELECT register_push_device(...)` under the caller's claims; `req.body.token` is already pino-redacted; never logged |
| `DELETE /me/push-devices/current` | Auth | → 204 | `unregister_push_devices_for_session()` |
| `PATCH /me/profile` (existing) | Auth, Consent | gains `notifyPhotosAnalyzed?`, `notifyShareViewed?` | column grants (2.9) |
| `GET /me` (existing) | Auth | `profile` gains both booleans | |

**Job**: `push.notify` (`pushNotifyJobSchema`, discriminated on `kind`: `{kind:"photos_analyzed",
babyId}` | `{kind:"share_viewed", shareLinkId}`), pg-boss queue policy `short` (one queued job per
`singletonKey` = `${kind}:${id}`, so a burst coalesces), `startAfter` = `PUSH_PHOTOS_DEBOUNCE_SEC`
(600) / `PUSH_SHARE_DEBOUNCE_SEC` (60), `retryLimit 2`, `expireInSeconds 300`. Worker queues: 13.

**Worker (backend-engineer, `apps/worker/src/push/**`)**

```ts
export interface PushMessage { title: string; body: string; data: PushData; collapseId: string }
export type PushSendStatus = "sent" | "fake" | "failed" | "invalid_token" | "unconfigured";
export interface PushSender { send(target: { provider: "apns" | "fcm"; token: string }, msg: PushMessage): Promise<PushSendStatus> }
export function createPushSender(config: PushConfig, log: WorkerLog): PushSender;
// PUSH_PROVIDER=none ⇒ "unconfigured" (production default until keys exist)
// PUSH_PROVIDER=fake ⇒ "fake" + one log line {kind, provider} (dev default; refused when NODE_ENV=production)
// PUSH_PROVIDER=live ⇒ APNs for provider "apns" if APNS_* set, FCM for "fcm" if FCM_* set, else "unconfigured"
```

- APNs: `node:http2` to `PUSH_APNS_BASE_URL` (default `https://api.sandbox.push.apple.com` when
  `APNS_ENVIRONMENT=sandbox`, `https://api.push.apple.com` for `production`), `POST
  /3/device/<token>`, headers `authorization: bearer <ES256 JWT (iss=APNS_TEAM_ID, kid=APNS_KEY_ID),
  cached 50 min>`, `apns-topic: APNS_BUNDLE_ID`, `apns-push-type: alert`, `apns-priority: 5`,
  `apns-collapse-id`, `apns-expiration: now+24h`; body `{aps:{alert:{title,body},sound:"default"},
  ll:data}`. 410, or 400 `BadDeviceToken`/`Unregistered` ⇒ `invalid_token`.
- FCM HTTP v1: service-account JWT (RS256, scope `https://www.googleapis.com/auth/firebase.messaging`)
  ⇒ `PUSH_OAUTH_TOKEN_URL` (default from the JSON's `token_uri`) ⇒ bearer cached until expiry;
  `POST ${PUSH_FCM_BASE_URL}/v1/projects/<FCM_PROJECT_ID>/messages:send` with `{message:{token,
  notification:{title,body}, data:{kind, babyId, shareLinkId?} (strings), android:{priority:"NORMAL",
  collapse_key, notification:{channel_id:"default"}}}}`. 404 `UNREGISTERED` / 400 on the token
  field ⇒ `invalid_token`.
- JWTs via `jose` (already a repo dependency; 9.1 adds it to the worker). No Firebase/APNs SDKs.
  Never log tokens, JWTs, bodies or responses; log `kind`, provider, status, counts.
- Handler `notify.ts`: `photos_analyzed`: skip unless `baby_ai_enabled`; `targets =
  push_targets(babyId, kind)`; per target: if `last_sent_at` is within `PUSH_MIN_GAP_MIN` (60),
  re-send the job once with `startAfter` = the remaining gap and skip; `n =
  push_photos_analyzed_count(babyId, max(last_sent_at, now() − 24 h))`; `n = 0` ⇒ skip; send;
  `push_record_delivery(...)`. `share_viewed`: baby from `share_link_baby(shareLinkId)` (via the
  target function), same gap rule per baby+kind, send, record.
- Reindex hook (`apps/worker/src/reindex.ts`): after the batch, `SELECT DISTINCT baby_id FROM
  photos WHERE id = ANY($ids)` for jobs with `reason = "ai"` ⇒ `sendPushNotify({kind:
  "photos_analyzed", babyId})` per baby, in its own try/catch (a push failure never fails or delays
  reindexing). No ai-engineer file changes.

### 2.9 Database (migration `1792200000100_native-push.sql`, security-engineer)

Conventions as before (reversible, ENABLE + FORCE RLS on new tables, policies `TO <role>`, column
grants, SECURITY DEFINER with pinned `search_path`, `REVOKE … FROM PUBLIC`, fixed error messages,
every policy change tested, nothing logs tokens).

1. **`push_devices`**: `id uuid PK default gen_random_uuid()`, `user_id uuid NOT NULL REFERENCES
   profiles(user_id) ON DELETE CASCADE`, `session_id uuid NOT NULL` (GoTrue session; no FK into
   `auth`), `platform text CHECK (platform IN ('ios','android'))`, `provider text CHECK (provider
   IN ('apns','fcm'))`, `CHECK ((platform='ios') = (provider='apns'))`, `token text NOT NULL`
   (`CHECK (length(token) BETWEEN 8 AND 4096 AND token !~ '\s')` — not parent text, plain CHECK
   allowed), `app_version text NOT NULL CHECK (app_version ~ '^[0-9A-Za-z.+-]{1,32}$')`,
   `created_at`, `last_registered_at`, `disabled_at timestamptz`, `disabled_reason text CHECK IN
   ('invalid_token')`; `UNIQUE (token)`; index `(user_id)`.
   Grants: `authenticated` SELECT `(id, platform, provider, app_version, created_at,
   last_registered_at, disabled_at)` + DELETE, policies `USING (user_id = auth_uid())`; no
   INSERT/UPDATE (functions only); `service_role` ALL; `viewer`, `pipeline`: nothing.
2. **`push_deliveries`** (ledger for gaps, gate proof, support): `id bigint identity PK`,
   `device_id uuid REFERENCES push_devices ON DELETE CASCADE`, `user_id uuid NOT NULL REFERENCES
   profiles(user_id) ON DELETE CASCADE`, `baby_id uuid NOT NULL REFERENCES babies ON DELETE
   CASCADE`, `share_link_id uuid REFERENCES share_links ON DELETE SET NULL`, `kind text CHECK IN
   ('photos_analyzed','share_viewed')`, `status text CHECK IN ('sent','fake','failed',
   'invalid_token','unconfigured')`, `item_count int`, `created_at`. Index `(user_id, baby_id, kind,
   created_at DESC)`. ENABLE + FORCE RLS; `service_role` only (functions for pipeline).
3. **`profiles`**: `notify_photos_analyzed boolean NOT NULL DEFAULT true`, `notify_share_viewed
   boolean NOT NULL DEFAULT true`; `GRANT SELECT, UPDATE (both)` to `authenticated` (existing
   own-row policies). Defaults are true because the OS permission + "Turn on notifications" is the
   opt-in; the toggles are per-kind opt-outs.
4. Functions (all SECURITY DEFINER, `REVOKE … FROM PUBLIC`; guard `to_regclass('auth.sessions')`
   like migration 10):
   - `register_push_device(p_platform text, p_provider text, p_token text, p_app_version text)
     RETURNS uuid` — `authenticated`. Needs `auth_uid()` and the claims' `session_id` (else raise
     `push registration needs a session`). In one statement set: delete any row with `token =
     p_token` (another user or session on a shared phone loses it), delete other rows for
     `(auth_uid(), session_id)`, insert, return id.
   - `unregister_push_devices_for_session() RETURNS integer` — `authenticated`: deletes rows of
     `auth_uid()` for the claims' `session_id`.
   - `push_targets(p_baby_id uuid, p_kind text) RETURNS TABLE (device_id uuid, user_id uuid,
     provider text, token text, last_sent_at timestamptz)` — `pipeline`, `service_role`: devices
     with `disabled_at IS NULL` of users who are **admins** of the baby, baby `deleted_at IS NULL`,
     profile `deleted_at IS NULL` and the kind's pref true, and whose `session_id` is still a live
     row in `auth.sessions` for that user (so sign-out, sign-out-everywhere, per-device sign-out,
     idle expiry and account deletion all stop pushes with no extra code path); for
     `photos_analyzed` also `baby_ai_enabled(p_baby_id)`. `last_sent_at` = latest delivery to that
     user for (baby, kind) with status `sent`/`fake`.
   - `push_photos_analyzed_count(p_baby_id uuid, p_since timestamptz) RETURNS integer` —
     `pipeline`, `service_role`: `photo_ai` rows created after `p_since` for approved, live,
     unquarantined photos of the baby.
   - `push_link_baby(p_share_link_id uuid) RETURNS uuid` — `pipeline`: the link's live baby.
   - `push_record_delivery(p_device_id uuid, p_baby_id uuid, p_share_link_id uuid, p_kind text,
     p_status text, p_count int) RETURNS void` — `pipeline`: inserts the ledger row;
     `invalid_token` ⇒ `disabled_at = now(), disabled_reason = 'invalid_token'`; deletes that
     device's ledger rows older than 30 days.
5. **Seed** (`packages/db/src/seed.ts`): demo photo rows become `image/jpeg` with `.jpg` original
   keys (2.11 writes real JPEG originals; HEIC originals cannot be rendered in-repo); nothing else
   changes. If an existing test depends on seeded HEIC rows, keep them and report (test-engineer
   updates in 9.14).
6. **Review family** (`packages/db/src/review-family.ts`, `pnpm db:review-family --email <addr>
   [--confirm-production]`, superuser like `db:plan`, audited): for an **existing** GoTrue user (the
   review account signs up normally once), creates baby "Sunny" (birth date 10 months before
   today), 24 photo rows `status='uploaded'`, `approval` approved, original keys
   `review/<photoId>.jpg`, parent details (milestones first smile/first steps/first food, people
   "Grandma", "Dad", notes in plain English), 4 measurements, plan `plus` with
   `plan_owner_user_id` = that user (no billing; audit `baby.plan_changed {source:"review"}` or the
   existing `db:plan` event). Idempotent by fixed ids derived from the user id. Refuses
   `NODE_ENV=production` without `--confirm-production`. Prints only ids and counts. Objects and
   derivatives are written by 9.12.
7. Regenerate `packages/db/src/generated`; README rows (push tables, functions, who may write
   what, review-family runbook). `pgmigrations` becomes **16**.

### 2.10 Shared contracts (`@tinyglow/shared`; architect-defined, backend-engineer writes in 9.2 with orchestrator approval)

- `src/native.ts` (new): `APP_ID = "app.tinyglow"`, `APP_NAME = "Tinyglow"`,
  `APP_UA_TOKEN = "Tinyglow"`, `APP_LINK_HOST_DEFAULT = "tinyglow.app"`,
  `DEV_URL_SCHEME = "tinyglow"`, `DEEP_LINK_PATTERNS` (the three regexes of 2.4),
  `NATIVE_ORIGINS_DEFAULT = ["capacitor://localhost", "https://localhost"]`,
  `NATIVE_UPLOAD_PICK_MAX = 500` (= `UPLOAD_MAX_FILES_PER_SESSION`).
- `src/push.ts` (new, browser-safe): `pushPlatformSchema`, `pushProviderSchema`,
  `pushKindSchema = z.enum(["photos_analyzed","share_viewed"])`, `pushDataSchema`
  (discriminated union of 2.8 data), `pushDeliveryStatusSchema`, `pushMessage(kind, count) →
  {title, body}` (exact strings of 2.8), constants `PUSH_TOKEN_MAX_CHARS = 4096`,
  `PUSH_REGISTRATIONS_PER_HOUR = 20`, `PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT = 600`,
  `PUSH_SHARE_DEBOUNCE_SEC_DEFAULT = 60`, `PUSH_MIN_GAP_MIN_DEFAULT = 60`.
- `src/api/push.ts` (new): `pushDeviceRegisterRequestSchema = z.strictObject({ platform, provider,
  token: z.string().min(8).max(4096).regex(/^\S+$/), appVersion: /^[0-9A-Za-z.+-]{1,32}$/ })`
  refine ios⇔apns / android⇔fcm; `pushDeviceResponseSchema { device: { id, platform, createdAt } }`.
- Profile DTOs: `profileUpdate` gains `notifyPhotosAnalyzed?`, `notifyShareViewed?` (booleans);
  the profile in `meResponse` gains both (required).
- `src/jobs.ts`: `JOBS.pushNotify = "push.notify"`, `pushNotifyJobSchema`.
- `src/env.ts`: `pushEnvSchema` (worker: `PUSH_PROVIDER` enum `none|fake|live` default `none`,
  `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY_BASE64`, `APNS_BUNDLE_ID` default `APP_ID`,
  `APNS_ENVIRONMENT` `sandbox|production` default `sandbox`, `FCM_PROJECT_ID`,
  `FCM_SERVICE_ACCOUNT_BASE64`, `PUSH_APNS_BASE_URL`, `PUSH_FCM_BASE_URL`, `PUSH_OAUTH_TOKEN_URL`,
  `PUSH_PHOTOS_DEBOUNCE_SEC` 0..3600, `PUSH_SHARE_DEBOUNCE_SEC` 0..3600, `PUSH_MIN_GAP_MIN`
  0..1440; `emptyAsUndefined`; refine `fake` refused in production), `nativeCorsEnvSchema` (api:
  `NATIVE_APP_ORIGINS` comma list, each `^(capacitor|https?)://[A-Za-z0-9.-]+(:\d{1,5})?$`),
  `reviewAccountEnvSchema` (api: both or neither of `REVIEW_ACCOUNT_EMAIL`,
  `REVIEW_ACCOUNT_CODE_HASH`; hash must start `scrypt$1$`).
- `src/auth.ts`: `userAgentLabel()` recognises `Tinyglow/<ver>` ⇒ "Tinyglow app on iPhone|
  iPad|Android"; `auditMetadataSchema` gains `method: z.enum(["review"]).optional()` (D4).
- `index.ts` re-exports.

### 2.11 Demo media and the store-review family

- **Dev demo family (closes the open issue)**: `apps/worker/src/demo/illustrations.ts` builds 12
  (dev) + 24 (review) deterministic **SVG illustrations** of non-real babies matching each seeded
  caption (sleeping in a blanket, smiling on a mat, tummy time, a bath tub with bubbles and no body
  visible, Christmas tree, first steps on grass, …) in the `docs/DESIGN.md` palette; rendered to
  JPEG by sharp with **no metadata at all** (no EXIF/GPS/ICC beyond sRGB). `ensureDemoMedia()` runs
  at worker start **only** when `SEED_DEMO_FAMILY=true` and `NODE_ENV !== "production"`: for each
  seeded demo photo, `HEAD` the original; if missing, put the JPEG at `storage_key_original` and
  write thumb/display/analysis through the **existing ingest derivative function** (same
  stripping), updating `photo_derivatives` width/height/bytes. Idempotent, logs ids/counts only,
  never blocks worker readiness (failure ⇒ warn). A fresh clone therefore shows real thumbnails for
  Maya with zero setup. CLI `pnpm demo:media [--check]` runs or verifies it on demand.
- **Review family**: `pnpm demo:media --review-baby <babyId> [--confirm-production]` puts the 24
  review JPEGs at the rows' `review/…` keys and enqueues the normal `ingest` job for each (real
  pipeline: derivatives, dedupe, then AI on Plus if a provider is configured), so the reviewer sees
  analysed photos, chat and a share link. Runs in production only with the flag and the user's
  approval (5.2).
- Only the worker's S3 credentials are used; the pipeline DB role; no model call from the script.

### 2.12 Native projects (mobile-engineer)

**iOS (`apps/mobile-web/ios/**`)**
- `Info.plist`: `NSPhotoLibraryUsageDescription` "Tinyglow lets you choose photos of your baby
  to add to your private album. Only the photos you pick are uploaded.";
  `NSPhotoLibraryAddUsageDescription` "Tinyglow saves photos you download from your album to
  your photo library."; `NSCameraUsageDescription` "Tinyglow uses the camera so you can take a
  photo of your baby and add it straight to your private album."; **no** location, contacts,
  microphone or tracking keys; `ITSAppUsesNonExemptEncryption = NO` (HTTPS only);
  `NSAppTransportSecurity.NSAllowsLocalNetworking = YES` (dev localhost; no arbitrary loads);
  `CFBundleURLTypes` `tinyglow`; portrait on iPhone; `UIViewControllerBasedStatusBarAppearance`
  per Capacitor; display name "Tinyglow".
- `App.entitlements`: associated domains (2.4), `aps-environment = development` (production set by
  the release export). Team: `DEVELOPMENT_TEAM` empty in the repo (simulator builds sign ad hoc).
- `PrivacyInfo.xcprivacy` (app target): `NSPrivacyTracking = false`, `NSPrivacyTrackingDomains =
  []`, `NSPrivacyCollectedDataTypes`: Email Address, Name, Photos or Videos, Other User Content
  (notes, milestones, measurements, chat messages), Search History (chat/search queries), User ID,
  Precise Location (GPS from photo metadata, stored encrypted; D11) — each `Linked = true`,
  `Tracking = false`, purpose `App Functionality`; `NSPrivacyAccessedAPITypes` for any
  required-reason API used by app code (UserDefaults `CA92.1` if used; Capacitor and plugins ship
  their own manifests — 9.8 verifies each bundled plugin has one).
- `AppDelegate.swift`: Capacitor push forwarding (`didRegisterForRemoteNotificationsWithDeviceToken`
  / `didFailToRegister…`); at launch mark `Library/WebKit` and `Library/Caches/ll-*` with
  `isExcludedFromBackup = true` (the Cache-API photo cache and WebView storage must not go to
  iCloud backups, R7); no logging of URLs/tokens.

**Android (`apps/mobile-web/android/**`)**
- `AndroidManifest.xml`: `INTERNET`, `POST_NOTIFICATIONS`, `CAMERA` (only if the camera plugin
  needs it); explicitly **remove** `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`,
  `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `ACCESS_MEDIA_LOCATION`, any location
  permission (`tools:node="remove"`) so no plugin merges them in (Play's photo-permission policy;
  PRD prefers the Photo Picker); foreground-service permission/type only if the uploader needs
  it; `android:allowBackup="false"`, `android:fullBackupContent="false"`,
  `android:dataExtractionRules="@xml/data_extraction_rules"` excluding everything (tokens, WebView
  storage and cached photos never go to Google backups); deep-link intent filter (2.4) +
  `tinyglow` scheme; `windowSoftInputMode="adjustResize"`.
- `network_security_config`: main = no cleartext; `src/debug/res/xml/…` permits cleartext for
  `localhost`, `127.0.0.1`, `10.0.2.2` only.
- FCM: the Capacitor template applies `com.google.gms.google-services` only when
  `app/google-services.json` exists (git-ignored); default notification channel `default`
  ("Album updates"), monochrome small icon.
- Release signing reads `android/keystore.properties` (git-ignored) or env; absent ⇒ release
  tasks fail with a clear message; debug uses the standard debug key.

**Icons and splash**: sources `apps/mobile-web/resources/{icon.svg, icon-foreground.svg,
splash.svg}` (brand mark of the step-8 viewer icons, coral on white / dark variant);
`apps/mobile-web/scripts/native-assets.ts` (sharp) writes the iOS 1024 px single-size AppIcon (+
dark/tinted variants), Android adaptive icon foreground/background + legacy mipmaps, splash images
for light/dark.

### 2.13 Store metadata and privacy drafts (mobile-engineer)

- `apps/mobile-web/fastlane/` layout (text only; fastlane is **not installed** now, R8):
  `metadata/en-US/{name, subtitle, description, keywords, promotional_text, release_notes,
  privacy_url, support_url, marketing_url}.txt`, `metadata/review_information/{notes,
  demo_user, demo_password(placeholder "see 5.2")}.txt`, `metadata/android/en-US/{title,
  short_description, full_description}.txt` + `changelogs/1.txt`; `Fastfile` with lanes `ios beta`
  (build + upload to TestFlight with an App Store Connect API key) and `android internal` (AAB to
  the internal track with a Play service account); `Appfile` with placeholders; `apps/mobile-web/Gemfile`.
- Listing copy must include the **AI disclosure** ("Plus uses AI from our model provider to
  describe your photos so you can search them; free accounts are never analysed; your photos are
  never used to train models"), "no ads, no tracking", age rating 4+ / Everyone, privacy policy URL
  `https://tinyglow.app/legal/privacy` (page exists; real text is a user item).
- `apps/mobile-web/store/`: `privacy-nutrition-label.md` (App Store Connect answers, mirroring
  `PrivacyInfo.xcprivacy`), `data-safety.md` (Play form answers: data types collected, purposes,
  encrypted in transit, deletion request supported, not shared — model providers are service
  providers; precise location from photo metadata), `age-rating.md`, `review-notes.md` (what the
  app does, the review account, where AI is, how sharing works, "sample photos are illustrations
  of non-real babies"), `screenshots.md` (required sizes: iPhone 6.9" and 6.5" sets, Android phone;
  which screens; captured from the simulator/emulator in 9.17), `release-checklist.md` (5.2 as a
  checklist).
- `apps/mobile-web/NATIVE.md`: build/run instructions for both platforms (2.3 dev networking,
  scripts, disk notes, how to add the team id / fingerprints / google-services.json later).

### 2.14 Env, compose, nginx, scripts, CI (devops-engineer)

| Item | Change |
| --- | --- |
| `.env.dev` | `NATIVE_APP_ORIGINS=capacitor://localhost,https://localhost`, `PUSH_PROVIDER=fake`, `PUSH_PHOTOS_DEBOUNCE_SEC=600`, `PUSH_SHARE_DEBOUNCE_SEC=60`, `PUSH_MIN_GAP_MIN=60` (one-line comments) |
| `docker-compose.dev.yml` | `api` gets `NATIVE_APP_ORIGINS`; `worker` gets `PUSH_*` and `SEED_DEMO_FAMILY` (demo media); `PUSH_PHOTOS_DEBOUNCE_SEC` / `PUSH_SHARE_DEBOUNCE_SEC` / `PUSH_MIN_GAP_MIN` as Compose interpolations so the push gate can recreate the worker with 0 (like `VISION_PROVIDER`) |
| `.env.example`, `docker-compose.yml` | `NATIVE_APP_ORIGINS` (api); `PUSH_PROVIDER=none`, `APNS_*`, `FCM_*` (**worker only**); `REVIEW_ACCOUNT_EMAIL`, `REVIEW_ACCOUNT_CODE_HASH` (**api only**, commented out); `S3_CORS_ALLOW_ORIGIN` default `${PUBLIC_URL},capacitor://localhost,https://localhost`; comments on how to produce each value |
| nginx | nothing new (`/.well-known/*` served, `/api/` passes `OPTIONS`); verify `/signin/native` falls to the SPA |
| `.gitignore`, `biome.json`, vitest excludes | ignore `apps/mobile-web/ios/App/App/public`, `ios/App/build`, `ios/DerivedData`, `android/app/src/main/assets/public`, `android/**/build`, `android/.gradle`, `android/app/google-services.json`, `android/keystore.properties`, `*.jks`, `*.keystore` (except none committed), `ios/App/App/GoogleService-Info.plist`, `apps/mobile-web/fastlane/report.xml`, `e2e/native-results/` |
| CI (9.16) | job `android-debug` (ubuntu, JDK 21, Android SDK from the runner image): `pnpm --filter @tinyglow/mobile-web native:sync:android && ./gradlew assembleDebug lintDebug`, then the manifest-permission check; job `ios-sim-build` on `macos-latest` **manual (`workflow_dispatch`) only** (cost): `native:sync:ios` + `xcodebuild … -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build`; integration report names for step 9; hygiene step (2.15) |

### 2.15 Tests and gates (test-engineer)

- **Unit, shared**: `push.test.ts` (messages exact, no names possible: the function takes only
  kind+count; data schema), `api/push.test.ts` (ios⇔apns refine, token shape), `native.test.ts`
  (deep-link regexes), `auth.test.ts` (`userAgentLabel` for the app UA), env schemas (fake refused
  in production, origins parse, review pair).
- **Unit, web** (`apps/mobile-web/src/**/*.test.ts(x)`, Capacitor plugins mocked):
  `deepLinks.test.ts` (accept matrix; dev scheme only with the flag; foreign hosts, `/signin/callback`,
  traversal, long tokens rejected), `secureTokenStore.test.ts` (never touches `localStorage`/
  `sessionStorage`; memory fallback), `apiBase.test.ts`, `api.native.test.ts` (bearer + native
  header + absolute URL; no `credentials: include`), `shareApi.native.test.ts` (bearer viewer token
  in memory, re-exchange once on 410), `uploader.native.test.ts` (single-part ⇒ `putFile`,
  multi-part ⇒ `putPart`), `push.native.test.ts` (no registration when Android flag off; tap routing),
  upload manager with a `nativeRef`.
- **Unit, api**: `plugins/cors.test.ts` (allowed origin preflight/actual headers, no
  `Allow-Credentials`, unknown origin untouched, native origin without native header ⇒ 403, SSE
  route carries the header), `routes/push.test.ts`.
- **Unit, worker**: `push/apns.test.ts` (mock HTTP/2 server: headers, JWT claims, 410 ⇒
  invalid_token), `push/fcm.test.ts` (mock token + send endpoints, UNREGISTERED), `push/notify.test.ts`
  (gap/reschedule, count 0 skip, free baby skip), `reindex.test.ts` (push enqueue on `reason:"ai"`,
  failure does not block), `queues` (13), `demo/illustrations.test.ts` (deterministic, JPEG without
  EXIF).
- **Integration, db** (`packages/db/push.integration.test.ts`): migration 16, FORCE RLS on both new
  tables, types diff clean, down/up; `register_push_device` (moves a token between users, one row
  per session, needs session claim); user A cannot see/delete B's devices, token column not
  selectable; `push_targets` excludes contributors, deleted profiles, prefs off, disabled devices,
  **dead sessions** (delete the `auth.sessions` row ⇒ gone), free baby for `photos_analyzed`;
  `push_record_delivery` disables on `invalid_token`; `pipeline` has no table access; seed still
  idempotent; `review-family` creates the expected rows and refuses production without the flag.
- **Integration, api**: push routes (native header required, 201, throttle 429, DELETE current),
  profile prefs round trip, CORS through Fastify inject, review sign-in (off by default ⇒ normal
  OTP; on ⇒ right code signs in without an email in Mailpit, wrong code counts against the
  throttle, audit `method:"review"`), viewer exchange enqueues exactly one `push.notify` per new
  session and none on reuse.
- **Integration, worker**: `push/notify.integration.test.ts` (real DB, fake sender: paid baby with
  fake-analysed photos ⇒ one `fake` delivery per admin device with the right count; contributor
  none; signed-out session none; second run inside the gap rescheduled), `demo/media.integration.test.ts`
  (MinIO: seeded originals + 3 derivatives present, no EXIF, idempotent).
- **e2e (web, Playwright)**: existing suites stay green (native code paths are inert on web);
  `e2e/smoke/dev-stack.sh`: `pgmigrations` 16, `queues: 13`, a seeded demo thumbnail URL returns
  `200 image/jpeg`, CORS preflight from `capacitor://localhost` returns the allow-origin header and
  no allow-credentials.
- **Push gate** `e2e/native/push-gate.ts` (`pnpm e2e:push-gate`, no device needed): recreate worker
  with `PUSH_PROVIDER=fake PUSH_PHOTOS_DEBOUNCE_SEC=0 PUSH_SHARE_DEBOUNCE_SEC=0 PUSH_MIN_GAP_MIN=0
  VISION_PROVIDER=fake AI_BATCH_FLUSH_MINUTES=0` (restored in `finally`); fresh admin signs in with
  `X-Tinyglow-Client: native` (bearer tokens, asserts no `Set-Cookie`), registers a fake APNs
  device, baby set Plus, uploads 3 photos, forces flush/poll ⇒ a `fake` `photos_analyzed` delivery
  with `item_count` 3; a free baby's uploads ⇒ none; a share-link exchange in a fresh client ⇒ one
  `share_viewed` delivery, a reused session ⇒ none; `DELETE /me/push-devices/current` + sign-out ⇒
  next trigger none; worker/api logs contain no device token, `eyJ`, or `X-Amz-Signature`. Writes
  `e2e/native-results/push-gate.json`.
- **Android gate** `e2e/native/android-gate.ts` (`pnpm e2e:native-android`; needs a booted
  emulator and the debug APK): `adb reverse` 8080/9000; install; grant link user-selection; launch;
  attach with Playwright `_android` `device.webView({ pkg })`:
  1. `Capacitor.isNativePlatform()` true, origin `https://localhost`.
  2. Sign in with a fresh email (OTP from Mailpit) ⇒ onboarding/home; `document.cookie` has no
     `ll_`; `localStorage`/`sessionStorage`/IndexedDB names contain no JWT-shaped value (`eyJ`);
     Devices list shows "Tinyglow app on Android".
  3. Force-stop + relaunch ⇒ still signed in (Keystore).
  4. `am start -d https://tinyglow.app/s/demo-grandparents-share-token` ⇒ WebView path
     `/s/…`, `share-album` visible, hidden tile present, no `ll_viewer` cookie.
  5. Invite: as demo mom via API create an invite for the gate email; read the link from Mailpit;
     rewrite its origin to `https://tinyglow.app`; `am start -d` ⇒ invite page ⇒
     accept ⇒ Maya listed.
  6. Upload (best-effort automation of the system Photo Picker with Playwright Android selectors;
     manual fallback printed): push 3 JPEG fixtures with GPS to `/sdcard/Pictures/ll-gate/` + media
     scan; pick them; once state is `uploading`, send `KEYCODE_HOME`; poll the API from the gate's
     own session until 3 photos are ingested **while the app is in the background**; relaunch ⇒
     summary "3 uploaded"; served derivatives have no GPS/EXIF (step-4 helper).
  7. Offline: open a photo, `cmd connectivity airplane-mode enable`, reopen ⇒ image shown; disable.
  8. Sign out ⇒ secure storage empty (plugin `get` via `evaluate`).
  9. `adb logcat -d` for the app pid has no `eyJ`, `X-Amz-Signature`, `token_hash`, share token,
     `latitude`.
  Writes `e2e/native-results/android.json` and screenshots.
- **iOS gate** `e2e/native/ios-gate.sh` (semi-automated; no WebView automation for WKWebView without
  new tools): boots the one simulator, installs the built `.app`, launches, runs `simctl openurl …
  tinyglow://s/demo-grandparents-share-token` and `…/invite/<token from Mailpit>`, `simctl push`
  a `photos_analyzed` payload, captures screenshots after each step, greps `simctl spawn booted log
  show --last 10m --predicate 'process == "App"'` for the same secrets as Android, checks
  `codesign -d --entitlements -` (associated domains, aps-environment) and `plutil -lint` on
  `Info.plist`/`PrivacyInfo.xcprivacy`, then prints the manual checklist (OTP sign-in, relaunch
  still signed in, pick 3 photos + home button + background completion, push tap routing, share
  sheet, download → Save Image, delete account screen reachable) for the orchestrator to tick.

## 3. Tasks

Owners per `CLAUDE.md`. Lanes: O = orchestrator, D = devops, B = backend, S = security, M = mobile,
F = frontend, T = test. Same-lane tasks run in sequence. **ai-engineer has no step-9 work** (the
push trigger lives in backend-owned `reindex.ts`; no model calls). Ownership exceptions assigned by
this plan (orchestrator to approve, as in step 8 D14): mobile-engineer owns
`apps/mobile-web/public/.well-known/**`, `apps/mobile-web/resources/**`,
`apps/mobile-web/scripts/{native-assets,check-association}.ts`, `apps/mobile-web/fastlane/**`,
`apps/mobile-web/Gemfile`, `apps/mobile-web/store/**`, `apps/mobile-web/NATIVE.md`; backend-engineer
writes `packages/shared/**` for 9.2; devops-engineer owns every `package.json` + `pnpm-lock.yaml`
for 9.1 only.

### 9.0 Toolchain and disk (orchestrator; needs the user's OK) — group 0

- Not code. Each item below needs the user's approval because it uses disk or `sudo` (section 5.1
  lists sizes): `sudo xcodebuild -license accept` and `xcodebuild -runFirstLaunch` (the Xcode
  licence is unaccepted per the step-4 notes); JDK 21 via asdf (`asdf install java <temurin-21.x>`,
  `JAVA_HOME`); Android `sdkmanager "platforms;android-36" "build-tools;36.0.0"` if missing and
  **one** system image `system-images;android-36;google_apis;arm64-v8a`; one AVD `ll-api36`
  (`disk.dataPartition.size=2048M`, run with `-no-snapshot-save`); **one** iOS Simulator runtime
  matching Xcode 27.0 (`xcodebuild -downloadPlatform iOS`, with `-architectureVariant arm64` if
  Xcode offers it). Recommended order: free Docker space first (`docker volume prune -f`, `docker
  builder prune -f`, user OK), Android before iOS.
- Done-when: `xcodebuild -version`, `java -version` (21), `sdkmanager --list_installed` shows exactly
  one system image, `emulator -list-avds` shows `ll-api36`; `xcrun simctl runtime list` shows one
  iOS runtime (once approved); `df -h` recorded before/after.

### 9.1 Dependencies, scripts, ignores (devops-engineer) — group 0, alone (serial lockfile change)

- Owned for this task only: every `package.json`, `pnpm-lock.yaml`, `.npmrc`, root `.gitignore`,
  `biome.json`, root `vitest.config.ts` (exclude native dirs).
- Add the 2.2 client dependencies to `apps/mobile-web` (pinned, newest past the release-age gate),
  `jose` to `apps/worker`, `playwright` (root dev, same version as `@playwright/test`).
- Scripts: `apps/mobile-web`: `native:build` (`vite build` with `VITE_API_URL=${VITE_API_URL:-http://localhost:8080}`
  and `VITE_DEEPLINK_DEV_SCHEME=${…:-1}`), `native:build:release` (requires `VITE_API_URL=https://…`,
  refuses `CAP_LIVE_RELOAD_URL`, sets the dev-scheme flag to 0), `native:sync`, `native:sync:ios`,
  `native:sync:android`, `native:assets`, `ios:build:sim`, `android:build:debug`; `packages/db`:
  `db:review-family`; `apps/worker`: `demo-media`; root: `mobile:sync`, `mobile:android`,
  `mobile:ios`, `demo:media`, `db:review-family`, `e2e:push-gate`, `e2e:native-android`,
  `e2e:native-ios`.
- If Gradle or SPM cannot resolve `@capacitor/*` through pnpm symlinks, add the narrowest
  `public-hoist-pattern[]=@capacitor/*` (and plugin scopes) to `.npmrc` and report (R3).
- Ignores per 2.14. No new dependency outside this list; stop and report if one is needed.
- Done-when: `pnpm install --frozen-lockfile` is a no-op afterwards; `pnpm lint && pnpm typecheck &&
  pnpm test` green; `pnpm --filter @tinyglow/mobile-web build` (web) output size within +5 % of
  before (native modules must be lazily imported, checked again after 9.6).

### 9.2 Shared contracts (backend-engineer, orchestrator approval) — group 0 (parallel with 9.1)

- Owned: `packages/shared/src/{native.ts, push.ts, api/push.ts}` (new); edits to the profile/me DTO
  file, `jobs.ts`, `env.ts`, `auth.ts`, `index.ts`.
- Build 2.10 literally; browser-safe (only `zod`); `pushMessage` takes only `(kind, count)`.
- Done-when: `pnpm typecheck` green; existing shared tests green; `userAgentLabel` unchanged for
  every existing fixture UA.

### 9.3 Capacitor projects and native configuration (mobile-engineer) — group 1 (after 9.1)

- Owned: `apps/mobile-web/capacitor.config.ts`, `apps/mobile-web/ios/**`, `apps/mobile-web/android/**`,
  `apps/mobile-web/public/.well-known/**`, `apps/mobile-web/scripts/check-association.ts`,
  `apps/mobile-web/NATIVE.md`.
- `cap add ios` (SPM) and `cap add android`; build 2.2 config, 2.4 association files/entitlements/
  intent filters/dev scheme, 2.12 iOS and Android configuration (permission strings verbatim,
  privacy manifest, backup exclusion, permission removals, network security configs, FCM guard,
  release-signing guard). `loggingBehavior: "none"` is mandatory. `capacitor.config.ts` stays out of
  the web `tsconfig` (the Capacitor CLI transpiles it); do not edit frontend-owned files.
- Done-when: `pnpm --filter @tinyglow/mobile-web native:sync` succeeds for both; `./gradlew
  assembleDebug lintDebug` passes; the merged manifest (`app/build/intermediates/merged_manifest/…`)
  contains none of the removed permissions; `xcodebuild … -sdk iphonesimulator
  CODE_SIGNING_ALLOWED=NO build` passes once the runtime is installed (else report "blocked on
  9.0"); `plutil -lint` passes on `Info.plist`, `PrivacyInfo.xcprivacy`, `App.entitlements`;
  `curl -s localhost:8080/.well-known/apple-app-site-association | jq .applinks.details[0].components`
  lists the three paths; `NATIVE.md` written.

### 9.4 Migration 16, seed mime fix, review-family script (security-engineer) — group 1 (after 9.2)

- Owned: `packages/db/migrations/1792200000100_native-push.sql`, `packages/db/src/seed.ts`,
  `packages/db/src/review-family.ts`, `packages/db/src/generated/**`, `packages/db/README.md`.
- Build 2.9. Explicit: FORCE RLS on both tables; `pipeline` gets EXECUTE on the four push functions
  only (no table grant); token column never selectable by `authenticated`; `push_targets` requires a
  live `auth.sessions` row; reversible down; nothing echoes a token in an error.
- Done-when: `pnpm db:migrate` applies 16, rerun no-op, `db:migrate:down 1 && db:migrate`
  round-trips, applies on the bare stub; `pnpm db:types` committed with no diff; every-table-forced
  query returns 0; seed idempotent; `pnpm db:review-family --email demo-dad@tinyglow.local`
  creates "Sunny" with 24 rows in dev and refuses `NODE_ENV=production` without the flag.

### 9.5 Env, compose (devops-engineer) — group 1 (parallel with 9.3, 9.4)

- Owned: `.env.dev`, `.env.example`, `docker-compose.dev.yml`, `docker-compose.yml`,
  `docker/nginx/default.conf` (verify only).
- Build 2.14 except CI. Secrets for push live in the **worker** env only; review-account vars in the
  **api** env only; a fresh clone still starts with no env files.
- Done-when: both `docker compose … config -q` pass; `docker compose -f docker-compose.dev.yml exec
  worker printenv PUSH_PROVIDER` ⇒ `fake`; `exec api printenv PUSH_PROVIDER` ⇒ nothing;
  `curl -s -o /dev/null -w '%{http_code}' localhost:8080/signin/native` ⇒ 200.

### 9.6 Native platform layer (frontend-engineer) — group 1 (after 9.1, 9.2; integrates with 9.3)

- Owned: `apps/mobile-web/src/platform/**` (incl. new `platform/native/**`, `apiBase.ts`),
  `src/lib/{api,sse,shareApi}.ts` (base URL + native viewer transport only),
  `src/components/SystemStatus.tsx`, `src/main.tsx` (bootstrap call), `apps/mobile-web/index.html`
  (`viewport-fit=cover`).
- Build 2.3 (apiBase), 2.4 JS rule (`deepLinks.ts` + `appUrlOpen` routing), 2.5 (secure token store,
  resume refresh), 2.6 (picker, `fileFromRef`, native uploader adapter against the 2.6 contract),
  2.7 (native viewer transport), push client module (2.8), share/haptics/status bar/splash/keyboard/
  back button helpers. All Capacitor imports are **dynamic** inside `isNative()` branches so the web
  bundle does not grow by more than 5 %.
- Explicit: tokens only in the secure store; never `localStorage`/`sessionStorage`/Preferences for
  tokens or viewer JWTs; never log URLs, tokens, paths or EXIF; deep-link URLs outside the allow-list
  are ignored silently.
- Done-when: `pnpm --filter @tinyglow/mobile-web typecheck && test` green; web e2e (`CI=1 pnpm
  e2e`) unchanged; on the iOS Simulator or Android emulator the app loads, `/api/healthz` shows `ok`
  in `SystemStatus` through `VITE_API_URL`.

### 9.7 API: CORS, push devices, profile prefs, push enqueue (backend-engineer) — group 2 (after 9.2, 9.4)

- Owned: `apps/api/src/plugins/cors.ts` (new), `apps/api/src/routes/push.ts` (new),
  `apps/api/src/routes/me.ts`, `apps/api/src/plugins/jobs.ts` (`enqueuePush`), `apps/api/src/config.ts`,
  `apps/api/src/app.ts`, `apps/api/src/lib/errors.ts`.
- Build 2.3 CORS and the 2.8 API rows. Explicit: no `Access-Control-Allow-Credentials`; CORS headers
  via `reply.raw.setHeader` (SSE covered, no edit to `apps/api/src/chat/**`); push routes run under
  the caller's claims (no `withServiceRole`); token never logged; `enqueuePush` sends only `{kind, id}`
  after commit with the 2.8 send options.
- Done-when: typecheck/tests green; `curl -si -X OPTIONS localhost:8080/api/me -H 'origin:
  capacitor://localhost' -H 'access-control-request-method: GET' -H 'access-control-request-headers:
  authorization,x-tinyglow-client'` ⇒ 204 with `access-control-allow-origin: capacitor://localhost`
  and no `access-control-allow-credentials`; 4.3 walkthrough steps 1–4 pass.

### 9.8 Native uploader, push wiring, backup exclusion (mobile-engineer) — group 2 (after 9.3)

- Owned: `apps/mobile-web/ios/**`, `apps/mobile-web/android/**`, `capacitor.config.ts`.
- Evaluate `@capgo/capacitor-uploader` against the 2.6 requirements on both platforms (raw-body PUT
  to a presigned MinIO URL from a file path returns 200 and the object's bytes match; continues with
  the app backgrounded; no multipart; no URL logging). If it fails any, implement the in-house
  `TinyglowUploader` plugin (Swift background `URLSession` + Kotlin WorkManager) with the 2.6
  bridge and tell the orchestrator to drop the dependency (9.1 rerun). Wire push natively
  (AppDelegate forwarding, Android channel + guard), confirm every bundled plugin ships a privacy
  manifest, implement the iOS `isExcludedFromBackup` step.
- Done-when: on a simulator/emulator a 3-photo upload completes while the app is in the background
  (MinIO object present, API marks ingested after resume); `xcrun simctl push` shows a notification
  and tapping it opens the app; Android build without `google-services.json` still assembles and runs
  with push disabled; report the uploader decision.

### 9.9 Native UI flows (frontend-engineer) — group 2 (after 9.6; integrates with 9.7, 9.8)

- Owned: `apps/mobile-web/src/**` except `src/platform/**` (finished in 9.6; small fixes allowed),
  notably `pages/UploadPage.tsx`, `pages/onboarding/FirstUploadPage.tsx`, `pages/auth/WelcomePage.tsx`,
  `pages/settings/**`, `components/share/**`, `pages/share/SharedAlbumPage.tsx`, viewer download,
  Plus upsell components, `App.tsx` (`/signin/native` route), `i18n/en.ts`.
- Build: native "Choose photos" / "Take photo" with the permission primer copy (PRD sign-up step 8)
  and the background notice (2.6); OTP-only welcome on native; sign-out sequence (2.5); Settings →
  Notifications (enable flow, two toggles, unavailable state) + post-first-upload primer + tap
  routing (2.8); native share sheet and download-to-share (2.7); haptics on upload complete, link
  created, milestone saved; safe areas checked on notched devices; `/signin/native` page (web: "Open
  this link on your phone with the Tinyglow app installed"; native: placeholder for 9b);
  **upgrade/purchase CTAs and prices hidden on native** (D3); i18n keys `native.*`, `push.*`.
- Explicit: no new storage of tokens or URLs; contributors see no push settings for admin-only kinds
  (they receive none); text rendering only.
- Done-when: typecheck/test green; web e2e green; screenshots of changed screens in light/dark ×
  phone/desktop (web) and light/dark on the simulator/emulator (`docs/DESIGN.md`).

### 9.10 API auth and sharing hooks (security-engineer) — group 3 (after 9.7)

- Owned: `apps/api/src/auth/**`, `apps/api/src/sharing/viewer-session.ts`.
- Viewer exchange: after commit, when a **new** viewer session was created, `enqueuePush({kind:
  "share_viewed", shareLinkId})` (failure logged with the link id only; never blocks the response).
- Review sign-in (2.5), **only if D4 is approved**: config via `reviewAccountEnvSchema`; GoTrue client
  gains `generateLink` (admin JWT exists); constant-time hash check; no email sent; audit
  `method:"review"`; nothing logged about the code.
- Done-when: 4.3 steps 5–6 pass; with the review vars unset, `/auth/otp` + `/auth/verify` behave
  exactly as before (step-3 e2e green).

### 9.11 Worker push (backend-engineer) — group 3 (after 9.7, same lane)

- Owned: `apps/worker/src/push/**` (new), `apps/worker/src/{reindex,queues,main,run-job,config}.ts`.
- Build the 2.8 worker part. Explicit: `fake` refused in production; tokens/JWTs/bodies never logged;
  pipeline role through the 2.9 functions only; push enqueue cannot fail or delay reindexing; the
  APNs/FCM adapters are fully exercised by mock servers in 9.14 (live use is 5.2).
- Done-when: boot log `queues: 13`; `pnpm --filter @tinyglow/worker run-job push.notify
  '{"kind":"share_viewed","shareLinkId":"00000000-0000-4000-8000-000000000200"}'` exits 0 on the dev
  stack (0 targets ⇒ no delivery); 9.14's worker tests green.

### 9.12 Demo media and review media (backend-engineer) — group 4 (after 9.4, 9.11)

- Owned: `apps/worker/src/demo/**` (new), `apps/worker/src/main.ts` (dev-only `ensureDemoMedia()`
  call).
- Build 2.11. Explicit: dev-only auto-run guarded by `SEED_DEMO_FAMILY=true` and non-production;
  JPEGs carry no metadata; derivatives through the existing ingest function; review mode only enqueues
  `ingest`; no model call; logs ids/counts only.
- Done-when: from `pnpm dev:reset`, Maya's 12 thumbnails render in the web timeline;
  `pnpm demo:media --check` prints 12/12 originals and 36/36 derivatives; `exifr` finds no tags in any
  demo object; `pnpm db:review-family --email demo-dad@tinyglow.local && pnpm demo:media
  --review-baby <id>` ingests 24 photos (fake AI describes them on Plus).

### 9.13 Icons, splash, store metadata, privacy drafts (mobile-engineer) — group 3 (after 9.8)

- Owned: `apps/mobile-web/resources/**`, `apps/mobile-web/scripts/native-assets.ts`,
  `apps/mobile-web/fastlane/**`, `apps/mobile-web/Gemfile`, `apps/mobile-web/store/**`, plus the
  generated icon/splash files under `ios/**` and `android/**`.
- Build 2.12 icons/splash and 2.13 drafts. The privacy label and Data Safety answers must match
  `PrivacyInfo.xcprivacy` and the actual data flows (photos, GPS from metadata, email, name, notes,
  chat text, push tokens stay with us; AI provider is a processor; no tracking, no ads, no analytics
  SDK).
- Done-when: `pnpm --filter @tinyglow/mobile-web native:assets` regenerates byte-identical
  assets; icons appear on the simulator/emulator home screen and the splash shows in light/dark;
  every listing text file is within the store character limits (script or table in
  `store/README.md`); `review-notes.md`, `privacy-nutrition-label.md`, `data-safety.md`,
  `release-checklist.md` exist.

### 9.14 Unit and integration tests (test-engineer) — group 5 (after 9.4–9.12)

- Owned: `**/*.test.ts(x)`, `packages/db/test/**`, `apps/api/src/testing/*`, `apps/worker/src/testing/*`.
- Build the unit and integration rows of 2.15 (mock HTTP/2 APNs server and mock FCM/OAuth servers in
  `apps/worker/src/testing/`).
- Done-when: `pnpm test` and `pnpm test:integration` green on the dev stack and on bare pgvector +
  MinIO, none skipped.

### 9.15 Push gate, native gates, smoke (test-engineer) — group 6 (after 9.14)

- Owned: `e2e/native/**`, `e2e/helpers/**`, `e2e/smoke/dev-stack.sh`.
- Build the push gate, Android gate, iOS gate script and smoke rows of 2.15.
- Done-when: `pnpm e2e:push-gate` passes twice in a row; `pnpm smoke` green; `pnpm e2e:native-android`
  passes on the emulator (picker step may fall back to the printed manual step, reported);
  `pnpm e2e:native-ios` runs to the manual checklist on the simulator (if the runtime is installed).

### 9.16 CI (devops-engineer) — group 7 (after 9.15)

- Owned: `.github/workflows/ci.yml`, `.github/scripts/**`.
- Build the CI rows of 2.14: `android-debug` job on every push; `ios-sim-build` manual; push gate in
  the dev-stack job; hygiene step: `grep -rn "localStorage\|sessionStorage" apps/mobile-web/src/platform`
  ⇒ no token writes (allow-list file), `grep -rn "loggingBehavior" apps/mobile-web/capacitor.config.ts`
  ⇒ `"none"`, merged-manifest forbidden-permission check, `grep -rnE "console\.(log|debug)"
  apps/mobile-web/src/platform/native` ⇒ none. `actionlint` clean.
- Done-when: every job's commands pass locally in order (Android job locally on the Mac).

### 9.17 Build and run on simulator and emulator; screenshots (orchestrator) — gate

- Section 4. Store screenshots captured with `xcrun simctl io booted screenshot` and `adb exec-out
  screencap -p` at the sizes in `store/screenshots.md`, of the demo family (illustrations only).

### Parallelism summary

| Group | Tasks | Notes |
| --- | --- | --- |
| 0 | 9.0 (O) · 9.1 (D) · 9.2 (B) | 9.1 alone touches lockfile/package.json; 9.2 only `packages/shared` |
| 1 (parallel) | 9.3 (M) · 9.4 (S) · 9.5 (D) · 9.6 (F) | disjoint paths; 9.6 codes against 2.2–2.8 and integrates when 9.3 lands |
| 2 (parallel) | 9.7 (B) · 9.8 (M) · 9.9 (F) | 9.7 after 9.4; 9.8 after 9.3; 9.9 after 9.6 |
| 3 (parallel) | 9.10 (S) · 9.11 (B) · 9.13 (M) | 9.10 needs `enqueuePush` (9.7); 9.11 same lane as 9.7; 9.13 after 9.8 |
| 4 | 9.12 (B) | after 9.11 (same lane) and 9.4 |
| 5 | 9.14 (T) | |
| 6 | 9.15 (T) | |
| 7 | 9.16 (D) | |
| Gate | 9.17 (O) | section 4; then the combined review of steps 1–9 (Fable) |

If 9.8 replaces the uploader dependency, 9.1 reruns (lockfile) before 9.14.

## 4. Acceptance checks and gate procedure

PRD step 9 check (verbatim): **"Check: TestFlight and Play internal builds install; invite and share
links open the app."** That check needs Apple/Google accounts and the production domain serving the
real association files, so it is run in section 5.2 when the user provides them. Everything below
needs no account and proves the same behaviour on the simulator/emulator (debug builds, dev stack,
fake AI, fake push). Run from the repo root with Docker running, `pnpm` 12.10.1 on PATH, JDK 21,
`ANDROID_HOME=~/Library/Android/sdk`.

### 4.1 Server side and web (always)

```sh
docker compose -f docker-compose.dev.yml down -v && docker compose -f docker-compose.dev.yml up -d --build --wait
pnpm install --frozen-lockfile
PSQL="docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d tinyglow -Atc"
$PSQL "select count(*) from pgmigrations"                                                  # 16
$PSQL "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname<>'pgmigrations' and not (c.relrowsecurity and c.relforcerowsecurity)"   # 0
docker compose -f docker-compose.dev.yml logs worker | grep 'queues: 13'
pnpm demo:media --check                                                                    # 12/12 originals, 36/36 derivatives
pnpm lint && pnpm typecheck && pnpm test
# integration: same env block as docs/plans/step-8.md 4.5
pnpm smoke && CI=1 pnpm e2e
pnpm e2e:push-gate        # fake deliveries: photos_analyzed (3) for the Plus admin; none for free baby,
                          # one share_viewed per new viewer session, none after sign-out; no tokens in logs
git diff --exit-code -- packages/db/src/generated
```

### 4.2 Association files and native-transport API (curl)

```sh
B=http://localhost:8080
curl -s $B/.well-known/apple-app-site-association | jq -c '.applinks.details[0] | .appIDs, .components'
#   ["APPLE_TEAM_ID.app.tinyglow"]  [{"/":"/invite/*"},{"/":"/s/*"},{"/":"/signin/native*"}]
curl -sI $B/.well-known/apple-app-site-association | grep -i 'content-type: application/json'
curl -s $B/.well-known/assetlinks.json | jq -r '.[0].target.package_name'                  # app.tinyglow
pnpm --filter @tinyglow/mobile-web exec tsx scripts/check-association.ts                # lists the 2 placeholders
curl -si -X OPTIONS $B/api/me -H 'origin: capacitor://localhost' -H 'access-control-request-method: GET' \
  -H 'access-control-request-headers: authorization,x-tinyglow-client' | grep -i '^access-control-allow-origin: capacitor://localhost'
curl -si -X OPTIONS $B/api/me -H 'origin: https://evil.example' -H 'access-control-request-method: GET' | grep -ci '^access-control-allow-origin'   # 0
curl -si -X OPTIONS $B/api/me -H 'origin: https://localhost' -H 'access-control-request-method: GET' | grep -ci 'allow-credentials'                 # 0
```

### 4.3 API walkthrough (native transport; `H='x-tinyglow-client: native'`)

1. `curl -s -X POST $B/api/auth/otp -H "$H" -H 'content-type: application/json' -d '{"email":"demo-mom@tinyglow.local"}'` → 202; code from Mailpit; `curl -si -X POST $B/api/auth/verify -H "$H" … -d '{"email":…,"code":…}'` → body has `tokens.accessToken`/`refreshToken`, **no** `Set-Cookie`. `TOK=<access>`.
2. `curl -s $B/api/auth/sessions -H "$H" -H "authorization: Bearer $TOK" -H 'user-agent: Mozilla/5.0 (iPhone) Tinyglow/1.0.0' …` after a verify sent with that UA → a device labelled "Tinyglow app on iPhone".
3. `curl -s -X POST $B/api/me/push-devices -H "$H" -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"platform":"ios","provider":"apns","token":"'"$(openssl rand -hex 32)"'","appVersion":"1.0.0"}'` → 201; same call with `x-tinyglow-client: web` → 400; `{"platform":"ios","provider":"fcm",…}` → 400.
4. `PATCH /api/me/profile {"notifyShareViewed":false}` → `GET /api/me | jq .profile.notifyShareViewed` → `false`; set back to `true`.
5. Viewer exchange from a fresh client (`-H "$H"`, body `{"token":"demo-grandparents-share-token"}`) → `viewerToken` in the body, no `Set-Cookie`; `docker compose exec worker pnpm run-job push.notify '{"kind":"share_viewed","shareLinkId":"00000000-0000-4000-8000-000000000200"}'` (or wait for the queued job) → `$PSQL "select kind,status from push_deliveries order by id desc limit 1"` → `share_viewed|fake`.
6. `curl -s -X DELETE $B/api/me/push-devices/current -H "$H" -H "authorization: Bearer $TOK"` → 204; repeat step 5's trigger → no new delivery row.
7. `docker compose -f docker-compose.dev.yml logs api worker | grep -E "$TOK|[0-9a-f]{64}|X-Amz-Signature|demo-grandparents-share-token"; echo "exit $?"` → exit 1.

### 4.4 Android (emulator `ll-api36`, debug build)

```sh
pnpm --filter @tinyglow/mobile-web native:sync:android
(cd apps/mobile-web/android && ./gradlew assembleDebug lintDebug)
APK=apps/mobile-web/android/app/build/outputs/apk/debug/app-debug.apk
"$ANDROID_HOME"/build-tools/36.0.0/aapt dump permissions $APK | grep -E 'READ_MEDIA|EXTERNAL_STORAGE|LOCATION'; echo "exit $?"   # exit 1
"$ANDROID_HOME"/build-tools/36.0.0/aapt dump xmltree $APK AndroidManifest.xml | grep -A2 allowBackup   # false
"$ANDROID_HOME"/emulator/emulator -avd ll-api36 -no-snapshot-save -no-boot-anim &
adb wait-for-device && adb shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 2; done'
pnpm e2e:native-android        # steps 1-9 of 2.15: native transport, Keystore, relaunch, /s and /invite deep links,
                               # background upload, offline photo, sign-out wipes storage, no secrets in logcat
adb shell pm get-app-links app.tinyglow          # tinyglow.app: user-selected (verified needs 5.2)
```

### 4.5 iOS (one simulator, debug build; needs 9.0's runtime)

```sh
pnpm --filter @tinyglow/mobile-web native:sync:ios
pnpm --filter @tinyglow/mobile-web ios:build:sim          # xcodebuild -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO
APP=$(find apps/mobile-web/ios/build -name 'App.app' -path '*iphonesimulator*' | head -1)
plutil -lint "$APP/Info.plist" apps/mobile-web/ios/App/App/PrivacyInfo.xcprivacy
/usr/libexec/PlistBuddy -c 'Print :NSPhotoLibraryUsageDescription' "$APP/Info.plist"        # the 2.12 string
/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' "$APP/Info.plist"         # false
pnpm e2e:native-ios            # installs, launches, openurl tinyglow://s/... and /invite/..., simctl push,
                               # screenshots, log scan, entitlements; then tick the printed manual checklist:
                               # OTP sign-in + autofill field, relaunch still signed in, pick 3 photos + Home
                               # + uploads finish in background, push tap opens Chat, share sheet, download ->
                               # Save Image prompt with the NSPhotoLibraryAddUsageDescription text, Settings ->
                               # Delete account reachable, dark mode, safe areas
```

### 4.6 Gate summary to record in PROGRESS

PASS for 4.1–4.4 and (if the runtime is installed) 4.5; the PRD check recorded as **pending user
credentials (5.2)**. Recommended: commit as "step 9 (part A): native builds without store accounts"
and run the combined review; run 5.2 as step 9 part B when credentials arrive (D2).

## 5. Work lists

### 5.1 Work that needs no accounts or credentials and can be done now

| Item | Task |
| --- | --- |
| Capacitor config and plugins (2.2) | 9.1, 9.3, 9.6 |
| iOS and Android projects (SPM, target SDK 36) | 9.3 |
| Native permission strings, iOS privacy manifest, Android Photo Picker without media permissions, no-backup rules | 9.3, 9.8 |
| Deep links: AASA / assetlinks with placeholder team id and fingerprints, associated-domains entitlement, App Links intent filters, debug scheme, JS routing for `/invite`, `/s`, `/signin/native` | 9.3, 9.6 |
| Native auth with email OTP (GoTrue via API), one-time-code autofill, 90-day sessions, app device label | 9.6, 9.9, 9.2 |
| Native bearer token storage in Keychain/Keystore, refresh on resume, sign-out wipe | 9.6 |
| Share-link native exchange (step-8 seam): bearer viewer JWT in memory, re-exchange on renew | 9.6 |
| Native share sheet and download-to-share | 9.6, 9.9 |
| Push plumbing: DB, registration API, prefs, opt-in UI, fake sender, APNs/FCM adapters vs mock servers, tap routing, `simctl push` test | 9.4, 9.7, 9.8, 9.9, 9.10, 9.11 |
| Camera-roll upload on native: originals (HEIC kept), camera, 500 per session, background upload | 9.6, 9.8, 9.9 |
| API CORS for the two Capacitor origins; MinIO CORS default | 9.7, 9.5 |
| Demo family with real (illustrated, non-real) images; review-family tooling (dev-tested) | 9.4, 9.12 |
| Icons, splash, store metadata drafts (fastlane layout), privacy nutrition label and Data Safety drafts, review notes, screenshots | 9.13, 9.17 |
| Building and running in the iOS Simulator and Android emulator; native gates | 9.0, 9.15, 9.17 |
| CI: Android debug build on every push, manual iOS simulator build | 9.16 |

**Disk plan (5–15 GB free).** Estimates; confirm with the download prompts and `df -h`:

| Item | Size | Needed? |
| --- | --- | --- |
| iOS Simulator runtime for Xcode 27 (one, iOS 27.x) | ~8–10 GB on disk (the arm64-only variant, if offered, is smaller) | **Yes** to run in the Simulator, and very likely to build at all (Xcode 15+ refuses iOS builds without the platform; verify with `xcodebuild -showsdks`). Not needed for Android work. |
| Xcode DerivedData + SPM checkouts for this app | ~1–2 GB | yes with iOS |
| Android `system-images;android-36;google_apis;arm64-v8a` (one image; `google_apis` includes Play services for later FCM tests; no Play Store image needed) | ~1.5–2 GB download, ~4 GB unpacked | **Yes** for the emulator |
| AVD `ll-api36` data (cap 2 GB, no snapshots) | ≤ 2 GB | yes |
| Gradle caches + Android build outputs | ~1–2 GB | yes |
| `platforms;android-36`, `build-tools;36.0.0` if missing | ~0.2 GB | if missing |
| JDK 21 (asdf) if missing | ~0.3 GB | if missing |

Android total ≈ 6–8 GB; iOS total ≈ 10–12 GB; both ≈ 17–20 GB. Recommended: free Docker space
first (~1.1 GB unused volumes noted in steps 5–8, plus build cache; user OK), run the **Android**
lane and its gate first, then either delete the system image and AVD (`sdkmanager --uninstall …`,
`avdmanager delete avd -n ll-api36`, ~6 GB back) before downloading the iOS runtime, or have the
user free ≥ 20 GB to keep both. One simulator runtime and one emulator image at most.

### 5.2 Work blocked on the user (exactly what to provide)

| # | Needed from the user | Unblocks | What we do with it |
| --- | --- | --- | --- |
| U1 | **Apple Developer Program** membership (individual or organisation; organisation needs a D-U-N-S number) and the **Team ID** (10 chars) | iOS signing, universal links, push, TestFlight | replace `APPLE_TEAM_ID` in AASA, set `DEVELOPMENT_TEAM`, commit |
| U2 | **Signing**: sign in to Xcode with the Apple ID that has the team (Xcode → Settings → Accounts) so automatic signing can create the App ID `app.tinyglow` with capabilities **Associated Domains, Push Notifications** (and **Sign in with Apple** if U8); or provide a distribution certificate + App Store provisioning profile | device builds, archive | `xcodebuild archive` / `-exportArchive` (app-store-connect) |
| U3 | **App Store Connect**: app record "Tinyglow" (bundle id above, SKU, primary language English), an **App Store Connect API key** (Issuer ID, Key ID, `.p8`) for uploads, internal **TestFlight testers** (Apple IDs) | TestFlight (PRD check) | `fastlane ios beta` or `xcrun altool`/Transporter upload; testers install via TestFlight |
| U4 | **APNs key** (`.p8`, Key ID; same Team ID) | live iOS push | worker env `PUSH_PROVIDER=live`, `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY_BASE64`, `APNS_ENVIRONMENT` (`sandbox` for debug builds, `production` for TestFlight/App Store) |
| U5 | **Google Play Console** account (one-time fee), app created with package `app.tinyglow`, **Play App Signing** enabled, internal-testing tester emails; agreement on where the **upload keystore** lives (we can generate it locally with `keytool`; the user keeps the file and passwords outside the repo) | Play internal build (PRD check) | `./gradlew bundleRelease` signed with the upload key; first AAB uploaded manually in the Console (Play requires it), later `fastlane android internal` with a Play **service-account JSON** |
| U6 | **SHA-256 fingerprints**: Play App Signing key (Console → App integrity) and the upload key | Android App Links verification | replace placeholders in `assetlinks.json`, commit |
| U7 | **Firebase project** with the Android app registered → `google-services.json`; an **FCM service account** JSON (HTTP v1); optionally upload the APNs key to Firebase only if FCM is ever used for iOS (not planned) | live Android push | file to `android/app/google-services.json` (git-ignored), build with `VITE_PUSH_ANDROID=1`; worker `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_BASE64` |
| U8 | **Apple / Google sign-in client IDs** (PRD "Sign-in methods" are P0, so needed before public launch, not for internal builds): Apple Services ID + Sign in with Apple key (also the step-3 list), Google OAuth **iOS client** (bundle id), **Android client** (package + SHA-1 of the Play signing and upload keys), web client + secret | native Apple/Google (9b) | add `@capgo/capacitor-social-login` (+ `@capacitor/browser` for Android Apple web OAuth via `/signin/native`), enable the GoTrue providers, `APPLE_CLIENT_ID=<services id>,app.tinyglow`, `GOOGLE_CLIENT_ID=<web>,<ios>,<android>`; iOS reversed-client-id URL scheme; client rule "Google only with Apple on iOS" |
| U9 | **Payments decision** (D3) and, if in scope: App Store Connect subscription product (Plus, $3.99/month), Play Billing product, **RevenueCat** project + API keys, Stripe for web | public store release with Plus purchasable | a separate billing step (entitlement webhooks → `babies.plan`), not part of step 9 |
| U10 | **Production deploy approval**: build and run the new web image on the server so `https://tinyglow.app/.well-known/*` serves the real AASA/assetlinks (after U1/U6), new env (`NATIVE_APP_ORIGINS`, `S3_CORS_ALLOW_ORIGIN`, push vars), migration 16 | universal/app links on real devices (PRD check), release builds pointing at production | orchestrator prepares the change; the user runs/approves it (touches production) |
| U11 | **Store listings**: final name check (trademark), subtitle/description approval, support URL + support email, marketing URL (optional), real **Privacy Policy and Terms** text (still placeholders since step 3), age-rating questionnaire answers (we draft 4+/Everyone), App Store privacy label and Play Data Safety submission (we draft), screenshots approval | store submission | from `apps/mobile-web/fastlane/**` and `apps/mobile-web/store/**` |
| U12 | **Review account**: decision D4, a mailbox/email for the review account (e.g. `review@tinyglow.app`), the static review code (we generate; the user stores it and pastes it into the review notes), approval to run `db:review-family` + `demo:media --review-baby` **on production** | App Review / Play "App access" | sign up once on production with that email, run both commands, set `REVIEW_ACCOUNT_*` on the api |
| U13 | **Machine actions**: `sudo xcodebuild -license accept`; approval to download the iOS runtime and Android image (5.1 sizes) and to prune Docker volumes/build cache | 9.0 | orchestrator runs them |

PRD check procedure once U1–U6 and U10 are done: (a) `fastlane ios beta` (or archive + upload),
install from TestFlight on an iPhone, open an invite email and a share link in Mail/Messages ⇒ the
app opens on the invite/share screen (Apple fetches the AASA from its CDN; allow up to a day after
U10, or use `applinks:…?mode=developer` with Developer Mode for testing); (b) upload the AAB to
internal testing, install from the Play testing link on an Android phone, `adb shell pm
verify-app-links --re-verify app.tinyglow && adb shell pm get-app-links
app.tinyglow` ⇒ `verified`, tap invite and share links ⇒ the app opens on those
screens. Note for later: new personal Play developer accounts need a closed test with 12 testers
for 14 days before production access (internal testing is not affected).

## 6. Risks and decisions (orchestrator to confirm or override)

- **D1 — Bundle id / package name `app.tinyglow`** (reverse of the tinyglow.app domain). Cannot
  be changed after publishing. **Needs the user's confirmation.**
- **D2 — Step 9 is completed in two parts.** Part A (everything in 5.1) is gated and committed now;
  the PRD check ("TestFlight and Play internal builds install; invite and share links open the app")
  runs as part B when U1–U6 and U10 exist. Recommended so the combined review is not blocked on
  accounts. **Needs the user's confirmation.**
- **D3 — Payments are not in step 9.** The PRD's step-9 text lists builds, push, deep links, store
  metadata and the privacy manifest; payments (RevenueCat + StoreKit/Play Billing + Stripe) appear
  in "Sign-up flow" step 7 and "App store requirements" but in no build step. App Store guideline
  3.1.1 forbids selling Plus in the app without IAP, and steering to web checkout is restricted
  outside the US storefront. Default: native builds **hide upgrade/purchase CTAs and prices**
  (features of a baby already on Plus still work); billing becomes its own step before public
  release. Internal TestFlight/Play builds don't need it. **Needs the user's decision.**
- **D4 — Store-review sign-in.** Reviewers cannot receive our OTP emails. Options: (a) a review
  account with a static code checked on the api (2.5; off unless both env vars are set; one email;
  owns only the synthetic review family; audited; same throttles) — recommended, common practice
  for OTP-only apps; (b) give reviewers credentials to a mailbox (often rejected as cumbersome);
  (c) nothing until rejected. **Needs the user's decision**; 9.10's review part is built only on (a).
- **D5 — Demo images are in-repo SVG illustrations of non-real babies**, rendered to metadata-free
  JPEGs (no licence question, deterministic, no real child). Satisfies "sample (non-real) baby
  photos". Alternative: AI-generated photoreal images supplied by the user (licence/terms check
  needed). **Confirm.**
- **D6 — iPhone only for v1** (`TARGETED_DEVICE_FAMILY = 1`; runs on iPad in compatibility mode).
  Universal would require iPad screenshots and iPad layout QA for review. Android ships to all form
  factors (no extra requirement for internal testing). Override: universal.
- **D7 — Library picking with `@capawesome/capacitor-file-picker`** (originals, HEIC kept via
  `skipTranscoding`, Android system Photo Picker) instead of `@capacitor/camera` `pickImages`
  (re-encodes to JPEG, which breaks "original kept untouched"); `@capacitor/camera` only for taking
  a photo. The PRD allows either ("or a multi-picker community plugin").
- **D8 — Native auth callback path is `/signin/native`, not `/signin/callback`.** Web OAuth and the
  magic link keep returning to the web page; only the native-initiated flow (9b, Android Apple via
  the browser) uses an app-claimed path, so the app never intercepts a browser sign-in whose PKCE
  verifier it cannot see. Magic links on native are not supported (CLAUDE.md: web-only fallback).
- **D9 — Android uploads usually arrive without GPS** because the system Photo Picker redacts
  location (the PRD prefers the picker; requesting `ACCESS_MEDIA_LOCATION` with full media access
  conflicts with Play's photo-permission policy). Consequence: no "Home" place label for those
  photos. Accepted as privacy-positive; iOS keeps GPS (encrypted server-side).
- **D10 — Push payloads are generic** ("{n} new photos are ready to search.", "Someone opened your
  shared album.") with opaque ids only; no baby name, link name or captions reach Apple/Google or
  the lock screen. Override: include the link name in `share_viewed` (admin-entered text).
- **D11 — Privacy label declares Precise Location** (from photo metadata, linked, app
  functionality), Photos, Email, Name, User ID, Other User Content, Search History; no tracking, no
  ads, no analytics or crash SDK in the app (Sentry is server-side only; if a client crash SDK is
  ever added the labels change). Conservative and accurate; reviewers penalise under-declaration.
- **D12 — Debug-only custom scheme `tinyglow://`** registered in both apps but honoured only by
  builds with `VITE_DEEPLINK_DEV_SCHEME=1`; release ignores it. Lets the Simulator test routing
  without a team id.
- **D13 — Deferred**: native Apple/Google sign-in (U8), biometric lock (P2), auto-backup (FR-2.6,
  P2), OTA live updates (Capgo/Appflow; PRD "Release" mentions them, adds a hosted service), full
  service worker/offline PWA for the web (steps 5/8 pointed here, but the step-9 PRD text does not
  include it and the app's offline cache already covers recent photos), fastlane installation (Ruby;
  layout only now, R8), multi-part background uploads for files > 16 MiB (foreground fallback).
- **D14 — Push opt-in**: OS permission requested only from Settings or the post-first-upload primer;
  per-kind toggles default on after opt-in; admins only; at most one `photos_analyzed` push per baby
  per user per hour (debounced 10 min) and one `share_viewed` per baby per hour.
- **R1 — New client dependencies** (2.2 table) need approval; the secure-storage and uploader
  plugins are the riskiest (maintenance, SPM support). If either fails 9.6/9.8 checks, fall back as
  stated (alternative plugin / in-house uploader) and report; no other dependency without approval.
- **R2 — Background upload limits.** Only single-part files (≤ 16 MiB) upload in the background;
  JS must finish hashing/registering in the foreground (the UI says so). If the OS kills the app,
  completed parts are recovered through ListParts and the user re-picks the rest. Measured in 9.8 /
  the Android gate.
- **R3 — pnpm symlinks vs Gradle/SPM.** Capacitor resolves native plugin sources through
  `node_modules`; if symlinked paths break, 9.1 adds a narrow `public-hoist-pattern`.
- **R4 — Simulator/emulator networking.** `http://localhost` from `capacitor://localhost`
  (WKWebView) and from `https://localhost` (Android WebView) is expected to be allowed as a
  potentially trustworthy origin; if WebKit or the WebView blocks it as mixed content, fall back to
  `CAP_DEV_MIXED_CONTENT=1` (Android) or live-reload mode (`CAP_LIVE_RELOAD_URL=http://localhost:8080`,
  same origin as the API) for dev only; release builds are HTTPS-only either way.
- **R5 — Universal links and push entitlement on unsigned simulator builds.** Associated Domains and
  `aps-environment` may not take effect without a team; the debug scheme and `simctl push` cover the
  routing and tap paths now; real association is U1/U10.
- **R6 — Cache API on `capacitor://`.** If WKWebView exposes no `caches` on the custom scheme, the
  offline photo cache is a no-op on iOS (it degrades silently by design). 9.6 checks; fallback is a
  Filesystem-backed cache (frontend, small) if the gate shows it missing.
- **R7 — Photos in device backups.** WebView storage holds cached photos; Android disables backup
  entirely and iOS excludes `Library/WebKit` and `Library/Caches/ll-*` from iCloud backup. Checked
  in the gates (manifest flags; `xattr -p com.apple.metadata:com_apple_backup_excludeItem` on the
  simulator container).
- **R8 — Fastlane** is the PRD's suggestion but needs Ruby/Bundler; only the metadata layout and
  lanes are written now. Installing it waits for U3/U5 (or uploads use Xcode/Transporter and the Play
  Console directly).
- **R9 — Playwright `_android` is experimental**; the Android gate falls back to printed manual steps
  for the system Photo Picker. iOS WebView automation would need Appium/ios-webkit-debug-proxy (new
  tools); not added — the iOS gate is semi-manual.
- **R10 — Target API level and store rules change yearly.** Target SDK 36 and the Play testing rules
  are as understood today; 9.3 confirms against current Android/Play documentation and reports.
- **Needs the user (summary):** D1, D2, D3, D4, D5 confirmations; U13 (licence, downloads, Docker
  prune) to run 9.0; everything in 5.2 for part B. Still open from earlier steps: production
  credentials (tunnel config, SMTP, B2, storage keys), Turnstile, legal text, CSAM provider,
  Cloudflare cache-bypass rule for `files.`.
