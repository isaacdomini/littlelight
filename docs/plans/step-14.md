# Step 14 plan: Live updates (OTA web bundle)

Status: proposed (architect, 2026-10-11). Not a PRD build-order step. User request: "Update
Capacitor so that when the web app updates, the app updates too without having to publish a new
update. Look at how https://github.com/isaacdomini/smymcolumbuschallenge is set up." The PRD's
"Mobile and Capacitor → App store requirements → Release" row allows it: "OTA web-layer updates
(Capgo / Appflow Live Updates) for JS-only fixes within store policy." Step-9 D13 deferred it
because both named products add a hosted service; this plan does it self-hosted. Billing moves to
step 15 (`docs/plans/roadmap-next.md` updated with this plan).

Starts after step 13 is committed. No database migration, no new service, no new npm dependency
(decision D1). Builds on: step 9 (native shells, `VITE_API_URL`, CORS, `X-Tinyglow-Client`),
step 10/12 (`photoSync` phases, upload manager lanes, Wi-Fi conditions), review fixes (CSP, web
image entrypoint), step 13 (in-house plugin pattern with host harness tests).

PRD sections touched: "Mobile and Capacitor" (Capacitor shell, "Release" row, "App store
requirements"), "Security" (signed artefacts, no secrets in clients), "Privacy" (no device
identifiers leave the phone), "Decisions to confirm" (web container serves static files).
`CLAUDE.md`: zero-setup dev stack, never commit secrets, never log tokens/URLs, no new
library without flagging, no production action without the user.

## 0. Research: what the referenced repo does (verified 2026-10-11)

`isaacdomini/smymcolumbuschallenge` (React + Vite + Express, Capacitor **7.4.4**, `@capacitor/app`,
`@capacitor/preferences`, `@capacitor/push-notifications`, `@capacitor/status-bar`,
`@capawesome/capacitor-badge`; no Capgo, no Appflow, no updater plugin, no `.github/workflows`,
`DEPLOYMENT.md` covers the web only). Its `capacitor.config.ts` is, verbatim:

```ts
const config: CapacitorConfig = {
  appId: 'com.tesarsoft.smym.biblegames',
  appName: 'SMYM Bible Games',
  webDir: 'dist',
  plugins: { PushNotifications: { presentationOptions: ["badge", "sound", "alert"] } },
  server: {
    url: "https://youth.columbuschurch.org",
    allowNavigation: ["youth.columbuschurch.org", "*.youth.columbuschurch.org"]
  }
};
```

So it is the **`server.url` remote-shell approach**: the native app is a WKWebView/WebView that
loads the live website on every start; the `dist` copied by `cap sync` is never shown (Capacitor
ignores `webDir` when `server.url` is set). Every web deploy is therefore an "app update" with
nothing to build, version, sign, verify or roll back, and the app is a blank error page when
offline or when the site is down. Versioning is the plain `package.json` `"version": "1.0.13"` and
Xcode's `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`; there is no CI publishing.

**Why Tinyglow does not copy it 1:1.** Tinyglow's shell already refuses `server.url` outside dev
live reload (`native:build:release` exits 1; step-9 2.2 R6) for reasons that still hold: (a) the
WebView origin would become `https://tinyglow.app`, so the session cookies, CSRF model and the
bearer-only native transport of step 3/9 (`X-Tinyglow-Client: native`, `NATIVE_APP_ORIGINS`)
would all change; (b) first paint waits on the network and the app is unusable offline (uploads
and album sync must keep working after a kill); (c) a deploy would hit every phone instantly with
no integrity check, no compatibility check against the native plugins and no rollback; (d) App
Review sees a thin web wrapper (guideline 4.2 risk), while a bundled app with signed OTA assets
is the pattern Apple and Google explicitly allow (section 2.11). What we keep from it: **one web
build is the truth for browsers and phones**, and shipping it needs no store release.

## 0.1 Decisions (architect defaults for the user to confirm or override)

| # | Question | Default |
| --- | --- | --- |
| D1 | Updater implementation | **In-house `TinyglowUpdater` plugin** (Swift + Java, like `TinyglowUploader` / `TinyglowPasskeys`) on top of Capacitor's **built-in** persisted `serverBasePath` (verified in `@capacitor/ios` 8.5.3 `CAPBridgeViewController.swift:18-24, 91-104, 280-286, 327-339` and `@capacitor/android` 8.5.3 `Bridge.java:295-303, 429-457, 1426-1446`, `plugin/WebView.java`). No Capgo plugin or CLI, no Appflow, no third-party endpoint. Alternative A: `@capgo/capacitor-updater` 8.52.1 (MPL-2.0, peer `@capacitor/core ^8`) in manual mode (`autoUpdate: false`, `updateUrl`/`statsUrl`/`channelUrl` set to `""`, `publicKey` set) plus `@capgo/cli` for `bundle zip --key-v2` + `bundle encrypt` in CI: more code than we need, defaults that phone home to `plugin.capgo.app` (would need a hygiene check we cannot fully prove from CI), a zip format tied to their CLI, and our CI has no secrets so signing would have to move to the server anyway (as in D2). Alternative B: the referenced `server.url` approach (rejected above). |
| D2 | Bundle format and signing | **Per-file manifest, no zip.** The `web` image build writes `dist/app-update/manifest.json` (`version` = content id, sha256 + size per file). The **api signs** it on demand (ECDSA P-256 / SHA-256, DER) with `APP_UPDATE_SIGNING_KEY_BASE64` from `.env` (api only) and hands the phone the signed JSON string + signature + absolute `baseUrl`. The phone verifies the signature with a **public key compiled into the app**, downloads only the files whose sha256 it does not already have, verifies each file's sha256, and stages the directory. Files are the normal `https://tinyglow.app/<path>` of the web container (hashed `/assets/*` are immutable). No MinIO, no new bucket. Signing on the server rather than in CI: the repo's CI is secret-free and pushes nothing (`ci.yml` header), the server already holds every other secret, and the signature still protects the phone from a tampered CDN/proxy/MITM and from bundles not produced by the deployer. |
| D3 | When to download / apply | Download **only when idle** (no upload item active in any lane, `photoSync` phase not `syncing`), on cold launch and on `resume` at most every 6 h; **apply on the next cold launch** (Capacitor loads the persisted path before any plugin runs: no in-session reload, so an upload or sync is never interrupted). Settings → About shows "Update ready — restart to apply" with a Restart button that reloads only when idle. No automatic mid-session reload in v1. |
| D4 | Metered connections | Missing bytes ≤ **2 MiB** → download on any network; more → **Wi-Fi only** (retry on the next trigger). Never while Low Data Mode (`isConstrained`) / Data Saver, Low Power Mode or a hot thermal state is on. Same primitives as `TinyglowPhotoSync.conditions()`. |
| D5 | Compatibility | `apps/mobile-web/app-update.json` → `minNativeBuild: { ios, android }` (integers = iOS `CFBundleVersion` / Android `versionCode`, both `1` today). Server **and** phone refuse a bundle whose `minNativeBuild` exceeds the shell's build (`reason: "native_too_old"`). A new native binary clears OTA state (Capacitor's `isNewBinary` reset, both platforms) and the shell runs its bundled web until the next successful check. The server's manifest is authoritative even when older than the shell's bundled web (same as browsers). |
| D6 | Keys | ECDSA P-256. Production pair generated **by us** with `docker/tools/app-update-keygen.sh` (no account needed): public key committed in `packages/shared/src/app-update.ts` and mirrored in `LLUpdateKeys.swift` / `UpdateKeys.java` (CI asserts equality); the private key is printed once for the user's `.env`. A **dev pair is committed** (`.env.dev`, same policy as the dev JWT secret) and trusted **only by Debug builds** (`#if DEBUG` / `BuildConfig.DEBUG`), so a Release build can never accept a dev-signed bundle. Rotation: `keyId` in the envelope; the apps hold a list; a new key ships in a store build before the server switches. |
| D7 | Operator controls | `APP_UPDATE_ENABLED` (api; default `true`; `false` ⇒ `reason: "disabled"`), `APP_UPDATE_SOURCE_URL` (default `http://web/app-update/manifest.json`), `APP_UPDATE_FILES_BASE_URL` (default `PUBLIC_URL`). Nothing in the dev stack runs unless a gate asks (zero-setup kept: no key ⇒ updater inert). |
| D8 | Store policy | Allowed: Apple DPLA 3.3.1(B) and Play's interpreter exemption (2.11). Every store build keeps the bundled web as fallback (`cap sync` at release time, unchanged). No listing text changes. |
| D9 | Privacy / telemetry | The only request is `GET /api/app-update/manifest?platform&native&current` (platform, native build number, current bundle id). **No device id, no stats, no per-device server state.** The api logs counts and outcomes only. |
| D10 | Build-flag drift | The OTA bundle is the web image's build, so the web image must bake the native release values: `VITE_API_URL=${PUBLIC_URL}` (`apiUrl()` uses it only when `isNative()`, browsers unaffected) and the Android push flag moves from build time (`VITE_PUSH_ANDROID`) to a **runtime probe** (`TinyglowUpdater.info().androidPushConfigured`); `VITE_APP_VERSION` for push registration is replaced by `info().nativeVersion` at runtime. `VITE_DEEPLINK_DEV_SCHEME` unset = off and `VITE_SENTRY_DSN` is already behind `isNative()`: both fine. |
| D11 | Web browsers | Unchanged: the SPA is served live by nginx; this step is native only. |

