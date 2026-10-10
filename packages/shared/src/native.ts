import { UPLOAD_MAX_FILES_PER_SESSION } from "./upload";

/** Display name on the home screen, and the title of every push notification (defined in constants). */
export { APP_NAME } from "./constants";
/** `BGAppRefreshTask` id of Apple album sync (docs/plans/step-10.md 2.4); defined in `imports.ts`. */
export { SYNC_BG_TASK_ID } from "./imports";

// Native app identity and deep-link contracts (docs/plans/step-9.md 2.2, 2.3, 2.4, 2.10; PRD
// "Mobile and Capacitor", "Invites": "The link opens the app if installed (Universal Links / App
// Links)"). Browser-safe: no Node imports. Shared by the SPA's native platform layer, the API's
// CORS allow-list and the worker's APNs topic default.

/** iOS bundle id and Android applicationId (D1; permanent once published). */
export const APP_ID = "com.tesarsoft.tinyglow";
/**
 * Product token Capacitor appends to the WebView User-Agent (`appendUserAgent:
 * "Tinyglow/<version>"`); `userAgentLabel()` maps it to "Tinyglow app on …".
 */
export const APP_UA_TOKEN = "Tinyglow";
/** Universal Links / App Links host (overridable in the SPA via `VITE_APP_LINK_HOSTS`). */
export const APP_LINK_HOST_DEFAULT = "tinyglow.app";
/**
 * Debug-only custom URL scheme (`tinyglow://s/<token>`) registered by both apps so the
 * Simulator/emulator can test routing without association. The SPA honours it only in builds
 * with `VITE_DEEPLINK_DEV_SCHEME=1` (D12).
 */
export const DEV_URL_SCHEME = "tinyglow";

/**
 * In-app path of the native-initiated auth callback (D8). Deliberately not
 * `SPA_AUTH_CALLBACK_PATH` (`/signin/callback`): web OAuth and magic links stay web pages.
 */
export const NATIVE_AUTH_CALLBACK_PATH = "/signin/native";

/**
 * The only URL paths the app accepts from `appUrlOpen` (2.4). Anchored, no flags (stateless
 * `test()`), matched against the URL's pathname only; anything else is ignored. Query and
 * fragment are kept only for `nativeSignIn`.
 * - `invite`: invite tokens (43-char base64url today; 20..128 accepted).
 * - `share`: share tokens (22-char base64url; the dev seed token is 29; max 64).
 * - `nativeSignIn`: `NATIVE_AUTH_CALLBACK_PATH` exactly.
 */
export const DEEP_LINK_PATTERNS = {
  invite: /^\/invite\/[A-Za-z0-9_-]{20,128}$/,
  share: /^\/s\/[A-Za-z0-9_-]{22,64}$/,
  nativeSignIn: /^\/signin\/native$/,
} as const satisfies Readonly<Record<string, RegExp>>;
export type DeepLinkKind = keyof typeof DEEP_LINK_PATTERNS;

/**
 * WebView origins of the bundled apps: iOS WKWebView (`capacitor://localhost`) and Android
 * WebView with `server.androidScheme: "https"` (`https://localhost`). Default of the API's
 * `NATIVE_APP_ORIGINS` CORS allow-list.
 */
export const NATIVE_ORIGINS_DEFAULT = ["capacitor://localhost", "https://localhost"] as const;

/** Most photos one native pick may return (= `UPLOAD_MAX_FILES_PER_SESSION`, FR-2.1). */
export const NATIVE_UPLOAD_PICK_MAX: number = UPLOAD_MAX_FILES_PER_SESSION;

/**
 * Secure-store entry (Keychain / Android Keystore) holding this install's id: a random UUID
 * created on demand, sent as `import_sources.device_id` (docs/plans/step-10.md 2.5). The
 * fresh-install Keychain wipe makes a reinstall a new device, by design (R8).
 */
export const INSTALL_ID_KEY = "ll.install.v1";

/**
 * Secure-store entry holding the device's album-sync config `{ sourceId, babyId, albumId,
 * albumTitle, wifiOnly, paused }`. The album's PHAsset collection id stays on the device (D3).
 */
export const SYNC_CONFIG_KEY = "ll.sync.v1";
