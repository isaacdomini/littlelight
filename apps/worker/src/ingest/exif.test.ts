import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { jpegWithExif, webpWithExif } from "../testing/exif-writer";
import { sceneJpeg, sceneWebp } from "../testing/images";
import {
  extractExif,
  parseExifDateTime,
  parseExifOffset,
  RAW_JSON_WHITELIST,
  resolveCaptureTime,
  whitelistRawJson,
} from "./exif";

const NOW = new Date("2026-10-08T12:00:00Z");

describe("parseExifDateTime", () => {
  it("parses EXIF wall times as fields read in UTC", () => {
    expect(parseExifDateTime("2026:06:14 15:04:05")?.asUtcMs).toBe(Date.UTC(2026, 5, 14, 15, 4, 5));
    expect(parseExifDateTime("2026-06-14T15:04:05")?.asUtcMs).toBe(Date.UTC(2026, 5, 14, 15, 4, 5));
    expect(parseExifDateTime("2026:06:14 15:04:05.123")?.asUtcMs).toBe(
      Date.UTC(2026, 5, 14, 15, 4, 5),
    );
    expect(parseExifDateTime("  2026:06:14 15:04:05 ")?.asUtcMs).toBe(
      Date.UTC(2026, 5, 14, 15, 4, 5),
    );
  });

  it.each([
    ["not a date"],
    [""],
    ["0000:00:00 00:00:00"],
    ["2026:13:01 00:00:00"],
    ["2026:02:30 10:00:00"],
    ["2026:06:14 24:00:00"],
    ["2026:06:14 12:60:00"],
    ["1899:12:31 23:59:59"],
    [null],
    [undefined],
    [12345],
    [new Date()],
  ])("rejects %j", (raw) => {
    expect(parseExifDateTime(raw)).toBeNull();
  });
});

describe("parseExifOffset", () => {
  it.each([
    ["+02:00", 120],
    ["-07:00", -420],
    ["+0530", 330],
    ["-0930", -570],
    ["Z", 0],
    ["+00:00", 0],
    [" +01:00 ", 60],
    ["+14:00", 840],
  ])("%j -> %j", (raw, minutes) => {
    expect(parseExifOffset(raw)).toBe(minutes);
  });

  it.each([["+15:00"], ["+02:60"], ["02:00"], ["UTC"], [""], [null], [3600], ["+2"]])(
    "rejects %j",
    (raw) => {
      expect(parseExifOffset(raw)).toBeNull();
    },
  );
});

describe("resolveCaptureTime", () => {
  const tags = { DateTimeOriginal: "2026:06:14 15:04:05" };

  it("the offset tag wins over the time zone hint", () => {
    const r = resolveCaptureTime({ ...tags, OffsetTimeOriginal: "-07:00" }, "Asia/Kolkata", NOW);
    expect(r?.takenAt.toISOString()).toBe("2026-06-14T22:04:05.000Z");
    expect(r?.tzOffsetMinutes).toBe(-420);
  });

  it("without an offset tag the wall time is read in tzHint (DST aware)", () => {
    const summer = resolveCaptureTime(tags, "America/Los_Angeles", NOW);
    expect(summer?.takenAt.toISOString()).toBe("2026-06-14T22:04:05.000Z");
    expect(summer?.tzOffsetMinutes).toBe(-420);
    const winter = resolveCaptureTime(
      { DateTimeOriginal: "2026:01:14 15:04:05" },
      "America/Los_Angeles",
      NOW,
    );
    expect(winter?.tzOffsetMinutes).toBe(-480);
  });

  it("without offset and hint the wall time is UTC and the offset is unknown", () => {
    const r = resolveCaptureTime(tags, undefined, NOW);
    expect(r?.takenAt.toISOString()).toBe("2026-06-14T15:04:05.000Z");
    expect(r?.tzOffsetMinutes).toBeNull();
  });

  it("an unknown tzHint is ignored like no hint", () => {
    const r = resolveCaptureTime(tags, "Not/AZone", NOW);
    expect(r?.tzOffsetMinutes).toBeNull();
    expect(r?.takenAt.toISOString()).toBe("2026-06-14T15:04:05.000Z");
  });

  it("falls back to CreateDate then ModifyDate (with the generic OffsetTime)", () => {
    expect(
      resolveCaptureTime(
        { CreateDate: "2026:06:14 10:00:00" },
        undefined,
        NOW,
      )?.takenAt.toISOString(),
    ).toBe("2026-06-14T10:00:00.000Z");
    const r = resolveCaptureTime(
      { ModifyDate: "2026:06:14 10:00:00", OffsetTime: "+02:00" },
      undefined,
      NOW,
    );
    expect(r?.takenAt.toISOString()).toBe("2026-06-14T08:00:00.000Z");
  });

  it("rejects dates before 1990 and more than a day in the future (unset camera clocks)", () => {
    expect(
      resolveCaptureTime({ DateTimeOriginal: "1989:12:31 23:59:59" }, undefined, NOW),
    ).toBeNull();
    expect(
      resolveCaptureTime({ DateTimeOriginal: "2000:01:01 00:00:00" }, undefined, NOW),
    ).not.toBeNull();
    expect(
      resolveCaptureTime({ DateTimeOriginal: "2027:01:01 00:00:00" }, undefined, NOW),
    ).toBeNull();
    // Within the one-day grace window: accepted.
    expect(
      resolveCaptureTime({ DateTimeOriginal: "2026:10:09 06:00:00" }, undefined, NOW),
    ).not.toBeNull();
  });

  it("an out-of-range DateTimeOriginal falls through to a valid CreateDate", () => {
    const r = resolveCaptureTime(
      { DateTimeOriginal: "1970:01:01 00:00:00", CreateDate: "2026:06:14 10:00:00" },
      undefined,
      NOW,
    );
    expect(r?.takenAt.toISOString()).toBe("2026-06-14T10:00:00.000Z");
  });

  it("no date tags: null (the caller marks the capture time estimated)", () => {
    expect(resolveCaptureTime({}, "UTC", NOW)).toBeNull();
  });
});

