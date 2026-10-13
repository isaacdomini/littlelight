import { z } from "zod";
import { isoDateTimeSchema } from "./api/common";

// Live updates: the signed OTA web bundle of the native apps (docs/plans/step-14.md 2.3, D2-D6).
// Browser-safe: no Node imports (the content id uses the pure SHA-256 below), so the SPA, the
// api, the e2e reference verifier and the tests share one definition.
//
// Flow: the web image's build writes `dist/app-update/manifest.json` (`appUpdateManifestSchema`,
// `apps/mobile-web/scripts/app-update-manifest.mjs`); the api adds `baseUrl`, serialises it once
// (`manifestJson`, parses with `signedAppUpdateManifestSchema`) and signs those exact UTF-8 bytes
// with ECDSA P-256 / SHA-256 (DER); the phone verifies with a key of `APP_UPDATE_PUBLIC_KEYS`
// compiled into the app (`LLUpdateKeys.swift`, `UpdateKeys.java`), then checks every file's
// sha256 and size. The native rules mirror the constants and schemas of this file.

/** `schema` of every manifest this build understands. */
export const APP_UPDATE_MANIFEST_SCHEMA = 1;
/** Manifest location relative to the web root (`https://tinyglow.app/app-update/manifest.json`). */
export const APP_UPDATE_MANIFEST_PATH = "app-update/manifest.json";
/**
 * Path prefixes never listed in a manifest (the manifest itself, Universal/App Links association
 * files, GoTrue's email templates). The generator keeps its own copy of these literals; a unit
 * test asserts they are equal.
 */
export const APP_UPDATE_EXCLUDE_PREFIXES = [
  "app-update/",
  ".well-known/",
  "email-templates/",
] as const;

const MIB = 1024 * 1024;

/** Missing bytes up to which a bundle downloads on a metered network; more waits for Wi-Fi (D4). */
export const APP_UPDATE_CELLULAR_MAX_BYTES = 2 * MIB;
/** Least time between two automatic checks (`launch` / `resume`; `manual` ignores it). */
export const APP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Watchdog: a new bundle that has not called `notifyAppReady()` by then is rolled back. */
export const APP_UPDATE_READY_TIMEOUT_MS = 10_000;
/** Most files one manifest may list. */
export const APP_UPDATE_MAX_FILES = 2_000;
/** Largest summed size of a bundle's files (and of any single file). */
export const APP_UPDATE_MAX_BUNDLE_BYTES = 64 * MIB;
/** Free space required on the device besides the bytes to download (`no_space` otherwise). */
export const APP_UPDATE_FREE_SPACE_MARGIN_BYTES = 64 * MIB;
/** OTA bundle directories kept on the device: current + previous (the builtin web is extra). */
export const APP_UPDATE_KEEP_BUNDLES = 2;

/** A bundle `version` (content id): 16 lowercase hex characters. */
export const APP_UPDATE_VERSION_RE = /^[0-9a-f]{16}$/;
/** A file's sha256: 64 lowercase hex characters. */
export const APP_UPDATE_SHA256_RE = /^[0-9a-f]{64}$/;
/** `webVersion`, the human label from `apps/mobile-web/app-update.json` (= `appVersionSchema`). */
export const APP_UPDATE_WEB_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
/**
 * A manifest file path: relative (no leading `/`), no `..` segment. NUL is refused separately
 * (`appUpdateFileSchema`). Native code applies the same three rules.
 */
export const APP_UPDATE_PATH_RE = /^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$)).+$/s;

/** One file of a bundle: path relative to the web root, sha256 (hex) and size of its bytes. */
export const appUpdateFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .regex(APP_UPDATE_PATH_RE, "must be relative, without '..' segments")
    .refine((p) => !p.includes("\u0000"), "must not contain NUL"),
  sha256: z.string().regex(APP_UPDATE_SHA256_RE),
  size: z.int().min(0).max(APP_UPDATE_MAX_BUNDLE_BYTES),
});
export type AppUpdateFile = z.infer<typeof appUpdateFileSchema>;

const appUpdateManifestBaseSchema = z.object({
  schema: z.literal(APP_UPDATE_MANIFEST_SCHEMA),
  version: z.string().regex(APP_UPDATE_VERSION_RE),
  webVersion: z.string().regex(APP_UPDATE_WEB_VERSION_RE),
  minNativeBuild: z.object({ ios: z.int().min(1), android: z.int().min(1) }),
  builtAt: isoDateTimeSchema,
  files: z.array(appUpdateFileSchema).min(1).max(APP_UPDATE_MAX_FILES),
});

