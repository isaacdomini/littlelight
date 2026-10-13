import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { type AppUpdatePublicKey, appUpdateTrustedKeyForSpki } from "@tinyglow/shared";

// Live-update manifest signer (docs/plans/step-14.md 2.6, D2, D6). The api signs the exact UTF-8
// bytes of `manifestJson` with ECDSA P-256 / SHA-256, DER-encoded, standard base64; the phone
// verifies with a public key of `APP_UPDATE_PUBLIC_KEYS` compiled into the app.
//
// The private key comes from `APP_UPDATE_SIGNING_KEY_BASE64` (base64 PKCS#8 DER). A missing,
// malformed, non-P-256 or untrusted key turns the feature off (the route answers `disabled`);
// it never stops the api. Nothing here logs or returns key material, a manifest or a signature:
// errors are reduced to a fixed outcome code.

/** Why the signer is not available. */
export type SignerUnavailable = "no_key" | "key_invalid" | "key_untrusted";

export interface AppUpdateSigner {
  /** `APP_UPDATE_PUBLIC_KEYS` entry whose public half matches the private key (the envelope's `keyId`). */
  readonly keyId: string;
  /** base64 DER ECDSA P-256 / SHA-256 signature over the UTF-8 bytes of `manifestJson`. */
  sign(manifestJson: string): string;
}

export type SignerResult =
  | { ok: true; signer: AppUpdateSigner }
  | { ok: false; outcome: SignerUnavailable };

/** Raised for any unusable key. The message is fixed: never the key, never Node's message. */
export class AppUpdateKeyError extends Error {
  constructor() {
    super("app update signing key is not a base64 PKCS#8 DER EC P-256 private key");
    this.name = "AppUpdateKeyError";
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parse a base64 PKCS#8 DER private key and require EC on curve P-256 (`prime256v1`). Throws
 * `AppUpdateKeyError` otherwise (strict base64: Node's decoder would silently skip junk).
 */
export function loadSigningKey(base64: string): KeyObject {
  const text = base64.trim();
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64_RE.test(text)) {
    throw new AppUpdateKeyError();
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.from(text, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new AppUpdateKeyError();
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new AppUpdateKeyError();
  }
  return key;
}

/** The public half of a private (or public) key as base64 SubjectPublicKeyInfo DER. */
export function publicSpkiBase64(key: KeyObject): string {
  const pub = key.type === "public" ? key : createPublicKey(key);
  return pub.export({ type: "spki", format: "der" }).toString("base64");
}

/** Sign the UTF-8 bytes of `manifestJson` (ECDSA P-256 / SHA-256, DER), base64. */
export function signManifestJson(key: KeyObject, manifestJson: string): string {
  return sign("sha256", Buffer.from(manifestJson, "utf8"), { key, dsaEncoding: "der" }).toString(
    "base64",
  );
}

/** Verify a base64 DER signature over `manifestJson` with a base64 SPKI (what the phone does). */
export function verifyManifestJson(
  spkiBase64: string,
  manifestJson: string,
  signatureBase64: string,
): boolean {
  try {
    const pub = createPublicKey({
      key: Buffer.from(spkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(
      "sha256",
      Buffer.from(manifestJson, "utf8"),
      { key: pub, dsaEncoding: "der" },
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Boot check (2.6): load the configured key and require its public half to be a trusted
 * `APP_UPDATE_PUBLIC_KEYS` entry (`prod` in production; `prod` or `dev` otherwise), then prove
 * one sign/verify round trip with that public key. Never throws.
 */
export function createAppUpdateSigner(
  keyBase64: string | undefined,
  opts: { production: boolean },
): SignerResult {
  if (keyBase64 === undefined || keyBase64.trim() === "") return { ok: false, outcome: "no_key" };
  let key: KeyObject;
  let trusted: AppUpdatePublicKey | null;
  try {
    key = loadSigningKey(keyBase64);
    trusted = appUpdateTrustedKeyForSpki(publicSpkiBase64(key), opts);
  } catch {
    return { ok: false, outcome: "key_invalid" };
  }
  if (trusted === null) return { ok: false, outcome: "key_untrusted" };
  const probe = '{"probe":true}';
  if (!verifyManifestJson(trusted.spkiBase64, probe, signManifestJson(key, probe))) {
    return { ok: false, outcome: "key_invalid" };
  }
  const { keyId } = trusted;
  return {
    ok: true,
    signer: {
      keyId,
      sign: (manifestJson) => signManifestJson(key, manifestJson),
    },
  };
}
