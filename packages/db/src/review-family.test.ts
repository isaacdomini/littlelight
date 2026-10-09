import { describe, expect, it } from "vitest";
import {
  CONFIRM_PRODUCTION_FLAG,
  parseReviewFamilyArgs,
  provisionReviewFamily,
  REVIEW_BABY_NAME,
  REVIEW_PHOTO_COUNT,
  REVIEW_PHOTOS,
  ReviewUsageError,
  reviewBabyId,
  reviewId,
  reviewOriginalKey,
  reviewPhotoId,
} from "./review-family";
import * as reviewIds from "./review-ids";

const USER = "11111111-2222-4333-8444-555555555555";
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("review ids", () => {
  it("are deterministic RFC 9562 version-8 uuids", () => {
    expect(reviewId(USER, "baby")).toMatch(UUID_V8);
    expect(reviewId(USER, "baby")).toBe(reviewId(USER, "baby"));
    expect(reviewBabyId(USER)).toBe(reviewId(USER, "baby"));
    expect(reviewPhotoId(USER, 3)).toBe(reviewId(USER, "photo:3"));
  });

  it("differ per user and per label, and ignore the user id's case", () => {
    expect(reviewId(USER, "baby")).not.toBe(reviewId(USER.replace("1111", "9999"), "baby"));
    expect(reviewId(USER, "baby")).not.toBe(reviewId(USER, "photo:1"));
    expect(reviewId(USER.toUpperCase(), "baby")).toBe(reviewId(USER, "baby"));
  });

  it("24 photo ids are distinct", () => {
    const ids = new Set(Array.from({ length: 24 }, (_, i) => reviewPhotoId(USER, i + 1)));
    expect(ids.size).toBe(24);
    expect(ids.has(reviewBabyId(USER))).toBe(false);
  });

  it("the dependency-free subpath module exports the same functions", () => {
    expect(reviewIds.reviewBabyId(USER)).toBe(reviewBabyId(USER));
    expect(reviewIds.reviewPhotoId(USER, 7)).toBe(reviewPhotoId(USER, 7));
    expect(reviewIds.reviewId(USER, "x")).toBe(reviewId(USER, "x"));
  });
});

describe("reviewOriginalKey", () => {
  it("is babies/<baby>/originals/<photo>.jpg so purge removes it with the photo and the baby", () => {
    const baby = reviewBabyId(USER);
    const photo = reviewPhotoId(USER, 1);
    const key = reviewOriginalKey(baby, photo);
    expect(key).toBe(`babies/${baby}/originals/${photo}.jpg`);
    expect(key.startsWith(`babies/${baby}/`)).toBe(true);
    expect(key.startsWith(`babies/${baby}/originals/${photo}`)).toBe(true);
    expect(key).not.toMatch(/^review\//);
  });
});

describe("REVIEW_PHOTOS", () => {
  it("is 24 numbered photos spread over fewer than 10 months, in order", () => {
    expect(REVIEW_PHOTOS).toHaveLength(REVIEW_PHOTO_COUNT);
    expect(REVIEW_PHOTOS.map((p) => p.nn)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    const days = REVIEW_PHOTOS.map((p) => p.day);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
    expect(Math.max(...days)).toBeLessThan(300);
    expect(REVIEW_BABY_NAME).toBe("Sunny");
  });

  it("notes are short plain English with no contact details", () => {
    for (const p of REVIEW_PHOTOS) {
      if (!p.note) continue;
      expect(p.note.length).toBeLessThanOrEqual(120);
      expect(p.note).not.toMatch(/@|https?:|\d{3}[- ]\d{3}/);
    }
  });
});

describe("parseReviewFamilyArgs", () => {
  it("parses the email (normalised) and the production flag", () => {
    expect(parseReviewFamilyArgs(["--email", "Review@Example.com"])).toEqual({
      email: "review@example.com",
      confirmProduction: false,
    });
    expect(parseReviewFamilyArgs(["--email", "r@example.com", CONFIRM_PRODUCTION_FLAG])).toEqual({
      email: "r@example.com",
      confirmProduction: true,
    });
    expect(parseReviewFamilyArgs([CONFIRM_PRODUCTION_FLAG, "--email", "r@example.com"]).email).toBe(
      "r@example.com",
    );
  });

  it("tolerates the leading -- pnpm passes", () => {
    expect(parseReviewFamilyArgs(["--", "--email", "r@example.com"]).email).toBe("r@example.com");
  });

  it.each([
    [[]],
    [["--email"]],
    [["--email", "--confirm-production"]],
    [["--email", "not-an-email"]],
    [["--email", "a b@example.com"]],
    [["--email", "r@example.com", "--force"]],
    [["r@example.com"]],
  ])("throws a usage error for %j", (argv) => {
    expect(() => parseReviewFamilyArgs(argv)).toThrow(ReviewUsageError);
  });

  it("never echoes the offending value in the message", () => {
    try {
      parseReviewFamilyArgs(["--email", "secret address@example.com"]);
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
    }
  });
});

describe("provisionReviewFamily guards (no database needed)", () => {
  it("refuses NODE_ENV=production without --confirm-production before connecting", async () => {
    await expect(
      provisionReviewFamily(
        { email: "r@example.com", confirmProduction: false },
        {
          env: { NODE_ENV: "production" },
          databaseUrl: "postgres://nobody:nothing@127.0.0.1:1/none",
          log: () => undefined,
        },
      ),
    ).rejects.toThrow(/refusing to provision a review family with NODE_ENV=production/);
  });
});
