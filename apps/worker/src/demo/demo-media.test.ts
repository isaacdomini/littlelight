import { describe, expect, it } from "vitest";
import {
  DemoMediaUsageError,
  demoMediaRefusal,
  devDefaults,
  parseDemoMediaArgs,
  resolveDemoMediaEnv,
} from "./demo-media";

// The `pnpm demo:media` CLI (docs/plans/step-9.md 2.11, 2.15): argument parsing, the production
// refusals and the dev-stack defaults. No database or storage is touched.

const BABY = "aaaaaaaa-0000-4000-8000-00000000b001";

describe("parseDemoMediaArgs", () => {
  it("no arguments is the ensure mode; --check is check", () => {
    expect(parseDemoMediaArgs([])).toEqual({ mode: "ensure" });
    expect(parseDemoMediaArgs(["--check"])).toEqual({ mode: "check" });
  });

  it("tolerates the leading -- pnpm passes", () => {
    expect(parseDemoMediaArgs(["--", "--check"])).toEqual({ mode: "check" });
  });

  it("--review-baby takes a uuid (lowercased) and an optional --confirm-production", () => {
    expect(parseDemoMediaArgs(["--review-baby", BABY])).toEqual({
      mode: "review",
      babyId: BABY,
      confirmProduction: false,
    });
    expect(
      parseDemoMediaArgs(["--review-baby", BABY.toUpperCase(), "--confirm-production"]),
    ).toEqual({
      mode: "review",
      babyId: BABY,
      confirmProduction: true,
    });
    expect(parseDemoMediaArgs(["--confirm-production", "--review-baby", BABY]).mode).toBe("review");
  });

  it.each([
    [["--review-baby"]],
    [["--review-baby", "not-a-uuid"]],
    [["--review-baby", "--check"]],
    [["--review-baby", BABY, "--check"]],
    [["--check", "--review-baby", BABY]],
    [["--confirm-production"]],
    [["--check", "--confirm-production"]],
    [["--unknown"]],
    [["extra"]],
  ])("rejects %j as a usage error", (argv) => {
    expect(() => parseDemoMediaArgs(argv)).toThrow(DemoMediaUsageError);
  });

  it("does not echo the offending argument", () => {
    try {
      parseDemoMediaArgs(["--hunter2-secret"]);
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
    }
  });
});

describe("demoMediaRefusal", () => {
  const prod = { NODE_ENV: "production" };
  const review = (confirmProduction: boolean) => ({
    mode: "review" as const,
    babyId: BABY,
    confirmProduction,
  });

  it("nothing is refused outside production", () => {
    for (const args of [{ mode: "ensure" as const }, { mode: "check" as const }, review(false)]) {
      expect(demoMediaRefusal(args, {})).toBeNull();
      expect(demoMediaRefusal(args, { NODE_ENV: "development" })).toBeNull();
    }
  });

  it("the demo family (ensure, check) is dev only: refused in production, flag or not", () => {
    expect(demoMediaRefusal({ mode: "ensure" }, prod)).toMatch(/dev only/);
    expect(demoMediaRefusal({ mode: "check" }, prod)).toMatch(/dev only/);
  });

  it("--review-baby in production needs --confirm-production", () => {
    expect(demoMediaRefusal(review(false), prod)).toMatch(/--confirm-production/);
    expect(demoMediaRefusal(review(true), prod)).toBeNull();
  });
});

describe("devDefaults / resolveDemoMediaEnv", () => {
  it("defaults to the dev stack's worker role and MinIO key on localhost, honouring DB_PORT / STORAGE_PORT", () => {
    expect(devDefaults({}).DATABASE_URL).toBe(
      "postgres://tinyglow_worker:dev@localhost:5432/tinyglow",
    );
    expect(devDefaults({}).S3_ENDPOINT).toBe("http://localhost:9000");
    expect(devDefaults({ DB_PORT: "55432", STORAGE_PORT: "59000" })).toMatchObject({
      DATABASE_URL: "postgres://tinyglow_worker:dev@localhost:55432/tinyglow",
      S3_ENDPOINT: "http://localhost:59000",
    });
  });

  it("outside production unset variables take the dev defaults and explicit ones win", () => {
    const env = resolveDemoMediaEnv({ S3_BUCKET: "other", DATABASE_URL: "postgres://u:p@h:1/d" });
    expect(env.S3_BUCKET).toBe("other");
    expect(env.DATABASE_URL).toBe("postgres://u:p@h:1/d");
    expect(env.S3_ACCESS_KEY).toBe("tinyglow-worker");
    expect(env.S3_PUBLIC_ENDPOINT).toBe(env.S3_ENDPOINT);
  });

  it("blank values count as unset", () => {
    expect(resolveDemoMediaEnv({ S3_BUCKET: "  " }).S3_BUCKET).toBe("tinyglow-dev");
  });

  it("in production there are NO defaults: missing settings fail, naming fields only", () => {
    try {
      resolveDemoMediaEnv({ NODE_ENV: "production" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DemoMediaUsageError);
      expect((e as Error).message).toContain("DATABASE_URL");
      expect((e as Error).message).not.toContain("dev-worker-s3-secret");
    }
  });

  it("in production an explicit full environment is accepted", () => {
    const env = resolveDemoMediaEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://tinyglow_worker:secret@db:5432/tinyglow",
      S3_ENDPOINT: "http://storage:9000",
      S3_ACCESS_KEY: "k",
      S3_SECRET_KEY: "s3cretsecret",
      S3_BUCKET: "tinyglow",
    });
    expect(env.S3_BUCKET).toBe("tinyglow");
  });
});
