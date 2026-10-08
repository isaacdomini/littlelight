import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Privacy tripwire (docs/plans/step-4.md 2.7 step 7, 4.8): nothing under apps/worker/src may
// call a sharp API that keeps or writes image metadata, so every derivative is born clean. The
// method names are assembled from fragments so this file itself does not contain them (the CI
// grep over apps/worker/src would otherwise match its own pattern).
const WORDS = [
  ["with", "Metadata"],
  ["keep", "Exif"],
  ["keep", "Metadata"],
  ["keep", "Icc", "Profile"],
  ["with", "Icc", "Profile"],
  ["with", "Exif"],
].map((parts) => parts.join(""));
const PATTERN = new RegExp(WORDS.join("|"));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

const SRC = path.resolve(import.meta.dirname, "..");

describe("no metadata-keeping sharp calls in the worker", () => {
  const files = walk(SRC).filter((f) => f.endsWith(".ts"));

  it("the scan sees the ingest sources", () => {
    const names = files.map((f) => path.relative(SRC, f));
    for (const f of [
      "ingest/derivatives.ts",
      "ingest/decode.ts",
      "ingest/index.ts",
      "ingest/phash.ts",
    ]) {
      expect(names).toContain(f);
    }
  });

  it("the pattern covers all six forbidden names", () => {
    expect(WORDS).toHaveLength(6);
    expect(PATTERN.test(`img.${WORDS[0]}()`)).toBe(true);
    expect(PATTERN.test(`img.${WORDS[5]}({})`)).toBe(true);
    expect(PATTERN.test("img.jpeg({ quality: 75 })")).toBe(false);
  });

  it("no worker source or test file mentions them (same scope as the plan's gate grep)", () => {
    const hits = files
      .filter((f) => PATTERN.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(hits).toEqual([]);
  });
});
