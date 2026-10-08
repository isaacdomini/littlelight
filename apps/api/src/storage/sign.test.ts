import { derivativeKey, SIGNED_URL_TTL_SEC } from "@littlelight/shared";
import { describe, expect, it } from "vitest";
import { testConfig } from "../testing/support";
import { clampTtl, createUrlSigner } from "./sign";

const BABY = "11111111-1111-4111-8111-111111111111";
const PHOTO = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 5, 14, 12, 0, 0);

const config = testConfig({
  S3_PUBLIC_ENDPOINT: "https://files.example.test",
  S3_ENDPOINT: "http://storage:9000",
  S3_BUCKET: "bucket-x",
});
const signer = createUrlSigner(config, () => NOW);

describe("clampTtl", () => {
  it("never exceeds one hour, never below one second", () => {
    expect(clampTtl(undefined)).toBe(SIGNED_URL_TTL_SEC);
    expect(clampTtl(Number.POSITIVE_INFINITY)).toBe(SIGNED_URL_TTL_SEC);
    expect(clampTtl(Number.NaN)).toBe(SIGNED_URL_TTL_SEC);
    expect(clampTtl(999_999)).toBe(3600);
    expect(clampTtl(0)).toBe(1);
    expect(clampTtl(-5)).toBe(1);
    expect(clampTtl(60.9)).toBe(60);
  });
});

describe("signGet", () => {
  it("signs on S3_PUBLIC_ENDPOINT (never the internal endpoint), one key, TTL <= 3600", async () => {
    const key = derivativeKey(BABY, PHOTO, "thumb");
    const { url, expiresAt } = await signer.signGet(key, { ttlSec: 10 * 3600 });
    const u = new URL(url);
    expect(u.origin).toBe("https://files.example.test");
    expect(url).not.toContain("storage:9000");
    expect(u.pathname).toBe(`/bucket-x/${key}`);
    expect(Number(u.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(3600);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(expiresAt.getTime()).toBe(NOW + 3600_000);
    expect(u.searchParams.get("X-Amz-Date")).toBe("20260614T120000Z");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("honours a shorter TTL and response overrides", async () => {
    const { url, expiresAt } = await signer.signGet("a/b", {
      ttlSec: 60,
      contentType: "image/heic",
      contentDisposition: 'attachment; filename="x.heic"',
    });
    const u = new URL(url);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(expiresAt.getTime()).toBe(NOW + 60_000);
    expect(u.searchParams.get("response-content-type")).toBe("image/heic");
    expect(u.searchParams.get("response-content-disposition")).toContain("attachment");
  });

  it("two keys give two different URLs and each URL names exactly one key", async () => {
    const a = new URL((await signer.signGet("k/one")).url);
    const b = new URL((await signer.signGet("k/two")).url);
    expect(a.pathname).toBe("/bucket-x/k/one");
    expect(b.pathname).toBe("/bucket-x/k/two");
    expect(a.searchParams.get("X-Amz-Signature")).not.toBe(b.searchParams.get("X-Amz-Signature"));
  });
});

describe("signUploadPart", () => {
  it("is a plain PUT URL: one key, partNumber + uploadId, TTL 3600, no checksum parameters", async () => {
    const { url, expiresAt } = await signer.signUploadPart("babies/b/originals/p", "up-1", 3);
    const u = new URL(url);
    expect(u.origin).toBe("https://files.example.test");
    expect(u.pathname).toBe("/bucket-x/babies/b/originals/p");
    expect(u.searchParams.get("partNumber")).toBe("3");
    expect(u.searchParams.get("uploadId")).toBe("up-1");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(expiresAt.getTime()).toBe(NOW + 3600_000);
    for (const k of u.searchParams.keys()) expect(k.toLowerCase()).not.toMatch(/checksum/);
    expect(url.toLowerCase()).not.toContain("x-amz-checksum");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("rejects part numbers outside 1..10000", async () => {
    for (const n of [0, -1, 10_001, 1.5, Number.NaN]) {
      await expect(signer.signUploadPart("k", "u", n)).rejects.toThrow(RangeError);
    }
  });
});
