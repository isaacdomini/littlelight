import { shareTokenSchema } from "@littlelight/shared";
import { describe, expect, it } from "vitest";
import { downloadDisposition, downloadStem, viewerManifest } from "./viewer-routes";

// Pure helpers of the viewer routes (docs/plans/step-8.md 2.6, D9, D11).

describe("downloadStem", () => {
  it("is ASCII letters, digits and single dashes only", () => {
    expect(downloadStem("Mia")).toBe("Mia");
    expect(downloadStem("Zoë Ann")).toBe("Zoe-Ann");
    expect(downloadStem("José María")).toBe("Jose-Maria");
    expect(downloadStem("  Baby   Bear!! ")).toBe("Baby-Bear");
    for (const name of [
      'a"b',
      "a\r\nb: x",
      "a;b",
      "a/b\\c",
      "../../etc",
      "名前",
      "🙂",
      "a\u0000b",
    ]) {
      expect(downloadStem(name), name).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });

  it("falls back to `photo` when nothing ASCII remains and caps the length", () => {
    expect(downloadStem("")).toBe("photo");
    expect(downloadStem("名前")).toBe("photo");
    expect(downloadStem("🙂🙂")).toBe("photo");
    expect(downloadStem("a".repeat(200)).length).toBeLessThanOrEqual(40);
    expect(downloadStem(`${"a".repeat(39)}-b`)).not.toMatch(/-$/);
  });
});

describe("downloadDisposition", () => {
  it("is an attachment with an ASCII file name <baby>-<YYYY-MM-DD>.jpg", () => {
    expect(downloadDisposition("Mia", "2026-06-14")).toBe(
      'attachment; filename="Mia-2026-06-14.jpg"',
    );
    expect(downloadDisposition("Zoë", "2026-01-02")).toBe(
      'attachment; filename="Zoe-2026-01-02.jpg"',
    );
  });

  it("cannot be bent by a hostile baby name or day (no quote, CR/LF, semicolon or path in the file name)", () => {
    for (const name of ["x\"; filename*=UTF-8''evil", "a\r\nSet-Cookie: x=1", "../../x", "名前‮"]) {
      const d = downloadDisposition(name, "2026-06-14");
      expect(d, name).toMatch(/^attachment; filename="[A-Za-z0-9-]+-2026-06-14\.jpg"$/);
      // pure ASCII, no control characters
      expect(/^[\x20-\x7e]+$/.test(d)).toBe(true);
    }
    expect(downloadDisposition("Mia", '2026-06-14"; x=')).toBe(
      'attachment; filename="Mia-photo.jpg"',
    );
    expect(downloadDisposition("Mia", "")).toBe('attachment; filename="Mia-photo.jpg"');
  });
});

describe("viewerManifest", () => {
  it("opens exactly the link, scoped to /s/, standalone", () => {
    const token = "abcdefghijklmnopqrstuv";
    expect(shareTokenSchema.safeParse(token).success).toBe(true);
    const m = viewerManifest(token);
    expect(m.start_url).toBe(`/s/${token}`);
    expect(m.scope).toBe("/s/");
    expect(m.display).toBe("standalone");
    expect(m.short_name).toBe("Album");
    expect(m.icons.length).toBeGreaterThanOrEqual(3);
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
    // nothing about the baby, the link or the owner
    expect(JSON.stringify(m)).not.toMatch(/baby|mia|email|passcode/i);
  });
});
