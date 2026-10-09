import { describe, expect, it } from "vitest";
import { hasPrice } from "../pricing";
import {
  cosineSimilarity,
  createFakeEmbedder,
  fakeEmbedding,
  fakeEmbeddingOpaque,
  fakeStem,
  fakeTokenCount,
  fakeTokens,
} from "./embed";

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe("fakeEmbedding", () => {
  it("is unit length with the requested dimension, for words and for stop-word-only text", () => {
    for (const text of ["baby splashing in the bath", "the of and", "", "!!!", "ünïcode 👶"]) {
      const v = fakeEmbedding(text, 1024);
      expect(v).toHaveLength(1024);
      expect(norm(v)).toBeCloseTo(1, 6);
    }
  });

  it("is deterministic", () => {
    expect(fakeEmbedding("walking in the park", 1024)).toEqual(
      fakeEmbedding("walking in the park", 1024),
    );
  });

  it("shared words rank higher: bath ~ bath, not park", () => {
    const q = fakeEmbedding("baby splashing in the bath", 1024);
    const bath = fakeEmbedding("bath time with the yellow duck", 1024);
    const park = fakeEmbedding("walking in the park", 1024);
    expect(cosineSimilarity(q, bath)).toBeGreaterThan(cosineSimilarity(q, park));
    expect(cosineSimilarity(q, bath)).toBeGreaterThan(0.1);
  });

  it("an identical text has similarity 1; stemming and case do not matter", () => {
    const a = fakeEmbedding("Walked on the grass", 1024);
    expect(cosineSimilarity(a, fakeEmbedding("walk ON THE grasses", 1024))).toBeGreaterThan(0.99);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
  });

  it("is blind to synonyms (documented: real semantics need the real model)", () => {
    const q = fakeEmbedding("splashing in the tub", 1024);
    const d = fakeEmbedding("bath time", 1024);
    expect(Math.abs(cosineSimilarity(q, d))).toBeLessThan(0.3);
  });

  it("search filler words (show, photos, please) are ignored", () => {
    expect(fakeTokens("Please show me photos of the bath")).toEqual(["bath"]);
  });

  it("fakeStem examples", () => {
    expect(fakeStem("splashing")).toBe("splash");
    expect(fakeStem("walked")).toBe("walk");
    expect(fakeStem("dresses")).toBe("dress");
    expect(fakeStem("steps")).toBe("step");
    expect(fakeStem("glass")).toBe("glass");
    expect(fakeStem("sing")).toBe("sing");
  });

  it("the opaque variant: identical text equals, anything else is unrelated, unit length", () => {
    const a = fakeEmbeddingOpaque("x", 1024);
    expect(norm(a)).toBeCloseTo(1, 6);
    expect(fakeEmbeddingOpaque("x", 1024)).toEqual(a);
    expect(Math.abs(cosineSimilarity(a, fakeEmbeddingOpaque("y", 1024)))).toBeLessThan(0.2);
  });

  it("cosineSimilarity of a zero vector is 0", () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

describe("createFakeEmbedder", () => {
  it("returns vectors in input order and token/cost usage priced like text-embedding-3-small", async () => {
    const e = createFakeEmbedder({ dims: 1024 });
    expect(e.model).toBe("fake");
    expect(e.dims).toBe(1024);
    const texts = ["abcd", "abcdefgh", ""];
    const { vectors, usage } = await e.embed(texts);
    expect(vectors).toEqual(texts.map((t) => fakeEmbedding(t, 1024)));
    expect(usage.inputTokens).toBe(fakeTokenCount(texts));
    expect(usage.inputTokens).toBe(1 + 2 + 0);
    expect(hasPrice("text-embedding-3-small")).toBe(true);
    expect(usage.costUsd).toBeGreaterThanOrEqual(0);
    const big = await e.embed(["x".repeat(4_000_000)]);
    expect(big.usage.costUsd).toBeGreaterThan(0);
  });

  it("honours a custom dimension and model tag", async () => {
    const e = createFakeEmbedder({ dims: 64, model: "fake-64" });
    expect(e.model).toBe("fake-64");
    expect((await e.embed(["a"])).vectors[0]).toHaveLength(64);
  });
});
