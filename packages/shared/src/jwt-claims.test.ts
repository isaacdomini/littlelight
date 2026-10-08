import { describe, expect, it } from "vitest";
import {
  authenticatedClaimsSchema,
  claimsToSql,
  jwtClaimsSchema,
  viewerClaimsSchema,
} from "./jwt-claims";

const UID = "00000000-0000-4000-8000-000000000001";
const LINK = "00000000-0000-4000-8000-000000000200";
const exp = 4_102_444_800;

const SID = "00000000-0000-4000-8000-0000000000aa";
const authed = {
  sub: UID,
  role: "authenticated",
  email: "a@b.co",
  aud: "authenticated",
  exp,
  session_id: SID,
};
const viewer = { role: "viewer", share_link_id: LINK, exp };

describe("authenticatedClaimsSchema", () => {
  it("accepts GoTrue claims and keeps unknown GoTrue keys", () => {
    const parsed = authenticatedClaimsSchema.parse({ ...authed, amr: [] });
    expect(parsed.sub).toBe(UID);
    expect(parsed).toHaveProperty("session_id", SID);
    expect(parsed).toHaveProperty("amr");
  });

  it("treats an empty-string email as absent", () => {
    expect(authenticatedClaimsSchema.parse({ ...authed, email: "" }).email).toBeUndefined();
  });

  it("rejects role viewer, missing/invalid sub, missing exp", () => {
    expect(authenticatedClaimsSchema.safeParse({ ...authed, role: "viewer" }).success).toBe(false);
    expect(authenticatedClaimsSchema.safeParse({ ...authed, sub: "nope" }).success).toBe(false);
    const { sub: _s, ...noSub } = authed;
    expect(authenticatedClaimsSchema.safeParse(noSub).success).toBe(false);
    const { exp: _e, ...noExp } = authed;
    expect(authenticatedClaimsSchema.safeParse(noExp).success).toBe(false);
  });

  it("requires session_id to be a uuid", () => {
    const { session_id: _s, ...none } = authed;
    expect(authenticatedClaimsSchema.safeParse(none).success).toBe(false);
    expect(authenticatedClaimsSchema.safeParse({ ...authed, session_id: "s" }).success).toBe(false);
  });

  it("rejects service_role and anon tokens", () => {
    for (const role of ["service_role", "anon", "postgres", "pipeline"]) {
      expect(jwtClaimsSchema.safeParse({ ...authed, role }).success).toBe(false);
    }
  });
});

describe("viewerClaimsSchema", () => {
  it("accepts viewer claims", () => {
    expect(viewerClaimsSchema.parse(viewer)).toEqual(viewer);
  });

  it("rejects a missing or malformed share_link_id", () => {
    const { share_link_id: _l, ...none } = viewer;
    expect(viewerClaimsSchema.safeParse(none).success).toBe(false);
    expect(viewerClaimsSchema.safeParse({ ...viewer, share_link_id: "x" }).success).toBe(false);
  });

  it("rejects role authenticated", () => {
    expect(viewerClaimsSchema.safeParse({ ...viewer, role: "authenticated" }).success).toBe(false);
  });

  it("strips sub, email and any other extra key: a viewer token never carries an identity", () => {
    const parsed = viewerClaimsSchema.parse({ ...viewer, sub: UID, email: "a@b.co", extra: 1 });
    expect(parsed).not.toHaveProperty("sub");
    expect(parsed).not.toHaveProperty("email");
    expect(parsed).not.toHaveProperty("extra");
  });
});

describe("jwtClaimsSchema (role union)", () => {
  it("discriminates by role", () => {
    expect(jwtClaimsSchema.parse(authed).role).toBe("authenticated");
    expect(jwtClaimsSchema.parse(viewer).role).toBe("viewer");
  });

  it("rejects a missing or unknown role", () => {
    const { role: _r, ...noRole } = viewer;
    expect(jwtClaimsSchema.safeParse(noRole).success).toBe(false);
    expect(jwtClaimsSchema.safeParse({ ...viewer, role: "admin" }).success).toBe(false);
  });
});

describe("claimsToSql", () => {
  it("returns JSON of the parsed claims", () => {
    expect(JSON.parse(claimsToSql(viewer as never))).toEqual(viewer);
    const out = JSON.parse(claimsToSql(authed as never));
    expect(out).toMatchObject({ sub: UID, role: "authenticated", email: "a@b.co" });
  });

  it("strips sub from viewer claims before they reach SQL", () => {
    const sql = claimsToSql({ ...viewer, sub: UID } as never);
    expect(JSON.parse(sql)).not.toHaveProperty("sub");
    expect(sql).not.toContain(UID);
  });

  it("throws on an invalid claim set instead of emitting it", () => {
    expect(() => claimsToSql({ role: "viewer", exp } as never)).toThrow();
    expect(() => claimsToSql({ ...authed, role: "service_role" } as never)).toThrow();
  });
});
