import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, integrationEnv } from "../testing/harness";
import { PARAPHRASES, UNRELATED_QUERIES } from "./search-calibrate";
import { remove, seed } from "./search-seed";

// `pnpm search:calibrate` (relevance-floor calibration) with the keyless fake provider against a
// small search seed in the test database. Child process, like run-job: the script is a CLI. No
// provider key is passed and the real provider is only exercised up to its refusal.

const run = promisify(execFile);
const SCRIPT = path.resolve(import.meta.dirname, "search-calibrate.ts");
const TSX = path.resolve(import.meta.dirname, "../../../../node_modules/.bin/tsx");

async function calibrate(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CALIBRATE_DATABASE_URL: integrationEnv?.databaseUrl ?? "",
        ...env,
      },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe.skipIf(!integrationEnv)("search:calibrate (fake provider)", () => {
  let h: Harness;
  let db: pg.Client;

  beforeAll(async () => {
    h = await createHarness();
    db = new pg.Client({ connectionString: integrationEnv?.databaseUrl });
    await db.connect();
    await seed(db, 60, () => undefined);
  }, 120_000);
  afterAll(async () => {
    if (db) {
      await remove(db, () => undefined).catch(() => undefined);
      await db.end();
    }
    await h?.close();
  });

  it("prints the header, one line per unrelated probe, the distributions and a recommendation", async () => {
    const r = await calibrate(["--provider", "fake"]);
    expect(r.code, r.stderr).toBe(0);
    const out = r.stdout;
    expect(out).toMatch(/provider=fake model=fake\/1024 docs=60 \(stored vectors reused\)/);
    expect(out).toMatch(/queries=\d+/);
    expect(out).toContain("estimated spend");
    expect(out).toContain("fake: nothing is billed");
    // one line per unrelated probe: "  0.123  \"zebra submarine\""
    const probes = out
      .split("\n")
      .filter((l) => /^ {2}-?\d\.\d{3} {2}"/.test(l) || /^ {2}- {2}"/.test(l));
    expect(probes).toHaveLength(UNRELATED_QUERIES.length);
    for (const q of UNRELATED_QUERIES) expect(out).toContain(`  ${JSON.stringify(q)}`);
    expect(out).toContain("unrelated probes: best vector-only similarity");
    expect(out).toMatch(/unrelated queries: best vector-only similarity per query/);
    expect(out).toMatch(/n=30 p50 [\d.-]+ p90 [\d.-]+ p95 [\d.-]+ max [\d.-]+/);
    expect(out).toMatch(/golden targets: n=\d+ similarity min/);
    expect(out).toMatch(/paraphrase targets: n=\d+ similarity min/);
    expect(out).toMatch(/recommended SEARCH_MIN_SIMILARITY for fake\/1024: \d\.\d\d/);
    expect(out).toContain("0.30 text-embedding-3-small, 0.60 fake");
  });

  it("the fake bag-of-words model separates unrelated probes from golden targets", async () => {
    const r = await calibrate([]);
    expect(r.code, r.stderr).toBe(0);
    const probes = r.stdout
      .split("\n")
      .map((l) => /^ {2}(-?\d\.\d{3}) {2}"/.exec(l)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);
    expect(probes).toHaveLength(UNRELATED_QUERIES.length);
    // the fake floor (0.60) is above every unrelated probe: they would all find nothing
    for (const p of probes) expect(p).toBeLessThan(0.6);
  });

  it("prints similarities, ranks and paraphrases only: never a document, a note or a name", async () => {
    const r = await calibrate(["--provider", "fake"]);
    expect(r.stdout).not.toMatch(/Note from parent|Golden|Goldie|search_text/);
    expect(r.stdout + r.stderr).not.toMatch(/sk-[A-Za-z0-9]{8}/);
    expect(PARAPHRASES.length).toBeGreaterThanOrEqual(15);
  });

  it("refuses a non-local database", async () => {
    const r = await calibrate(["--provider", "fake"], {
      CALIBRATE_DATABASE_URL: "postgres://postgres:x@db.example.com:5432/littlelight",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/only reads a local database/);
  });

  it("an unknown provider is refused", async () => {
    const r = await calibrate(["--provider", "gemini"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--provider must be fake or real/);
  });

  it("the real provider is refused without a key, before any network call", async () => {
    const r = await calibrate(["--provider", "real"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/search:calibrate failed/);
    expect(r.stdout).not.toContain("estimated spend");
  });

  it("an empty album is an error that points at the seed", async () => {
    const r = await calibrate([
      "--provider",
      "fake",
      "--baby",
      "00000000-0000-4000-8000-000000000fff",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/pnpm search:seed/);
  });
});