## 1. Goal

Make a production deploy (`git pull && docker compose up -d --build`) reach the installed iPhone
and Android apps without a store release: the apps keep their bundled web as a fallback, check a
signed manifest from our own server when idle, download only the changed files (Wi-Fi by default,
small deltas on cellular), verify every byte against the manifest and the manifest against a key
compiled into the app, refuse bundles that need a newer native shell, apply on the next cold
launch, and roll back automatically to the last good bundle when the new one fails to boot. No
third-party service, account or dependency; the dev stack stays zero-setup; store builds and
`pnpm native:build` / `cap sync` keep working as today.

## 2. Interfaces first

### 2.1 Topology

```
build   apps/mobile-web/Dockerfile (build stage): pnpm --filter @tinyglow/mobile-web build
          = vite build (VITE_API_URL=${PUBLIC_URL}) + node scripts/app-update-manifest.mjs dist
          -> dist/app-update/manifest.json  { schema, version, webVersion, minNativeBuild, builtAt, files[] }
        nginx (web) serves dist/ as today + GET /app-update/manifest.json (no-cache, exact match)
sign    api  GET /api/app-update/manifest?platform=ios&native=12&current=<id>   (public, X-Tinyglow-Client)
          -> fetch http://web/app-update/manifest.json (cached 60 s, stale ok 24 h)
          -> gate: enabled? platform/native >= minNativeBuild? current == version?
          -> { update: { manifestJson, signature, keyId } } | { update: null, reason }
             manifestJson = JSON string of { ...manifest, baseUrl } ; signature = ECDSA-P256-SHA256(DER) over its UTF-8 bytes
phone   JS (platform/native/appUpdate.ts): idle? -> fetch manifest -> TinyglowUpdater.stage({ manifestJson, signature, keyId })
        native: verify signature (compiled-in keys) -> parse -> minNativeBuild check -> missing files
                -> network policy (D4) -> download baseUrl/<path> (Accept-Encoding: identity) -> sha256 each
                -> write <bundles>/<version>/ (reuse unchanged files from the current bundle) -> persist serverBasePath
        next cold start: Capacitor loads <bundles>/<version>/ ; plugin watchdog 10 s -> JS notifyAppReady()
                -> else: mark failed, restore previous good (or builtin), reload
```

No new service. No new npm dependency. New native code: `TinyglowUpdater` (iOS Swift, Android
Java), ~300 lines each plus Foundation/JCA crypto (CryptoKit `P256.Signing`, `SHA256withECDSA`).

### 2.2 Database (security-engineer): none

Nothing per device is stored (D9). No migration, no RLS change. Task 14.2 greps `packages/db` to
prove no table was added by anyone.

### 2.3 Shared contracts (`@tinyglow/shared`; architect-defined here, backend-engineer writes in 14.1 with orchestrator approval)

- `app-update.ts` (new; browser-safe):
  - `APP_UPDATE_MANIFEST_SCHEMA = 1`; `APP_UPDATE_MANIFEST_PATH = "app-update/manifest.json"`.
  - `APP_UPDATE_EXCLUDE_PREFIXES = ["app-update/", ".well-known/", "email-templates/"]`.
  - `APP_UPDATE_CELLULAR_MAX_BYTES = 2 * 1024 * 1024` (D4); `APP_UPDATE_CHECK_INTERVAL_MS = 6 h`;
    `APP_UPDATE_READY_TIMEOUT_MS = 10_000`; `APP_UPDATE_MAX_FILES = 2_000`;
    `APP_UPDATE_MAX_BUNDLE_BYTES = 64 MiB`; `APP_UPDATE_FREE_SPACE_MARGIN_BYTES = 64 MiB`;
    `APP_UPDATE_KEEP_BUNDLES = 2` (current + previous, besides builtin).
  - `appUpdateFileSchema = z.object({ path: z.string().min(1).max(512).regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\u0000]+$/), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.int().min(0).max(APP_UPDATE_MAX_BUNDLE_BYTES) })`.
  - `appUpdateManifestSchema = z.object({ schema: z.literal(1), version: z.string().regex(/^[0-9a-f]{16}$/), webVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/), minNativeBuild: z.object({ ios: z.int().min(1), android: z.int().min(1) }), builtAt: isoDateTimeSchema, files: z.array(appUpdateFileSchema).min(1).max(APP_UPDATE_MAX_FILES) })` with a refinement: `files` contains `index.html`, paths unique, none starts with an excluded prefix.
  - `signedAppUpdateManifestSchema = appUpdateManifestSchema.extend({ baseUrl: z.url() })` (what `manifestJson` parses to; `baseUrl` is an origin or origin + path, no query, no fragment, `https:` unless host is `localhost`/`127.0.0.1`/`10.0.2.2`).
  - `APP_UPDATE_PUBLIC_KEYS = { prod: { keyId: "prod-2026-10", spkiBase64: "<set by 14.3>" }, dev: { keyId: "dev", spkiBase64: "<set by 14.3>" } }` (SPKI DER, base64). Server-side check in 14.4: the configured private key's public half must equal `prod` (NODE_ENV=production) or `dev`/`prod` (otherwise), else the api refuses to start the feature with one log line (no key material logged).
  - `appUpdateContentId(files)`: `sha256(files.sort(by path).map(f => `${f.path}\n${f.sha256}\n`).join("")).slice(0, 16)` — the `version`. Pure function so the generator, the api and the tests share it.
