import { describe, expect, it } from "vitest";
import { PASSKEY_DEFAULT_NAME, PASSKEY_NAME_MAX, WEBAUTHN_FIELD_MAX_CHARS } from "../auth";
import {
  authConfigResponseSchema,
  base64urlSchema,
  goTruePasskeyListSchema,
  goTruePasskeyOptionsSchema,
  goTruePasskeySchema,
  passkeyFromGoTrue,
  passkeyOptionsFromGoTrue,
  passkeyOptionsRequestSchema,
  passkeyOptionsResponseSchema,
  passkeyParamsSchema,
  passkeyRegisterRequestSchema,
  passkeyRenameRequestSchema,
  passkeySchema,
  passkeysListResponseSchema,
  passkeyVerifyRequestSchema,
  publicKeyCredentialJsonSchema,
  WEBAUTHN_TRANSPORTS,
} from "./auth";
import { apiErrorCodeSchema, PASSKEY_FAILED_MESSAGE, passkeyLimitDetailsSchema } from "./errors";

// Passkey contracts (docs/plans/step-13.md 2.3; 0.1 decisions a, b). The size caps are what keep
// the API from forwarding arbitrary blobs to GoTrue; the GoTrue adapters cover its real wire
// shapes (Unix-second `expires_at`, bare list array, absent `friendly_name` / `last_used_at`).

const UUID = "3f2c1b0a-1234-4abc-8def-0123456789ab";
const b64 = (n: number, ch = "A") => ch.repeat(n);

const assertion = (over: Record<string, unknown> = {}) => ({
  id: "AQIDBA",
  rawId: "AQIDBA",
  type: "public-key",
  response: {
    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
    authenticatorData: b64(50),
    signature: b64(96),
    userHandle: "dXNlcg",
  },
  ...over,
});

describe("base64urlSchema", () => {
  it("accepts unpadded base64url, tolerates = padding, rejects the standard alphabet and empties", () => {
    const s = base64urlSchema(16);
    expect(s.safeParse("abc-_09").success).toBe(true);
    expect(s.safeParse("abcd==").success).toBe(true);
    expect(s.safeParse("abc+/").success).toBe(false);
    expect(s.safeParse("").success).toBe(false);
    expect(s.safeParse("a b").success).toBe(false);
    expect(s.safeParse(b64(17)).success).toBe(false);
    expect(s.safeParse(b64(16)).success).toBe(true);
  });
});

