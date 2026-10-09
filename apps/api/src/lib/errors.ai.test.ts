import { describe, expect, it } from "vitest";
import { mapPgError, type PgErrorLike } from "./errors";

const pg = (code: string, message: string, extra: Partial<PgErrorLike> = {}): PgErrorLike => ({
  code,
  message,
  severity: "ERROR",
  ...extra,
});

describe("mapPgError: step 6 messages", () => {
  it("a non-overridable AI field -> 400 validation_failed on the body", () => {
    expect(
      mapPgError(pg("23514", "photo_ai_overrides.field_path is not an overridable field")),
    ).toMatchObject({ status: 400, code: "validation_failed", details: { fields: ["body"] } });
  });

  it("the AI queue and AI results guards -> 409 conflict with a generic message", () => {
    for (const m of [
      "photo cannot enter the AI queue: it must be approved, not deleted and belong to a paid-tier baby",
      "AI results can only be stored for photos of a paid-tier baby",
    ]) {
      const e = mapPgError(pg("23514", m));
      expect(e).toMatchObject({ status: 409, code: "conflict" });
      expect(e.message).toBe("That conflicts with the current state");
    }
  });

  it("does not echo the offending text", () => {
    const e = mapPgError(
      pg("23514", "photo_ai_overrides.field_path is not an overridable field", {
        table: "photo_ai_overrides",
        column: "value",
      }),
    );
    expect(JSON.stringify(e)).not.toContain("photo_ai_overrides");
  });
});
