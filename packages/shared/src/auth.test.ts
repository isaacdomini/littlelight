import { describe, expect, it } from "vitest";
import {
  AUDIT_EVENTS,
  auditMetadataSchema,
  authenticatorDataHasUserVerification,
  PASSKEY_CAPTCHA_AFTER_FAILURES,
  PASSKEY_DEFAULT_NAME,
  PASSKEY_MAX_PER_USER,
  PASSKEY_NAME_MAX,
  PASSKEY_OPTIONS_PER_IP_PER_HOUR,
  PASSKEY_PROMPT_SNOOZE_DAYS,
  PASSKEY_VERIFY_FAILURES_PER_IP_PER_15_MIN,
  PASSKEY_VERIFY_PER_IP_PER_HOUR,
  SIGN_IN_METHODS,
  userAgentLabel,
  WEBAUTHN_AUTH_DATA_MIN_BYTES,
  WEBAUTHN_FLAG_UP,
  WEBAUTHN_FLAG_UV,
  WEBAUTHN_FLAGS_OFFSET,
} from "./auth";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Tinyglow/1.0.0";
const IPAD_APP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Tinyglow/1.2.3";
const IPAD_APP_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Tinyglow/1.0.0";
const ANDROID_APP =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 Tinyglow/1.0.0+12";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("userAgentLabel", () => {
  it("labels the native apps by platform, without versions", () => {
    expect(userAgentLabel(IPHONE_APP)).toBe("Tinyglow app on iPhone");
    expect(userAgentLabel(IPAD_APP_UA)).toBe("Tinyglow app on iPad");
    expect(userAgentLabel(ANDROID_APP)).toBe("Tinyglow app on Android");
  });

  it("an iPad WKWebView sends a Macintosh UA: the app on Mac is an iPad", () => {
    expect(userAgentLabel(IPAD_APP)).toBe("Tinyglow app on iPad");
  });

  it("the app token wins over the Chrome/Safari tokens in the same UA", () => {
    expect(userAgentLabel(ANDROID_APP)).not.toContain("Chrome");
  });

  it("does not turn a real Mac Safari into an iPad or an app", () => {
    expect(userAgentLabel(MAC_SAFARI)).toBe("Safari on Mac");
  });

  it("still labels ordinary browsers", () => {
    expect(userAgentLabel(IPHONE_SAFARI)).toBe("Safari on iPhone");
    expect(
      userAgentLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36"),
    ).toBe("Chrome on Windows");
  });

  it("requires the product token to be a whole token", () => {
    expect(userAgentLabel("Mozilla/5.0 (iPhone) XTinyglow/1.0")).not.toContain("Tinyglow app");
    expect(userAgentLabel("Mozilla/5.0 (iPhone) Tinyglow")).not.toContain("Tinyglow app");
  });

  it("falls back for empty or unknown input", () => {
    expect(userAgentLabel(null)).toBe("Unknown device");
    expect(userAgentLabel(undefined)).toBe("Unknown device");
    expect(userAgentLabel("")).toBe("Unknown device");
    expect(userAgentLabel("curl/8.0")).toBe("Unknown device");
  });

  it("ignores anything past 512 characters", () => {
    expect(userAgentLabel(`${"x".repeat(600)} Tinyglow/1.0.0 (iPhone)`)).toBe("Unknown device");
  });
});

// ---- step 13: passkeys (docs/plans/step-13.md 2.3; decision g) ---------------------------------

describe("passkey constants", () => {
  it("pin the documented limits", () => {
    expect(PASSKEY_OPTIONS_PER_IP_PER_HOUR).toBe(60);
    expect(PASSKEY_VERIFY_PER_IP_PER_HOUR).toBe(60);
    expect(PASSKEY_VERIFY_FAILURES_PER_IP_PER_15_MIN).toBe(10);
    expect(PASSKEY_CAPTCHA_AFTER_FAILURES).toBe(3);
    expect(PASSKEY_MAX_PER_USER).toBe(5);
    expect(PASSKEY_NAME_MAX).toBe(60);
    expect(PASSKEY_DEFAULT_NAME).toBe("Passkey");
    expect(PASSKEY_PROMPT_SNOOZE_DAYS).toBe(30);
    expect(WEBAUTHN_AUTH_DATA_MIN_BYTES).toBe(37);
    expect(WEBAUTHN_FLAGS_OFFSET).toBe(32);
    expect(WEBAUTHN_FLAG_UP).toBe(0x01);
    expect(WEBAUTHN_FLAG_UV).toBe(0x04);
  });

  it("the audit vocabulary names the three passkey events and the passkey sign-in method", () => {
    for (const e of ["auth.passkey_added", "auth.passkey_removed", "auth.passkey_renamed"]) {
      expect(AUDIT_EVENTS).toContain(e);
    }
    expect([...SIGN_IN_METHODS]).toContain("passkey");
    expect(
      auditMetadataSchema.safeParse({ method: "passkey", client: "web", user_agent_label: "x" })
        .success,
    ).toBe(true);
    expect(
      auditMetadataSchema.safeParse({ passkey_id: "3f2c1b0a-1234-4abc-8def-0123456789ab" }).success,
    ).toBe(true);
    // Never a name, a credential id or a challenge id.
    expect(auditMetadataSchema.safeParse({ passkey_id: "not-a-uuid" }).success).toBe(false);
    expect(auditMetadataSchema.safeParse({ name: "My iPhone" }).success).toBe(false);
    expect(auditMetadataSchema.safeParse({ credential_id: "AQID" }).success).toBe(false);
    expect(auditMetadataSchema.safeParse({ challenge_id: "x" }).success).toBe(false);
  });
});

describe("authenticatorDataHasUserVerification", () => {
  const bytes = (flags: number, length = 37) => {
    const out = new Uint8Array(length);
    if (length > 32) out[32] = flags;
    return out;
  };

  it("is true only when the UV bit (0x04) is set in byte 32", () => {
    expect(authenticatorDataHasUserVerification(bytes(0x05))).toBe(true); // UP + UV
    expect(authenticatorDataHasUserVerification(bytes(0x04))).toBe(true); // UV alone
    expect(authenticatorDataHasUserVerification(bytes(0x45))).toBe(true); // UP + UV + AT
    expect(authenticatorDataHasUserVerification(bytes(0x1d))).toBe(true); // + BE/BS
    expect(authenticatorDataHasUserVerification(bytes(0x01))).toBe(false); // UP only
    expect(authenticatorDataHasUserVerification(bytes(0x00))).toBe(false);
    expect(authenticatorDataHasUserVerification(bytes(0x41))).toBe(false); // UP + AT, no UV
  });

  it("refuses anything shorter than 37 bytes, even with the flag set", () => {
    expect(authenticatorDataHasUserVerification(bytes(0x05, 36))).toBe(false);
    expect(authenticatorDataHasUserVerification(bytes(0x05, 33))).toBe(false);
    expect(authenticatorDataHasUserVerification(new Uint8Array(0))).toBe(false);
    expect(authenticatorDataHasUserVerification(bytes(0x05, 38))).toBe(true);
    expect(authenticatorDataHasUserVerification(bytes(0x05, 200))).toBe(true);
  });

  it("reads only the flags byte: the rest of the blob is irrelevant", () => {
    const a = bytes(0x05, 64);
    a.fill(0xff, 0, 32);
    a.fill(0xff, 33);
    expect(authenticatorDataHasUserVerification(a)).toBe(true);
  });
});