- `api/app-update.ts` (new):
  - `appUpdateManifestQuerySchema = z.object({ platform: z.enum(["ios","android"]), native: z.coerce.number().int().min(1).max(1_000_000), current: z.string().regex(/^[0-9a-f]{16}$/).optional() })`.
  - `appUpdateManifestResponseSchema = z.object({ update: z.object({ manifestJson: z.string().max(1_048_576), signature: z.string().regex(base64) /* DER ECDSA, ≤ 72 bytes */, keyId: z.string().max(32) }).nullable(), reason: z.enum(["disabled","unavailable","native_too_old","up_to_date"]).optional() })`.
- `native.ts`: `APP_UPDATE_STATE_KEY = "ll.app-update.v1"` (localStorage; `{ lastCheckAt }` only; allow-listed in `native-storage-allowlist.txt`).
- `env.ts`: `appUpdateEnvSchema = z.object({ APP_UPDATE_ENABLED: boolean default true, APP_UPDATE_SIGNING_KEY_BASE64: z.string().optional() /* base64 PKCS#8 DER, EC P-256; empty = feature off */, APP_UPDATE_SOURCE_URL: z.url().default("http://web/app-update/manifest.json"), APP_UPDATE_FILES_BASE_URL: z.url().optional() /* default PUBLIC_URL */ })`.
- `api/errors.ts`: no new code. Bad query → existing `validation_failed`. Everything else is a 200 with `update: null, reason`.
- `telemetry.ts`: scrub `signature`, `manifestJson`, `APP_UPDATE_SIGNING_KEY_BASE64` values.
- `index.ts`: export both new files.

### 2.4 Manifest generator (`apps/mobile-web/scripts/app-update-manifest.mjs`, `apps/mobile-web/app-update.json`; mobile-engineer)

