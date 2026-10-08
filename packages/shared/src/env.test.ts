import { describe, expect, it } from "vitest";
import { databaseEnvSchema, jwtEnvSchema, logEnvSchema, s3EnvSchema } from "./env";

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
    S3_BUCKET: "littlelight-dev",
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
