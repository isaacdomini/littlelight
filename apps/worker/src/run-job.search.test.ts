import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Strict payload parsing and the usage line of the step-7 jobs in `run-job`, as a child process
// (like run-job.test.ts). A dead database URL proves nothing is reached for bad payloads. No
// provider key is passed: nothing here can call a model.

const run = promisify(execFile);
const SCRIPT = path.resolve(import.meta.dirname, "run-job.ts");
const TSX = path.resolve(import.meta.dirname, "../../../node_modules/.bin/tsx");

const BASE_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  DATABASE_URL: "postgres://tinyglow_worker:x@127.0.0.1:1/none",
  S3_ENDPOINT: "http://127.0.0.1:1",
  S3_PUBLIC_ENDPOINT: "http://127.0.0.1:1",
  S3_ACCESS_KEY: "dev",
  S3_SECRET_KEY: "devdevdev",
  S3_BUCKET: "b",
  S3_REGION: "us-east-1",
  JWT_SECRET: "dev-only-jwt-secret-at-least-32-characters",
  DATA_ENCRYPTION_KEY: "dev-only-data-encryption-key-32-chars-min",
  LOG_LEVEL: "silent",
};

async function runJob(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], {
      env: { ...BASE_ENV, ...env },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const PHOTO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BABY = "11111111-1111-4111-8111-111111111111";

describe("run-job search jobs", () => {
  it("the usage line lists the search job names", async () => {
    const r = await runJob(["nope"]);
    expect(r.code).toBe(2);
    for (const name of ["photo.reindex", "search.reconcile", "search.backfill"]) {
      expect(r.stderr).toContain(name);
    }
  });

  it.each([
    ["photo.reindex", "{}"],
    ["photo.reindex", JSON.stringify({ photoId: PHOTO, babyId: BABY, reason: "nope" })],
    [
      "photo.reindex",
      JSON.stringify({ photoId: PHOTO, babyId: BABY, reason: "backfill", note: "x" }),
    ],
    ["search.reconcile", '{"babyId":"x"}'],
    ["search.backfill", '{"reason":"upgrade"}'],
    ["search.backfill", "{}"],
    ["search.backfill", JSON.stringify({ reason: "manual", extra: 1 })],
  ])(
    "%s %s: a bad payload is an error (exit 1) before any database is touched",
    async (name, payload) => {
      const r = await runJob([name as string, payload as string]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(name);
      // the error line carries a category, never the payload
      expect(r.stderr).not.toContain('"note"');
    },
  );

  it("a non-JSON payload is a usage error (exit 2)", async () => {
    expect((await runJob(["search.backfill", "{oops"])).code).toBe(2);
  });

  it("a valid payload with an unreachable database fails with a category, not a payload dump", async () => {
    const r = await runJob(["search.backfill", JSON.stringify({ babyId: BABY, reason: "manual" })]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain(BABY);
  });

  it("the key of a configured provider is never printed", async () => {
    const r = await runJob(["search.reconcile"], { OPENAI_API_KEY: "sk-test-never-printed" });
    expect(r.stdout + r.stderr).not.toContain("sk-test-never-printed");
  });
});