/**
 * Cross-field rules of a manifest: `files` lists `index.html`, paths are unique, none starts
 * with an `APP_UPDATE_EXCLUDE_PREFIXES` entry, and the summed size is at most
 * `APP_UPDATE_MAX_BUNDLE_BYTES` (the generator and the phones enforce the same cap). `version`
 * is not recomputed here: the phone checks every file's hash, and a mismatching id only names a
 * different bundle.
 */
function checkManifestFiles(m: { files: readonly AppUpdateFile[] }, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  let total = 0;
  m.files.forEach((f, i) => {
    if (seen.has(f.path)) {
      ctx.addIssue({ code: "custom", path: ["files", i, "path"], message: "duplicate path" });
    }
    seen.add(f.path);
    if (APP_UPDATE_EXCLUDE_PREFIXES.some((prefix) => f.path.startsWith(prefix))) {
      ctx.addIssue({ code: "custom", path: ["files", i, "path"], message: "excluded path" });
    }
    total += f.size;
  });
  if (!seen.has("index.html")) {
    ctx.addIssue({ code: "custom", path: ["files"], message: "must list index.html" });
  }
  if (total > APP_UPDATE_MAX_BUNDLE_BYTES) {
    ctx.addIssue({ code: "custom", path: ["files"], message: "bundle too large" });
  }
}

/** `dist/app-update/manifest.json` as the web image serves it (what the api fetches). */
export const appUpdateManifestSchema = appUpdateManifestBaseSchema.superRefine(checkManifestFiles);
export type AppUpdateManifest = z.infer<typeof appUpdateManifestSchema>;

const LOCAL_HTTP_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

/**
 * True for a valid files base URL: `http(s)://host[:port][/path]`, no user-info, query,
 * fragment or trailing `/`; `https:` unless the host is `localhost`, `127.0.0.1` or `10.0.2.2`
 * (Android emulator → host). File URLs are `appUpdateFileUrl(baseUrl, path)`.
 */
