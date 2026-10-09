import { parseCitations } from "@littlelight/shared";
import { describe, expect, it } from "vitest";
import { createCitationFilter } from "./citations";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const M1 = "33333333-3333-4333-8333-333333333333";

function run(chunks: string[]) {
  const f = createCitationFilter();
  let out = "";
  for (const c of chunks) out += f.push(c);
  out += f.flush();
  return { text: out, citations: f.citations, invalid: f.invalid };
}

function splitEvery(text: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}

const SAMPLES = [
  `Here are 2 photos that match. [photo:${P1}] [photo:${P2}]`,
  `Weight 7.20 kg on 2026-01-01 (6 months). [measurement:${M1}] [photo:${P1}]`,
  `No markers here, just text with [brackets] and (parens).`,
  `A marker at the very end[photo:${P1}]`,
  `[photo:${P1}] at the very start`,
  `Two  spaces   before [photo:${P1}]    and tabs\t[measurement:${M1}]. Done`,
  `Odd case [PHOTO:${P1.toUpperCase()}] and spaces [ photo : ${P2} ].`,
  `Bad ids [photo:123] and [photo:../../etc] and [measurement:] remain stripped`,
  `Duplicate [photo:${P1}] and again [photo:${P1}] and [measurement:${P1}]`,
  `Newline before\n[photo:${P1}]\nand after`,
  `Unfinished marker at the end [photo:${P1.slice(0, 12)}`,
  `Nested [ [photo:${P1}] ] brackets`,
  `Emoji 👶 and ünïcode [photo:${P1}] stay intact`,
  "",
];

describe("createCitationFilter: streaming equals the one-shot rule at every split size", () => {
  it.each(SAMPLES.map((s, i) => [i, s] as const))("sample %i", (_i, text) => {
    const oneShot = parseCitations(text);
    for (let n = 1; n <= Math.max(1, text.length); n++) {
      const r = run(splitEvery(text, n));
      // The streaming filter keeps surrounding whitespace that the one-shot trims; compare trimmed.
      expect(r.text.trim(), `split ${n}`).toBe(oneShot.text);
      expect(r.citations, `split ${n}`).toEqual(oneShot.citations);
      expect(r.invalid, `split ${n}`).toBe(oneShot.invalid);
    }
  });
});

describe("createCitationFilter", () => {
  it("never leaks any part of a marker in an emitted delta (marker split across deltas)", () => {
    const text = `Look [photo:${P1}] here`;
    for (let n = 1; n < text.length; n++) {
      const f = createCitationFilter();
      let emitted = "";
      for (const c of splitEvery(text, n)) {
        const piece = f.push(c);
        emitted += piece;
        expect(emitted, `split ${n}`).not.toMatch(/\[ph|\[photo|photo:|\[$/);
      }
      emitted += f.flush();
      expect(emitted).toBe("Look here");
    }
  });

  it("removes the spaces before a marker, keeps the ones after", () => {
    expect(run([`first steps   [photo:${P1}]. Yes`]).text).toBe("first steps. Yes");
  });

  it("order is kept and unknown ids are recorded (the caller validates them)", () => {
    const r = run([`a [photo:${P2}] b [photo:${P1}] c [measurement:${M1}]`]);
    expect(r.citations).toEqual([
      { kind: "photo", id: P2 },
      { kind: "photo", id: P1 },
      { kind: "measurement", id: M1 },
    ]);
    expect(r.text).toBe("a b c");
  });

  it("an unfinished marker at the end of the stream is ordinary text", () => {
    const r = run([`broken [photo:abc`]);
    expect(r.text).toBe("broken [photo:abc");
    expect(r.citations).toEqual([]);
  });

  it("an opening bracket that cannot become a marker is released once 60 characters passed", () => {
    const f = createCitationFilter();
    let out = f.push(`[${"x".repeat(80)}`);
    out += f.flush();
    expect(out).toBe(`[${"x".repeat(80)}`);
  });

  it("holds back only a possible marker: plain text is emitted immediately", () => {
    const f = createCitationFilter();
    expect(f.push("Hello world")).toBe("Hello world");
    expect(f.push(" and then [")).toBe(" and then");
    expect(f.push("photo:")).toBe("");
    expect(f.push(`${P1}]`)).toBe("");
    expect(f.push(" done")).toBe(" done");
    expect(f.flush()).toBe("");
    expect(f.citations).toEqual([{ kind: "photo", id: P1 }]);
  });

  it("counts malformed ids as invalid and still strips them", () => {
    const r = run([`x [photo:nope] y`]);
    expect(r.text).toBe("x y");
    expect(r.invalid).toBe(1);
    expect(r.citations).toEqual([]);
  });

  it("empty deltas and an empty stream are fine", () => {
    const f = createCitationFilter();
    expect(f.push("")).toBe("");
    expect(f.flush()).toBe("");
  });
});
