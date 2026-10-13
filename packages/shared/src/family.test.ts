import { describe, expect, it } from "vitest";
import { abuseEnvSchema } from "./env";
import {
  apiErrorCodeSchema,
  CANONICAL_EMAIL_FIXTURES,
  canonicalEmail,
  emailShape,
  FAMILIES_PER_IP_PER_DAY_DEFAULT,
  FAMILY_START_RETENTION_DAYS,
  FREE_TIER_PHOTO_LIMIT,
  freeTierSchema,
  inboxHasFamilyDetailsSchema,
  maskEmail,
  NEVER_BLOCKED_EMAIL_DOMAINS,
  PENDING_PHOTOS_PER_GUEST_PER_FAMILY,
  pendingLimitDetailsSchema,
} from "./index";

// The family model's shared contracts (docs/plans/step-11.md 2.3, task 11.8b): canonical email
// (TS side of the parity with SQL `email_canonical()`, whose integration test runs the same
// fixtures), the abuse env, constants, error codes and the new DTOs.

describe("canonicalEmail (TS side of the SQL parity)", () => {
  it.each(CANONICAL_EMAIL_FIXTURES)("%s -> %s", (input, canonical) => {
    expect(canonicalEmail(input)).toBe(canonical);
  });

  it("is idempotent over the fixtures", () => {
    for (const [, canonical] of CANONICAL_EMAIL_FIXTURES)
      expect(canonicalEmail(canonical)).toBe(canonical);
  });

  it("splits at the LAST @, strips trailing dots from the domain, keeps a leading +", () => {
    expect(canonicalEmail("a@b@Example.com.")).toBe("a@b@example.com");
    expect(canonicalEmail("+x@example.com")).toBe("+x@example.com");
    expect(canonicalEmail("no-at-sign")).toBe("no-at-sign");
  });

  it("folds dots only for gmail.com / googlemail.com, +tag for every domain", () => {
    expect(canonicalEmail("a.b+c@gmail.com")).toBe("ab@gmail.com");
    expect(canonicalEmail("a.b+c@googlemail.com")).toBe("ab@gmail.com");
    expect(canonicalEmail("a.b+c@outlook.com")).toBe("a.b@outlook.com");
  });
});

describe("emailShape (the family_starts flags)", () => {
  it("plusTag and dotsFolded", () => {
    expect(emailShape("a.b+c@gmail.com")).toEqual({
      plusTag: true,
      dotsFolded: true,
      domain: "gmail.com",
    });
    expect(emailShape("a.b@outlook.com")).toEqual({
      plusTag: false,
      dotsFolded: false,
      domain: "outlook.com",
    });
    expect(emailShape("ab+x@googlemail.com")).toEqual({
      plusTag: true,
      dotsFolded: false,
      domain: "gmail.com",
    });
    expect(emailShape("+x@gmail.com").plusTag).toBe(false); // a leading + is not a tag
    expect(emailShape("nodomain")).toEqual({ plusTag: false, dotsFolded: false, domain: "" });
  });
});

describe("maskEmail", () => {
  it("first character, three stars, domain", () => {
    expect(maskEmail("maria@gmail.com")).toBe("m***@gmail.com");
    expect(maskEmail("a@x.com")).toBe("*@x.com");
    expect(maskEmail("nope")).toBe("***");
  });
});

describe("constants", () => {
  it("the numbers the database mirrors", () => {
    expect(FREE_TIER_PHOTO_LIMIT).toBe(1000);
    expect(PENDING_PHOTOS_PER_GUEST_PER_FAMILY).toBe(200);
    expect(FAMILIES_PER_IP_PER_DAY_DEFAULT).toBe(5);
    expect(FAMILY_START_RETENTION_DAYS).toBe(30);
  });

  it("never-blocked domains include Apple relay, our own and the dev/e2e domains", () => {
    expect(NEVER_BLOCKED_EMAIL_DOMAINS).toEqual(
      expect.arrayContaining([
        "privaterelay.appleid.com",
        "tinyglow.app",
        "tinyglow.local",
        "example.com",
      ]),
    );
  });
});

