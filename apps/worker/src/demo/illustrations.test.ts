import { createHash } from "node:crypto";
import { DEMO_IDS } from "@littlelight/shared";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_SCENES,
  demoScene,
  ILLUSTRATION_HEIGHT,
  ILLUSTRATION_WIDTH,
  REVIEW_SCENES,
  type RenderedIllustration,
  renderScene,
  reviewScene,
} from "./illustrations";
import { isMetadataFree, jpegMetadataSegments } from "./media";

// Demo and review illustrations (docs/plans/step-9.md 2.11, 2.15; D5): drawn in code, non-real
// babies, deterministic, metadata-free JPEGs.

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("scene sets", () => {
  it("has one scene per seeded demo photo (12) and 24 review scenes", () => {
    expect(DEMO_SCENES).toHaveLength(12);
    expect(DEMO_SCENES).toHaveLength(DEMO_IDS.photos.length);
    expect(REVIEW_SCENES).toHaveLength(24);
  });

  it("slugs are unique and non-empty", () => {
    const slugs = [...DEMO_SCENES, ...REVIEW_SCENES].map((s) => s.slug);
    expect(slugs.every((s) => /^[a-z0-9-]+$/.test(s))).toBe(true);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("demoScene / reviewScene are 1-based and reject out-of-range numbers", () => {
    expect(demoScene(1)).toBe(DEMO_SCENES[0]);
    expect(demoScene(12)).toBe(DEMO_SCENES[11]);
    expect(reviewScene(24)).toBe(REVIEW_SCENES[23]);
    for (const n of [0, 13, -1]) expect(() => demoScene(n)).toThrow(RangeError);
    for (const n of [0, 25]) expect(() => reviewScene(n)).toThrow(RangeError);
  });

  it("drawing is a pure function: no randomness, no external references, no text", () => {
    for (const scene of [...DEMO_SCENES, ...REVIEW_SCENES]) {
      const svg = scene.draw();
      expect(svg, scene.slug).toBe(scene.draw());
      expect(svg.startsWith("<svg "), scene.slug).toBe(true);
      expect(svg, scene.slug).not.toMatch(
        /<image|<text|xlink:href|href=|<script|<foreignObject|url\(http/i,
      );
    }
  });
});

describe("rendering", () => {
  const rendered = new Map<string, RenderedIllustration>();

  beforeAll(async () => {
    for (const scene of [...DEMO_SCENES, ...REVIEW_SCENES]) {
      rendered.set(scene.slug, await renderScene(scene));
    }
  }, 120_000);

  it("every scene renders to a 1200x1600 baseline-readable JPEG of sensible size", async () => {
    for (const [slug, r] of rendered) {
      expect(r.width, slug).toBe(ILLUSTRATION_WIDTH);
      expect(r.height, slug).toBe(ILLUSTRATION_HEIGHT);
      expect(r.bytes, slug).toBe(r.buffer.byteLength);
      expect(r.bytes, slug).toBeGreaterThan(5_000);
      expect(r.bytes, slug).toBeLessThan(500_000);
      expect([r.buffer[0], r.buffer[1]], slug).toEqual([0xff, 0xd8]);
      const meta = await sharp(r.buffer).metadata();
      expect(meta.format, slug).toBe("jpeg");
      expect(meta.width, slug).toBe(1200);
      expect(meta.height, slug).toBe(1600);
      expect(meta.space, slug).toBe("srgb");
    }
  }, 60_000);

  it("carries no metadata at all: no EXIF, XMP, IPTC, ICC, GPS or comment segment", async () => {
    for (const [slug, r] of rendered) {
      expect(jpegMetadataSegments(r.buffer), slug).toEqual([]);
      expect(await isMetadataFree(r.buffer), slug).toBe(true);
      const meta = await sharp(r.buffer).metadata();
      expect(meta.exif, slug).toBeUndefined();
      expect(meta.xmp, slug).toBeUndefined();
      expect(meta.iptc, slug).toBeUndefined();
      expect(meta.icc, slug).toBeUndefined();
    }
  }, 60_000);

  it("is deterministic: rendering the same scene again gives identical bytes", async () => {
    for (const scene of [DEMO_SCENES[0], DEMO_SCENES[8], REVIEW_SCENES[6], REVIEW_SCENES[23]]) {
      if (!scene) throw new Error("missing scene");
      const again = await renderScene(scene);
      expect(sha(again.buffer), scene.slug).toBe(sha(rendered.get(scene.slug)?.buffer as Buffer));
    }
  }, 60_000);

  it("scenes are visibly different from one another (distinct bytes)", () => {
    const hashes = [...rendered.values()].map((r) => sha(r.buffer));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("a blurry scene is rendered blurred: less edge energy than its own unblurred drawing", async () => {
    const blurry = [...DEMO_SCENES, ...REVIEW_SCENES].find((s) => s.blur);
    expect(blurry).toBeDefined();
    if (!blurry) return;
    const energy = async (input: Buffer) => {
      const { data } = await sharp(input)
        .resize(300, 400, { fit: "fill" })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let sum = 0;
      for (let i = 1; i < data.length; i++) sum += Math.abs((data[i] ?? 0) - (data[i - 1] ?? 0));
      return sum / data.length;
    };
    const unblurred = await sharp(Buffer.from(blurry.draw(), "utf8"), { density: 72 })
      .resize(ILLUSTRATION_WIDTH, ILLUSTRATION_HEIGHT, { fit: "fill" })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
    expect(await energy(rendered.get(blurry.slug)?.buffer as Buffer)).toBeLessThan(
      await energy(unblurred),
    );
  }, 60_000);
});
