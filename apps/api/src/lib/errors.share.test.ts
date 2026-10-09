import { describe, expect, it } from "vitest";
import {
  ApiError,
  mapPgError,
  type PgErrorLike,
  passcodeInvalid,
  passcodeLocked,
  passcodeRequired,
  shareLinkExpired,
  shareLinkLimit,
  shareRulePlanRequired,
} from "./errors";

// Step 8 error mapping (docs/plans/step-8.md 2.4, 2.9; PRD FR-9). Database trigger messages map to
// friendly API errors, never echoing the SQL or a value.

const pg = (code: string, message: string, extra: Partial<PgErrorLike> = {}): PgErrorLike => ({
  code,
  message,
  severity: "ERROR",
  ...extra,
});

describe("viewer errors", () => {
  it("share_link_expired is 410 with the one friendly message", () => {
    const e = shareLinkExpired();
    expect(e).toMatchObject({ status: 410, code: "share_link_expired" });
    expect(e.message).toBe("This link has expired. Ask the parents for a new link.");
  });

  it("passcode errors: required 401, invalid 401 with attemptsLeft, locked 429 with Retry-After", () => {
    expect(passcodeRequired()).toMatchObject({ status: 401, code: "passcode_required" });
    const invalid = passcodeInvalid(3);
    expect(invalid).toMatchObject({ status: 401, code: "passcode_invalid" });
    expect(invalid.details).toEqual({ attemptsLeft: 3 });
    expect(passcodeInvalid(-2).details).toEqual({ attemptsLeft: 0 });
    const locked = passcodeLocked(120);
    expect(locked).toMatchObject({ status: 429, code: "passcode_locked" });
    expect(JSON.stringify(locked)).toContain("120");
  });

  it("plan_required for rules on a free baby", () => {
    expect(shareRulePlanRequired()).toMatchObject({ status: 403, code: "plan_required" });
    expect(shareRulePlanRequired().message).toMatch(/Plus/);
  });
});

describe("mapPgError: step 8 messages", () => {
  it("share_rules tags hold at most 20 entries per list -> 400 validation_failed", () => {
    const e = mapPgError(pg("23514", "share_rules tags hold at most 20 entries per list"));
    expect(e).toMatchObject({ status: 400, code: "validation_failed" });
    expect(e.message).toBe("A rule can list at most 20 tags");
  });

  it("renewing a revoked link -> 409 conflict (both trigger messages)", () => {
    for (const m of [
      "a revoked share link cannot be renewed",
      "a revoked share link can only be reactivated with a new token",
    ]) {
      const e = mapPgError(pg("23514", m));
      expect(e, m).toMatchObject({ status: 409, code: "conflict" });
      expect(e.message).toBe("This link was revoked. Regenerate it to share again.");
    }
  });

  it("tags must be 1 to 60 characters / need an include tag -> 400", () => {
    expect(
      mapPgError(
        pg("23514", "share_rules tags must be 1 to 60 characters, trimmed and lower-case"),
      ),
    ).toMatchObject({ status: 400, code: "validation_failed" });
    const e = mapPgError(pg("23514", "share rule needs at least one include tag"));
    expect(e).toMatchObject({ status: 400, details: { fields: ["body.includeTags"] } });
  });

  it("auto-share rules need the paid plan -> 403 plan_required", () => {
    expect(mapPgError(pg("23514", "auto-share rules need the paid plan"))).toMatchObject({
      status: 403,
      code: "plan_required",
    });
  });

  it("the 20 links cap -> 409 conflict", () => {
    const e = mapPgError(pg("23514", "share link limit reached"));
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(e.message).toBe(shareLinkLimit().message);
    expect(e.message).toMatch(/20/);
  });

  it("expiry beyond 30 days and ttl_hours range -> 400 on body.ttlHours", () => {
    for (const m of [
      "share link expiry must be within 30 days",
      "share_links.ttl_hours must be 1 to 720",
    ]) {
      expect(mapPgError(pg("23514", m)), m).toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { fields: ["body.ttlHours"] },
      });
    }
  });

  it("a share_links.* shape message (passcode format, name length) -> 400", () => {
    for (const m of [
      "share_links.passcode_hash has an unknown format",
      "share_links.name must be 1 to 80 characters",
    ]) {
      expect(mapPgError(pg("23514", m)), m).toMatchObject({
        status: 400,
        code: "validation_failed",
      });
    }
  });

  it("the viewer session guard (link died during the exchange) -> 410 share_link_expired", () => {
    expect(mapPgError(pg("23514", "share link is not active"))).toMatchObject({
      status: 410,
      code: "share_link_expired",
    });
  });

  it("the shared_photos gate on manual adds -> 409 conflict without echoing anything", () => {
    for (const m of [
      "only approved, non-deleted photos can be shared",
      "sensitive photos are never auto-shared",
      "only analysed photos can be auto-shared",
      "photo was removed from this album by an admin",
    ]) {
      const e = mapPgError(pg("23514", m));
      expect(e, m).toMatchObject({ status: 409, code: "conflict" });
      expect(e.message).toBe("That photo can't be shared right now");
    }
    expect(mapPgError(pg("23514", "photo does not belong to the share link's baby"))).toMatchObject(
      {
        status: 409,
      },
    );
  });

  it("never carries the original message or SQL", () => {
    const e = mapPgError(
      pg("23514", "share_rules tags hold at most 20 entries per list", {
        detail: "Failing row contains (secret-tag)",
      } as never),
    );
    expect(JSON.stringify(e)).not.toContain("secret-tag");
    expect(e).toBeInstanceOf(ApiError);
  });
});