export function isAppUpdateBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOCAL_HTTP_HOSTS.has(url.hostname))
  ) {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (/[?#]/.test(value) || value.endsWith("/")) return false;
  return true;
}

/** Message of a rejected base URL (schemas and `appUpdateEnvSchema`). */
export const APP_UPDATE_BASE_URL_MESSAGE =
  "must be http(s)://host[/path] without query, fragment, credentials or trailing '/'; https unless localhost";

/**
 * What `manifestJson` parses to: the manifest plus the absolute `baseUrl` the files download
 * from (the api's `APP_UPDATE_FILES_BASE_URL`, default `PUBLIC_URL`).
 */
export const signedAppUpdateManifestSchema = appUpdateManifestBaseSchema
  .extend({
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .refine(isAppUpdateBaseUrl, APP_UPDATE_BASE_URL_MESSAGE),
  })
  .superRefine(checkManifestFiles);
export type SignedAppUpdateManifest = z.infer<typeof signedAppUpdateManifestSchema>;

/**
 * URL of one bundle file: `${baseUrl}/${path}` with every path segment percent-encoded
 * (`encodeURIComponent`). Vite output names need no encoding; native code must produce the
 * same URL for any other name.
 */
export function appUpdateFileUrl(baseUrl: string, path: string): string {
  return `${baseUrl}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// ---------------------------------------------------------------------------------------------
// Signing keys (D6). ECDSA P-256; `spkiBase64` = base64 (standard, padded) of the SubjectPublicKeyInfo
// DER (91 bytes, 124 characters). `prod` is trusted by every build; `dev` (private half committed in
// `.env.dev`) only by Debug builds. Rotation: add a key with a new `keyId`, ship it in a store
// build, then switch the server. CI (`.github/scripts/app-update-hygiene.sh`) asserts these
// literals equal `LLUpdateKeys.swift` and `UpdateKeys.java`.
// ---------------------------------------------------------------------------------------------

/** Marker of a public key not pasted yet (task 14.3). A test fails while any key still holds it. */
export const APP_UPDATE_KEY_PLACEHOLDER = "<set by 14.3>";

/** Base64 of a P-256 SubjectPublicKeyInfo DER (fixed 36-character algorithm prefix). */
export const APP_UPDATE_P256_SPKI_BASE64_RE =
  /^MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE[A-Za-z0-9+/]{86}==$/;

export interface AppUpdatePublicKey {
  /** Sent as the envelope's `keyId` (≤ 32 characters); selects the key on the phone. */
  readonly keyId: string;
  /** SPKI DER, standard base64. */
  readonly spkiBase64: string;
}

export const APP_UPDATE_PUBLIC_KEYS: Readonly<Record<"prod" | "dev", AppUpdatePublicKey>> =
  Object.freeze({
    // ---- PLACEHOLDERS: the orchestrator pastes both SPKI strings from task 14.3 here. ----
    prod: Object.freeze({
      keyId: "prod-2026-10",
      spkiBase64:
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAaou0YPN124j6e+8Ig6+WC/K2HcOGom7OWaM4Gqpqd+KBMjoRimHim4zFf+cDW/YNegBgOgH3nbIRgSczj2AnQ==",
    }),
    dev: Object.freeze({
      keyId: "dev",
      spkiBase64:
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmF4/OE/rfPgzXHUS+6VBcqWMWvqO4h+6HFhn1hGFzFJq2D8+w6JduoO6BU5aSmqyW74hxsVh1uqA79xVFlGFyw==",
    }),
    // ---- end PLACEHOLDERS ----
  });

/**
 * The trusted key whose SPKI equals `spkiBase64` (the configured private key's public half), or
 * `null`. `production` trusts `prod` only; otherwise `prod` or `dev`. Placeholders never match.
 * The api uses it at boot (2.6): `null` ⇒ the feature is off (`reason: "disabled"`).
 */
export function appUpdateTrustedKeyForSpki(
  spkiBase64: string,
  opts: { production: boolean },
): AppUpdatePublicKey | null {
  const candidates = opts.production
    ? [APP_UPDATE_PUBLIC_KEYS.prod]
    : [APP_UPDATE_PUBLIC_KEYS.prod, APP_UPDATE_PUBLIC_KEYS.dev];
  for (const key of candidates) {
    if (key.spkiBase64 !== APP_UPDATE_KEY_PLACEHOLDER && key.spkiBase64 === spkiBase64) return key;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Content id
// ---------------------------------------------------------------------------------------------

/** Plain code-unit order (`<`, Java `String.compareTo`; Swift: compare `Array(path.utf16)`). */
const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * A bundle's `version`: the first 16 hex characters of the SHA-256 of the UTF-8 bytes of
 * `${path}\n${sha256}\n` for every file, files sorted by path in UTF-16 code-unit order (never
 * `localeCompare`). Sizes, `webVersion`, `minNativeBuild` and `builtAt` do not take part. Does not
 * mutate `files`. Mirrored by `scripts/app-update-manifest.mjs`, `LLUpdateBundle.swift` and
 * `UpdateBundle.java`.
 *
 * Vectors (`E` = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855, sha256 of ""):
 * - `[{ path: "index.html", sha256: E }]` → `da529e6871940b56`
 * - `[{ path: "index.html", sha256: sha256("<html></html>") = b633a587c652d02386c4f16f8c6f6aab7352d97f16367c3c40576214372dd628 },
 *    { path: "assets/app-1.js", sha256: sha256("console.log(1)") = 0a286891c11c056e1ab5bfc25bf5d6b2f5b06d38eac10944f678fd8a2e70c393 }]`
 *   → `2f80d966699add55` (either input order)
 * - `[{ path: "index.html", sha256: "0"×64 }, { path: "Z.txt", sha256: "1"×64 }, { path: "a.txt", sha256: "2"×64 }]`
 *   → `0d576c52526db35a` (code-unit order: `Z.txt` < `a.txt` < `index.html`)
 */
export function appUpdateContentId(
  files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>,
): string {
  const text = [...files]
    .sort(byPath)
    .map((f) => `${f.path}\n${f.sha256}\n`)
    .join("");
  return sha256Hex(new TextEncoder().encode(text)).slice(0, 16);
}

// Minimal synchronous SHA-256 (FIPS 180-4) so the content id stays browser-safe and synchronous.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

function sha256Hex(data: Uint8Array): string {
  const bitLen = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    const v = Array.from(h);
    let a = v[0] as number;
    let b = v[1] as number;
    let c = v[2] as number;
    let d = v[3] as number;
    let e = v[4] as number;
    let f = v[5] as number;
    let g = v[6] as number;
    let hh = v[7] as number;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((x, i) => {
      h[i] = ((h[i] as number) + x) >>> 0;
    });
  }
  let hex = "";
  for (const word of h) hex += word.toString(16).padStart(8, "0");
  return hex;
}
