import { describe, expect, it } from "vitest";
import {
  appVersionSchema,
  pushDeviceRegisterRequestSchema,
  pushDeviceResponseSchema,
} from "./push";

const ok = {
  platform: "ios",
  provider: "apns",
  token: "a".repeat(64),
  appVersion: "1.0.0",
};

describe("pushDeviceRegisterRequestSchema", () => {
  it("accepts ios/apns and android/fcm", () => {
    expect(pushDeviceRegisterRequestSchema.parse(ok)).toEqual(ok);
    const android = { ...ok, platform: "android", provider: "fcm" };
    expect(pushDeviceRegisterRequestSchema.parse(android)).toEqual(android);
  });

  it.each([
    ["ios with fcm", { ...ok, provider: "fcm" }],
    ["android with apns", { ...ok, platform: "android" }],
    ["an unknown platform", { ...ok, platform: "web" }],
    ["an unknown provider", { ...ok, provider: "webpush" }],
    ["an unexpected key", { ...ok, userId: "x" }],
    ["a missing token", { platform: "ios", provider: "apns", appVersion: "1.0.0" }],
    ["a missing app version", { platform: "ios", provider: "apns", token: ok.token }],
  ])("rejects %s", (_n, body) => {
    expect(pushDeviceRegisterRequestSchema.safeParse(body).success).toBe(false);
  });

  it("reports the pairing problem on provider", () => {
    const r = pushDeviceRegisterRequestSchema.safeParse({ ...ok, provider: "fcm" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["provider"]);
  });

  it("token: 8..4096 chars, no whitespace", () => {
    const parse = (token: string) => pushDeviceRegisterRequestSchema.safeParse({ ...ok, token });
    expect(parse("a".repeat(7)).success).toBe(false);
    expect(parse("a".repeat(8)).success).toBe(true);
    expect(parse("a".repeat(4096)).success).toBe(true);
    expect(parse("a".repeat(4097)).success).toBe(false);
    expect(parse("abcd efgh").success).toBe(false);
    expect(parse("abcdefgh\n").success).toBe(false);
    expect(parse("abcd\tefgh").success).toBe(false);
  });

  it("does not echo the token in a validation issue", () => {
    const token = "secret token with spaces";
    const r = pushDeviceRegisterRequestSchema.safeParse({ ...ok, token });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).not.toContain(token);
  });
});

describe("appVersionSchema", () => {
  it.each(["1.0.0", "1.0.0+12", "2.3.4-beta.1", "1"])("accepts %s", (v) => {
    expect(appVersionSchema.safeParse(v).success).toBe(true);
  });
  it.each(["", "1 0", "1.0.0/evil", "a".repeat(33), "v1;drop"])("rejects %j", (v) => {
    expect(appVersionSchema.safeParse(v).success).toBe(false);
  });
});

describe("pushDeviceResponseSchema", () => {
  it("is id/platform/createdAt and strips a token", () => {
    const device = {
      id: "11111111-1111-4111-8111-111111111111",
      platform: "android",
      createdAt: "2026-10-09T10:00:00.000Z",
    };
    expect(pushDeviceResponseSchema.parse({ device: { ...device, token: "leak" } })).toEqual({
      device,
    });
  });
});
