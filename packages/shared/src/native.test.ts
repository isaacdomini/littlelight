import { describe, expect, it } from "vitest";
import {
  APP_ID,
  APP_LINK_HOST_DEFAULT,
  APP_UA_TOKEN,
  DEEP_LINK_PATTERNS,
  DEV_URL_SCHEME,
  NATIVE_AUTH_CALLBACK_PATH,
  NATIVE_ORIGINS_DEFAULT,
  NATIVE_UPLOAD_PICK_MAX,
} from "./native";
import { UPLOAD_MAX_FILES_PER_SESSION } from "./upload";

const t = (n: number) => "A".repeat(n);

describe("native identity constants", () => {
  it("has the published identifiers", () => {
    expect(APP_ID).toBe("com.tesarsoft.littlelight");
    expect(APP_UA_TOKEN).toBe("Littlelight");
    expect(APP_LINK_HOST_DEFAULT).toBe("littlelight.tesarsoft.com");
    expect(DEV_URL_SCHEME).toBe("littlelight");
    expect(NATIVE_AUTH_CALLBACK_PATH).toBe("/signin/native");
    expect([...NATIVE_ORIGINS_DEFAULT]).toEqual(["capacitor://localhost", "https://localhost"]);
    expect(NATIVE_UPLOAD_PICK_MAX).toBe(UPLOAD_MAX_FILES_PER_SESSION);
  });
});

describe("DEEP_LINK_PATTERNS", () => {
  it("invite: 20..128 url-safe chars", () => {
    expect(DEEP_LINK_PATTERNS.invite.test(`/invite/${t(43)}`)).toBe(true);
    expect(DEEP_LINK_PATTERNS.invite.test(`/invite/${t(20)}`)).toBe(true);
    expect(DEEP_LINK_PATTERNS.invite.test(`/invite/${t(128)}`)).toBe(true);
    expect(DEEP_LINK_PATTERNS.invite.test(`/invite/${t(19)}`)).toBe(false);
    expect(DEEP_LINK_PATTERNS.invite.test(`/invite/${t(129)}`)).toBe(false);
    expect(DEEP_LINK_PATTERNS.invite.test(`/invite/${t(42)}-_`)).toBe(true);
  });

  it("share: 22..64 url-safe chars", () => {
    expect(DEEP_LINK_PATTERNS.share.test(`/s/${t(22)}`)).toBe(true);
    expect(DEEP_LINK_PATTERNS.share.test(`/s/${t(29)}`)).toBe(true);
    expect(DEEP_LINK_PATTERNS.share.test(`/s/${t(64)}`)).toBe(true);
    expect(DEEP_LINK_PATTERNS.share.test(`/s/${t(21)}`)).toBe(false);
    expect(DEEP_LINK_PATTERNS.share.test(`/s/${t(65)}`)).toBe(false);
  });

  it("nativeSignIn matches exactly /signin/native", () => {
    expect(DEEP_LINK_PATTERNS.nativeSignIn.test("/signin/native")).toBe(true);
    for (const p of [
      "/signin/callback",
      "/signin/native/",
      "/signin/native/x",
      "/x/signin/native",
      "/signin",
    ]) {
      expect(DEEP_LINK_PATTERNS.nativeSignIn.test(p), p).toBe(false);
    }
  });

  it.each([
    `/invite/${t(30)}/extra`,
    `/invite/${t(30)}/`,
    `/s/${t(30)}/..`,
    `/s/../${t(30)}`,
    `/s/${t(30)}%2e%2e`,
    `/s/${t(30)}.`,
    `/s/${t(30)}\n`,
    `/s/${t(30)}?x=1`,
    `/s/${t(30)}#frag`,
    `//s/${t(30)}`,
    `/S/${t(30)}`,
    `/invite/${t(15)} ${t(15)}`,
    `/s/${t(11)}/${t(11)}`,
  ])("rejects %j on every pattern", (path) => {
    for (const re of Object.values(DEEP_LINK_PATTERNS)) expect(re.test(path)).toBe(false);
  });

  it("is stateless: no global or sticky flags", () => {
    for (const re of Object.values(DEEP_LINK_PATTERNS)) {
      expect(re.flags).toBe("");
      const p = re === DEEP_LINK_PATTERNS.nativeSignIn ? "/signin/native" : null;
      if (p) {
        expect(re.test(p)).toBe(true);
        expect(re.test(p)).toBe(true);
      }
    }
  });
});
