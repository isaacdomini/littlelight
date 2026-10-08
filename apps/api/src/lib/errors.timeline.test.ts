import { describe, expect, it } from "vitest";
import { mapPgError, type PgErrorLike } from "./errors";

const pg = (code: string, message: string, extra: Partial<PgErrorLike> = {}): PgErrorLike => ({
  code,
  message,
  severity: "ERROR",
  ...extra,
});

describe("mapPgError: step 5 trigger messages", () => {
  it("milestone limit and measurement photo -> 409 conflict", () => {
    expect(mapPgError(pg("23514", "milestone limit reached"))).toMatchObject({
      status: 409,
      code: "conflict",
    });
    expect(mapPgError(pg("23514", "measurement photo must belong to the same baby"))).toMatchObject(
      { status: 409, code: "conflict" },
    );
  });

  it("the two milestone same-baby messages -> 409 (before the generic <table>.<column> rule)", () => {
    for (const m of [
      "photo_details.milestone_id must belong to the same baby",
      "upload_sessions.milestone_id must belong to the same baby",
    ]) {
      const e = mapPgError(pg("23514", m, { table: "photo_details" }));
      expect(e).toMatchObject({ status: 409, code: "conflict" });
      expect(e.message).toBe("That milestone belongs to another album");
    }
  });

  it("people / location limits name the body field", () => {
    expect(mapPgError(pg("23514", "photo_details.people holds at most 20 entries"))).toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { fields: ["body.people"] },
    });
    expect(
      mapPgError(pg("23514", "photo_details.location_label is longer than 120 characters")),
    ).toMatchObject({ status: 400, details: { fields: ["body.locationLabel"] } });
  });

  it.each([
    "photo_details.note is longer than 2000 characters",
    "measurements.note is longer than 2000 characters",
    "measurements.value_metric exceeds the sanity bound",
    "upload_sessions.note is longer than 2000 characters",
    "babies.name must be 1 to 80 characters",
    "share_links.name must be 1 to 80 characters",
    "milestones.name must be 1 to 80 characters",
    "chat_threads.title is longer than 200 characters",
    "invites.email must be lower-case and 3 to 320 characters",
    "measurements values must be positive",
  ])("shape trigger %j -> 400 validation_failed, nothing echoed", (m) => {
    const e = mapPgError(pg("23514", m));
    expect(e).toMatchObject({ status: 400, code: "validation_failed" });
    expect(e.message).toBe("The request is invalid");
  });

  it("a plain CHECK on photo_details / measurements (by table) is a 400 too", () => {
    expect(
      mapPgError(pg("23514", "new row violates check constraint", { table: "measurements" })),
    ).toMatchObject({ status: 400 });
  });

  it("an unknown 23514 on another table stays a 500", () => {
    expect(mapPgError(pg("23514", "something else", { table: "photos" }))).toMatchObject({
      status: 500,
      code: "internal",
    });
  });

  it("23505 on the milestone name key -> its own 409 message, others generic", () => {
    expect(
      mapPgError(pg("23505", "x", { constraint: "milestones_baby_id_lower_name_key" })).message,
    ).toBe("A milestone with that name already exists");
    expect(mapPgError(pg("23505", "x", { constraint: "other" })).message).toBe(
      "That already exists",
    );
    expect(mapPgError(pg("23505", "x"))).toMatchObject({ status: 409 });
  });

  it("23503 -> 409 conflict", () => {
    expect(mapPgError(pg("23503", "insert violates foreign key"))).toMatchObject({
      status: 409,
      code: "conflict",
    });
  });

  it("the same text under another SQLSTATE is not mapped", () => {
    expect(mapPgError(pg("P0001", "milestone limit reached")).status).toBe(500);
  });

  it("bodies never echo database text", () => {
    const e = mapPgError(pg("23514", "photo_details.note is longer than 2000 characters SECRET"));
    expect(JSON.stringify(e.toBody())).not.toContain("SECRET");
  });
});
