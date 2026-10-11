import { afterEach, describe, expect, it } from "vitest";
import { setNativePlatform } from "../testing/native";
import { ApiError } from "./api";
import { approveError, familyStartError, memberError, pendingLimitMessage } from "./familyErrors";

// Copy for the family-model refusals (docs/plans/step-11.md 2.8, 2.9).

afterEach(() => setNativePlatform(null));

const api = (
  status: number,
  code: ApiError["code"],
  message = "server text",
  details?: unknown,
  retry: number | null = null,
) => new ApiError(status, code, message, details, retry);

describe("familyStartError", () => {
  it("disposable address: says temporary addresses can't start a family and offers the guest route", () => {
    const m = familyStartError(api(400, "email_not_allowed"));
    expect(m).toMatch(/disposable email addresses can't start a family/i);
    expect(m).toMatch(/join a family as a guest/i);
  });

  it("inbox_has_family: names the masked address from details, never anything else", () => {
    const m = familyStartError(
      api(409, "inbox_has_family", "x", { existingEmailMasked: "m***@gmail.com" }),
    );
    expect(m).toContain("(m***@gmail.com)");
    expect(m).toMatch(/already has a family/i);
    expect(m).toMatch(/sign in with that account/i);
  });

  it("inbox_has_family without a usable hint drops the parenthesis", () => {
    for (const details of [undefined, {}, { existingEmailMasked: 5 }, null]) {
      const m = familyStartError(api(409, "inbox_has_family", "x", details));
      expect(m).toMatch(/already has a family/i);
      expect(m).not.toMatch(/\(|undefined|\{/);
    }
  });

  it("family_limited: with Retry-After says when, without it says tomorrow", () => {
    expect(familyStartError(api(429, "family_limited", "x", undefined, 3 * 3600))).toMatch(
      /in about 3 hours/,
    );
    expect(familyStartError(api(429, "family_limited", "x", undefined, 60))).toMatch(
      /in about 1 minute/,
    );
    const noHeader = familyStartError(api(429, "family_limited"));
    expect(noHeader).toMatch(/try again tomorrow/i);
    expect(noHeader).toMatch(/guest/i);
  });

  it("anything else passes the server message through; non-API errors get the generic line", () => {
    expect(familyStartError(api(500, "internal", "boom from server"))).toBe("boom from server");
    expect(familyStartError(new Error("secret internals"))).toBe(
      "Something went wrong. Please try again.",
    );
  });
});

describe("memberError (already_parent_elsewhere)", () => {
  const err = api(409, "already_parent_elsewhere", "server text");

  it("invitee copy: use a different account, or join as a guest", () => {
    const m = memberError(err, "invitee");
    expect(m).toMatch(/already a parent in another family/i);
    expect(m).toMatch(/different account/i);
    expect(m).toMatch(/guest/i);
  });

  it("promoter copy: the other person can join as a guest or use a different account", () => {
    const m = memberError(err, "promoter");
    expect(m).toMatch(/already a parent in another family/i);
    expect(m).toMatch(/guest/i);
    expect(m).not.toBe(memberError(err, "invitee"));
  });

  it("other codes keep the server message", () => {
    expect(memberError(api(409, "admins_full", "Two admins already"), "invitee")).toBe(
      "Two admins already",
    );
    expect(memberError(new Error("x"), "promoter")).toBe("Something went wrong. Please try again.");
  });
});

describe("pendingLimitMessage", () => {
  it("is null for anything but pending_limit", () => {
    expect(pendingLimitMessage(api(409, "free_tier_limit"))).toBeNull();
    expect(pendingLimitMessage(new Error("x"))).toBeNull();
    expect(pendingLimitMessage(null)).toBeNull();
  });

  it("uses the counts when the server sent them", () => {
    const m = pendingLimitMessage(api(409, "pending_limit", "x", { pending: 200, limit: 200 }));
    expect(m).toContain("200 photos waiting for approval");
    expect(m).toContain("the most is 200");
  });

  it("falls back to the count-free copy for missing or malformed details", () => {
    for (const details of [
      undefined,
      {},
      { pending: -1, limit: 0 },
      { pending: "a", limit: "b" },
    ]) {
      const m = pendingLimitMessage(api(409, "pending_limit", "x", details));
      expect(m).toMatch(/waiting for approval/);
      expect(m).not.toMatch(/\{|undefined|NaN/);
    }
  });
});

describe("approveError (409 free_tier_limit on approve)", () => {
  const full = api(409, "free_tier_limit", "server text");

  it("web: family's free albums are full; make room or upgrade", () => {
    const m = approveError(full, false);
    expect(m).toMatch(/family's free albums are full/i);
    expect(m).toMatch(/1,000 photos/);
    expect(m).toMatch(/upgrade to Plus/i);
  });

  it("native: no purchase prompt", () => {
    const m = approveError(full, true);
    expect(m).toMatch(/family's free albums are full/i);
    expect(m).not.toMatch(/upgrade|plus/i);
  });

  it("other errors keep the server message", () => {
    expect(approveError(api(403, "forbidden", "Admins only"), false)).toBe("Admins only");
  });
});
