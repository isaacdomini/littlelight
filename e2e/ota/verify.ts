/**
 * Reference implementation of the phone's live-update check (docs/plans/step-14.md 2.7, 2.10), in
 * TypeScript for the OTA gate: signature (ECDSA P-256 / SHA-256, DER, over the exact UTF-8 bytes
 * of `manifestJson`, key chosen by `keyId`) -> parse (`signedAppUpdateManifestSchema`) -> rules
 * (minNativeBuild, base URL) -> download every file `baseUrl/<path>` -> sha256 + size.
 * The native plugins (`LLUpdateBundle.swift`, `UpdateBundle.java`) follow the same order.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  type AppUpdateEnvelope,
  type AppUpdatePublicKey,
  appUpdateContentId,
  appUpdateFileUrl,
  type SignedAppUpdateManifest,
  signedAppUpdateManifestSchema,
} from "../../packages/shared/src/index";

export type VerifyOutcome =
  | { ok: true; manifest: SignedAppUpdateManifest; bytes: number }
  | {
      ok: false;
      outcome: "rejected" | "native_too_old" | "verify_failed" | "network";
      why: string;
    };

export function verifySignature(spkiBase64: string, manifestJson: string, signature: string) {
  try {
    const key = createPublicKey({
      key: Buffer.from(spkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(
      "sha256",
      Buffer.from(manifestJson, "utf8"),
      { key, dsaEncoding: "der" },
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export interface VerifyOptions {
  trusted: readonly AppUpdatePublicKey[];
  platform: "ios" | "android";
  nativeBuild: number;
  /** Files already on the phone (path -> sha256): not downloaded. */
  have?: ReadonlyMap<string, string>;
  fetch?: typeof fetch;
}

export async function verifyEnvelope(
  env: AppUpdateEnvelope,
  opts: VerifyOptions,
): Promise<VerifyOutcome> {
  const key = opts.trusted.find((k) => k.keyId === env.keyId);
  if (!key || !verifySignature(key.spkiBase64, env.manifestJson, env.signature)) {
    return { ok: false, outcome: "rejected", why: "signature" };
  }
  let parsed: SignedAppUpdateManifest;
  try {
    parsed = signedAppUpdateManifestSchema.parse(JSON.parse(env.manifestJson));
  } catch {
    return { ok: false, outcome: "rejected", why: "schema" };
  }
  if (opts.nativeBuild < parsed.minNativeBuild[opts.platform]) {
    return { ok: false, outcome: "native_too_old", why: "minNativeBuild" };
  }
  if (appUpdateContentId(parsed.files) !== parsed.version) {
    return { ok: false, outcome: "verify_failed", why: "content id" };
  }
  const f = opts.fetch ?? fetch;
  let bytes = 0;
  for (const file of parsed.files) {
    if (opts.have?.get(file.path) === file.sha256) continue;
    let body: Buffer;
    try {
      const res = await f(appUpdateFileUrl(parsed.baseUrl, file.path), {
        headers: { "accept-encoding": "identity" },
        redirect: "error",
      });
      if (!res.ok) return { ok: false, outcome: "network", why: `HTTP ${res.status}` };
      body = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      return { ok: false, outcome: "network", why: e instanceof Error ? e.message : String(e) };
    }
    bytes += body.length;
    const sha = createHash("sha256").update(body).digest("hex");
    if (sha !== file.sha256 || body.length !== file.size) {
      return { ok: false, outcome: "verify_failed", why: `hash ${file.path}` };
    }
  }
  return { ok: true, manifest: parsed, bytes };
}
