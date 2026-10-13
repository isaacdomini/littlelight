import { readFileSync } from "node:fs";
import { derivativeKey } from "@tinyglow/shared";
import { describe, expect, it, vi } from "vitest";
import type { UrlSigner } from "../storage/sign";
import {
  decodeCursor,
  encodeCursor,
  type PhotoSummaryRow,
  signDerivative,
  toPhotoSummary,
  visibleToCaller,
} from "./queries";

const BABY = "11111111-1111-4111-8111-111111111111";
const PHOTO = "22222222-2222-4222-8222-222222222222";

function recordingSigner() {
  const signGet = vi.fn(async (key: string) => ({
    url: `https://files.test/${key}?sig=x`,
    expiresAt: new Date("2026-06-14T13:00:00Z"),
  }));
  const signer: UrlSigner = { signGet, signUploadPart: vi.fn() as never };
  return { signer, signGet };
}

describe("cursor", () => {
  const c = { sortKey: "2026-06-14T12:00:00.123456Z", id: PHOTO };

  it("round-trips, keeping microsecond precision", () => {
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("is URL-safe (the query schema only allows [A-Za-z0-9_-])", () => {
    expect(encodeCursor(c)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("lower-cases the id", () => {
    expect(decodeCursor(encodeCursor({ ...c, id: PHOTO.toUpperCase() })).id).toBe(PHOTO);
  });

  it.each([
    ["not a cursor", "!!!"],
    ["empty", ""],
    ["no separator", Buffer.from("2026-06-14T12:00:00.123456Z").toString("base64url")],
    ["extra part", Buffer.from(`${c.sortKey}|${PHOTO}|x`).toString("base64url")],
    [
      "millisecond precision only",
      Buffer.from(`2026-06-14T12:00:00.123Z|${PHOTO}`).toString("base64url"),
    ],
    ["bad id", Buffer.from(`${c.sortKey}|not-a-uuid`).toString("base64url")],
    ["bad date", Buffer.from(`2026-13-45T99:00:00.123456Z|${PHOTO}`).toString("base64url")],
    [
      "sql injection",
      Buffer.from(`${c.sortKey}'; DROP TABLE photos;--|${PHOTO}`).toString("base64url"),
    ],
  ])("rejects a malformed cursor: %s", (_n, raw) => {
    expect(() => decodeCursor(raw)).toThrowError(
      expect.objectContaining({
        status: 400,
        code: "validation_failed",
        details: { fields: ["querystring.cursor"] },
      }),
    );
  });
});

describe("signDerivative", () => {
  it("signs only thumb and display, via derivativeKey", async () => {
    const { signer, signGet } = recordingSigner();
    await signDerivative(signer, BABY, PHOTO, "thumb");
    await signDerivative(signer, BABY, PHOTO, "display");
    expect(signGet.mock.calls.map((c) => c[0])).toEqual([
      derivativeKey(BABY, PHOTO, "thumb"),
      derivativeKey(BABY, PHOTO, "display"),
    ]);
  });

  it("refuses analysis (and anything else) without signing", () => {
    const { signer, signGet } = recordingSigner();
    for (const kind of ["analysis", "original", "", "../thumb"]) {
      expect(() => signDerivative(signer, BABY, PHOTO, kind as never)).toThrow(
        /only thumb\/display/,
      );
    }
    expect(signGet).not.toHaveBeenCalled();
  });

  it("an invalid photo or baby id cannot produce a key (no path injection)", () => {
    const { signer } = recordingSigner();
    expect(() => signDerivative(signer, BABY, "../../x", "thumb")).toThrow();
    expect(() => signDerivative(signer, "a/b", PHOTO, "thumb")).toThrow();
  });

  it("storage keys are never read from rows: source files contain no key literals", () => {
    // The only way to a signed derivative URL is derivativeKey(); no module in photos/ or
    // uploads/ may assemble a derivative key by hand or sign a storage_key column except the
    // admin original route.
    for (const f of ["photos/queries.ts", "photos/routes.ts", "uploads/service.ts"]) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8").replace(
        /\/\/.*$/gm,
        "",
      );
      expect(src, f).not.toMatch(/derivatives\//);
      expect(src, f).not.toMatch(/\.jpg/);
      expect(src, f).not.toMatch(/signGet\(\s*(row|r|p|photo)\.storage_key\b(?!_original)/);
    }
    const routes = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
    // signGet is called with a stored key exactly once: the admin-only original route.
    expect([...routes.matchAll(/signGet\(/g)].length).toBe(1);
    expect(routes).toMatch(/signGet\(photo\.storage_key_original/);
  });
});

const row = (over: Partial<PhotoSummaryRow> = {}): PhotoSummaryRow => ({
  id: PHOTO,
  baby_id: BABY,
  // step 12: every summary row names its media kind (photos: no duration, no rendition)
  media_kind: "photo",
  duration_ms: null,
  rendition_status: "none",
  status: "ready",
  approval: "approved",
  taken_at: new Date("2026-06-14T10:00:00Z"),
  taken_at_estimated: false,
  age_days: 10,
  width: 100,
  height: 50,
  mime: "image/jpeg",
  is_sensitive: false,
  duplicate_of_photo_id: null,
  uploaded_by: null,
  created_at: new Date("2026-06-14T11:00:00Z"),
  deleted_at: null,
  has_thumb: true,
  ...over,
});

describe("toPhotoSummary", () => {
  it("signs a thumb only when the derivative exists", async () => {
    const { signer, signGet } = recordingSigner();
    const withThumb = await toPhotoSummary(signer, row());
    expect(withThumb.thumbUrl).toContain(derivativeKey(BABY, PHOTO, "thumb"));
    expect(withThumb.urlExpiresAt).toBe("2026-06-14T13:00:00.000Z");
    signGet.mockClear();
    const none = await toPhotoSummary(signer, row({ has_thumb: false }));
    expect(none).toMatchObject({ thumbUrl: null, urlExpiresAt: null });
    expect(signGet).not.toHaveBeenCalled();
  });

  it("exposes no storage key, hash or GPS fields", async () => {
    const { signer } = recordingSigner();
    const s = await toPhotoSummary(signer, row());
    expect(Object.keys(s).sort()).not.toEqual(expect.arrayContaining(["storage_key_original"]));
    expect(JSON.stringify(s)).not.toMatch(/storage|sha256|gps|originals/i);
  });
});

describe("visibleToCaller", () => {
  const base = {
    role: "contributor" as const,
    deleted_at: null as Date | null,
    status: "ready" as const,
  };
  it("hides nothing from an admin, even trashed or failed photos", () => {
    expect(
      visibleToCaller({ ...base, role: "admin", deleted_at: new Date(), status: "failed" }),
    ).toBe(true);
  });
  it("hides trashed and failed photos from non-admins (looks nonexistent)", () => {
    expect(visibleToCaller({ ...base, deleted_at: new Date() })).toBe(false);
    expect(visibleToCaller({ ...base, status: "failed" })).toBe(false);
    expect(visibleToCaller({ ...base, role: null, deleted_at: new Date() })).toBe(false);
  });
  it("shows a live photo to a non-admin and nothing for null", () => {
    expect(visibleToCaller(base)).toBe(true);
    expect(visibleToCaller(null)).toBe(false);
  });
});