Plain Node ESM (no tsx: the web image's build stage must run it). `node scripts/app-update-manifest.mjs <distDir>`:
walks `<distDir>`, skips `APP_UPDATE_EXCLUDE_PREFIXES` (own copy of the three literals; a unit test
asserts they equal the shared constant), sha256 + size per file, sorted by path, `version =
appUpdateContentId(files)` (same algorithm, re-implemented in 20 lines; tested against the shared
function), `webVersion` and `minNativeBuild` from `apps/mobile-web/app-update.json`:

```json
{ "webVersion": "1.0.0", "minNativeBuild": { "ios": 1, "android": 1 } }
```

Writes `<distDir>/app-update/manifest.json` (2-space JSON, trailing newline). Deterministic for a
given `dist` (`builtAt` is the only non-content field; content id ignores it). `package.json`:
`"build": "vite build && node scripts/app-update-manifest.mjs dist"`, and the same suffix on
`native:build` and `native:build:release`, so `cap sync` copies `public/app-update/manifest.json`
into both shells = the **builtin bundle's identity**. Rule in `NATIVE.md`: bump `minNativeBuild.<platform>`
in the same commit that adds or changes a native plugin method the web calls (the release lanes
bump `CFBundleVersion`/`versionCode`).

### 2.5 Web container (`docker/nginx/default.conf`, `apps/mobile-web/Dockerfile`; devops-engineer)

- Dockerfile `build` stage: `ARG VITE_API_URL=""` passed to `pnpm build` (D10). docker-compose.yml
  `web.build.args.VITE_API_URL: ${PUBLIC_URL:-https://tinyglow.app}`. Dev compose unchanged (Vite dev
  server; no manifest; `apiUrl()` dev builds keep `http://localhost:8080`).
- nginx: `location = /app-update/manifest.json { expires -1; add_header Cache-Control "no-cache" always; try_files $uri =404; }`
  so a missing manifest is a 404, never the SPA shell (the catch-all would answer `index.html` with
  200). nginx 1.28 drops server-level `add_header`s in a location with its own: repeat the four
  security headers + the CSP include as `/s/` does. Keep the file public (it lists public files).
- The api fetches it over the compose network (`http://web/...`, like GoTrue fetches the email
  templates). Nothing else changes; `/assets/*` stays `expires 1y`.

### 2.6 API (`apps/api/src/app-update/**`, `apps/api/src/config.ts`, `apps/api/src/app.ts`; backend-engineer)

- `config.ts`: merge `appUpdateEnvSchema`; `appUpdateFilesBaseUrl = APP_UPDATE_FILES_BASE_URL ?? PUBLIC_URL`.
- `app-update/signer.ts`: `loadSigningKey(b64)` → `crypto.createPrivateKey({ key, format: "der", type: "pkcs8" })`,
  asserts `asymmetricKeyType === "ec"` and curve `prime256v1`; `publicSpkiBase64(key)`; boot check
  against `APP_UPDATE_PUBLIC_KEYS` (2.3). `sign(manifestJson)` = `crypto.sign("sha256", utf8, { key, dsaEncoding: "der" })`
  base64. Never logs the key, the manifest or the signature.
- `app-update/source.ts`: fetch `APP_UPDATE_SOURCE_URL` with a 3 s timeout, `If-None-Match`,
  validate with `appUpdateManifestSchema` (reject → treated as unavailable, logged once per distinct
  failure as `{ outcome: "invalid_manifest" }`), cache 60 s, serve stale ≤ 24 h on upstream failure.
  Signed envelope memoised per `(manifest.version, baseUrl)`.
- `app-update/routes.ts`: `GET /app-update/manifest` (public; no auth; the CORS plugin already
  requires `X-Tinyglow-Client: native` for native origins; web callers get `{ update: null, reason: "disabled" }`
  when `X-Tinyglow-Client` is not `native`, so browsers never see it as an update source).
  Order: key missing or `APP_UPDATE_ENABLED=false` → `disabled`; upstream unavailable → `unavailable`;
  `native < minNativeBuild[platform]` → `native_too_old`; `current === version` → `up_to_date`;
  else `{ update: { manifestJson, signature, keyId } }`. `Cache-Control: no-store`. Log
  `{ outcome, platform }` only (never `native`, `current`, bodies or URLs). Registered in
  `app.ts registerRoutes` after `pushRoutes`.
- Rate limit: the route is cheap and cached; no new limiter. Body size irrelevant (GET).

### 2.7 Native plugin `TinyglowUpdater` (`apps/mobile-web/ios/**`, `apps/mobile-web/android/**`; mobile-engineer)

Files: `ios/App/App/TinyglowUpdater.swift` (plugin), `ios/App/App/LLUpdateBundle.swift`
(Foundation-only: manifest parsing, content id, file layout, verification; harness-testable),
`ios/App/App/LLUpdateKeys.swift`; `android/app/src/main/java/app/tinyglow/update/TinyglowUpdaterPlugin.java`,
`UpdateBundle.java` (pure Java: same responsibilities), `UpdateKeys.java`. Register in
`MainActivity` and the iOS packages list like the other plugins.

Storage: iOS `Library/NoCloud/ionic_built_snapshots/<version>/` (**this exact path**: Capacitor
maps the persisted `serverBasePath` to `Library/NoCloud/ionic_built_snapshots/<lastPathComponent>`,
`CAPBridgeViewController.swift:94-100`); add `Library/NoCloud` to `AppDelegate.excludeFromBackup()`.
Android `filesDir/ll-updates/<version>/`. State file `<bundles>/state.json` =
`{ current: version|null, previous: version|null, good: [versions], failed: [versions] }` (no URLs,
no timestamps that identify a person). Builtin identity from `public/app-update/manifest.json`.

```ts
interface TinyglowUpdaterPlugin {
  /** Shell + bundle facts for the UI and for the manifest query. */
  info(): Promise<{
    nativeVersion: string;      // CFBundleShortVersionString / versionName
    nativeBuild: number;        // CFBundleVersion / versionCode
    builtinVersion: string;     // content id of public/app-update/manifest.json
    currentVersion: string;     // builtin or the active OTA bundle
    currentSource: "builtin" | "ota";
    stagedVersion: string | null;   // downloaded, applies on next launch
    androidPushConfigured: boolean; // Android: google-services resources present; iOS: true (D10)
  }>;
  /** Verify the signed manifest, download the missing files, stage the bundle (D3, D4). */
  stage(args: { manifestJson: string; signature: string; keyId: string }): Promise<{
    outcome: "staged" | "up_to_date" | "already_staged" | "native_too_old" | "wifi_required"
           | "constrained" | "no_space" | "network" | "verify_failed" | "rejected";
    version?: string; bytes?: number;   // bytes = what would be / was downloaded
  }>;
  /** JS booted: cancel the watchdog, mark the current bundle good. Must be called every launch. */
  notifyAppReady(): Promise<void>;
  /** Reload into the staged bundle now (the JS side checks idle first). */
  applyNow(): Promise<void>;
  /** Back to the bundled web (Settings → About → "Reset app files"); clears OTA state. */
  reset(): Promise<void>;
}
```

Rules the native code must follow:

- **Verification order**: signature over the exact `manifestJson` bytes with every trusted key
  (`prod` always; `dev` only under `#if DEBUG` / `BuildConfig.DEBUG`; `keyId` selects, mismatch →
  `verify_failed`) → parse → `schema == 1`, `files ≤ 2000`, total size ≤ 64 MiB, path rules (no
  leading `/`, no `..` segment, no NUL) → `minNativeBuild[platform] ≤ nativeBuild` else
  `native_too_old` → `version` in `failed` → `rejected` → `version == current` → `up_to_date`.
- **Downloads**: foreground only (`URLSession` default session / `HttpURLConnection` on an executor,
  4 in flight), `Accept-Encoding: identity`, 20 s per file, into `<bundles>/tmp-<version>/`; sha256
  of the bytes as stored must equal the manifest's; size must equal too; unchanged files are copied
  from the current bundle directory (same sha256) instead of downloaded; free space must be ≥ bytes
  needed + 64 MiB else `no_space`; any failure deletes the temp dir and returns `network` /
  `verify_failed` (a tampered file is `verify_failed`; nothing partial is ever staged).
- **Network policy** (D4): iOS `NWPathMonitor` (`isExpensive`, `isConstrained`), Android
  `ConnectivityManager.isActiveNetworkMetered()` + `getRestrictBackgroundStatus()`; Low Power /
  `ProcessInfo.thermalState` hot → `constrained`; metered and bytes > 2 MiB → `wifi_required`.
- **Staging**: rename temp → `<bundles>/<version>/`, write `state.json` (`previous = current`),
  persist the Capacitor key: iOS `KeyValueStore.standard["serverBasePath"] = path`
  (`WebView.swift:40` does exactly this), Android `SharedPreferences(WEBVIEW_PREFS_NAME)
  .serverBasePath = path` (`plugin/WebView.java:40-45`). Do **not** reload.
- **Launch**: Capacitor applies the persisted path itself before any plugin loads. In `load()`: if
  `currentSource == "ota"` and `current ∉ good`, start a 10 s watchdog (from the WebView's
  `didFinish` / `onPageFinished`, else from `load()` + 15 s). `notifyAppReady()` cancels it and
  appends `current` to `good`. Expiry → append to `failed`, delete the bundle, set
  `serverBasePath` to `previous` (if present and in `good`) or clear it and point at the builtin
  (`Bundle.main.path(forResource: "public")` / `bridge.setServerAssetPath("public")`), then reload
  via `CAPBridgeViewController.setServerBasePath(path:)` / `bridge.setServerBasePath(path)`.
- **New native binary**: Capacitor clears the persisted path (`isNewBinary`). The plugin prunes
  every bundle dir on that launch and resets `state.json` (the next check re-downloads the
  server's bundle, incremental).
- **Pruning**: keep `current` and `previous` only (`APP_UPDATE_KEEP_BUNDLES`); delete `tmp-*`
  older than a day on `load()`.
- **Logging**: outcomes only. Never a URL, path, signature, manifest or file name (`print`/`NSLog`/
  `Log.*` with such values are forbidden; the hygiene check greps for them).
- `applyNow()`: only if `stagedVersion` is set; sets `serverBasePath` (already persisted) and
  reloads (`setServerBasePath`). `reset()`: clear the persisted key, delete all bundles, reload into
  the builtin.

Host-side tests (no simulator): `ios/scripts/update-bundle-harness.sh` compiles
`LLUpdateBundle.swift` with a harness (`swiftc` on macOS; skipped on Linux with a SKIP line like
the passkey harness) and asserts: signature verification with the dev key over a vector produced
by `e2e/ota/vectors.json` (14.10 writes it with Node), rejection of a flipped byte, path rules,
`minNativeBuild`, content id equality with the shared function, state transitions, prune. Android
`./gradlew testDebugUnitTest --tests 'app.tinyglow.update.*'` (`UpdateBundleTest`) with the same
vectors.

### 2.8 Web app (`apps/mobile-web/src/**`; frontend-engineer)

- `platform/native/appUpdate.ts` (new): `registerPlugin<TinyglowUpdaterPlugin>("TinyglowUpdater")`
  (wrap, never resolve a promise with the plugin object: NATIVE.md pitfall 1). `checkForUpdate(trigger: "launch" | "resume" | "manual")`:
  (1) native only; (2) `trigger !== "manual"` and `lastCheckAt` (localStorage `APP_UPDATE_STATE_KEY`,
  `{ lastCheckAt }` only) younger than `APP_UPDATE_CHECK_INTERVAL_MS` → skip; (3) **idle gate**:
  `summarize(uploadManager.snapshot).active === 0` for every lane and (iOS) `photoSync.phase() !== "syncing"`,
  else skip (re-tried on the next trigger); (4) `info()` → `GET /api/app-update/manifest?platform&native&current`
  via `lib/api.ts` (unauthenticated call; keeps the `X-Tinyglow-Client` header); (5) `update ?
  stage(update) : record reason`; (6) store `lastCheckAt`; outcomes to a small zustand/`useSyncExternalStore`
  store for the About page. Never logs bodies. 5 s timeout fallbacks like `pushPermission()`.
- `bootstrap.ts` `afterFirstRender()`: after `hideSplash()`, `void notifyAppReady()` (both the main
  app and the share viewer path reach it from `main.tsx`). `NativeEvents.tsx`: `checkForUpdate("launch")`
  10 s after the signed-in effect fires, `checkForUpdate("resume")` in the `resume` listener (after
  `refreshIfNeeded`), both fire-and-forget.
- `push.ts`: `supportsPush()` for Android uses `info().androidPushConfigured` (fallback to
  `VITE_PUSH_ANDROID === "1"` when the plugin is missing, i.e. unit tests / old shells); the
  `app_version` sent to `register_push_device` becomes `info().nativeVersion` (fallback
  `VITE_APP_VERSION`) (D10).
- Settings → new `AboutPage` (`/settings/about`, row `settings-about`, native and web): web shows
  "Tinyglow web <webVersion>" from `/app-update/manifest.json`? No: web shows nothing version-related
  beyond the build (`import.meta.env.VITE_APP_VERSION` fallback "web"). Native shows "App
  {nativeVersion} ({nativeBuild})", "Web {webVersion} · {currentVersion}", source badge (bundled /
  updated), "Update ready — restart to apply" + `Restart` button (disabled with explanation while an
  upload or sync is active), "Check for updates" (manual trigger; shows the outcome copy: up to
  date / waiting for Wi-Fi / update needs the App Store version / downloading), and "Reset app
  files" under a confirm sheet. i18n keys under `appUpdate.*`. Follows `docs/DESIGN.md`
  (light/dark phone/desktop screenshot check before the UI commit).
- Native-only chunk: `appUpdate.ts` is imported lazily from `NativeEvents`/`bootstrap`/About so the
  web bundle carries no Capacitor code (existing rule).

### 2.9 Devops (`docker-compose*.yml`, `.env.example`, `.env.dev`, `docker/**`, `.github/**`, `docs/PRODUCTION.md`; devops-engineer)

- `docker-compose.yml` api: `APP_UPDATE_ENABLED: ${APP_UPDATE_ENABLED:-true}`,
  `APP_UPDATE_SIGNING_KEY_BASE64: ${APP_UPDATE_SIGNING_KEY_BASE64:-}`,
  `APP_UPDATE_SOURCE_URL: http://web/app-update/manifest.json` (fixed), `APP_UPDATE_FILES_BASE_URL:
  ${APP_UPDATE_FILES_BASE_URL:-${PUBLIC_URL:-https://tinyglow.app}}`. **api only** (not x-app-env):
  extend `check-compose-keys.mjs` so the canary proves the key reaches no other service. `web`
  build arg `VITE_API_URL` (2.5).
- `docker-compose.dev.yml` api: the dev private key from `.env.dev` (`APP_UPDATE_SIGNING_KEY_BASE64`,
  loaded by env_file, api only — the other services' env_file blocks must blank it like the review
  account: add it to a `*dev-no-app-update-key` anchor for migrate/worker/web), `APP_UPDATE_SOURCE_URL:
  ${APP_UPDATE_SOURCE_URL:-http://web:8080/app-update/manifest.json}` and
  `APP_UPDATE_FILES_BASE_URL: ${APP_UPDATE_FILES_BASE_URL:-http://localhost:${WEB_PORT:-8080}}` as
  Compose INTERPOLATION variables so the gate can point the api at its own static server
  (`http://host.docker.internal:18090/manifest.json`, files `http://localhost:18090`) and a plain
  `up` restores the defaults (Vite dev → 404 → `unavailable`: inert).
- `.env.example`: the three variables with comments; how to generate the key
  (`sh docker/tools/app-update-keygen.sh` prints `APP_UPDATE_SIGNING_KEY_BASE64=` and the public
  SPKI base64 to compare with `packages/shared`). `.env.dev`: the committed dev key with the
  throwaway banner.
- `docker/tools/app-update-keygen.sh`: `openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -outform DER | base64`
  and the matching `openssl ec -pubout -outform DER | base64`; prints both, never writes a file.
- CI (`ci.yml`): `check` job runs `.github/scripts/app-update-hygiene.sh`: (a) the `prod` and
  `dev` SPKI strings in `packages/shared/src/app-update.ts` equal the constants in
  `LLUpdateKeys.swift` and `UpdateKeys.java`, and the `dev` constant is referenced only inside
  `#if DEBUG` (Swift) / `if (BuildConfig.DEBUG)` (Java); (b) no `@capgo/*`, `@ionic-enterprise/*`,
  `capacitor-updater` or `appflow` in any `package.json`; (c) `APP_UPDATE_SIGNING_KEY_BASE64` is
  empty in `.env.example`, set in `.env.dev`, and `.env.dev`'s value decodes to the `dev` public
  key (node one-liner); (d) no `print`/`NSLog`/`Log.` call in the updater sources carries a path,
  URL, signature or manifest variable; no `console.*` in `appUpdate.ts`; (e) `apps/mobile-web/package.json`
  `build`, `native:build`, `native:build:release` all end with the manifest step; (f)
  `apps/mobile-web/app-update.json` parses and `minNativeBuild` values are ≤ the shells' current
  build numbers (`CURRENT_PROJECT_VERSION` in the pbxproj, `versionCode` in `build.gradle`): a web
  that needs a build nobody has yet is a mistake. `images` job: after the CSP check, run the web
  image and `.github/scripts/check-web-app-update.sh`: `curl /app-update/manifest.json` is JSON with
  `schema 1`, lists `index.html`, lists nothing under `.well-known/` or `app-update/`, every listed
  file downloads with matching sha256 and size, and `/app-update/missing.json` is 404 (not the SPA).
  `dev-stack-smoke`: `pnpm e2e:ota-gate` (2.10) after the abuse gate, with its own log tap and a
  scan of api logs for `signature`, `manifestJson`, base64 key material and URLs. `android-debug`:
  add `--tests 'app.tinyglow.update.*'` to a `testDebugUnitTest` step. `ios-sim-build`: run
  `sh ios/scripts/update-bundle-harness.sh`.
- `docs/PRODUCTION.md`: new **Part L: App updates without the stores** (what it does, the key
  (`.env` + `up -d api`), how to confirm (`curl -s 'https://tinyglow.app/api/app-update/manifest?platform=ios&native=1' -H 'X-Tinyglow-Client: native' | head -c 300` shows `manifestJson`;
  without the header: `reason: "disabled"`), the `APP_UPDATE_ENABLED=false` kill switch, Cloudflare
  must not rewrite HTML/JS (Rocket Loader, Auto Minify, Email Address Obfuscation off; the hash
  check makes a rewrite a failed update, never a broken app), when a store release is still needed
  (any native change: plugins, permissions, SDK, Capacitor upgrade; bump `minNativeBuild` then),
  and a line in "Updating Tinyglow later": phones pick the new web up on their next launch after
  the check interval. Part H gets step 7 "the first store build already contains the updater".

### 2.10 Tests and gates (`**/*.test.ts`, `e2e/ota/**`, `e2e/native/**`; test-engineer)

- Unit: `packages/shared/src/app-update.test.ts` (schemas, content id vectors, path rules,
  exclude prefixes), `apps/mobile-web/scripts/app-update-manifest.test.ts` (runs the `.mjs` on a
  fixture dir; determinism; excludes; equals shared content id), `apps/api/src/app-update/*.test.ts`
  (signer key checks, boot mismatch refusal, signature verifies with Node `crypto.verify` and the
  SPKI from shared, DER length ≤ 72; source cache/stale/invalid handling with an injected fetch),
  `apps/mobile-web/src/platform/native/appUpdate.test.ts` (idle gate against a fake upload manager
  and photoSync phase, interval, trigger rules, outcome store, never logs), `push.test.ts` updates
  (runtime flag), `AboutPage.test.tsx`.
- Integration (`apps/api/src/app-update/routes.integration.test.ts`, api-integration project, added to
  `check-integration-report.mjs`): disabled when key empty; `unavailable` on upstream 404/500/invalid;
  `native_too_old`; `up_to_date`; signed envelope verifies; web client header → `disabled`;
  `Cache-Control: no-store`; log capture contains no `native=`, `current=`, signature or URL.
- `e2e/ota/gate.ts` (`pnpm e2e:ota-gate`, dev stack): builds the web once (`pnpm --filter
  @tinyglow/mobile-web build` with `VITE_API_URL=http://localhost:8080`), writes variant **B**
  (comment appended to `index.html` → new content id) and variant **C** (module `<script>` removed:
  boots to a blank page, never calls `notifyAppReady`), serves them from a host static server on
  `18090` (`e2e/ota/serve.ts`), recreates the api with `APP_UPDATE_SOURCE_URL` /
  `APP_UPDATE_FILES_BASE_URL` pointing at it, then asserts through `/api/app-update/manifest`:
  signature verifies with the dev SPKI (Node), `native=0`-style too-old → `native_too_old`
  (temporarily serving a manifest with `minNativeBuild.ios = 99`), `current=<B>` → `up_to_date`,
  `APP_UPDATE_ENABLED=false` → `disabled`, a tampered `manifest.json` (hash edited) → still signed
  (the server signs what it is given) but `e2e/ota/verify.ts` (the TS reference implementation of
  the native algorithm: signature → parse → rules → download → sha256) reports `verify_failed`;
  variant B verifies end to end and the delta size vs. A is < 2 MiB (D4 sanity). Writes
  `e2e/ota/vectors.json` (manifestJson, signature, dev key, expected content id, one tampered
  variant) for the two native harnesses. Restores the api to the stack defaults in a finally.
- Native (local only, like the other device gates): extend `e2e/native/ios-gate.sh` (+ XCUITest
  `testOtaUpdateAndRollback` in `e2e/native/ios-uitest`) and `e2e/native/android-gate.ts`: install
  the Debug build (bundled A), start the OTA server with B, api pointed at it, launch, sign in,
  wait for Settings → About "Update ready", relaunch → About shows B's id and source "updated";
  switch the server to C, "Check for updates", relaunch → blank for ≤ 10 s, then the app comes back
  on B (About: B, source updated) and a second relaunch stays on B (C in `failed`, not re-offered);
  "Reset app files" → bundled A. Log scan of the app process for URLs, signatures, paths.
  Documented as `pnpm e2e:native-ios -- --ota` / `pnpm e2e:native-android -- --ota`.

### 2.11 Store policy (for the record; copy into `store/review-notes.md` only if asked)

- Apple App Review Guideline 2.5.2 (verbatim): "Apps should be self-contained in their bundles,
  and may not read or write data outside the designated container area, nor may they download,
  install, or execute code which introduces or changes features or functionality of the app,
  including other apps." Read together with the Apple Developer Program License Agreement
  §3.3.1(B) "Executable Code" (verbatim, current agreement): "Interpreted code may be downloaded to
  an Application but only so long as such code: (a) does not change the primary purpose of the
  Application by providing features or functionality that are inconsistent with the intended and
  advertised purpose of the Application (b) does not bypass signing, sandbox, or other security
  features of the OS; and (c) for Applications distributed on the App Store, does not create a
  store or storefront for other Applications." Tinyglow's OTA bundle is HTML/CSS/JS run by WebKit
  inside the sandbox, keeps the same purpose (a private baby photo album), and uses no private
  API: this is the mechanism Appflow Live Updates and Capgo rely on and that App Review accepts.
  Guideline 4.7 (HTML5 mini apps) does not apply: the content is the app itself, not third-party
  software offered inside it.
- Google Play "Device and Network Abuse" (verbatim): "An app distributed via Google Play may not
  modify, replace, or update itself using any method other than Google Play's update mechanism.
  Likewise, an app may not download executable code (such as dex, JAR, .so files) from a source
  other than Google Play. This restriction does not apply to code that runs in a virtual machine
  or an interpreter where either provides indirect access to Android APIs (such as JavaScript in
  a webview or browser)." The bundle is JavaScript in a WebView: exempt. No dex/JAR/.so is ever
  downloaded; the hygiene check (2.9 d) and the path rules (2.7) make that structural.
- Both stores still get a native release for any native change (D5, D8). No new privacy label
  or Data Safety entry: the manifest request carries no identifier (D9).

## 3. Tasks

Owners per `CLAUDE.md`. Groups run in parallel (disjoint paths); later groups depend on earlier.
`packages/shared/**` is written by backend-engineer with orchestrator approval, as in steps 12–13.

### Group 0 — contracts, keys, generator, compose (parallel)

**14.1 Shared contracts** — backend-engineer (orchestrator approval). Owns
`packages/shared/src/{app-update,native,env,telemetry,index}.ts`, `packages/shared/src/api/app-update.ts`.
Inputs: 2.3. Done when: every name in 2.3 exists with those shapes; `appUpdateContentId` has
documented vectors; `pnpm --filter @tinyglow/shared test typecheck` green; `APP_UPDATE_PUBLIC_KEYS`
holds placeholders `"<set by 14.3>"` that 14.3 replaces (a test fails while a placeholder remains).

**14.2 No database change (proof)** — security-engineer. Owns nothing new; reads `packages/db/**`.
Done when: `git diff --stat main -- packages/db` is empty at the gate and `grep -ri "app_update\|app-update" packages/db` finds nothing; one line in the step's PROGRESS entry.

**14.3 Keys and keygen** — devops-engineer, then orchestrator. Owns `docker/tools/app-update-keygen.sh`,
`.env.dev` (dev key), `.env.example`. Inputs: D6. Done when: the script prints a fresh pair
(`APP_UPDATE_SIGNING_KEY_BASE64=…` and `# public SPKI: …`) and never writes a file; `.env.dev` carries a
**dev** pair generated with it; the orchestrator runs it once more for **production**, pastes the two
public SPKI strings into `packages/shared/src/app-update.ts` (`dev`, `prod`; this edit is
pre-approved by this plan) and hands the production private line to the user for `.env` (printed
once in the chat, not written anywhere in the repo). `bash .github/scripts/native-hygiene.sh` still
passes (the base64 DER does not match the PEM-header regex; keep it that way).

**14.4 Manifest generator, app-update.json, scripts** — mobile-engineer. Owns
`apps/mobile-web/scripts/app-update-manifest.mjs`, `apps/mobile-web/app-update.json`,
`apps/mobile-web/package.json` (scripts only). Inputs: 2.4. Done when: `pnpm --filter
@tinyglow/mobile-web build` leaves `dist/app-update/manifest.json` with `schema 1`, `index.html`
listed, nothing under `.well-known/`, `version` equal to the shared `appUpdateContentId` of its
files (checked in 14.11's test), two builds of the same tree give the same `version`;
`native:build` and `native:build:release` include the step; `native:sync:ios` puts
`public/app-update/manifest.json` into `ios/App/App/public/` (git-ignored there, like the rest).

**14.5 Compose, env, nginx, Dockerfile** — devops-engineer. Owns `docker-compose.yml`,
`docker-compose.dev.yml`, `.env.example`, `.env.dev`, `docker/nginx/default.conf`,
`apps/mobile-web/Dockerfile`. Inputs: 2.5, 2.9. Done when: both compose files `config -q` clean;
`check-compose-keys.mjs` extended so `APP_UPDATE_SIGNING_KEY_BASE64` reaches **api only** in both
files (canary green); the web image built with `--build-arg VITE_API_URL=https://example.test`
serves `/app-update/manifest.json` as JSON with `Cache-Control: no-cache` and `/app-update/nope.json`
as 404; `docker compose -f docker-compose.dev.yml up -d --wait` from a clean checkout still needs no
env file (api logs `app updates: source unavailable` once, nothing else changes).

### Group 1 — server, native, web (parallel; after group 0)

**14.6 API: signer, source, route** — backend-engineer. Owns `apps/api/src/app-update/**`,
`apps/api/src/config.ts`, `apps/api/src/app.ts`. Inputs: 2.6, 14.1. Done when: with the dev key
and a stub upstream (vitest), `GET /app-update/manifest?platform=ios&native=1` (header
`x-tinyglow-client: native`) returns an envelope whose signature `crypto.verify("sha256", utf8(manifestJson), spki, sig)`
is true with the shared `dev` SPKI; the five `reason`s of 2.6 reproduce; a key whose public half is
not in `APP_UPDATE_PUBLIC_KEYS` makes the api log one line and answer `disabled`; a captured log of
the suite has no `signature`, `manifestJson`, `native=`, `current=` or URL; `Cache-Control: no-store`.

**14.7 Native plugin `TinyglowUpdater` (iOS + Android)** — mobile-engineer. Owns
`apps/mobile-web/ios/**` (new `TinyglowUpdater.swift`, `LLUpdateBundle.swift`, `LLUpdateKeys.swift`,
`ios/scripts/update-bundle-harness.sh`, `AppDelegate.swift` backup exclusion),
`apps/mobile-web/android/**` (`app/tinyglow/update/*`, `MainActivity.java`, unit test scaffold),
`apps/mobile-web/NATIVE.md`. Inputs: 2.7, 14.1 (keys), 14.4 (builtin manifest). Done when: the
interface of 2.7 is implemented on both platforms with the rules listed; `sh ios/scripts/update-bundle-harness.sh`
and `./gradlew testDebugUnitTest --tests 'app.tinyglow.update.*'` pass against `e2e/ota/vectors.json`
(14.10) including the tampered vector; a Release-configuration build has no reference to the dev
key outside `#if DEBUG` / `BuildConfig.DEBUG` (`strings` on the Release binary does not contain
the dev SPKI); `NATIVE.md` gains "Live updates (`TinyglowUpdater`)" with the storage layout, the
watchdog, the `minNativeBuild` rule and how to run the harnesses; no `print`/`NSLog`/`Log.*` with
a path, URL or signature; Android manifest unchanged (no new permission; `INTERNET` already present).

**14.8 Web: updater client, About page, push flag** — frontend-engineer. Owns
`apps/mobile-web/src/**` (`platform/native/appUpdate.ts`, `bootstrap.ts`, `NativeEvents.tsx`,
`platform/native/push.ts`, `pages/settings/AboutPage.tsx`, `SettingsPage.tsx`, `App.tsx` route,
`i18n/en.ts`), `.github/scripts/native-storage-allowlist.txt` lines for `APP_UPDATE_STATE_KEY`
(reviewer OK recorded in the file header, as for `syncFlag.ts`). Inputs: 2.8, 14.1. Done when: in
the Vitest suites the check is skipped while an upload is active or sync is `syncing`, runs on
`launch`/`resume` within the interval rules, calls `stage` only for `update != null`, `notifyAppReady`
is called from `afterFirstRender` on both entry paths; the web bundle (`pnpm build`) contains no
`TinyglowUpdater` string (lazy native chunk); the About page renders every state of 2.8 at 375 px
light/dark and desktop (screenshots attached to the task result); `supportsPush()` on Android uses
the runtime flag; `bash .github/scripts/native-hygiene.sh` passes.

### Group 2 — tests, gates, CI (after group 1)

**14.9 Unit + integration tests** — test-engineer. Owns every `*.test.ts(x)` of 2.10 and
`.github/scripts/check-integration-report.mjs` suite list. Inputs: 14.1–14.8. Done when: `pnpm test`
and `pnpm test:integration` green with the new suites executed (report check lists
`apps/api/src/app-update/routes.integration.test.ts`); no new suite is `skipIf`'d away in CI.

**14.10 OTA gate + vectors + native gate extensions** — test-engineer. Owns `e2e/ota/**`,
`e2e/native/ios-gate.sh`, `e2e/native/android-gate.ts`, `e2e/native/ios-uitest/**`, root
`package.json` scripts (`e2e:ota-gate`, `typecheck:e2e` glob `e2e/ota/*.ts`). Inputs: 2.10.
Done when: `pnpm e2e:ota-gate` prints `PASS n/n` on the dev stack and leaves the api on the stack
defaults; `e2e/ota/vectors.json` is committed and consumed by 14.7's harnesses (14.7 and 14.10
iterate once: 14.10 writes the vectors first with the dev key from `.env.dev`, which needs only
14.1 + 14.3); the iOS and Android gates run the OTA scenario of 2.10 locally (recorded in
PROGRESS with screenshots; the device gates are local-only like today).

**14.11 CI + production guide** — devops-engineer. Owns `.github/**`, `docs/PRODUCTION.md`,
`apps/mobile-web/store/release-checklist.md` (one line: "bump `minNativeBuild` when a native change
ships"). Inputs: 2.9, 14.4–14.10. Done when: `bash .github/scripts/app-update-hygiene.sh` passes
locally and fails on each of the six conditions when provoked (documented in the script header);
`check-web-app-update.sh` passes against `tinyglow-web:ci`; `dev-stack-smoke` runs the OTA gate
with its log scan; `android-debug` runs the update unit tests; `ios-sim-build` runs the Swift
harness; Part L reads as a runbook (key, check, kill switch, Cloudflare settings, when a store
release is still needed).

### Group 3 — gate, PROGRESS, commit (orchestrator)

**14.12** Run section 4; record decisions D1–D11 and the user's answers to section 5 in
`docs/PROGRESS.md`; hand the production private key line to the user (once); commit
`step 14: live updates (OTA web bundle)`.

### Parallelism summary

| Group | Parallel tasks | Serial constraints |
| --- | --- | --- |
| 0 | 14.1 ∥ 14.3 ∥ 14.4 ∥ 14.5; 14.2 any time | 14.3's SPKI paste into shared happens after 14.1 lands (orchestrator edit) |
| 1 | 14.6 ∥ 14.7 ∥ 14.8 | 14.7 needs 14.4 (builtin manifest in `public/`) and the dev SPKI; 14.8 needs 14.1 |
| 2 | 14.9 ∥ 14.10; then 14.11 | 14.10's vectors feed 14.7's harnesses (one hand-back) |
| 3 | 14.12 | after 14.11 |

## 4. Acceptance checks

### 4.1 Static, unit, integration (always)

```sh
pnpm lint && pnpm typecheck && pnpm typecheck:e2e
bash .github/scripts/native-hygiene.sh
bash .github/scripts/app-update-hygiene.sh
pnpm test                                   # incl. shared app-update, manifest generator, api signer/source, appUpdate.ts, AboutPage
pnpm test:integration                       # incl. apps/api/src/app-update/routes.integration.test.ts (same env block as docs/plans/step-13.md 4)
git diff --stat main -- packages/db          # empty (14.2)
docker compose -f docker-compose.dev.yml config -q && cp .env.example .env && docker compose -f docker-compose.yml config -q; rm .env
node .github/scripts/check-compose-keys.mjs --print-env > .env.local && docker compose -f docker-compose.dev.yml config --format json | node .github/scripts/check-compose-keys.mjs dev; rm .env.local
```

### 4.2 Web image produces a valid bundle

```sh
docker build -f apps/mobile-web/Dockerfile --target prod --build-arg VITE_API_URL=https://example.test -t tinyglow-web:ota .
bash .github/scripts/check-web-app-update.sh tinyglow-web:ota
# prints: manifest ok (schema 1, N files, version <16 hex>), index.html listed, no .well-known/, every file sha256+size match, /app-update/nope.json -> 404
docker run --rm tinyglow-web:ota sh -c 'grep -o "example.test" /usr/share/nginx/html/assets/*.js | head -n1'   # VITE_API_URL baked (D10)
```

### 4.3 API by hand (dev stack, `B=http://localhost:8080`)

```sh
curl -s "$B/api/app-update/manifest?platform=ios&native=1" -H 'X-Tinyglow-Client: native'        # {"update":null,"reason":"unavailable"}  (Vite dev: no manifest; inert)
curl -s "$B/api/app-update/manifest?platform=ios&native=1" -H 'X-Tinyglow-Client: web'           # {"update":null,"reason":"disabled"}
curl -s -o /dev/null -w '%{http_code}\n' "$B/api/app-update/manifest?platform=mac&native=1" -H 'X-Tinyglow-Client: native'   # 400
pnpm e2e:ota-gate                                                                                  # PASS n/n: signed envelope verifies with the dev key, native_too_old, up_to_date, disabled, tampered -> verify_failed, delta < 2 MiB
docker compose -f docker-compose.dev.yml logs --no-color api | grep -E 'signature|manifestJson|native=|current=|http://' | grep -i 'app.update' && echo LEAK || echo 'log clean'
```

### 4.4 Native (local; one simulator, one emulator; Debug builds trust the dev key)

```sh
sh apps/mobile-web/ios/scripts/update-bundle-harness.sh                                   # host-side: signature, tamper, paths, minNativeBuild, state
(cd apps/mobile-web/android && JAVA_HOME=<jdk21> ./gradlew testDebugUnitTest --tests 'app.tinyglow.update.*')
pnpm e2e:native-ios -- --ota            # A -> "Update ready" -> relaunch on B -> broken C -> watchdog -> back on B -> C never re-offered -> Reset -> A
pnpm e2e:native-android -- --ota        # same scenario; adb reverse tcp:18090 tcp:18090 done by the gate
# Release build must not trust the dev key:
xcodebuild ... -configuration Release ... && ! strings <Release App.app>/App | grep -q "$(node -e 'console.log(require("./packages/shared/dist/index.js").APP_UPDATE_PUBLIC_KEYS.dev.spkiBase64)')"
```

### 4.5 Gate procedure (orchestrator)

1. 4.1 and 4.2 green; 4.3 on a fresh `docker compose -f docker-compose.dev.yml up -d --wait` (no env file).
2. 4.4 on the dev Mac (disk guard: one simulator build at a time; delete `ios/DerivedData` after).
3. Screenshots of Settings → About (bundled / update ready / updated / needs App Store version),
   light and dark, phone and desktop, per `docs/DESIGN.md`.
4. Production is **not** touched. The user gets: the `.env` line, Part L, and the note that the
   feature is live for phones only once a store build containing `TinyglowUpdater` is installed.
5. PROGRESS entry + commit.

## 5. Risks and decisions

### 5.1 Open questions for the user (defaults apply if unanswered)

| # | Question | Default |
| --- | --- | --- |
| U1 | In-house updater (D1) rather than the Capgo plugin? | **In-house.** Capgo's plugin is fine software, but zero phone-home cannot be proven from CI, and our CI cannot sign anyway. |
| U2 | Apply only on next cold launch, with a manual "Restart to apply" (D3), or also auto-apply after N hours in the background? | **Next launch + manual restart.** iOS keeps apps alive for days; a later follow-up can add "apply when backgrounded > 30 min and idle". |
| U3 | Cellular threshold (D4) | **2 MiB** of missing bytes. Typical JS-only fixes change 1–3 hashed chunks (≈ 200–800 KB). |
| U4 | Where the private key lives | **Server `.env` (api only)**, generated by us, handed over once. Alternative: the user generates it with the script and keeps the only copy; then paste the public half into shared before the first store build. |
| U5 | Dev key committed in `.env.dev`, trusted by Debug builds only (D6) | **Yes** (same class as the dev JWT secret). Alternative: no dev key; the OTA device gates then need a local secret and manual setup. |
| U6 | Show "Web <version>" to users in About (D9/2.8) | **Yes**, it is the support handle ("which web are you on?"). |

### 5.2 Architecture decisions (architect defaults; orchestrator confirms)

- **A1 Capacitor's own persisted path, not a custom WebView loader.** Verified in 8.5.3: iOS reads
  `KeyValueStore["serverBasePath"]` in `instanceDescriptor()` (before plugins) and maps it under
  `Library/NoCloud/ionic_built_snapshots/`; Android reads the `serverBasePath` pref in
  `Bridge` init; both clear it when the binary version changes. Our bundles must live at those
  paths and be written only after full verification. If a future Capacitor removes this (it exists
  since 2.x for Appflow), the plugin falls back to calling `setServerBasePath` from `load()` with
  one extra load at splash time.
- **A2 Per-file manifest instead of a zip.** No unzip library on iOS (Foundation has none),
  incremental downloads, per-file integrity, and the files are exactly what browsers fetch. Cost:
  N requests per update (≈ 40–80 files on a full change; usually a handful). Cloudflare serves them
  cached; `Accept-Encoding: identity` keeps hashes exact.
- **A3 Server-side signing with an api-held key.** See D2. The signature is over the exact
  `manifestJson` string so no canonical-JSON logic is needed natively.
- **A4 Content id = sha256 of (path, sha256) pairs**, 16 hex. Not the git SHA (`.git` is excluded
  from the Docker build context) and not `package.json` version (a build-independent label);
  `webVersion` is the human label and comes from `app-update.json`.
- **A5 Download gated on idle; apply at cold start.** No in-session reload except the explicit
  Restart button, which also checks idle. Background `URLSession` uploads and the sync ledger
  survive a kill anyway (steps 9/10/12), so a cold-start switch cannot lose data.
- **A6 No channels / staged rollout in v1.** One channel (what the server serves). A percentage
  rollout can be added later server-side without a client change (the client just gets
  `up_to_date`).

### 5.3 Risks

- **Cloudflare HTML/JS rewriting** (Rocket Loader, Email Obfuscation, Auto Minify) changes bytes →
  every update fails `verify_failed` (safe, but no updates). Part L says to keep them off; the
  `images` job cannot see Cloudflare, so 4.3's gate on production (`curl` of a listed file and
  `sha256sum`) is a Part L step for the user after the first deploy.
- **Build-flag drift between the web image and the shell** (D10). `VITE_API_URL` is baked from
  `PUBLIC_URL` at image build (rebuild after changing it: already true for `SENTRY_WEB_DSN`);
  the Android push flag becomes a runtime probe. Any new `import.meta.env.VITE_*` that differs per
  target must be added to the hygiene check's list: 14.11 greps `import.meta.env.VITE_` and
  compares against an allow-list in the script.
- **Rollback window.** A bundle that renders but is broken later (e.g. a runtime error on the
  Upload tab) still calls `notifyAppReady` and is kept. Mitigation: the Settings → About "Reset
  app files" button, the server kill switch, and shipping a fixed web (the next check replaces it).
  Consider a stricter readiness (first successful `/api/me`) later.
- **iOS `isNewBinary` keyed on `CFBundleVersion` + `CFBundleShortVersionString`**: a TestFlight
  build with the same numbers would keep an OTA bundle meant for the previous build. The release
  checklist already bumps the build number per upload; 14.11's hygiene (f) keeps `minNativeBuild`
  honest.
- **Disk.** Two bundles (≈ 6–8 MB each raw) plus temp during download; `no_space` guard at 64 MiB
  margin. Excluded from backup on iOS; Android backups are off.
- **Key compromise** (server): rotate by shipping a store build with a new `keyId` first; the old
  key stays trusted until a later build drops it. Document in Part L.
- **Scope creep risk**: the runtime push flag (D10) touches `push.ts` and the plugin `info()`.
  Small, but it is a behaviour change on Android: test in 14.9 and the Android gate.

### 5.4 Deferred (record in `docs/PROGRESS.md`)

Background auto-apply (U2), percentage rollout and channels (A6), readiness tied to the first
API success, "what's new" notes in About, OTA for the share viewer's offline shell (none exists),
browser-side "new version available" toast.
