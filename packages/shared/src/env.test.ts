import { describe, expect, it } from "vitest";
import {
  AI_PIPELINE_DEFAULTS,
  aiPipelineEnvSchema,
  databaseEnvSchema,
  exportEnvSchema,
  jwtEnvSchema,
  logEnvSchema,
  s3EnvSchema,
  sentryDsnSchema,
  sentryEnvSchema,
} from "./env";

const SECRET = "dev-only-jwt-secret-at-least-32-characters";

describe("jwtEnvSchema", () => {
  it("accepts matching JWT_SECRET and GOTRUE_JWT_SECRET", () => {
    expect(jwtEnvSchema.safeParse({ JWT_SECRET: SECRET, GOTRUE_JWT_SECRET: SECRET }).success).toBe(
      true,
    );
  });

  it("accepts JWT_SECRET alone", () => {
    expect(jwtEnvSchema.safeParse({ JWT_SECRET: SECRET }).success).toBe(true);
  });

  it("rejects a GOTRUE_JWT_SECRET that differs from JWT_SECRET, without echoing values", () => {
    const other = `${SECRET}-different`;
    const result = jwtEnvSchema.safeParse({ JWT_SECRET: SECRET, GOTRUE_JWT_SECRET: other });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["GOTRUE_JWT_SECRET"]);
      const text = JSON.stringify(result.error.issues);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(other);
    }
  });

  it("rejects a short JWT_SECRET", () => {
    expect(jwtEnvSchema.safeParse({ JWT_SECRET: "short" }).success).toBe(false);
  });
});

