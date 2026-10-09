import { describe, expect, it } from "vitest";
import { backfillHint, PRODUCTION_FLAG, parseSetPlanArgs, setPlan, UsageError } from "./set-plan";

const BABY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("parseSetPlanArgs", () => {
  it("parses baby and plan", () => {
    expect(parseSetPlanArgs([BABY, "plus"])).toEqual({
      babyId: BABY,
      plan: "plus",
      ownerUserId: null,
      expiresAt: null,
      allowProduction: false,
    });
    expect(parseSetPlanArgs([BABY.toUpperCase(), "free"]).babyId).toBe(BABY);
  });

  it("ignores one leading -- (pnpm forwarding)", () => {
    expect(parseSetPlanArgs(["--", BABY, "plus"]).plan).toBe("plus");
  });

  it("accepts --owner, --expires and the production flag in any order", () => {
    const a = parseSetPlanArgs([
      BABY,
      "plus",
      "--owner",
      USER,
      "--expires",
      "2027-01-01T00:00:00Z",
      PRODUCTION_FLAG,
    ]);
    expect(a.ownerUserId).toBe(USER);
    expect(a.expiresAt?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(a.allowProduction).toBe(true);
    expect(parseSetPlanArgs(["--owner", USER, BABY, "plus"]).ownerUserId).toBe(USER);
  });

  it.each([
    ["no args", []],
    ["only a baby", [BABY]],
    ["a non-uuid baby", ["baby-1", "plus"]],
    ["an unknown plan", [BABY, "gold"]],
    ["an extra argument", [BABY, "plus", "extra"]],
    ["an unknown option", [BABY, "plus", "--force"]],
    ["--owner without a value", [BABY, "plus", "--owner"]],
    ["--owner followed by an option", [BABY, "plus", "--owner", "--expires"]],
    ["a non-uuid owner", [BABY, "plus", "--owner", "mom"]],
    ["a bad --expires", [BABY, "plus", "--expires", "tomorrow-ish"]],
    ["--owner on free", [BABY, "free", "--owner", USER]],
    ["--expires on free", [BABY, "free", "--expires", "2027-01-01"]],
  ])("rejects %s with a UsageError", (_n, argv) => {
    expect(() => parseSetPlanArgs(argv as string[])).toThrow(UsageError);
  });

  it("usage errors do not echo odd values back", () => {
    try {
      parseSetPlanArgs([BABY, "plus", "--owner", "SECRET-VALUE"]);
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRET-VALUE");
    }
  });
});

describe("setPlan guards (no database needed)", () => {
  it("refuses with NODE_ENV=production unless the flag is passed, before touching the database", async () => {
    await expect(
      setPlan(
        { babyId: BABY, plan: "plus", ownerUserId: null, expiresAt: null, allowProduction: false },
        {
          env: { NODE_ENV: "production" },
          databaseUrl: "postgres://nobody:nope@127.0.0.1:1/none",
          log: () => undefined,
        },
      ),
    ).rejects.toThrow(/refusing to change a plan with NODE_ENV=production/);
  });

  it("with the flag it proceeds to connect (and fails on the dead URL without leaking the password)", async () => {
    const err = await setPlan(
      { babyId: BABY, plan: "plus", ownerUserId: null, expiresAt: null, allowProduction: true },
      {
        env: { NODE_ENV: "production" },
        databaseUrl: "postgres://nobody:hunter2pass@127.0.0.1:1/none",
        log: () => undefined,
      },
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/refusing/);
    expect((err as Error).message).not.toContain("hunter2pass");
  });

  it("backfillHint names the upgrade job for that baby", () => {
    expect(backfillHint(BABY)).toContain(`"babyId":"${BABY}"`);
    expect(backfillHint(BABY)).toContain('"reason":"upgrade"');
  });
});
