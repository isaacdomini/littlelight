import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// `run-job` executes `main()` on import, so it is tested as a child process (the way operators
// and the AI gate use it). No database or network is reached: usage errors, strict payload
// parsing and the no-provider skip all happen before the first query.

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

describe("run-job AI jobs", () => {
  it("the usage line lists the three AI job names (exit 2 for an unknown job)", async () => {
    const r = await runJob(["nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ai.flush");
    expect(r.stderr).toContain("ai.poll");
    expect(r.stderr).toContain("ai.backfill");
  });

  it("a non-JSON payload is a usage error (exit 2)", async () => {
    expect((await runJob(["ai.flush", "{not json"])).code).toBe(2);
  });

  it.each([
    ["ai.flush", '{"force":"yes"}'],
    ["ai.flush", '{"note":"x"}'],
    ["ai.poll", '{"force":true}'],
    ["ai.backfill", '{"reason":"upgrade"}'],
    ["ai.backfill", "{}"],
    ["ai.backfill", '{"reason":"manual","extra":1}'],
  ])("%s %s: a bad payload is an error (exit 1), never a silent drop", async (name, payload) => {
    const r = await runJob([name as string, payload as string]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(name);
  });

  it("without a provider key ai.flush prints { skipped: true } and exits 0, touching no database", async () => {
    const r = await runJob(["ai.flush", '{"force":true}']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1) as string);
    expect(out).toMatchObject({
      job: "ai.flush",
      enqueue: false,
      result: { skipped: true, claimed: 0 },
    });
  });

  it("ai.poll and ai.backfill skip the same way", async () => {
    const poll = await runJob(["ai.poll"]);
    expect(poll.code).toBe(0);
    expect(JSON.parse(poll.stdout.trim().split("\n").at(-1) as string).result.skipped).toBe(true);
    const backfill = await runJob(["ai.backfill", '{"reason":"manual"}']);
    expect(backfill.code).toBe(0);
    expect(JSON.parse(backfill.stdout.trim().split("\n").at(-1) as string).result.skipped).toBe(
      true,
    );
  });

  it("an unreadable env (no DATABASE_URL) is a usage error", async () => {
    const r = await runJob(["ai.poll"], { DATABASE_URL: "" });
    expect(r.code).toBe(2);
  });
});
