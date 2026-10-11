import { NEVER_BLOCKED_EMAIL_DOMAINS } from "@tinyglow/shared";
import { describe, expect, it } from "vitest";
import type { ApiError } from "../lib/errors";
import { createDomainBlocklist, type DomainBlocklist } from "./disposable";
import {
  callerFamilyId,
  FAMILY_START_LOCK_CLASS,
  familyHolderEmailHint,
  familyStartGuards,
  isSuspendedEmail,
  recordFamilyStart,
  releaseFamilyStart,
} from "./family-guards";
import { hashFamilyIp } from "./ip-hash";

// Family-start safeguards with a fake app and a scripted pool (docs/plans/step-11.md 2.4, task
// 11.8b): no database. The real SQL is covered by the integration tests; here the control flow,
// the parameters sent and what is (not) logged.

const SECRET = "dev-only-jwt-secret-at-least-32-characters";
const IP = "203.0.113.77";
const EMAIL = "Some.Parent+twins@gmail.com";

type Row = Record<string, unknown>;
type Handler = (sql: string, params: unknown[]) => Row[];

function fakeApp(
  handler: Handler = (sql) => (/INSERT INTO public\.family_starts/.test(sql) ? [{ id: "42" }] : []),
) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const logs: { level: string; args: unknown[] }[] = [];
  let connects = 0;
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (sql === "COMMIT") return { rows: [], command: "COMMIT" };
      if (/^(BEGIN|ROLLBACK|RESET ROLE|DISCARD ALL|SET LOCAL ROLE)/.test(sql)) return { rows: [] };
      return { rows: handler(sql, params) };
    },
    on() {
      return this;
    },
    off() {
      return this;
    },
    release() {},
  };
  const log = new Proxy(
    {},
    {
      get:
        (_t, level: string) =>
        (...args: unknown[]) => {
          logs.push({ level, args });
        },
    },
  );
  const app = {
    db: {
      connect: async () => {
        connects++;
        return client;
      },
    },
    log,
    config: { JWT_SECRET: SECRET, DATA_ENCRYPTION_KEY: "x".repeat(40) },
  } as never;
  return {
    app,
    logs,
    get connects() {
      return connects;
    },
    /** Only the application statements (no BEGIN/role plumbing). */
    app_queries: () =>
      queries.filter(
        (q) => !/^(BEGIN|COMMIT|ROLLBACK|RESET ROLE|DISCARD ALL|SET LOCAL ROLE)/.test(q.sql),
      ),
  };
}

const list = (
  o: { deny?: string[]; allow?: string[]; on?: boolean; vendored?: string[] } = {},
): DomainBlocklist =>
  createDomainBlocklist(
    {
      BLOCK_DISPOSABLE_EMAIL: o.on ?? true,
      EMAIL_DOMAIN_DENYLIST: o.deny ?? [],
      EMAIL_DOMAIN_ALLOWLIST: o.allow ?? [],
    },
    o.vendored ?? ["trash-mail.example", "mailinator.com"],
  );

const input = (over: Partial<Parameters<typeof familyStartGuards>[3]> = {}) => ({
  email: "mom@gmail.com" as string | null,
  ip: IP,
  country: "DE",
  client: "web" as const,
  userId: "22222222-2222-4222-8222-222222222222",
  ...over,
});

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected a rejection");
}

