import { INVITE_TOKEN_LENGTH } from "@tinyglow/shared";
import { describe, expect, it } from "vitest";
import { hashInviteToken, inviteAcceptUrl, newInviteToken, toInvite } from "./invites";
import { removalRequestLive, toMember } from "./members";

describe("invite tokens", () => {
  it("are 43-char base64url, unique, and stored only as sha256", () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(a.token).toHaveLength(INVITE_TOKEN_LENGTH);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toHaveLength(32);
    expect(a.hash.equals(hashInviteToken(a.token))).toBe(true);
    expect(a.hash.equals(b.hash)).toBe(false);
    expect(a.hash.toString("utf8")).not.toContain(a.token);
  });

  it("builds the accept URL from PUBLIC_URL", () => {
    expect(inviteAcceptUrl("https://x.example/", "T")).toBe("https://x.example/invite/T");
    expect(inviteAcceptUrl("http://localhost:8080", "T")).toBe("http://localhost:8080/invite/T");
  });
});

describe("toInvite status", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "a@b.co",
    role: "contributor" as const,
    created_at: new Date("2026-10-01T00:00:00Z"),
    expires_at: new Date("2026-10-08T00:00:00Z"),
    accepted_at: null,
    revoked_at: null,
  };
  const now = new Date("2026-10-05T00:00:00Z");

  it("derives pending / expired / accepted / revoked (revoked wins)", () => {
    expect(toInvite(base, now).status).toBe("pending");
    expect(toInvite(base, new Date("2026-10-08T00:00:00Z")).status).toBe("expired");
    expect(toInvite({ ...base, accepted_at: now }, now).status).toBe("accepted");
    expect(toInvite({ ...base, accepted_at: now, revoked_at: now }, now).status).toBe("revoked");
  });

  it("never includes a token or hash", () => {
    const out = toInvite({ ...base, token_hash: Buffer.from("x") } as never, now);
    expect(Object.keys(out).sort()).toEqual([
      "createdAt",
      "email",
      "expiresAt",
      "id",
      "role",
      "status",
    ]);
  });
});

describe("removal requests", () => {
  const now = new Date("2026-10-08T00:00:00Z");
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it("are live for 7 days", () => {
    expect(removalRequestLive(null, now)).toBe(false);
    expect(removalRequestLive(days(6.9), now)).toBe(true);
    expect(removalRequestLive(days(7), now)).toBe(true);
    expect(removalRequestLive(days(7.01), now)).toBe(false);
  });

  it("toMember hides stale request fields", () => {
    const row = {
      user_id: "11111111-1111-4111-8111-111111111111",
      display_name: "Dad",
      relationship_label: null,
      role: "admin" as const,
      joined_at: days(30),
      removal_requested_by: "22222222-2222-4222-8222-222222222222",
      removal_requested_at: days(1),
    };
    expect(toMember(row, now)).toMatchObject({
      removalRequestedBy: row.removal_requested_by,
      removalRequestedAt: days(1).toISOString(),
    });
    expect(toMember({ ...row, removal_requested_at: days(8) }, now)).toMatchObject({
      removalRequestedBy: null,
      removalRequestedAt: null,
    });
  });
});