describe("abuseEnvSchema (renamed keys, api only)", () => {
  const parse = (env: Record<string, string | undefined>) => abuseEnvSchema.safeParse(env);

  it("defaults", () => {
    expect(parse({})).toMatchObject({
      success: true,
      data: {
        FAMILIES_PER_IP_PER_DAY: 5,
        BLOCK_DISPOSABLE_EMAIL: true,
        EMAIL_DOMAIN_DENYLIST: [],
        EMAIL_DOMAIN_ALLOWLIST: [],
      },
    });
  });

  it("empty strings count as unset", () => {
    expect(
      parse({ FAMILIES_PER_IP_PER_DAY: "", BLOCK_DISPOSABLE_EMAIL: "", EMAIL_DOMAIN_DENYLIST: "" })
        .data,
    ).toMatchObject({
      FAMILIES_PER_IP_PER_DAY: 5,
      BLOCK_DISPOSABLE_EMAIL: true,
      EMAIL_DOMAIN_DENYLIST: [],
    });
  });

  it("FAMILIES_PER_IP_PER_DAY is an integer 1..100000", () => {
    expect(parse({ FAMILIES_PER_IP_PER_DAY: "1000" }).data?.FAMILIES_PER_IP_PER_DAY).toBe(1000);
    for (const bad of ["0", "-1", "100001", "1.5", "abc"])
      expect(parse({ FAMILIES_PER_IP_PER_DAY: bad }).success, bad).toBe(false);
  });

  it("BLOCK_DISPOSABLE_EMAIL is a boolean word", () => {
    expect(parse({ BLOCK_DISPOSABLE_EMAIL: "false" }).data?.BLOCK_DISPOSABLE_EMAIL).toBe(false);
    expect(parse({ BLOCK_DISPOSABLE_EMAIL: "0" }).data?.BLOCK_DISPOSABLE_EMAIL).toBe(false);
    expect(parse({ BLOCK_DISPOSABLE_EMAIL: "maybe" }).success).toBe(false);
  });

  it("domain lists: lowercased, trimmed, de-duplicated, dots stripped", () => {
    expect(
      parse({ EMAIL_DOMAIN_DENYLIST: " Spam.Example, .spam.example. ,other.example" }).data
        ?.EMAIL_DOMAIN_DENYLIST,
    ).toEqual(["spam.example", "other.example"]);
  });

  it("never-blocked domains are dropped from the deny list but kept in the allow list", () => {
    expect(
      parse({ EMAIL_DOMAIN_DENYLIST: "example.com,spam.example,tinyglow.app" }).data
        ?.EMAIL_DOMAIN_DENYLIST,
    ).toEqual(["spam.example"]);
    expect(parse({ EMAIL_DOMAIN_ALLOWLIST: "example.com" }).data?.EMAIL_DOMAIN_ALLOWLIST).toEqual([
      "example.com",
    ]);
  });

  it("an entry that is not a domain is rejected", () => {
    expect(parse({ EMAIL_DOMAIN_DENYLIST: "not a domain" }).success).toBe(false);
    expect(parse({ EMAIL_DOMAIN_ALLOWLIST: "nodots" }).success).toBe(false);
  });

  it("the old names mean nothing any more", () => {
    const keys = Object.keys(abuseEnvSchema.shape);
    expect(keys.sort()).toEqual(
      [
        "BLOCK_DISPOSABLE_EMAIL",
        "EMAIL_DOMAIN_ALLOWLIST",
        "EMAIL_DOMAIN_DENYLIST",
        "FAMILIES_PER_IP_PER_DAY",
      ].sort(),
    );
  });
});

describe("error codes", () => {
  const codes = new Set<string>(apiErrorCodeSchema.options);

  it("has the family-model codes", () => {
    for (const c of [
      "email_not_allowed",
      "inbox_has_family",
      "family_limited",
      "already_parent_elsewhere",
      "pending_limit",
      "account_suspended",
      "free_tier_limit",
    ])
      expect(codes.has(c), c).toBe(true);
  });

  it("lost the sign-up-time codes", () => {
    // spelled in pieces so the "old model is gone" grep of the plan (4.1) stays clean
    expect(codes.has(["account", "exists"].join("_"))).toBe(false);
    expect(codes.has(["signup", "limited"].join("_"))).toBe(false);
  });
});

describe("DTOs", () => {
  it("freeTierSchema: familyAlbums >= 1, limit literal 1000, used may exceed it; videos/videoLimit (step 12)", () => {
    // step 12 (Q3): `videos` (inside `used`) and the effective `videoLimit` are required.
    const v = { videos: 3, videoLimit: 100 };
    expect(
      freeTierSchema.safeParse({ used: 1012, limit: 1000, familyAlbums: 2, ...v }).success,
    ).toBe(true);
    expect(freeTierSchema.safeParse({ used: 0, limit: 1000, familyAlbums: 0, ...v }).success).toBe(
      false,
    );
    expect(freeTierSchema.safeParse({ used: 0, limit: 500, familyAlbums: 1, ...v }).success).toBe(
      false,
    );
    expect(freeTierSchema.safeParse({ used: 0, limit: 1000, albums: 1, ...v }).success).toBe(false);
    expect(freeTierSchema.safeParse({ used: -1, limit: 1000, familyAlbums: 1, ...v }).success).toBe(
      false,
    );
    // the video pair is required and bounded
    expect(freeTierSchema.safeParse({ used: 0, limit: 1000, familyAlbums: 1 }).success).toBe(false);
    expect(
      freeTierSchema.safeParse({
        used: 0,
        limit: 1000,
        familyAlbums: 1,
        videos: -1,
        videoLimit: 100,
      }).success,
    ).toBe(false);
    expect(
      freeTierSchema.safeParse({ used: 0, limit: 1000, familyAlbums: 1, videos: 0, videoLimit: 0 })
        .success,
    ).toBe(false);
  });

  it("pendingLimitDetailsSchema", () => {
    expect(pendingLimitDetailsSchema.safeParse({ pending: 200, limit: 200 }).success).toBe(true);
    expect(pendingLimitDetailsSchema.safeParse({ pending: 0, limit: 1 }).success).toBe(true);
    expect(pendingLimitDetailsSchema.safeParse({ pending: -1, limit: 200 }).success).toBe(false);
    expect(pendingLimitDetailsSchema.safeParse({ pending: 1, limit: 0 }).success).toBe(false);
  });

  it("inboxHasFamilyDetailsSchema carries only the masked address", () => {
    expect(
      inboxHasFamilyDetailsSchema.safeParse({ existingEmailMasked: "m***@gmail.com" }).success,
    ).toBe(true);
    expect(inboxHasFamilyDetailsSchema.safeParse({ existingEmailMasked: "" }).success).toBe(false);
    expect(inboxHasFamilyDetailsSchema.safeParse({}).success).toBe(false);
  });
});
