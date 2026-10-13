import { randomBytes } from "node:crypto";
import {
  type PublicKeyCredentialJsonInput,
  WEBAUTHN_AUTH_DATA_MIN_BYTES,
  WEBAUTHN_FLAG_UP,
  WEBAUTHN_FLAG_UV,
  WEBAUTHN_FLAGS_OFFSET,
} from "@tinyglow/shared";

// WebAuthn fixtures for the API tests (docs/plans/step-13.md 2.8): authenticator data with a
// chosen flags byte, a `none` attestation object around it (canonical CBOR, RFC 8949), and the
// `PublicKeyCredential.toJSON()` shapes the routes accept. Nothing here is a real credential:
// the signatures and keys are random bytes; only the flags byte matters to the API (decision g).
// Test-only; never imported by a production module.

export const b64url = (bytes: Uint8Array | Buffer): string =>
  Buffer.from(bytes).toString("base64url");

/**
 * Authenticator data: 32-byte RP id hash, the flags byte, a 4-byte sign count (37 bytes), then
 * `extra` bytes (attested credential data / extensions, opaque here). `length` overrides the total
 * (shorter than 37 for the "truncated" cases).
 */
export function authData(flags: number, length = WEBAUTHN_AUTH_DATA_MIN_BYTES): Uint8Array {
  const out = new Uint8Array(length);
  out.set(randomBytes(Math.min(32, length)).subarray(0, Math.min(32, length)), 0);
  if (length > WEBAUTHN_FLAGS_OFFSET) out[WEBAUTHN_FLAGS_OFFSET] = flags & 0xff;
  return out;
}

/** UP + UV: what a platform authenticator reports after Face ID / fingerprint / PIN. */
export const FLAGS_UV = WEBAUTHN_FLAG_UP | WEBAUTHN_FLAG_UV; // 0x05
/** UP only: present but not verified. */
export const FLAGS_UP_ONLY = WEBAUTHN_FLAG_UP; // 0x01

// ---- minimal canonical CBOR encoder (enough for an attestation object) -------------------------

export type CborValue =
  | number
  | string
  | Uint8Array
  | CborValue[]
  | { [key: string]: CborValue }
  | null
  | boolean
  | { tag: number; value: CborValue }
  | { raw: Uint8Array };

function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  return Uint8Array.of(
    (major << 5) | 26,
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Encode `v` as CBOR. Map keys are written in the order given (callers choose canonical or not). */
export function cbor(v: CborValue): Uint8Array {
  if (v === null) return Uint8Array.of(0xf6);
  if (v === true) return Uint8Array.of(0xf5);
  if (v === false) return Uint8Array.of(0xf4);
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("test cbor: integers only");
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (typeof v === "string") {
    const bytes = new TextEncoder().encode(v);
    return concat([head(3, bytes.length), bytes]);
  }
  if (v instanceof Uint8Array) return concat([head(2, v.length), v]);
  if (Array.isArray(v)) return concat([head(4, v.length), ...v.map(cbor)]);
  if ("raw" in v && v.raw instanceof Uint8Array) return v.raw;
  if ("tag" in v && typeof v.tag === "number") {
    return concat([head(6, v.tag), cbor((v as { value: CborValue }).value)]);
  }
  const entries = Object.entries(v as { [key: string]: CborValue });
  return concat([head(5, entries.length), ...entries.flatMap(([k, val]) => [cbor(k), cbor(val)])]);
}

/** A `none` attestation object (`fmt`, `attStmt`, `authData`) in canonical key order. */
export function attestationObject(auth: Uint8Array): Uint8Array {
  return cbor({ fmt: "none", attStmt: {}, authData: auth });
}

const CRED_ID = () => b64url(randomBytes(16));
const CLIENT_DATA = (type: "webauthn.get" | "webauthn.create") =>
  b64url(
    Buffer.from(
      JSON.stringify({
        type,
        challenge: b64url(randomBytes(32)),
        origin: "http://localhost:8080",
        crossOrigin: false,
      }),
    ),
  );

/** An assertion (`navigator.credentials.get().toJSON()`) whose authenticator data has `flags`. */
export function assertionCredential(
  over: { flags?: number; authDataLength?: number; omitAuthenticatorData?: boolean } = {},
): PublicKeyCredentialJsonInput {
  const id = CRED_ID();
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: CLIENT_DATA("webauthn.get"),
      ...(over.omitAuthenticatorData
        ? {}
        : {
            authenticatorData: b64url(
              authData(over.flags ?? FLAGS_UV, over.authDataLength ?? WEBAUTHN_AUTH_DATA_MIN_BYTES),
            ),
          }),
      signature: b64url(randomBytes(64)),
      userHandle: b64url(Buffer.from("11111111-1111-4111-8111-111111111111")),
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
  };
}

/** A registration (`navigator.credentials.create().toJSON()`) whose attestation carries `flags`. */
export function registrationCredential(
  over: { flags?: number; authDataLength?: number; attestationObject?: Uint8Array } = {},
): PublicKeyCredentialJsonInput {
  const id = CRED_ID();
  const auth = authData(over.flags ?? FLAGS_UV, over.authDataLength ?? 37 + 16 + 77);
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: CLIENT_DATA("webauthn.create"),
      attestationObject: b64url(over.attestationObject ?? attestationObject(auth)),
      transports: ["internal", "hybrid"],
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: { credProps: { rk: true } },
  };
}