describe("whitelistRawJson", () => {
  it("keeps only whitelisted camera/exposure tags as strings or finite numbers", () => {
    const out = whitelistRawJson({
      Make: "Acme",
      Model: "Cam 1",
      ISO: 200,
      FNumber: 1.8,
      ImageDescription: "Baby Mia at 12 Elm Street",
      Artist: "Jane Parent",
      Copyright: "(c) Jane",
      UserComment: "private",
      latitude: 47.6,
      longitude: -122.3,
      GPSLatitude: [47, 36, 22],
      GPSLongitude: [122, 19, 55],
      GPSAltitude: 10,
      MakerNote: "x",
      Orientation: 6,
      Flash: Number.NaN,
      Software: { nested: true },
    });
    expect(out).toEqual({ Make: "Acme", Model: "Cam 1", ISO: 200, FNumber: 1.8, Orientation: 6 });
  });

  it("the whitelist itself contains no free-text or GPS-ish key", () => {
    for (const k of RAW_JSON_WHITELIST) {
      expect(k).not.toMatch(
        /gps|latitude|longitude|description|artist|comment|copyright|owner|maker/i,
      );
    }
  });

  it("strips control characters and truncates long strings", () => {
    const out = whitelistRawJson({ Make: `Ac\u0000me\n${"x".repeat(500)}` });
    for (const ch of String(out.Make)) expect(ch.charCodeAt(0)).toBeGreaterThan(0x1f);
    expect(String(out.Make).length).toBeLessThanOrEqual(120);
  });
});

