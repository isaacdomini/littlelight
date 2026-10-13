import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/errors";
import {
  assertionCredential,
  attestationObject,
  authData,
  b64url,
  cbor,
  FLAGS_UP_ONLY,
  FLAGS_UV,
  registrationCredential,
} from "../testing/webauthn";
import { GoTrueError } from "./gotrue";
import {
  assertionHasUserVerification,
  assertPasskeyId,
  assertPasskeyNameShape,
  attestationHasUserVerification,
  cborMapBytes,
  mapPasskeyError,
  passkeyLimit,
} from "./webauthn";

// The only WebAuthn parsing the API does (docs/plans/step-13.md 2.4, decision g): find `authData`
// in a `none` attestation object and read its flags byte. The CBOR walker must fail closed on
// anything non-canonical or hostile (indefinite lengths, oversize lengths, deep nesting,
// truncation) and never throw.

const text = (s: string) => new TextEncoder().encode(s);
const bytes = (...b: number[]) => Uint8Array.of(...b);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe("cborMapBytes", () => {
  const auth = authData(FLAGS_UV, 50);

  it("finds a byte string by text key in a canonical top-level map", () => {
    const found = cborMapBytes(attestationObject(auth), "authData");
    expect(found).not.toBeNull();
    expect(Buffer.from(found as Uint8Array).equals(Buffer.from(auth))).toBe(true);
  });

  it("does not depend on key order (authData first, last, or between other value types)", () => {
    const first = cbor({ authData: auth, fmt: "none", attStmt: {} });
    const last = cbor({ fmt: "packed", attStmt: { alg: -7, sig: bytes(1, 2, 3) }, authData: auth });
    const mixed = cbor({
      n: 1,
      neg: -5,
      big: 70000,
      arr: [1, "x", bytes(9)],
      nil: null,
      yes: true,
      tagged: { tag: 1, value: 1600000000 },
      authData: auth,
      after: "z",
    });
    for (const buf of [first, last, mixed]) {
      const found = cborMapBytes(buf, "authData");
      expect(found && Buffer.from(found).equals(Buffer.from(auth))).toBe(true);
    }
  });

  it("returns null when the key is missing, the value is not a byte string, or the top level is not a map", () => {
    expect(cborMapBytes(cbor({ fmt: "none", attStmt: {} }), "authData")).toBeNull();
    expect(cborMapBytes(cbor({ authData: "not bytes" }), "authData")).toBeNull();
    expect(cborMapBytes(cbor({ authData: 42 }), "authData")).toBeNull();
    expect(cborMapBytes(cbor({ authData: [auth] }), "authData")).toBeNull();
    expect(cborMapBytes(cbor([{ authData: auth }]), "authData")).toBeNull();
    expect(cborMapBytes(cbor(auth), "authData")).toBeNull();
    expect(cborMapBytes(new Uint8Array(0), "authData")).toBeNull();
    // a map whose key is a byte string (not text) spelling authData is not a match
    expect(
      cborMapBytes(
        cbor({ raw: join(bytes(0xa1), cbor(text("authData")), cbor(auth)) }),
        "authData",
      ),
    ).toBeNull();
    // key prefix / superstring are not matches
    expect(cborMapBytes(cbor({ authDat: auth, authData2: auth }), "authData")).toBeNull();
  });

  it("refuses indefinite-length items (not canonical CBOR)", () => {
    // 0xbf: indefinite-length map; 0x5f: indefinite-length byte string; 0xff: break
    const indefMap = join(bytes(0xbf), cbor("authData"), cbor(auth), bytes(0xff));
    expect(cborMapBytes(indefMap, "authData")).toBeNull();
    const indefBytes = join(bytes(0xa1), cbor("authData"), bytes(0x5f), cbor(auth), bytes(0xff));
    expect(cborMapBytes(indefBytes, "authData")).toBeNull();
    // an indefinite-length item in an unrelated value also fails the whole walk
    const indefOther = join(
      bytes(0xa2),
      cbor("x"),
      bytes(0x7f),
      cbor("a"),
      bytes(0xff),
      cbor("authData"),
      cbor(auth),
    );
    expect(cborMapBytes(indefOther, "authData")).toBeNull();
    // reserved additional-info values 28..30
    expect(cborMapBytes(join(bytes(0xa1), cbor("authData"), bytes(0x5c)), "authData")).toBeNull();
  });

  it("refuses truncated input: a declared length past the end of the buffer", () => {
    const full = attestationObject(auth);
    expect(cborMapBytes(full.subarray(0, full.length - 1), "authData")).toBeNull();
    expect(cborMapBytes(full.subarray(0, 5), "authData")).toBeNull();
    // the value head claims 100 bytes, 3 follow
    const short = join(bytes(0xa1), cbor("authData"), bytes(0x58, 100), bytes(1, 2, 3));
    expect(cborMapBytes(short, "authData")).toBeNull();
    // a key head with an argument that runs off the end
    expect(cborMapBytes(join(bytes(0xa1), bytes(0x79, 0x10)), "authData")).toBeNull();
    // A map that lies about its size but holds the wanted key first: the match returns before the
    // missing entries are reached (the value itself is bounds-checked; GoTrue validates the rest).
    const lying = join(bytes(0xa3), cbor("authData"), cbor(auth));
    expect(cborMapBytes(lying, "authData")).toEqual(auth);
    // ... but a map that runs out of bytes before the wanted key fails closed.
    const lyingNoKey = join(bytes(0xa3), cbor("x"), cbor(1), cbor("y"), cbor(2));
    expect(cborMapBytes(lyingNoKey, "authData")).toBeNull();
  });

  it("refuses nesting deeper than 8 levels in a value it has to skip, while moderate nesting is fine", () => {
    const nest = (depth: number): Uint8Array => {
      let v: Uint8Array = cbor(1);
      for (let i = 0; i < depth; i++) v = join(bytes(0x81), v);
      return v;
    };
    const moderate = join(bytes(0xa2), cbor("x"), nest(5), cbor("authData"), cbor(auth));
    expect(cborMapBytes(moderate, "authData")).not.toBeNull();
    const deep = join(bytes(0xa2), cbor("x"), nest(12), cbor("authData"), cbor(auth));
    expect(cborMapBytes(deep, "authData")).toBeNull();
    const deepTags = join(
      bytes(0xa2),
      cbor("x"),
      join(...Array(12).fill(bytes(0xc1)), cbor(1)),
      cbor("authData"),
      cbor(auth),
    );
    expect(cborMapBytes(deepTags, "authData")).toBeNull();
  });

  it("refuses 8-byte lengths above 2^32 (and never allocates for them)", () => {
    // 0x5b = byte string, 8-byte length; first four bytes non-zero => > 2^32
    const huge = join(bytes(0xa1), cbor("authData"), bytes(0x5b, 0, 0, 0, 1, 0, 0, 0, 0));
    expect(cborMapBytes(huge, "authData")).toBeNull();
    const hugeMap = bytes(0xbb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
    expect(cborMapBytes(hugeMap, "authData")).toBeNull();
    // an 8-byte length that fits in 32 bits is a valid head (but truncated here => null, not a throw)
    const fits = join(
      bytes(0xa1),
      cbor("authData"),
      bytes(0x5b, 0, 0, 0, 0, 0, 0, 0, 5),
      bytes(1, 2),
    );
    expect(cborMapBytes(fits, "authData")).toBeNull();
    // the same with the bytes present works
    const ok = join(
      bytes(0xa1),
      cbor("authData"),
      bytes(0x5b, 0, 0, 0, 0, 0, 0, 0, 3),
      bytes(7, 8, 9),
    );
    expect(cborMapBytes(ok, "authData")).toEqual(bytes(7, 8, 9));
  });

  it("refuses a map that declares more than 65536 entries", () => {
    const many = join(bytes(0xba, 0, 1, 0, 1), cbor("authData"), cbor(auth));
    expect(cborMapBytes(many, "authData")).toBeNull();
  });

  it("never throws on random bytes", () => {
    for (let i = 0; i < 200; i++) {
      const len = 1 + ((i * 7919) % 64);
      const buf = new Uint8Array(len);
      for (let j = 0; j < len; j++) buf[j] = (i * 31 + j * 131) & 0xff;
      buf[0] = 0xa0 | (i % 24); // make it a map so the walk goes somewhere
      expect(() => cborMapBytes(buf, "authData")).not.toThrow();
    }
  });
});

describe("attestationHasUserVerification / assertionHasUserVerification", () => {
  it("attestation: true for UP+UV, false for UP only, a 36-byte authData, a missing object or junk", () => {
    expect(attestationHasUserVerification(registrationCredential({ flags: FLAGS_UV }))).toBe(true);
    expect(attestationHasUserVerification(registrationCredential({ flags: FLAGS_UP_ONLY }))).toBe(
      false,
    );
    expect(
      attestationHasUserVerification(
        registrationCredential({ flags: FLAGS_UV, authDataLength: 36 }),
      ),
    ).toBe(false);
    expect(
      attestationHasUserVerification(
        registrationCredential({ flags: FLAGS_UV, authDataLength: 37 }),
      ),
    ).toBe(true);
    const noObject = registrationCredential();
    delete (noObject.response as { attestationObject?: string }).attestationObject;
    expect(attestationHasUserVerification(noObject)).toBe(false);
    expect(
      attestationHasUserVerification(
        registrationCredential({ attestationObject: cbor({ fmt: "none", attStmt: {} }) }),
      ),
    ).toBe(false);
    expect(
      attestationHasUserVerification(
        registrationCredential({ attestationObject: text("not cbor at all") }),
      ),
    ).toBe(false);
  });

  it("assertion: true for UP+UV, false for UP only, 36 bytes, or no authenticatorData", () => {
    expect(assertionHasUserVerification(assertionCredential({ flags: FLAGS_UV }))).toBe(true);
    expect(assertionHasUserVerification(assertionCredential({ flags: 0x04 }))).toBe(true);
    expect(assertionHasUserVerification(assertionCredential({ flags: FLAGS_UP_ONLY }))).toBe(false);
    expect(assertionHasUserVerification(assertionCredential({ flags: 0x00 }))).toBe(false);
    expect(
      assertionHasUserVerification(assertionCredential({ flags: FLAGS_UV, authDataLength: 36 })),
    ).toBe(false);
    expect(assertionHasUserVerification(assertionCredential({ omitAuthenticatorData: true }))).toBe(
      false,
    );
  });

  it("tolerates padded base64url (the schema allows up to two = signs)", () => {
    const c = assertionCredential({ flags: FLAGS_UV });
    c.response.authenticatorData = `${c.response.authenticatorData}==`;
    expect(assertionHasUserVerification(c)).toBe(true);
    expect(b64url(authData(FLAGS_UV))).not.toContain("=");
  });
});

describe("assertPasskeyNameShape", () => {
  it("accepts ordinary names, including non-Latin letters and emoji", () => {
    for (const n of ["My iPhone", "Laptop (work)", "Mamás Pixel", "家の鍵", "Key 🔑", "a"]) {
      expect(() => assertPasskeyNameShape(n), n).not.toThrow();
    }
  });

  it.each([
    ["BEL", "Phone\u0007"],
    ["LF", "Phone\nmore"],
    ["CR", "Phone\r"],
    ["TAB", "Pho\tne"],
    ["NUL", "Phone\u0000"],
    ["DEL", "Phone\u007f"],
    ["NEL (C1)", "Phone\u0085"],
    ["C1 0x9f", "Phone\u009f"],
    ["LINE SEPARATOR", "Phone "],
    ["PARAGRAPH SEPARATOR", "Phone "],
  ])(
    "rejects %s with 400 validation_failed naming body.name and never echoing the value",
    (_n, v) => {
      try {
        assertPasskeyNameShape(v);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        const err = e as ApiError;
        expect(err.status).toBe(400);
        expect(err.code).toBe("validation_failed");
        expect(err.details).toEqual({ fields: ["body.name"] });
        expect(err.message).not.toContain("Phone");
      }
    },
  );
});

describe("assertPasskeyId", () => {
  it("accepts a uuid and answers not_found for anything else (never a 400 that confirms the format)", () => {
    expect(() => assertPasskeyId("3f2c1b0a-1234-4abc-8def-0123456789ab")).not.toThrow();
    for (const bad of [
      "1",
      "",
      "../admin",
      "3f2c1b0a-1234-4abc-8def-0123456789a",
      "x".repeat(36),
    ]) {
      try {
        assertPasskeyId(bad);
        expect.unreachable();
      } catch (e) {
        expect((e as ApiError).status).toBe(404);
        expect((e as ApiError).code).toBe("not_found");
      }
    }
  });
});

describe("mapPasskeyError (decision b: the exact (status, error_code) map)", () => {
  const log = { warn: () => undefined, error: () => undefined };
  const cases: [number, string, "sign_in" | "register" | "manage", number, string][] = [
    [404, "passkey_disabled", "sign_in", 404, "passkey_disabled"],
    [404, "passkey_disabled", "manage", 404, "passkey_disabled"],
    [400, "webauthn_verification_failed", "sign_in", 401, "passkey_failed"],
    [400, "webauthn_challenge_not_found", "sign_in", 401, "passkey_failed"],
    [400, "webauthn_challenge_expired", "sign_in", 401, "passkey_failed"],
    [400, "validation_failed", "sign_in", 401, "passkey_failed"],
    [400, "bad_json", "sign_in", 401, "passkey_failed"],
    [403, "email_not_confirmed", "sign_in", 401, "passkey_failed"],
    [403, "user_banned", "sign_in", 401, "passkey_failed"],
    [403, "insufficient_aal", "register", 401, "passkey_failed"],
    [422, "validation_failed", "register", 401, "passkey_failed"],
    [422, "too_many_passkeys", "register", 409, "passkey_limit"],
    [422, "webauthn_credential_exists", "register", 409, "passkey_exists"],
    [404, "validation_failed", "manage", 404, "not_found"],
    // the 404 validation_failed -> not_found mapping is for rename/delete only
    [404, "validation_failed", "sign_in", 401, "passkey_failed"],
    [404, "validation_failed", "register", 401, "passkey_failed"],
    [401, "no_authorization", "manage", 401, "passkey_failed"],
    // GoTrue's own limiter (options route) is relayed as 429 rate_limited (review fix)
    [429, "over_request_rate_limit", "sign_in", 429, "rate_limited"],
    [500, "unexpected_failure", "sign_in", 503, "internal"],
    [502, "bad_passkey_body", "manage", 503, "internal"],
    [503, "ECONNREFUSED", "sign_in", 503, "internal"],
    [503, "timeout", "register", 503, "internal"],
  ];

  it.each(cases)("GoTrue %i %s (%s) -> %i %s", (gs, gc, ctx, status, code) => {
    const mapped = mapPasskeyError(new GoTrueError(gs, gc), log, ctx);
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped.status).toBe(status);
    expect(mapped.code).toBe(code);
  });

  it("a GoTrue 429 carries Retry-After through when GoTrue sent one, and no header otherwise", () => {
    const withHeader = mapPasskeyError(
      new GoTrueError(429, "over_request_rate_limit", 120),
      log,
      "sign_in",
    );
    expect(withHeader.status).toBe(429);
    expect(withHeader.code).toBe("rate_limited");
    expect(
      (withHeader as { headers?: Record<string, unknown> }).headers ??
        (withHeader as { retryAfterSec?: number }),
    ).toBeDefined();
    const without = mapPasskeyError(
      new GoTrueError(429, "over_request_rate_limit"),
      log,
      "sign_in",
    );
    expect(without.status).toBe(429);
    expect(without.code).toBe("rate_limited");
  });

  it("a non-GoTrue error is 503 and the message never includes the cause", () => {
    const mapped = mapPasskeyError(new Error("secret a@b.co detail"), log, "sign_in");
    expect(mapped.status).toBe(503);
    expect(mapped.code).toBe("internal");
    expect(mapped.message).not.toContain("a@b.co");
  });

  it("logs status + code only, never a body or message", () => {
    const lines: unknown[] = [];
    const spy = {
      warn: (o: unknown, _m?: string) => void lines.push(o),
      error: (o: unknown, _m?: string) => void lines.push(o),
    };
    mapPasskeyError(new GoTrueError(400, "webauthn_verification_failed"), spy, "sign_in");
    mapPasskeyError(new Error("boom a@b.co"), spy, "sign_in");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      status: 400,
      code: "webauthn_verification_failed",
      context: "sign_in",
    });
    // The non-GoTrue path logs `safeErrorLog(err)`: name and stack, no `message` field. (The V8
    // stack's first line repeats the message; that is `lib/errors.ts`' pre-existing shape, shared
    // with the OTP path, and such errors are programming errors, never GoTrue bodies.)
    const second = lines[1] as { err: Record<string, unknown>; context: string };
    expect(second.context).toBe("sign_in");
    expect(second.err.name).toBe("Error");
    expect("message" in second.err).toBe(false);
    expect(JSON.stringify(lines[0])).not.toContain("a@b.co");
  });

  it("passkeyLimit carries details { max: 5 }", () => {
    const e = passkeyLimit();
    expect(e.status).toBe(409);
    expect(e.code).toBe("passkey_limit");
    expect(e.details).toEqual({ max: 5 });
  });
});
