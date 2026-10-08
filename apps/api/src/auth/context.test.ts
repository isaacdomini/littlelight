import { describe, expect, it, vi } from "vitest";
import { testConfig } from "../testing/support";
import { audit, isFreshSignIn, requireFreshSignIn, withServiceRole } from "./context";

const app = () =>
  ({
    db: { connect: vi.fn(), query: vi.fn(), end: vi.fn() },
    log: { debug: vi.fn() },
    config: testConfig(),
  }) as unknown as Parameters<typeof withServiceRole>[0];

describe("withServiceRole", () => {
  it("throws synchronously without a reason and never opens a connection", () => {
    const a = app();
    for (const reason of ["", "   ", undefined as unknown as string]) {
      expect(() => withServiceRole(a, reason, async () => 1)).toThrow(/reason/);
    }
    expect(a.db.connect).not.toHaveBeenCalled();
  });
});

describe("isFreshSignIn / requireFreshSignIn", () => {
  it("is fresh for 10 minutes and not after", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(isFreshSignIn(new Date(now.getTime() - 9 * 60_000), now)).toBe(true);
    expect(isFreshSignIn(new Date(now.getTime() - 10 * 60_000), now)).toBe(true);
    expect(isFreshSignIn(new Date(now.getTime() - 10 * 60_000 - 1000), now)).toBe(false);
  });

  it("requireFreshSignIn throws 403 fresh_sign_in_required", () => {
    expect(() => requireFreshSignIn({ isFresh: true })).not.toThrow();
    try {
      requireFreshSignIn({ isFresh: false });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ status: 403, code: "fresh_sign_in_required" });
    }
  });
});

describe("audit", () => {
  it("rejects unknown events and metadata keys before touching the database", async () => {
    const client = { query: vi.fn() } as unknown as Parameters<typeof audit>[0];
    await expect(audit(client, "nope" as never, { actorUserId: null })).rejects.toThrow();
    await expect(
      audit(client, "auth.sign_in", {
        actorUserId: null,
        metadata: { email: "a@b.co" } as never,
      }),
    ).rejects.toThrow();
    expect(client.query).not.toHaveBeenCalled();
  });
});
