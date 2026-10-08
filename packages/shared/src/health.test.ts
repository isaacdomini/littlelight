import { describe, expect, it } from "vitest";
import { healthzResponseSchema } from "./health";

const ok = {
  status: "ok",
  service: "api",
  version: "0.0.0",
  uptimeSec: 12,
  checks: { db: { ok: true, latencyMs: 3 }, storage: { ok: true, latencyMs: 5 } },
};

describe("healthzResponseSchema", () => {
  it("accepts a healthy payload", () => {
    expect(healthzResponseSchema.parse(ok)).toEqual(ok);
  });

  it("accepts a degraded payload with an error category", () => {
    const degraded = {
      ...ok,
      status: "degraded",
      checks: { ...ok.checks, storage: { ok: false, error: "ECONNREFUSED" } },
    };
    expect(healthzResponseSchema.safeParse(degraded).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(healthzResponseSchema.safeParse({ ...ok, status: "fine" }).success).toBe(false);
  });

  it("rejects a payload missing a check", () => {
    expect(healthzResponseSchema.safeParse({ ...ok, checks: { db: ok.checks.db } }).success).toBe(
      false,
    );
  });
});
