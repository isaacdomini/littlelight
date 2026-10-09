import { describe, expect, it } from "vitest";
import { ConfigError } from "../config";
import { hashPasscode } from "../sharing/crypto";
import { testConfig } from "../testing/support";
import { isReviewEmail, loadReviewAccount, verifyReviewCode } from "./review";

// Store-review sign-in building blocks (docs/plans/step-9.md 2.5, D4). Config is the only source:
// the ambient environment never switches the account on.

const EMAIL = "review@example.com";

describe("loadReviewAccount (config only)", () => {
  it("is off when neither value is configured", () => {
    expect(loadReviewAccount(testConfig())).toBeNull();
  });

  it("is on with both, returning the normalised email and the hash", async () => {
    const hash = await hashPasscode("123456");
    const acc = loadReviewAccount(
      testConfig({ REVIEW_ACCOUNT_EMAIL: EMAIL, REVIEW_ACCOUNT_CODE_HASH: hash }),
    );
    expect(acc).toEqual({ email: EMAIL, codeHash: hash });
  });

  it("fails closed with a ConfigError when only one of the pair is set, naming the field", async () => {
    const hash = await hashPasscode("123456");
    expect(() => loadReviewAccount(testConfig({ REVIEW_ACCOUNT_EMAIL: EMAIL }))).toThrow(
      ConfigError,
    );
    expect(() => loadReviewAccount(testConfig({ REVIEW_ACCOUNT_EMAIL: EMAIL }))).toThrow(
      "REVIEW_ACCOUNT_CODE_HASH",
    );
    try {
      loadReviewAccount(testConfig({ REVIEW_ACCOUNT_CODE_HASH: hash }));
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).fields.join(" ")).toContain("REVIEW_ACCOUNT_EMAIL");
      expect((e as Error).message).not.toContain(hash);
    }
  });

  it("fails closed on a malformed hash and never echoes it", () => {
    const bad = "plaintext-code-123456";
    try {
      loadReviewAccount(testConfig({ REVIEW_ACCOUNT_EMAIL: EMAIL, REVIEW_ACCOUNT_CODE_HASH: bad }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).not.toContain(bad);
    }
  });

  it("ignores process.env entirely (a developer shell cannot enable it)", async () => {
    const hash = await hashPasscode("123456");
    const saved = {
      e: process.env.REVIEW_ACCOUNT_EMAIL,
      h: process.env.REVIEW_ACCOUNT_CODE_HASH,
    };
    process.env.REVIEW_ACCOUNT_EMAIL = EMAIL;
    process.env.REVIEW_ACCOUNT_CODE_HASH = hash;
    try {
      expect(loadReviewAccount(testConfig())).toBeNull();
    } finally {
      if (saved.e === undefined) delete process.env.REVIEW_ACCOUNT_EMAIL;
      else process.env.REVIEW_ACCOUNT_EMAIL = saved.e;
      if (saved.h === undefined) delete process.env.REVIEW_ACCOUNT_CODE_HASH;
      else process.env.REVIEW_ACCOUNT_CODE_HASH = saved.h;
    }
  });

  it("does not read process.env even when config is half-set (config alone decides)", () => {
    const saved = process.env.REVIEW_ACCOUNT_CODE_HASH;
    process.env.REVIEW_ACCOUNT_CODE_HASH = "scrypt$1$16384$8$1$c2FsdA$a2V5";
    try {
      expect(loadReviewAccount(testConfig())).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.REVIEW_ACCOUNT_CODE_HASH;
      else process.env.REVIEW_ACCOUNT_CODE_HASH = saved;
    }
  });
});

describe("isReviewEmail", () => {
  const acc = { email: EMAIL, codeHash: "x" };
  it("matches only the configured address", () => {
    expect(isReviewEmail(acc, EMAIL)).toBe(true);
    expect(isReviewEmail(acc, "other@example.com")).toBe(false);
    expect(isReviewEmail(acc, null)).toBe(false);
    expect(isReviewEmail(null, EMAIL)).toBe(false);
  });
});

describe("verifyReviewCode", () => {
  it("accepts the right code and rejects everything else without throwing", async () => {
    const acc = { email: EMAIL, codeHash: await hashPasscode("482915") };
    expect(await verifyReviewCode(acc, "482915")).toBe(true);
    for (const wrong of [
      "482916",
      "000000",
      "",
      "48291",
      "4829155",
      "abcdef",
      " 482915",
      "482915\n",
    ]) {
      expect(await verifyReviewCode(acc, wrong), JSON.stringify(wrong)).toBe(false);
    }
  });
});