describe("extractExif (real files)", () => {
  const full = {
    make: "Acme",
    model: "PhotoMaster 3000",
    orientation: 1,
    dateTimeOriginal: "2026:06:14 15:04:05",
    offsetTimeOriginal: "-07:00",
    exifImageWidth: 640,
    exifImageHeight: 480,
    fNumber: 1.8,
    iso: 100,
    imageDescription: "Mia at 12 Elm Street, the nursery",
    artist: "Jane Parent",
    gps: { lat: 47.6062, lng: -122.3321 },
  };

  it("reads time, camera, GPS and the whitelisted tags from a JPEG", async () => {
    const jpeg = jpegWithExif(await sceneJpeg(640, 480, 1), full);
    const e = await extractExif(jpeg, "image/jpeg", "Asia/Kolkata", NOW);
    expect(e.takenAt?.toISOString()).toBe("2026-06-14T22:04:05.000Z");
    expect(e.tzOffsetMinutes).toBe(-420);
    expect(e.cameraMake).toBe("Acme");
    expect(e.cameraModel).toBe("PhotoMaster 3000");
    expect(e.orientation).toBe(1);
    expect(e.exifWidth).toBe(640);
    expect(e.exifHeight).toBe(480);
    expect(e.gps?.lat).toBeCloseTo(47.6062, 4);
    expect(e.gps?.lng).toBeCloseTo(-122.3321, 4);
    expect(e.rawJson).toMatchObject({ Make: "Acme", Model: "PhotoMaster 3000", ISO: 100 });
  });

  it("GPS is a non-enumerable property: absent from keys, JSON and spreads", async () => {
    const e = await extractExif(
      jpegWithExif(await sceneJpeg(64, 48, 2), full),
      "image/jpeg",
      undefined,
      NOW,
    );
    expect(e.gps).not.toBeNull();
    expect(Object.keys(e)).not.toContain("gps");
    expect(JSON.stringify(e)).not.toMatch(/gps|47\.6|122\.3|latitude|longitude/i);
    expect({ ...e }).not.toHaveProperty("gps");
    expect(Object.getOwnPropertyDescriptor(e, "gps")?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(e, "gps")?.writable).toBe(false);
    expect(JSON.stringify(e.rawJson)).not.toMatch(/gps|latitude|longitude/i);
  });

  it("raw_json never carries free text (ImageDescription / Artist) or any GPS key", async () => {
    const e = await extractExif(
      jpegWithExif(await sceneJpeg(64, 48, 2), full),
      "image/jpeg",
      undefined,
      NOW,
    );
    const text = JSON.stringify(e.rawJson);
    expect(text).not.toContain("Elm Street");
    expect(text).not.toContain("Jane");
    for (const k of Object.keys(e.rawJson))
      expect(RAW_JSON_WHITELIST as readonly string[]).toContain(k);
  });

  it("a southern/western point has the right signs", async () => {
    const e = await extractExif(
      jpegWithExif(await sceneJpeg(64, 48, 3), { gps: { lat: -33.8688, lng: 151.2093 } }),
      "image/jpeg",
      undefined,
      NOW,
    );
    expect(e.gps?.lat).toBeCloseTo(-33.8688, 4);
    expect(e.gps?.lng).toBeCloseTo(151.2093, 4);
  });

  it("a (0, 0) GPS block is treated as no GPS", async () => {
    const e = await extractExif(
      jpegWithExif(await sceneJpeg(64, 48, 3), { gps: { lat: 0, lng: 0 } }),
      "image/jpeg",
      undefined,
      NOW,
    );
    expect(e.gps).toBeNull();
  });

  it("no EXIF at all: every field null, no throw (capture time is estimated by the caller)", async () => {
    const e = await extractExif(await sceneJpeg(64, 48, 4), "image/jpeg", "UTC", NOW);
    expect(e).toMatchObject({
      takenAt: null,
      tzOffsetMinutes: null,
      cameraMake: null,
      orientation: null,
      rawJson: {},
    });
    expect(e.gps).toBeNull();
  });

  it("garbage bytes are not an error", async () => {
    const e = await extractExif(
      Buffer.from("definitely not an image"),
      "image/jpeg",
      undefined,
      NOW,
    );
    expect(e.takenAt).toBeNull();
    expect(e.gps).toBeNull();
  });

  it("a missing offset tag uses the tz hint", async () => {
    const jpeg = jpegWithExif(await sceneJpeg(64, 48, 5), {
      dateTimeOriginal: "2026:01:14 15:04:05",
    });
    const e = await extractExif(jpeg, "image/jpeg", "America/Los_Angeles", NOW);
    expect(e.takenAt?.toISOString()).toBe("2026-01-14T23:04:05.000Z");
    expect(e.tzOffsetMinutes).toBe(-480);
  });

  it("reports Orientation as stored", async () => {
    const e = await extractExif(
      jpegWithExif(await sceneJpeg(64, 48, 6), { orientation: 6 }),
      "image/jpeg",
      undefined,
      NOW,
    );
    expect(e.orientation).toBe(6);
  });

  it("reads EXIF (time, camera, GPS) from a WebP", async () => {
    const webp = webpWithExif(await sceneWebp(64, 48, 7), full, 64, 48);
    expect((await sharp(webp).metadata()).exif).toBeTruthy(); // fixture sanity: libvips sees the chunk
    const e = await extractExif(webp, "image/webp", undefined, NOW);
    expect(e.takenAt?.toISOString()).toBe("2026-06-14T22:04:05.000Z");
    expect(e.cameraMake).toBe("Acme");
    expect(e.gps?.lat).toBeCloseTo(47.6062, 4);
    expect(JSON.stringify(e)).not.toMatch(/47\.6|latitude/);
  });

  it("a WebP without EXIF yields nulls", async () => {
    const e = await extractExif(await sceneWebp(64, 48, 8), "image/webp", undefined, NOW);
    expect(e.takenAt).toBeNull();
    expect(e.gps).toBeNull();
  });
});
