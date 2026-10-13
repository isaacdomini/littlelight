import { describe, expect, it } from "vitest";
import { gpsFromTags, parseIso6709, parseIsoInstant, whitelistVideoTags } from "./metadata";

// Video metadata parsing (docs/plans/step-12.md 2.6 step 5): the QuickTime location tag becomes
// a non-enumerable GPS point (encrypted downstream, never logged), `raw_json` only ever holds the
// whitelisted tags minus every location-like key, timestamps keep their offset.

describe("parseIso6709", () => {
  it.each([
    ["+37.3349-122.0090+012.345/", 37.3349, -122.009],
    ["+37.3349-122.0090/", 37.3349, -122.009],
    ["+37.3349-122.0090", 37.3349, -122.009],
    ["-33.8688+151.2093/", -33.8688, 151.2093],
    ["+4820.00+01230.00/", 48 + 20 / 60, 12.5], // DDMM.MM / DDDMM.MM
    ["+482000.0+0123000.0/", 48 + 20 / 60, 12.5], // DDMMSS / DDDMMSS
  ])("parses %s", (raw, lat, lng) => {
    const p = parseIso6709(raw);
    expect(p).not.toBeNull();
    expect(p?.lat).toBeCloseTo(lat, 4);
    expect(p?.lng).toBeCloseTo(lng, 4);
  });

  it.each([
    ["+91.0000-122.0090/", "lat out of range"],
    ["+37.3349-181.0000/", "lng out of range"],
    ["+00.0000+000.0000/", "null island"],
    ["37.3349,-122.0090", "no sign / comma form"],
    ["", "empty"],
    [null, "null"],
    [42, "number"],
    ["+3.3349-122.0090/", "too few lat digits"],
  ] as [unknown, string][])("rejects %s (%s)", (raw) => {
    expect(parseIso6709(raw)).toBeNull();
  });
});

describe("gpsFromTags", () => {
  it("reads the QuickTime key, the generic `location` key and `location-*` variants, any case", () => {
    const p = { lat: 37.3349, lng: -122.009 };
    expect(gpsFromTags({ "com.apple.quicktime.location.ISO6709": "+37.3349-122.0090/" })).toEqual(
      p,
    );
    expect(gpsFromTags({ "COM.APPLE.QUICKTIME.LOCATION.ISO6709": "+37.3349-122.0090/" })).toEqual(
      p,
    );
    expect(gpsFromTags({ location: "+37.3349-122.0090/" })).toEqual(p);
    expect(gpsFromTags({ "location-eng": "+37.3349-122.0090/" })).toEqual(p);
    expect(gpsFromTags({ encoder: "x", creation_time: "2026-01-01T00:00:00Z" })).toBeNull();
    expect(gpsFromTags({ location: "garbage" })).toBeNull();
  });
});

describe("whitelistVideoTags", () => {
  it("copies only the whitelisted string tags, trimmed and bounded; never a location key", () => {
    const out = whitelistVideoTags({
      major_brand: "qt  ",
      encoder: "  Lavf61  ",
      "com.apple.quicktime.make": "Apple",
      "com.apple.quicktime.model": "iPhone 16",
      "com.apple.quicktime.location.ISO6709": "+37.3349-122.0090/",
      location: "+37.3349-122.0090/",
      "location-eng": "+37.3349-122.0090/",
      gps: "x",
      latitude: "37",
      creation_time: "2026-06-01T08:00:00.000000Z",
      handler_name: "VideoHandler",
      random_tag: "dropped",
      "com.apple.quicktime.software": 12 as unknown as string,
    });
    expect(out).toEqual({
      major_brand: "qt",
      encoder: "Lavf61",
      "com.apple.quicktime.make": "Apple",
      "com.apple.quicktime.model": "iPhone 16",
      creation_time: "2026-06-01T08:00:00.000000Z",
      handler_name: "VideoHandler",
    });
    expect(JSON.stringify(out)).not.toMatch(/37\.33|122\.00|location|gps|latitude/i);
  });

  it("strips control characters and clips long values", () => {
    const out = whitelistVideoTags({ encoder: `${"x".repeat(300)}\u0000\n` });
    expect(out.encoder?.length).toBe(120);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they were stripped
    expect(out.encoder).not.toMatch(/[\u0000-\u001f]/);
    expect(whitelistVideoTags({ encoder: "   " })).toEqual({});
  });
});

describe("parseIsoInstant", () => {
  it("keeps the offset of a QuickTime creationdate and marks creation_time (UTC) as offset-less", () => {
    const q = parseIsoInstant("2026-07-12T10:30:00+0200");
    expect(q).toEqual({
      utcMs: Date.parse("2026-07-12T08:30:00Z"),
      offsetMinutes: 120,
      hasOffset: true,
    });
    const z = parseIsoInstant("2026-06-01T08:00:00.000000Z");
    expect(z?.utcMs).toBe(Date.parse("2026-06-01T08:00:00Z"));
    // `Z` is an explicit zero offset (the mp4 muxer writes UTC); only a bare wall time has none
    expect(z?.hasOffset).toBe(true);
    expect(z?.offsetMinutes).toBe(0);
    expect(parseIsoInstant("2026-06-01 08:00:00")?.hasOffset).toBe(false);
    expect(parseIsoInstant("2026-07-12T10:30:00-05:30")?.offsetMinutes).toBe(-330);
  });

  it("rejects non-strings and garbage", () => {
    expect(parseIsoInstant(null)).toBeNull();
    expect(parseIsoInstant(1_700_000_000)).toBeNull();
    expect(parseIsoInstant("yesterday")).toBeNull();
    expect(parseIsoInstant("")).toBeNull();
  });
});
