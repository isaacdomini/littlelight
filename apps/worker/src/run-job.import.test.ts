import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Step 10: `run-job` supports `import.google` and `import.sweep`, with strict payloads parsed
// before any database is touched (a dead database URL proves nothing is reached).

const run = promisify(execFile);
const SCRIPT = path.resolve(import.meta.dirname, "run-job.ts");
const TSX = path.resolve(import.meta.dirname, "../../../node_modules/.bin/tsx");

const BASE_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  DATABASE_URL: "postgres://littlelight_worker:x@127.0.0.1:1/none",
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

async function runJob(args: string[]) {
  try {
    const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], {
      env: BASE_ENV,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const BATCH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BABY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("run-job import jobs", () => {
  it("the usage line lists both import job names", async () => {
    const r = await runJob(["nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("import.google");
    expect(r.stderr).toContain("import.sweep");
  });

  it.each([
    ["import.google", "{}"],
    ["import.google", JSON.stringify({ batchId: BATCH })],
    ["import.google", JSON.stringify({ batchId: "nope", babyId: BABY })],
    ["import.google", JSON.stringify({ batchId: BATCH, babyId: BABY, refreshToken: "1//secret" })],
    ["import.sweep", '{"x":1}'],
  ])(
    "%s %s: a bad payload is an error (exit 1) before any database is touched",
    async (name, payload) => {
      const r = await runJob([name as string, payload as string]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(name);
      expect(r.stderr).not.toContain("1//secret");
    },
  );

  it("a valid import.google with an unreachable database fails with a category, not a payload dump", async () => {
    const r = await runJob(["import.google", JSON.stringify({ batchId: BATCH, babyId: BABY })]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain(BATCH);
  });

  it("import.sweep with an unreachable database fails (exit 1), proving the job is wired", async () => {
    expect((await runJob(["import.sweep"])).code).toBe(1);
  });

  it("a non-JSON payload is a usage error (exit 2)", async () => {
    expect((await runJob(["import.google", "{oops"])).code).toBe(2);
  });
});
