import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { noiseJpeg, sceneJpeg } from "../testing/images";
import { computePhash, isNearDuplicate, phashDistance, phashFromGrey } from "./phash";

describe("pHash", () => {
  it("is a 64-character 0/1 string", async () => {
    const h = await computePhash(await sceneJpeg(400, 300, 1));
    expect(h).toMatch(/^[01]{64}$/);
  });

  it("the same image hashes to distance 0 and is deterministic", async () => {
    const img = await sceneJpeg(400, 300, 11);
    const a = await computePhash(img);
    const b = await computePhash(Buffer.from(img));
    expect(phashDistance(a, b)).toBe(0);
    expect(isNearDuplicate(a, b)).toBe(true);
  });

  it("a q60 recompression and a downscale stay within the near-duplicate distance", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const original = await sceneJpeg(800, 600, seed, 95);
      const recompressed = await sharp(original).jpeg({ quality: 60 }).toBuffer();
      const smaller = await sharp(original).resize(400).jpeg({ quality: 80 }).toBuffer();
      const h = await computePhash(original);
      expect(
        phashDistance(h, await computePhash(recompressed)),
        `q60 seed ${seed}`,
      ).toBeLessThanOrEqual(10);
      expect(
        phashDistance(h, await computePhash(smaller)),
        `resize seed ${seed}`,
      ).toBeLessThanOrEqual(10);
    }
  });

  it("unrelated noise images are far apart (>= 20)", async () => {
    const a = await computePhash(await noiseJpeg(300, 300, 101));
    const b = await computePhash(await noiseJpeg(300, 300, 202));
    expect(phashDistance(a, b)).toBeGreaterThanOrEqual(20);
    expect(isNearDuplicate(a, b)).toBe(false);
  });

  it("two different scenes are not near-duplicates", async () => {
    const a = await computePhash(await sceneJpeg(400, 300, 21));
    const b = await computePhash(await sceneJpeg(400, 300, 22));
    expect(isNearDuplicate(a, b)).toBe(false);
  });

  it("a transparent PNG is flattened onto white rather than hashing as black", async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const white = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    expect(await computePhash(png)).toBe(await computePhash(white));
  });

  it("phashFromGrey validates its input size", () => {
    expect(() => phashFromGrey(new Uint8Array(10))).toThrow(RangeError);
    expect(phashFromGrey(new Uint8Array(1024).fill(5))).toMatch(/^[01]{64}$/);
  });

  it("phashDistance counts differing bits and rejects mismatched lengths", () => {
    expect(phashDistance("0".repeat(64), "1".repeat(64))).toBe(64);
    expect(phashDistance("0101", "0110")).toBe(2);
    expect(() => phashDistance("01", "011")).toThrow(RangeError);
  });
});
