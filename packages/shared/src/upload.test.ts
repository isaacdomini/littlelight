import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { derivativeKindSchema } from "./db-enums";
import {
  babyPrefix,
  DERIVATIVE_LONG_EDGE,
  derivativeKey,
  exportKey,
  extensionForMime,
  originalKey,
  PHASH_NEAR_DUPLICATE_MAX_DISTANCE,
  partCount,
  photoPrefixes,
  SIGNED_URL_TTL_SEC,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_FILES_PER_REQUEST,
  UPLOAD_MAX_FILES_PER_SESSION,
  UPLOAD_PART_BYTES,
  uploadFileErrorSchema,
  uploadFileStateSchema,
} from "./upload";

const BABY = "11111111-1111-4111-8111-111111111111";
const PHOTO = "22222222-2222-4222-8222-222222222222";
const MIB = 1024 * 1024;

describe("partCount", () => {
  it("ceil(bytes / 16 MiB)", () => {
    expect(UPLOAD_PART_BYTES).toBe(16 * MIB);
    expect(partCount(1)).toBe(1);
    expect(partCount(UPLOAD_PART_BYTES)).toBe(1);
    expect(partCount(UPLOAD_PART_BYTES + 1)).toBe(2);
    expect(partCount(2 * UPLOAD_PART_BYTES)).toBe(2);
    expect(partCount(UPLOAD_MAX_FILE_BYTES)).toBe(7);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])("rejects %s", (n) => {
    expect(() => partCount(n)).toThrow(RangeError);
  });
});

describe("limits", () => {
  it("match the plan and the database", () => {
    expect(UPLOAD_MAX_FILE_BYTES).toBe(104_857_600); // upload_files.declared_bytes CHECK
    expect(UPLOAD_MAX_FILES_PER_SESSION).toBe(500);
    expect(UPLOAD_MAX_FILES_PER_REQUEST).toBe(100);
    expect(SIGNED_URL_TTL_SEC).toBe(3600);
    expect(PHASH_NEAR_DUPLICATE_MAX_DISTANCE).toBe(10);
    expect(DERIVATIVE_LONG_EDGE).toEqual({ thumb: 320, display: 1600, analysis: 768 });
  });
});

describe("object keys", () => {
  it("are built from uuids only", () => {
    expect(babyPrefix(BABY)).toBe(`babies/${BABY}/`);
    expect(originalKey(BABY, PHOTO)).toBe(`babies/${BABY}/originals/${PHOTO}`);
    expect(derivativeKey(BABY, PHOTO, "thumb")).toBe(
      `babies/${BABY}/derivatives/${PHOTO}/thumb.jpg`,
    );
    expect(photoPrefixes(BABY, PHOTO)).toEqual([
      `babies/${BABY}/originals/${PHOTO}`,
      `babies/${BABY}/derivatives/${PHOTO}/`,
    ]);
  });

  it.each([
    "",
    "../x",
    "a/b",
    "11111111-1111-4111-8111-11111111111",
    `${BABY}/..`,
    "%2e%2e",
    `${BABY.toUpperCase()}x`,
  ])("rejects a non-uuid id %j", (bad) => {
    expect(() => babyPrefix(bad)).toThrow(TypeError);
    expect(() => originalKey(BABY, bad)).toThrow(TypeError);
    expect(() => derivativeKey(BABY, bad, "thumb")).toThrow(TypeError);
    expect(() => photoPrefixes(BABY, bad)).toThrow(TypeError);
  });

  it("rejects a derivative kind outside the enum", () => {
    expect(() => derivativeKey(BABY, PHOTO, "../thumb" as never)).toThrow();
    expect(() => derivativeKey(BABY, PHOTO, "original" as never)).toThrow();
  });

  it("one photo's original key is never a prefix of another photo's key (fixed-length ids)", () => {
    const other = "33333333-3333-4333-8333-333333333333";
    expect(originalKey(BABY, other).startsWith(originalKey(BABY, PHOTO))).toBe(false);
    expect(derivativeKey(BABY, other, "thumb").startsWith(photoPrefixes(BABY, PHOTO)[1])).toBe(
      false,
    );
    for (const k of derivativeKindSchema.options) {
      expect(derivativeKey(BABY, PHOTO, k).startsWith(photoPrefixes(BABY, PHOTO)[1])).toBe(true);
    }
  });

  it("extensionForMime", () => {
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/heic")).toBe("heic");
    expect(extensionForMime("image/heif")).toBe("heif");
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/webp")).toBe("webp");
    expect(() => extensionForMime("image/gif" as never)).toThrow();
  });
});

describe("enums match the migration CHECK constraints (value and order)", () => {
  const sql = readFileSync(
    new URL("../../db/migrations/1791700000100_uploads-and-ingest.sql", import.meta.url),
    "utf8",
  ).split("-- Down Migration")[0] as string;

  const checkValues = (column: string): string[] => {
    const m = new RegExp(
      `${column}\\s+[a-z]+(?:\\s+NOT NULL)?(?:\\s+DEFAULT '[^']*')?\\s*CHECK \\(${column} IN \\(([^)]*)\\)`,
      "s",
    ).exec(sql);
    // multi-line CHECKs put the type and CHECK on separate lines
    const loose = new RegExp(`${column}[^;]*?CHECK \\(${column} IN \\(([^)]*)\\)`, "s").exec(sql);
    const body = (m ?? loose)?.[1] ?? "";
    return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
  };

  it("upload_files.state", () => {
    expect(uploadFileStateSchema.options).toEqual(checkValues("state"));
  });
  it("upload_files.error (migration 21 extends the CHECK with pending_limit)", () => {
    // The original CHECK (this migration) is superseded by migration 21; compare with the last one.
    const latest = readFileSync(
      new URL("../../db/migrations/1792400000100_free-tier-abuse.sql", import.meta.url),
      "utf8",
    ).split("-- Down Migration")[0] as string;
    const m = /upload_files_error_check\s+CHECK \(error IN \(([^)]*)\)/s.exec(latest);
    const values = [...(m?.[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
    expect(uploadFileErrorSchema.options).toEqual(values);
    expect(values).toContain("pending_limit");
    // the original values are a prefix: nothing was reordered or dropped
    expect(values.slice(0, checkValues("error").length)).toEqual(checkValues("error"));
  });
  it("upload_files.client_mime accepts exactly the photo mimes", () => {
    expect(checkValues("client_mime").sort()).toEqual(
      ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"].sort(),
    );
  });
});

describe("exportKey", () => {
  const EXPORT = "99999999-9999-4999-8999-999999999999";
  it("is the zip under the baby prefix, so a baby purge deletes it", () => {
    expect(exportKey(BABY, EXPORT)).toBe(`babies/${BABY}/exports/${EXPORT}.zip`);
    expect(exportKey(BABY, EXPORT).startsWith(babyPrefix(BABY))).toBe(true);
  });

  it.each(["x", "../x", `${EXPORT}/../../a`, "", `${EXPORT}.zip`])(
    "rejects the export id %j",
    (bad) => {
      expect(() => exportKey(BABY, bad)).toThrow(TypeError);
    },
  );

  it("rejects a bad baby id", () => {
    expect(() => exportKey("../x", EXPORT)).toThrow(TypeError);
  });
});
