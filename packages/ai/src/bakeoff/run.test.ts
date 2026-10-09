import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { craftJpeg } from "../../../../e2e/fixtures/ai-images";
import { formatReport, parseBakeoffArgs, runBakeoff } from "./run";

const SAMPLE = resolve(__dirname, "../../../../e2e/fixtures/bakeoff-sample");
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("bakeoff with --providers fake on the committed sample", () => {
  it("sample fixtures are 3 JPEGs of at most 768 px", async () => {
    const { readdir, stat } = await import("node:fs/promises");
    const jpgs = (await readdir(SAMPLE)).filter((n) => n.endsWith(".jpg"));
    expect(jpgs).toHaveLength(3);
    for (const n of jpgs) expect((await stat(join(SAMPLE, n))).size).toBeLessThan(400_000);
  });

  it("prints a report table with 3/3 schema-valid and a cost", async () => {
    const out = await mkdtemp(join(tmpdir(), "bakeoff-"));
    dirs.push(out);
    const lines: string[] = [];
    const { reports, markdown } = await runBakeoff({
      photosDir: SAMPLE,
      providers: ["fake"],
      mode: "batch",
      labelsPath: join(SAMPLE, "labels.json"),
      outPath: join(out, "report.md"),
      progress: (l) => lines.push(l),
      env: {},
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      provider: "fake",
      photos: 3,
      valid: 3,
      refusals: 0,
      invalid: 0,
    });
    expect(reports[0]?.costUsd).toBeCloseTo(3 * 0.0001385, 9);
    expect(markdown).toContain("| Metric | fake (gpt-6-luna) |");
    expect(markdown).toContain("Schema-valid | 3/3");
    expect(await readFile(join(out, "report.md"), "utf8")).toBe(markdown);
    expect(lines.join("\n")).not.toContain("expected spend"); // fake only: no real spend
  });

  it("realtime mode works with the fake provider", async () => {
    const { reports } = await runBakeoff({
      photosDir: SAMPLE,
      providers: ["fake"],
      mode: "realtime",
      progress: () => undefined,
      env: {},
    });
    expect(reports[0]?.valid).toBe(3);
  });

  it("refuses a directory with a photo larger than 768 px (it never resizes)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakeoff-big-"));
    dirs.push(dir);
    await writeFile(join(dir, "big.jpg"), craftJpeg(1600, 1200));
    await expect(
      runBakeoff({
        photosDir: dir,
        providers: ["fake"],
        mode: "batch",
        progress: () => undefined,
        env: {},
      }),
    ).rejects.toThrow(/768 px analysis copies/);
  });

  it("refuses an empty directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakeoff-empty-"));
    dirs.push(dir);
    await mkdir(join(dir, "sub"));
    await expect(
      runBakeoff({
        photosDir: dir,
        providers: ["fake"],
        mode: "batch",
        progress: () => undefined,
        env: {},
      }),
    ).rejects.toThrow(/no .jpg/);
  });

  it("--limit caps the photo count", async () => {
    const { reports } = await runBakeoff({
      photosDir: SAMPLE,
      providers: ["fake"],
      mode: "batch",
      limit: 2,
      progress: () => undefined,
      env: {},
    });
    expect(reports[0]?.photos).toBe(2);
  });
});

describe("parseBakeoffArgs", () => {
  it("parses flags, ignores a leading --, validates providers and mode", () => {
    const o = parseBakeoffArgs([
      "--",
      "--photos",
      SAMPLE,
      "--providers",
      "fake",
      "--mode=realtime",
      "--limit",
      "5",
      "--poll-seconds",
      "2",
      "--timeout-min",
      "3",
    ]);
    expect(o).toMatchObject({
      photosDir: SAMPLE,
      providers: ["fake"],
      mode: "realtime",
      limit: 5,
      pollIntervalMs: 2000,
      timeoutMs: 180_000,
    });
    expect(() => parseBakeoffArgs([])).toThrow(/--photos/);
    expect(() => parseBakeoffArgs(["--photos", SAMPLE, "--providers", "gemini"])).toThrow(
      /unknown provider/,
    );
    expect(() => parseBakeoffArgs(["--photos", SAMPLE, "--mode", "stream"])).toThrow(/--mode/);
    expect(() => parseBakeoffArgs(["stray"])).toThrow(/unexpected argument/);
    expect(() => parseBakeoffArgs(["--photos"])).toThrow(/needs a value/);
  });
  it("defaults to openai,anthropic in batch mode", () => {
    const o = parseBakeoffArgs(["--photos", SAMPLE]);
    expect(o.providers).toEqual(["openai", "anthropic"]);
    expect(o.mode).toBe("batch");
  });
});

describe("formatReport", () => {
  it("notes an unfinished batch", () => {
    const md = formatReport(
      [
        {
          provider: "openai",
          model: "m",
          photos: 1,
          results: 0,
          valid: 0,
          refusals: 0,
          invalid: 0,
          expiredOrMissing: 1,
          errors: 0,
          sensitive: { tp: 0, fp: 0, fn: 0, labeled: 0 },
          milestone: { hits: 0, labeled: 0 },
          tokens: {
            input: 0,
            cached: 0,
            output: 0,
            image: 0,
            withImage: 0,
            reasoning: 0,
            withUsage: 0,
          },
          costUsd: 0,
          wallMs: 0,
          meanLatencyMs: null,
          unfinishedBatchId: "b1",
        },
      ],
      { mode: "batch", photos: 1 },
    );
    expect(md).toContain("batch b1 did not finish");
    expect(md).toContain("n/a");
  });
});
