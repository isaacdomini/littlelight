import { apiErrorSchema } from "@littlelight/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiError,
  forbidden,
  isPgError,
  mapPgError,
  notFound,
  rateLimited,
  registerErrorHandling,
  safeErrorLog,
  toApiError,
} from "./errors";

const pgErr = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, severity: "ERROR", ...extra });

describe("mapPgError", () => {
  it("maps the step-2 trigger messages to specific API errors", () => {
    expect(mapPgError(pgErr("23514", "baby already has two admins"))).toMatchObject({
      status: 409,
      code: "admins_full",
    });
    expect(mapPgError(pgErr("23514", "baby must keep at least one admin"))).toMatchObject({
      status: 409,
      code: "last_admin",
    });
    expect(mapPgError(pgErr("23514", "invite rate limit exceeded for baby"))).toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterSec: 3600,
    });
    expect(mapPgError(pgErr("23514", "invite is no longer valid"))).toMatchObject({
      status: 410,
      code: "invite_expired",
    });
  });

  it("maps 42501 to forbidden, 23505 to conflict, everything else to internal", () => {
    expect(mapPgError(pgErr("42501", "permission denied for table x"))).toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(mapPgError(pgErr("23505", "duplicate key value"))).toMatchObject({
      status: 409,
      code: "conflict",
    });
    expect(mapPgError(pgErr("23514", "some other check"))).toMatchObject({
      status: 500,
      code: "internal",
    });
    expect(mapPgError(pgErr("57P01", "terminating connection"))).toMatchObject({ status: 500 });
  });

  it("never echoes the database message", () => {
    const e = mapPgError(pgErr("42501", "permission denied for table secret_table (a@b.co)"));
    expect(JSON.stringify(e.toBody())).not.toContain("secret_table");
    expect(JSON.stringify(e.toBody())).not.toContain("a@b.co");
  });
});

describe("toApiError / isPgError", () => {
  it("recognises pg errors by SQLSTATE shape and rejects lookalikes", () => {
    expect(isPgError(pgErr("23505", "x"))).toBe(true);
    expect(isPgError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isPgError(null)).toBe(false);
  });

  it("turns ZodError into validation_failed with field paths only", () => {
    const parsed = z.object({ email: z.email() }).safeParse({ email: "secret-value" });
    if (parsed.success) throw new Error("unreachable");
    const e = toApiError(parsed.error);
    expect(e).toMatchObject({ status: 400, code: "validation_failed" });
    expect(e.details).toEqual({ fields: ["email"] });
    expect(JSON.stringify(e.toBody())).not.toContain("secret-value");
  });

  it("maps statusCode 4xx errors, and unknown errors to a bare 500", () => {
    expect(toApiError(Object.assign(new Error("x"), { statusCode: 404 }))).toMatchObject({
      code: "not_found",
    });
    expect(toApiError(Object.assign(new Error("x"), { statusCode: 429 }))).toMatchObject({
      code: "rate_limited",
    });
    expect(toApiError(Object.assign(new Error("x"), { statusCode: 415 }))).toMatchObject({
      status: 415,
      code: "validation_failed",
    });
    const e = toApiError(new Error("boom: password=hunter2"));
    expect(e).toMatchObject({ status: 500, code: "internal" });
    expect(e.message).not.toContain("hunter2");
  });

  it("passes ApiError through and clamps Retry-After to at least one second", () => {
    const a = new ApiError(418 as never, "conflict", "m");
    expect(toApiError(a)).toBe(a);
    expect(rateLimited(0.2).retryAfterSec).toBe(1);
    expect(rateLimited(59.1).retryAfterSec).toBe(60);
    expect(notFound().status).toBe(404);
    expect(forbidden().status).toBe(403);
  });
});

describe("safeErrorLog", () => {
  it("describes pg errors by identifiers, not messages", () => {
    const log = safeErrorLog(
      pgErr("23505", "Key (email)=(a@b.co) already exists", { constraint: "c" }),
    );
    expect(JSON.stringify(log)).not.toContain("a@b.co");
    expect(log).toMatchObject({ sqlstate: "23505", constraint: "c" });
  });
});

describe("registerErrorHandling", () => {
  it("answers every failure in apiErrorSchema shape with Retry-After on 429", async () => {
    const app = Fastify();
    registerErrorHandling(app);
    app.get("/limited", async () => {
      throw rateLimited(42);
    });
    app.get("/boom", async () => {
      throw new Error("internal detail");
    });
    app.post("/json", async () => ({ ok: true }));

    const limited = await app.inject({ method: "GET", url: "/limited" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("42");
    expect(apiErrorSchema.parse(limited.json()).error).toBe("rate_limited");

    const boom = await app.inject({ method: "GET", url: "/boom" });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: "internal", message: "Something went wrong" });

    const missing = await app.inject({ method: "GET", url: "/nope" });
    expect(missing.statusCode).toBe(404);
    expect(apiErrorSchema.parse(missing.json()).error).toBe("not_found");

    const badJson = await app.inject({
      method: "POST",
      url: "/json",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(badJson.statusCode).toBe(400);
    expect(apiErrorSchema.safeParse(badJson.json()).success).toBe(true);
    await app.close();
  });
});
