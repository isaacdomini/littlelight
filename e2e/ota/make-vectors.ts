/**
 * Writes `e2e/ota/vectors.json` (docs/plans/step-14.md 2.10, task 14.10): a manifest envelope
 * signed with the committed DEV key from `.env.dev`, consumed by the native host harnesses
 * (`sh apps/mobile-web/ios/scripts/update-bundle-harness.sh`, Android `UpdateBundleTest`).
 *
 *   tsx e2e/ota/make-vectors.ts            # (re)write the file
 *   tsx e2e/ota/make-vectors.ts --check    # verify the committed file (signature, ids, hashes)
 *
 * Shape: { keyId, spkiBase64, manifestJson, signature, expectedVersion, files: { path: base64 },
 * tampered: { manifestJson, signature }, tamperedFile: { path, contentBase64 } }.
 * ECDSA signatures are randomised, so a rewrite changes `signature` (and nothing else).
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  APP_UPDATE_PUBLIC_KEYS,
  appUpdateContentId,
  signedAppUpdateManifestSchema,
} from "../../packages/shared/src/index";
import { verifySignature } from "./verify";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(import.meta.dirname, "vectors.json");

export function devSigningKey(): string {
  const m = /^APP_UPDATE_SIGNING_KEY_BASE64=(\S+)$/m.exec(
    readFileSync(path.join(ROOT, ".env.dev"), "utf8"),
  );
  if (!m?.[1]) throw new Error(".env.dev has no APP_UPDATE_SIGNING_KEY_BASE64");
  return m[1];
}

export function signWithDevKey(text: string): string {
  const key = createPrivateKey({
    key: Buffer.from(devSigningKey(), "base64"),
    format: "der",
    type: "pkcs8",
  });
  return sign("sha256", Buffer.from(text, "utf8"), { key, dsaEncoding: "der" }).toString("base64");
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The bundle: a few files incl. a nested path and non-ASCII bytes. */
const FILES: Record<string, Buffer> = {
  "index.html": Buffer.from(
    '<!doctype html><html><head><script type="module" src="/assets/app-ota.js"></script></head><body>OTA vector</body></html>\n',
  ),
  "assets/app-ota.js": Buffer.from("document.body.dataset.ota = 'vector';\n"),
  "assets/style-ota.css": Buffer.from("body{color:#123}/* é ✓ */\n"),
  "icons/dot.svg": Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n'),
};

function build() {
  const files = Object.entries(FILES)
    .map(([p, b]) => ({ path: p, sha256: sha(b), size: b.length }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const version = appUpdateContentId(files);
  const manifest = {
    schema: 1,
    version,
    webVersion: "1.0.0",
    minNativeBuild: { ios: 1, android: 1 },
    builtAt: "2026-10-13T00:00:00.000Z",
    files,
    baseUrl: "http://localhost:18090",
  };
  signedAppUpdateManifestSchema.parse(manifest);
  const manifestJson = JSON.stringify(manifest);
  // Tampered: one file hash edited, signature of the ORIGINAL text kept (must fail to verify).
  const tamperedManifest = {
    ...manifest,
    files: files.map((f) =>
      f.path === "assets/app-ota.js" ? { ...f, sha256: sha(Buffer.from("evil")) } : f,
    ),
  };
  const tamperedFileBody = Buffer.from("document.body.dataset.ota = 'evil';\n");
  return {
    comment:
      "Live-update vectors (docs/plans/step-14.md 2.10), signed with the committed DEV key from .env.dev. Written by `tsx e2e/ota/make-vectors.ts`; consumed by the iOS harness and Android UpdateBundleTest.",
    keyId: APP_UPDATE_PUBLIC_KEYS.dev.keyId,
    spkiBase64: APP_UPDATE_PUBLIC_KEYS.dev.spkiBase64,
    manifestJson,
    signature: signWithDevKey(manifestJson),
    expectedVersion: version,
    files: Object.fromEntries(Object.entries(FILES).map(([p, b]) => [p, b.toString("base64")])),
    tampered: { manifestJson: JSON.stringify(tamperedManifest), signature: "" },
    tamperedFile: { path: "assets/app-ota.js", contentBase64: tamperedFileBody.toString("base64") },
  };
}

export function checkVectors(v: ReturnType<typeof build>): string[] {
  const errs: string[] = [];
  const pub = createPublicKey(
    createPrivateKey({ key: Buffer.from(devSigningKey(), "base64"), format: "der", type: "pkcs8" }),
  );
  if (pub.export({ type: "spki", format: "der" }).toString("base64") !== v.spkiBase64)
    errs.push(".env.dev key does not match spkiBase64");
  if (v.spkiBase64 !== APP_UPDATE_PUBLIC_KEYS.dev.spkiBase64) errs.push("spki != shared dev key");
  if (!verifySignature(v.spkiBase64, v.manifestJson, v.signature)) errs.push("signature");
  if (verifySignature(v.spkiBase64, v.tampered.manifestJson, v.tampered.signature || v.signature))
    errs.push("tampered manifest verifies");
  const m = signedAppUpdateManifestSchema.parse(JSON.parse(v.manifestJson));
  if (m.version !== v.expectedVersion || appUpdateContentId(m.files) !== v.expectedVersion)
    errs.push("content id");
  for (const f of m.files) {
    const b = Buffer.from(v.files[f.path as keyof typeof v.files] ?? "", "base64");
    if (sha(b) !== f.sha256 || b.length !== f.size) errs.push(`file ${f.path}`);
  }
  const tf = m.files.find((f) => f.path === v.tamperedFile.path);
  if (!tf || sha(Buffer.from(v.tamperedFile.contentBase64, "base64")) === tf.sha256)
    errs.push("tamperedFile");
  return errs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  if (process.argv.includes("--check")) {
    const errs = checkVectors(JSON.parse(readFileSync(OUT, "utf8")));
    console.log(errs.length ? `FAIL vectors.json: ${errs.join(", ")}` : "PASS vectors.json");
    process.exit(errs.length ? 1 : 0);
  }
  const v = build();
  const tamperedSig = v.signature; // keep the original signature on the tampered text
  v.tampered.signature = tamperedSig;
  const errs = checkVectors(v);
  if (errs.length) throw new Error(errs.join(", "));
  writeFileSync(OUT, `${JSON.stringify(v, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT)} (version ${v.expectedVersion})`);
}