describe("publicKeyCredentialJsonSchema", () => {
  it("accepts an assertion and a registration, defaulting clientExtensionResults", () => {
    const a = publicKeyCredentialJsonSchema.parse(assertion());
    expect(a.clientExtensionResults).toEqual({});
    const r = publicKeyCredentialJsonSchema.parse({
      id: "AQIDBA",
      rawId: "AQIDBA",
      type: "public-key",
      response: {
        clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
        attestationObject: b64(200),
        transports: ["internal", "hybrid"],
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: { credProps: { rk: true } },
    });
    expect(r.response.transports).toEqual(["internal", "hybrid"]);
  });

  it("caps clientDataJSON at 8192 characters (8193 rejected) and rejects non-base64url", () => {
    const ok = assertion({ response: { ...assertion().response, clientDataJSON: b64(8192) } });
    expect(publicKeyCredentialJsonSchema.safeParse(ok).success).toBe(true);
    const tooLong = assertion({
      response: { ...assertion().response, clientDataJSON: b64(8193) },
    });
    expect(publicKeyCredentialJsonSchema.safeParse(tooLong).success).toBe(false);
    const notB64 = assertion({
      response: { ...assertion().response, clientDataJSON: '{"type":"webauthn.get"}' },
    });
    expect(publicKeyCredentialJsonSchema.safeParse(notB64).success).toBe(false);
    expect(WEBAUTHN_FIELD_MAX_CHARS.clientDataJSON).toBe(8192);
  });

  it("caps every binary field at its documented size", () => {
    const F = WEBAUTHN_FIELD_MAX_CHARS;
    const cases: [string, number, (v: string) => Record<string, unknown>][] = [
      ["id", F.id, (v) => assertion({ id: v })],
      ["rawId", F.id, (v) => assertion({ rawId: v })],
      [
        "authenticatorData",
        F.authenticatorData,
        (v) => assertion({ response: { ...assertion().response, authenticatorData: v } }),
      ],
      [
        "signature",
        F.signature,
        (v) => assertion({ response: { ...assertion().response, signature: v } }),
      ],
      [
        "userHandle",
        F.userHandle,
        (v) => assertion({ response: { ...assertion().response, userHandle: v } }),
      ],
      [
        "attestationObject",
        F.attestationObject,
        (v) => assertion({ response: { ...assertion().response, attestationObject: v } }),
      ],
    ];
    for (const [name, max, build] of cases) {
      expect(publicKeyCredentialJsonSchema.safeParse(build(b64(max))).success, name).toBe(true);
      expect(publicKeyCredentialJsonSchema.safeParse(build(b64(max + 1))).success, name).toBe(
        false,
      );
    }
    expect(F.attestationObject).toBe(64 * 1024);
  });

  it("requires type public-key, rejects unknown transports and bad attachments; drops unknown keys", () => {
    expect(publicKeyCredentialJsonSchema.safeParse(assertion({ type: "password" })).success).toBe(
      false,
    );
    expect(
      publicKeyCredentialJsonSchema.safeParse(
        assertion({ response: { ...assertion().response, transports: ["telepathy"] } }),
      ).success,
    ).toBe(false);
    expect(
      publicKeyCredentialJsonSchema.safeParse(assertion({ authenticatorAttachment: "cloud" }))
        .success,
    ).toBe(false);
    expect(
      publicKeyCredentialJsonSchema.safeParse(assertion({ authenticatorAttachment: null })).success,
    ).toBe(true);
    const parsed = publicKeyCredentialJsonSchema.parse(assertion({ extra: "x" }));
    expect("extra" in parsed).toBe(false);
    expect([...WEBAUTHN_TRANSPORTS]).toEqual([
      "usb",
      "nfc",
      "ble",
      "internal",
      "hybrid",
      "smart-card",
    ]);
  });

  it("userHandle may be null (non-discoverable assertions)", () => {
    expect(
      publicKeyCredentialJsonSchema.safeParse(
        assertion({ response: { ...assertion().response, userHandle: null } }),
      ).success,
    ).toBe(true);
  });
});

describe("request bodies", () => {
  it("passkeyOptionsRequestSchema: a missing body is {}; a captcha token is bounded", () => {
    expect(passkeyOptionsRequestSchema.parse(undefined)).toEqual({});
    expect(passkeyOptionsRequestSchema.parse({})).toEqual({});
    expect(passkeyOptionsRequestSchema.parse({ captchaToken: "t" })).toEqual({ captchaToken: "t" });
    expect(passkeyOptionsRequestSchema.safeParse({ captchaToken: "x".repeat(2049) }).success).toBe(
      false,
    );
  });

  it("passkeyVerifyRequestSchema needs a uuid challengeId and a credential", () => {
    expect(
      passkeyVerifyRequestSchema.safeParse({ challengeId: UUID, credential: assertion() }).success,
    ).toBe(true);
    expect(
      passkeyVerifyRequestSchema.safeParse({ challengeId: "abc", credential: assertion() }).success,
    ).toBe(false);
    expect(passkeyVerifyRequestSchema.safeParse({ challengeId: UUID }).success).toBe(false);
  });

  it("passkeyRegisterRequestSchema trims the optional name and bounds it to PASSKEY_NAME_MAX", () => {
    const base = { challengeId: UUID, credential: assertion() };
    expect(passkeyRegisterRequestSchema.parse(base).name).toBeUndefined();
    expect(passkeyRegisterRequestSchema.parse({ ...base, name: "  My iPhone  " }).name).toBe(
      "My iPhone",
    );
    expect(passkeyRegisterRequestSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(
      passkeyRegisterRequestSchema.safeParse({ ...base, name: "x".repeat(PASSKEY_NAME_MAX) })
        .success,
    ).toBe(true);
    expect(
      passkeyRegisterRequestSchema.safeParse({ ...base, name: "x".repeat(PASSKEY_NAME_MAX + 1) })
        .success,
    ).toBe(false);
    expect(PASSKEY_NAME_MAX).toBe(60);
  });

  it("passkeyRenameRequestSchema requires a name; passkeyParamsSchema a uuid", () => {
    expect(passkeyRenameRequestSchema.safeParse({}).success).toBe(false);
    expect(passkeyRenameRequestSchema.parse({ name: " Laptop " })).toEqual({ name: "Laptop" });
    expect(passkeyParamsSchema.safeParse({ id: UUID }).success).toBe(true);
    expect(passkeyParamsSchema.safeParse({ id: "1" }).success).toBe(false);
  });
});

describe("GoTrue wire shapes -> API DTOs (0.1 decision a)", () => {
  it("passkeyOptionsFromGoTrue converts Unix seconds to ISO and passes the options through", () => {
    const g = goTruePasskeyOptionsSchema.parse({
      challenge_id: UUID,
      options: { challenge: "abc", rpId: "localhost", allowCredentials: [] },
      expires_at: 1_760_000_000,
    });
    const dto = passkeyOptionsFromGoTrue(g);
    expect(dto).toEqual({
      challengeId: UUID,
      options: { challenge: "abc", rpId: "localhost", allowCredentials: [] },
      expiresAt: "2025-10-09T08:53:20.000Z",
    });
    expect(passkeyOptionsResponseSchema.safeParse(dto).success).toBe(true);
    // An ISO string where GoTrue should have sent seconds is a parse failure, not a silent pass.
    expect(
      goTruePasskeyOptionsSchema.safeParse({
        challenge_id: UUID,
        options: {},
        expires_at: "2026-10-11T12:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      goTruePasskeyOptionsSchema.safeParse({ challenge_id: UUID, options: {}, expires_at: 0 })
        .success,
    ).toBe(false);
  });

  it("passkeyFromGoTrue defaults the name and last-used, and accepts GoTrue's microsecond timestamps", () => {
    const bare = goTruePasskeySchema.parse({ id: UUID, created_at: "2026-10-11T12:34:56.123456Z" });
    expect(passkeyFromGoTrue(bare)).toEqual({
      id: UUID,
      name: PASSKEY_DEFAULT_NAME,
      createdAt: "2026-10-11T12:34:56.123456Z",
      lastUsedAt: null,
    });
    expect(PASSKEY_DEFAULT_NAME).toBe("Passkey");
    const blank = goTruePasskeySchema.parse({
      id: UUID,
      friendly_name: "   ",
      created_at: "2026-10-11T12:34:56Z",
      last_used_at: null,
    });
    expect(passkeyFromGoTrue(blank).name).toBe(PASSKEY_DEFAULT_NAME);
    const named = goTruePasskeySchema.parse({
      id: UUID,
      friendly_name: " My iPhone ",
      created_at: "2026-10-11T12:34:56Z",
      last_used_at: "2026-10-12T08:00:00Z",
    });
    const dto = passkeyFromGoTrue(named);
    expect(dto).toEqual({
      id: UUID,
      name: "My iPhone",
      createdAt: "2026-10-11T12:34:56Z",
      lastUsedAt: "2026-10-12T08:00:00Z",
    });
    expect(passkeySchema.safeParse(dto).success).toBe(true);
  });

  it("the list is a bare array: an object body fails to parse", () => {
    const item = { id: UUID, created_at: "2026-10-11T12:34:56Z" };
    expect(goTruePasskeyListSchema.safeParse([item]).success).toBe(true);
    expect(goTruePasskeyListSchema.safeParse([]).success).toBe(true);
    expect(goTruePasskeyListSchema.safeParse({ passkeys: [item] }).success).toBe(false);
    expect(goTruePasskeyListSchema.safeParse({ data: [item] }).success).toBe(false);
    expect(goTruePasskeyListSchema.safeParse(null).success).toBe(false);
  });

  it("passkeysListResponseSchema: at most 10 items and a positive max", () => {
    const p = passkeyFromGoTrue({ id: UUID, created_at: "2026-10-11T12:34:56Z" });
    expect(passkeysListResponseSchema.safeParse({ passkeys: [p], max: 5 }).success).toBe(true);
    expect(
      passkeysListResponseSchema.safeParse({ passkeys: Array(11).fill(p), max: 5 }).success,
    ).toBe(false);
    expect(passkeysListResponseSchema.safeParse({ passkeys: [], max: 0 }).success).toBe(false);
  });

  it("passkeySchema never carries credential material", () => {
    const p = {
      id: UUID,
      name: "x",
      createdAt: "2026-10-11T12:34:56Z",
      lastUsedAt: null,
      credential_id: "AQID",
    };
    expect("credential_id" in passkeySchema.parse(p)).toBe(false);
  });
});

describe("authConfigResponseSchema", () => {
  it("requires the passkeys flag (the UI's feature switch)", () => {
    const base = {
      providers: { apple: false, google: false },
      turnstileSiteKey: null,
      termsVersion: "2026-01",
      privacyVersion: "2026-01",
    };
    expect(authConfigResponseSchema.safeParse({ ...base, passkeys: true }).success).toBe(true);
    expect(authConfigResponseSchema.safeParse(base).success).toBe(false);
  });
});

describe("error codes (decision b)", () => {
  it("names the five passkey codes and the one user-facing failure message", () => {
    for (const c of [
      "passkey_disabled",
      "passkey_failed",
      "passkey_limit",
      "passkey_exists",
      "passkey_unavailable_for_account",
    ]) {
      expect(apiErrorCodeSchema.safeParse(c).success, c).toBe(true);
    }
    // No dedicated "unknown passkey" code: rename/delete of an unknown id is `not_found`.
    expect(apiErrorCodeSchema.safeParse("passkey_not_found").success).toBe(false);
    expect(PASSKEY_FAILED_MESSAGE).toBe("That passkey didn't work. Use your email code instead.");
    expect(passkeyLimitDetailsSchema.parse({ max: 5 })).toEqual({ max: 5 });
    expect(passkeyLimitDetailsSchema.safeParse({ max: 0 }).success).toBe(false);
  });
});