describe("familyStartGuards: disposable domains", () => {
  it("a vendored disposable domain is 400 email_not_allowed before any database call", async () => {
    const f = fakeApp();
    const err = await rejection(
      familyStartGuards(f.app, list(), 5, input({ email: "x@mailinator.com" })),
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe("email_not_allowed");
    expect(f.connects).toBe(0);
    expect(f.logs).toEqual([]);
  });

  it("a subdomain of a listed domain is refused too", async () => {
    const f = fakeApp();
    const err = await rejection(
      familyStartGuards(f.app, list(), 5, input({ email: "x@mx.trash-mail.example" })),
    );
    expect(err.code).toBe("email_not_allowed");
    expect(f.connects).toBe(0);
  });

  it("EMAIL_DOMAIN_DENYLIST adds domains; BLOCK_DISPOSABLE_EMAIL=false keeps only those", async () => {
    const f = fakeApp();
    const bl = list({ on: false, deny: ["spam.example"] });
    expect(
      (await rejection(familyStartGuards(f.app, bl, 5, input({ email: "a@spam.example" })))).code,
    ).toBe("email_not_allowed");
    await expect(
      familyStartGuards(f.app, bl, 5, input({ email: "a@mailinator.com" })),
    ).resolves.toBeDefined();
  });

  it("EMAIL_DOMAIN_ALLOWLIST beats the vendored list", async () => {
    const f = fakeApp();
    await expect(
      familyStartGuards(
        f.app,
        list({ allow: ["mailinator.com"] }),
        5,
        input({ email: "a@mailinator.com" }),
      ),
    ).resolves.toBeDefined();
    expect(f.connects).toBe(1);
  });

  it("NEVER_BLOCKED domains pass even when deny-listed", async () => {
    for (const domain of NEVER_BLOCKED_EMAIL_DOMAINS) {
      const f = fakeApp();
      const bl = list({ deny: [domain], vendored: [domain] });
      await expect(
        familyStartGuards(f.app, bl, 5, input({ email: `x@${domain}` })),
        domain,
      ).resolves.toBeDefined();
    }
  });

  it("a null email skips the domain check (nothing to check) and has no flags", async () => {
    const f = fakeApp();
    const bl: DomainBlocklist = {
      isBlocked: () => {
        throw new Error("must not be called");
      },
      isBlockedEmail: () => {
        throw new Error("must not be called");
      },
    };
    const v = await familyStartGuards(f.app, bl, 5, input({ email: null }));
    expect(v.flags).toEqual({ plusTag: false, dotsFolded: false });
  });
});

describe("familyStartGuards: flags, the lock, the cap and the reservation", () => {
  /** Handler: the cap query answers `cap`, the reservation INSERT answers id 42. */
  const reserving =
    (cap: Row[] = []): Handler =>
    (sql) =>
      /INSERT INTO public\.family_starts/.test(sql)
        ? [{ id: "42" }]
        : /OFFSET/.test(sql)
          ? cap
          : [];

  it("flags come from emailShape: +tag and Gmail dots", async () => {
    for (const [email, flags] of [
      [EMAIL, { plusTag: true, dotsFolded: true }],
      ["mom@outlook.com", { plusTag: false, dotsFolded: false }],
      ["m.om@outlook.com", { plusTag: false, dotsFolded: false }],
    ] as const) {
      const f = fakeApp(reserving());
      expect((await familyStartGuards(f.app, list(), 5, input({ email }))).flags).toEqual(flags);
    }
  });

  it("query order: advisory lock 1015 on the hash, then the cap query, then the reservation INSERT", async () => {
    const f = fakeApp(reserving());
    const v = await familyStartGuards(f.app, list(), 5, input());
    const q = f.app_queries();
    expect(q).toHaveLength(3);
    expect(FAMILY_START_LOCK_CLASS).toBe(1015);
    expect(q[0]?.sql).toMatch(/pg_advisory_xact_lock/);
    expect(q[0]?.params).toEqual([1015, v.ipHash]);
    expect(q[1]?.sql).toMatch(/OFFSET \$2 LIMIT 1/);
    expect(q[1]?.sql).toMatch(/created_at > now\(\) - interval '24 hours'/);
    expect(q[2]?.sql).toMatch(/INSERT INTO public\.family_starts/);
    expect(q[2]?.sql).toMatch(/VALUES \(NULL,/); // family_id NULL: a reservation
    expect(q[2]?.sql).toMatch(/RETURNING id/);
    expect(v.reservationId).toBe("42");
  });

  it("the reservation carries user, hash, country, client and flags; no email, no raw IP", async () => {
    const f = fakeApp(reserving());
    const v = await familyStartGuards(
      f.app,
      list(),
      5,
      input({ email: EMAIL, country: "DE", client: "native" }),
    );
    const ins = f.app_queries()[2];
    expect(ins?.params).toEqual([
      "22222222-2222-4222-8222-222222222222",
      v.ipHash,
      "DE",
      "native",
      true,
      true,
    ]);
    expect(ins?.sql).not.toMatch(/email|user_agent|ip_address/i);
    expect(JSON.stringify(f.app_queries())).not.toContain(IP);
    expect(JSON.stringify(f.logs)).not.toContain(IP);
  });

  it("a malformed country is stored NULL on the reservation", async () => {
    for (const [country, stored] of [
      ["usa", null],
      ["us", null],
      ["", null],
      [null, null],
      ["1", null],
      ["D", null],
      ["DE", "DE"],
      ["T1", "T1"],
    ] as const) {
      const f = fakeApp(reserving());
      await familyStartGuards(f.app, list(), 5, input({ country }));
      expect(f.app_queries()[2]?.params[2], String(country)).toBe(stored);
    }
  });

  it("the verdict carries the 32-byte HMAC of the IP, never the IP", async () => {
    const f = fakeApp(reserving());
    const v = await familyStartGuards(f.app, list(), 5, input());
    expect(v.ipHash).toHaveLength(32);
    expect(v.ipHash.equals(hashFamilyIp({ JWT_SECRET: SECRET }, IP))).toBe(true);
    expect(v.ipHash.equals(hashFamilyIp({ JWT_SECRET: SECRET }, "203.0.113.78"))).toBe(false);
  });

  it("the cap query asks for the limit-th newest row: OFFSET is limit - 1 (never negative)", async () => {
    for (const [limit, offset] of [
      [5, 4],
      [1, 0],
      [2, 1],
      [0, 0],
      [1000, 999],
    ] as const) {
      const f = fakeApp(reserving());
      await familyStartGuards(f.app, list(), limit, input());
      expect(f.app_queries()[1]?.params[1], `limit ${limit}`).toBe(offset);
    }
  });

  it("a capped network is 429 family_limited, rolls back, and inserts NOTHING", async () => {
    const f = fakeApp(reserving([{ retry_after: 3600 }]));
    const err = await rejection(familyStartGuards(f.app, list(), 5, input()));
    expect(err.status).toBe(429);
    expect(err.code).toBe("family_limited");
    expect(err.retryAfterSec).toBe(3600);
    expect(f.app_queries().some((q) => /INSERT/.test(q.sql))).toBe(false);
    expect(f.app_queries()).toHaveLength(2); // lock + cap query only
    expect(f.app_queries()[1]?.sql).toMatch(/GREATEST\(1,/);
  });

  it("a disposable refusal never reaches the database at all (no lock, no insert)", async () => {
    const f = fakeApp(reserving());
    await rejection(familyStartGuards(f.app, list(), 5, input({ email: "x@mailinator.com" })));
    expect(f.connects).toBe(0);
    expect(f.app_queries()).toEqual([]);
  });

  it("Retry-After is at least one second and at most 24 hours", async () => {
    expect(
      (
        await rejection(
          familyStartGuards(fakeApp(reserving([{ retry_after: 0 }])).app, list(), 5, input()),
        )
      ).retryAfterSec,
    ).toBe(1);
    expect(
      (
        await rejection(
          familyStartGuards(fakeApp(reserving([{ retry_after: 999_999 }])).app, list(), 5, input()),
        )
      ).retryAfterSec,
    ).toBe(86_400);
  });

  it("a missing RETURNING row is an error, not a silent success", async () => {
    const f = fakeApp(() => []);
    await expect(familyStartGuards(f.app, list(), 5, input())).rejects.toThrow(/reservation/);
  });

  it("runs as service_role under a named reason and logs no email, IP or hash", async () => {
    const f = fakeApp(reserving());
    await familyStartGuards(f.app, list(), 5, input({ email: EMAIL }));
    const dump = JSON.stringify(f.logs);
    expect(dump).toContain("family-start guards");
    expect(dump).not.toContain(IP);
    expect(dump.toLowerCase()).not.toContain("gmail");
  });
});

describe("recordFamilyStart and releaseFamilyStart", () => {
  it("record fills the reservation (only while family_id is NULL), then prunes", async () => {
    const f = fakeApp();
    await recordFamilyStart(f.app, {
      reservationId: "42",
      familyId: "11111111-1111-4111-8111-111111111111",
    });
    const q = f.app_queries();
    expect(q).toHaveLength(2);
    expect(q[0]?.sql).toMatch(/UPDATE public\.family_starts SET family_id = \$2/);
    expect(q[0]?.sql).toMatch(/family_id IS NULL/);
    expect(q[0]?.params).toEqual(["42", "11111111-1111-4111-8111-111111111111"]);
    expect(q[1]?.sql).toMatch(/family_starts_prune\(\)/);
    expect(JSON.stringify(f.logs)).toContain("family-start ledger");
  });

  it("release deletes only a reservation (family_id IS NULL), by id", async () => {
    const f = fakeApp();
    await releaseFamilyStart(f.app, "42");
    const q = f.app_queries();
    expect(q).toHaveLength(1);
    expect(q[0]?.sql).toMatch(/DELETE FROM public\.family_starts/);
    expect(q[0]?.sql).toMatch(/family_id IS NULL/);
    expect(q[0]?.params).toEqual(["42"]);
  });
});

describe("familyHolderEmailHint", () => {
  it("masks the holder's address", async () => {
    const f = fakeApp(() => [{ address: "mom.holder@gmail.com" }]);
    const hint = await familyHolderEmailHint(f.app, "mom.holder+x@gmail.com");
    expect(hint).toBe("m***@gmail.com");
    expect(f.app_queries()[0]?.sql).toMatch(
      /family_holder_email_for_canonical\(public\.email_canonical\(\$1\)\)/,
    );
    expect(JSON.stringify(f.logs)).not.toContain("holder");
  });

  it("is null when nobody holds a family (or the row has no address)", async () => {
    expect(await familyHolderEmailHint(fakeApp(() => []).app, "a@b.example")).toBeNull();
    expect(
      await familyHolderEmailHint(fakeApp(() => [{ address: null }]).app, "a@b.example"),
    ).toBeNull();
  });

  it("a one-character local part is masked to *", async () => {
    const f = fakeApp(() => [{ address: "m@gmail.com" }]);
    expect(await familyHolderEmailHint(f.app, "m@gmail.com")).toBe("*@gmail.com");
  });
});

describe("callerFamilyId and isSuspendedEmail", () => {
  it("callerFamilyId reads my_family_id() on the caller's transaction", async () => {
    const calls: string[] = [];
    const tx = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [{ family_id: "fam-1" }] };
      },
    };
    expect(await callerFamilyId(tx as never)).toBe("fam-1");
    expect(calls[0]).toMatch(/public\.my_family_id\(\)/);
    const none = { query: async () => ({ rows: [{ family_id: null }] }) };
    expect(await callerFamilyId(none as never)).toBeNull();
    expect(await callerFamilyId({ query: async () => ({ rows: [] }) } as never)).toBeNull();
  });

  it("isSuspendedEmail is true only for 'suspended'", async () => {
    for (const [state, expected] of [
      ["suspended", true],
      ["active", false],
      ["none", false],
    ] as const) {
      const f = fakeApp(() => [{ state }]);
      expect(await isSuspendedEmail(f.app, "a@b.example"), state).toBe(expected);
      expect(f.app_queries()[0]?.sql).toMatch(/account_state_for_email\(\$1\)/);
    }
  });
});
