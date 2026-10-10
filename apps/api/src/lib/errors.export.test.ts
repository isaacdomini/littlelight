import { apiErrorSchema, EXPORTS_PER_BABY_PER_DAY } from "@tinyglow/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  babyTrashed,
  exportExpired,
  exportInProgress,
  exportRateLimited,
  mapPgError,
  notRequester,
  registerErrorHandling,
  toApiError,
} from "./errors";

const pgErr = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, severity: "ERROR", ...extra });

describe("data export errors", () => {
  it("constructors carry the documented status and code", () => {
    expect(exportInProgress()).toMatchObject({ status: 409, code: "export_in_progress" });
    expect(exportRateLimited()).toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterSec: 3600,
    });
    expect(exportRateLimited().message).toContain(String(EXPORTS_PER_BABY_PER_DAY));
    expect(babyTrashed()).toMatchObject({ status: 409, code: "baby_trashed" });
    expect(exportExpired()).toMatchObject({ status: 410, code: "export_expired" });
    expect(exportExpired(true).message).toMatch(/still being prepared/);
    expect(exportExpired(false).message).toMatch(/no longer available/);
    expect(notRequester()).toMatchObject({ status: 403, code: "not_requester" });
  });

  it.each([
    ["an export is already in progress for this album", 409, "export_in_progress"],
    ["export rate limit reached", 429, "rate_limited"],
    ["cannot export a trashed album", 409, "baby_trashed"],
    ["an export cannot be extended", 409, "conflict"],
    ["export download history cannot be rewritten", 409, "conflict"],
    ["approved_by and approved_at are set by the database", 409, "conflict"],
  ])("maps the trigger message %j", (message, status, code) => {
    expect(mapPgError(pgErr("23514", message))).toMatchObject({ status, code });
  });

  it("maps the contributor photo guard (42501) to 403 forbidden, not 500", () => {
    expect(
      mapPgError(pgErr("42501", "contributors may only trash their own pending uploads")),
    ).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("maps the one-active-per-baby unique index to export_in_progress", () => {
    expect(
      mapPgError(
        pgErr("23505", "duplicate key", { constraint: "data_exports_one_active_per_baby" }),
      ),
    ).toMatchObject({ status: 409, code: "export_in_progress" });
  });

  it("the HTTP body parses as an ApiError and never echoes database text", async () => {
    const app = Fastify();
    registerErrorHandling(app);
    app.get("/in-progress", async () => {
      throw pgErr("23514", "an export is already in progress for this album", {
        detail: "Key (baby_id)=(secret) ...",
      });
    });
    app.get("/limit", async () => {
      throw pgErr("23514", "export rate limit reached");
    });
    const a = await app.inject("/in-progress");
    expect(a.statusCode).toBe(409);
    expect(apiErrorSchema.parse(a.json()).error).toBe("export_in_progress");
    expect(a.body).not.toContain("secret");
    const b = await app.inject("/limit");
    expect(b.statusCode).toBe(429);
    expect(b.headers["retry-after"]).toBe("3600");
    await app.close();
  });

  it("an unrelated 23514 is still a 500", () => {
    expect(toApiError(pgErr("23514", "some other check")).status).toBe(500);
  });
});
