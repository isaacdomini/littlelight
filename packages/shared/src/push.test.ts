import { describe, expect, it } from "vitest";
import { APP_NAME } from "./constants";
import {
  PUSH_MIN_GAP_MIN_DEFAULT,
  PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT,
  PUSH_PROVIDER_FOR_PLATFORM,
  PUSH_SHARE_DEBOUNCE_SEC_DEFAULT,
  PUSH_TOKEN_MAX_CHARS,
  PUSH_TOKEN_MIN_CHARS,
  pushDataSchema,
  pushDeliveryStatusSchema,
  pushKindSchema,
  pushMessage,
  pushPlatformSchema,
  pushProviderSchema,
} from "./push";

const BABY = "11111111-1111-4111-8111-111111111111";
const LINK = "22222222-2222-4222-8222-222222222222";

describe("push enums (must match the migration-16 CHECK constraints)", () => {
  it("lists the exact values in order", () => {
    expect(pushPlatformSchema.options).toEqual(["ios", "android"]);
    expect(pushProviderSchema.options).toEqual(["apns", "fcm"]);
    expect(pushKindSchema.options).toEqual(["photos_analyzed", "share_viewed"]);
    expect(pushDeliveryStatusSchema.options).toEqual([
      "sent",
      "fake",
      "failed",
      "invalid_token",
      "unconfigured",
    ]);
  });

  it("pairs ios with apns and android with fcm", () => {
    expect(PUSH_PROVIDER_FOR_PLATFORM).toEqual({ ios: "apns", android: "fcm" });
  });

  it("has the documented defaults and token bounds", () => {
    expect(PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT).toBe(600);
    expect(PUSH_SHARE_DEBOUNCE_SEC_DEFAULT).toBe(60);
    expect(PUSH_MIN_GAP_MIN_DEFAULT).toBe(60);
    expect(PUSH_TOKEN_MIN_CHARS).toBe(8);
    expect(PUSH_TOKEN_MAX_CHARS).toBe(4096);
  });
});

describe("pushMessage (generic text only; D10)", () => {
  it("photos_analyzed: singular and plural", () => {
    expect(pushMessage("photos_analyzed", 1)).toEqual({
      title: APP_NAME,
      body: "1 new photo is ready to search.",
    });
    expect(pushMessage("photos_analyzed", 23)).toEqual({
      title: APP_NAME,
      body: "23 new photos are ready to search.",
    });
  });

  it("defaults the count to 1 and groups thousands", () => {
    expect(pushMessage("photos_analyzed").body).toBe("1 new photo is ready to search.");
    expect(pushMessage("photos_analyzed", 1234).body).toBe("1,234 new photos are ready to search.");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects count %s", (n) => {
    expect(() => pushMessage("photos_analyzed", n)).toThrow(RangeError);
  });

  it("share_viewed ignores the count", () => {
    const expected = { title: APP_NAME, body: "Someone opened your shared album." };
    expect(pushMessage("share_viewed")).toEqual(expected);
    expect(pushMessage("share_viewed", 99)).toEqual(expected);
    expect(pushMessage("share_viewed", 0)).toEqual(expected);
  });

  it("takes only (kind, count): the function has no parameter for a name or caption", () => {
    expect(pushMessage.length).toBeLessThanOrEqual(2);
  });
});

describe("pushDataSchema (ids only, strict)", () => {
  it("accepts both kinds", () => {
    expect(pushDataSchema.parse({ kind: "photos_analyzed", babyId: BABY })).toEqual({
      kind: "photos_analyzed",
      babyId: BABY,
    });
    expect(pushDataSchema.parse({ kind: "share_viewed", babyId: BABY, shareLinkId: LINK })).toEqual(
      { kind: "share_viewed", babyId: BABY, shareLinkId: LINK },
    );
  });

  it.each([
    ["an extra key (name)", { kind: "photos_analyzed", babyId: BABY, name: "Mia" }],
    ["an extra key (token)", { kind: "share_viewed", babyId: BABY, shareLinkId: LINK, token: "x" }],
    ["share_viewed without a link id", { kind: "share_viewed", babyId: BABY }],
    [
      "photos_analyzed with a link id",
      { kind: "photos_analyzed", babyId: BABY, shareLinkId: LINK },
    ],
    ["a non-uuid baby id", { kind: "photos_analyzed", babyId: "mia" }],
    ["an unknown kind", { kind: "chat", babyId: BABY }],
    ["null", null],
  ])("rejects %s", (_n, data) => {
    expect(pushDataSchema.safeParse(data).success).toBe(false);
  });
});