describe("s3EnvSchema", () => {
  const base = {
    S3_ENDPOINT: "http://storage:9000",
    S3_PUBLIC_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY: "dev",
    S3_SECRET_KEY: "devdevdev",
    S3_BUCKET: "tinyglow-dev",
  };

  it("applies defaults (region, path-style)", () => {
    const parsed = s3EnvSchema.parse(base);
    expect(parsed.S3_REGION).toBe("us-east-1");
    expect(parsed.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it("parses S3_FORCE_PATH_STYLE=false as boolean false", () => {
    expect(s3EnvSchema.parse({ ...base, S3_FORCE_PATH_STYLE: "false" }).S3_FORCE_PATH_STYLE).toBe(
      false,
    );
  });

  it("rejects a missing bucket", () => {
    const { S3_BUCKET: _omit, ...rest } = base;
    expect(s3EnvSchema.safeParse(rest).success).toBe(false);
  });
});

describe("databaseEnvSchema / logEnvSchema", () => {
  it("requires a URL", () => {
    expect(databaseEnvSchema.safeParse({ DATABASE_URL: "not a url" }).success).toBe(false);
    expect(databaseEnvSchema.safeParse({ DATABASE_URL: "postgres://u:p@db:5432/x" }).success).toBe(
      true,
    );
  });

  it("defaults log settings and rejects bad levels", () => {
    expect(logEnvSchema.parse({}).LOG_LEVEL).toBe("info");
    expect(logEnvSchema.safeParse({ LOG_LEVEL: "loud" }).success).toBe(false);
  });
});

describe("aiPipelineEnvSchema (step 6)", () => {
  it("defaults match AI_PIPELINE_DEFAULTS and the PRD (30 min / 1,000 photos / 2 attempts / $3 / 80 % / 2 h)", () => {
    const e = aiPipelineEnvSchema.parse({});
    expect(e).toMatchObject({
      AI_BATCH_MAX_PHOTOS: 1000,
      AI_BATCH_FLUSH_MINUTES: 30,
      AI_MAX_ATTEMPTS: 2,
      AI_BABY_MONTHLY_BUDGET_USD: 3,
      AI_BUDGET_ALERT_PCT: 80,
      AI_QUEUE_AGE_ALERT_MINUTES: 120,
      AI_POLL_INTERVAL_CRON: "*/5 * * * *",
      AI_FLUSH_INTERVAL_CRON: "*/5 * * * *",
      AI_IMAGE_DETAIL: "auto",
    });
    expect(e.AI_BATCH_MAX_BYTES).toBe(AI_PIPELINE_DEFAULTS.AI_BATCH_MAX_BYTES);
  });

  it("treats empty strings (compose passes FOO=) as unset", () => {
    expect(
      aiPipelineEnvSchema.parse({ AI_BATCH_MAX_PHOTOS: "", AI_IMAGE_DETAIL: "" })
        .AI_BATCH_MAX_PHOTOS,
    ).toBe(1000);
  });

  it("allows AI_BATCH_FLUSH_MINUTES=0 (flush on every tick) and coerces strings", () => {
    expect(aiPipelineEnvSchema.parse({ AI_BATCH_FLUSH_MINUTES: "0" }).AI_BATCH_FLUSH_MINUTES).toBe(
      0,
    );
    expect(
      aiPipelineEnvSchema.parse({ AI_BABY_MONTHLY_BUDGET_USD: "0.0001" })
        .AI_BABY_MONTHLY_BUDGET_USD,
    ).toBe(0.0001);
    expect(
      aiPipelineEnvSchema.parse({ AI_BABY_MONTHLY_BUDGET_USD: "0" }).AI_BABY_MONTHLY_BUDGET_USD,
    ).toBe(0);
  });

  it.each([
    ["AI_BATCH_MAX_PHOTOS", "0"],
    ["AI_BATCH_MAX_PHOTOS", "5001"],
    ["AI_BATCH_FLUSH_MINUTES", "-1"],
    ["AI_BATCH_FLUSH_MINUTES", "1441"],
    ["AI_BATCH_MAX_BYTES", "999999"],
    ["AI_BATCH_MAX_BYTES", "200000001"],
    ["AI_MAX_ATTEMPTS", "0"],
    ["AI_MAX_ATTEMPTS", "6"],
    ["AI_BABY_MONTHLY_BUDGET_USD", "-1"],
    ["AI_BABY_MONTHLY_BUDGET_USD", "1001"],
    ["AI_BUDGET_ALERT_PCT", "49"],
    ["AI_BUDGET_ALERT_PCT", "101"],
    ["AI_QUEUE_AGE_ALERT_MINUTES", "0"],
    ["AI_MAX_OUTPUT_TOKENS", "255"],
    ["AI_MAX_OUTPUT_TOKENS", "16385"],
    ["AI_IMAGE_DETAIL", "ultra"],
    ["AI_POLL_INTERVAL_CRON", "every day"],
    ["AI_FLUSH_INTERVAL_CRON", "* * * *"],
  ])("rejects %s=%s", (k, v) => {
    expect(aiPipelineEnvSchema.safeParse({ [k]: v }).success).toBe(false);
  });

  it("accepts the bounds", () => {
    expect(
      aiPipelineEnvSchema.safeParse({
        AI_BATCH_MAX_PHOTOS: "5000",
        AI_BATCH_MAX_BYTES: "200000000",
        AI_BUDGET_ALERT_PCT: "50",
        AI_MAX_ATTEMPTS: "5",
        AI_IMAGE_DETAIL: "low",
        AI_FLUSH_INTERVAL_CRON: "*/1 * * * *",
      }).success,
    ).toBe(true);
  });
});

describe("exportEnvSchema", () => {
  it("defaults EXPORT_MAX_BYTES to 100 GiB and treats blank as unset", () => {
    expect(exportEnvSchema.parse({}).EXPORT_MAX_BYTES).toBe(107_374_182_400);
    expect(exportEnvSchema.parse({ EXPORT_MAX_BYTES: "" }).EXPORT_MAX_BYTES).toBe(107_374_182_400);
  });

  it("accepts 1 GiB and more, rejects less and non-numbers", () => {
    expect(exportEnvSchema.parse({ EXPORT_MAX_BYTES: "1073741824" }).EXPORT_MAX_BYTES).toBe(
      1_073_741_824,
    );
    expect(exportEnvSchema.safeParse({ EXPORT_MAX_BYTES: "1073741823" }).success).toBe(false);
    expect(exportEnvSchema.safeParse({ EXPORT_MAX_BYTES: "lots" }).success).toBe(false);
    expect(exportEnvSchema.safeParse({ EXPORT_MAX_BYTES: "1.5e9" }).success).toBe(true);
  });
});

describe("sentry env", () => {
  it.each([
    "https://abc123@o1.ingest.sentry.io/42",
    "http://k@localhost:9009/1",
    "https://k@sentry.example.test/prefix/7/",
  ])("accepts the DSN %s", (dsn) => {
    expect(sentryDsnSchema.safeParse(dsn).success).toBe(true);
  });

  it.each([
    "not a url",
    "https://sentry.io/42",
    "https://k@sentry.io/",
    "https://k@sentry.io/project",
    "ftp://k@sentry.io/1",
  ])("rejects the DSN %s", (dsn) => {
    expect(sentryDsnSchema.safeParse(dsn).success).toBe(false);
  });

  it("unset or blank DSN means off; the environment defaults to NODE_ENV", () => {
    expect(sentryEnvSchema.parse({ NODE_ENV: "production" })).toEqual({
      SENTRY_DSN: undefined,
      SENTRY_ENVIRONMENT: "production",
    });
    expect(sentryEnvSchema.parse({ SENTRY_DSN: "", SENTRY_ENVIRONMENT: "" }).SENTRY_DSN).toBe(
      undefined,
    );
  });

  it("takes an explicit environment and rejects odd characters", () => {
    expect(sentryEnvSchema.parse({ SENTRY_ENVIRONMENT: "staging" }).SENTRY_ENVIRONMENT).toBe(
      "staging",
    );
    expect(sentryEnvSchema.safeParse({ SENTRY_ENVIRONMENT: "my env!" }).success).toBe(false);
  });

  it("a bad DSN fails and the error never echoes the value", () => {
    const r = sentryEnvSchema.safeParse({ SENTRY_DSN: "https://secretkey@bad" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain("secretkey");
  });
});
