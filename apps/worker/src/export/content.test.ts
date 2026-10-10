import { describe, expect, it } from "vitest";
import { metaRow, photoId } from "../testing/export";
import {
  albumJson,
  extensionFor,
  measurementCsvRow,
  milestoneCsvRows,
  originalFileName,
  PHOTOS_CSV_COLUMNS,
  photoCsvRow,
  photoJson,
  photosCsvHeader,
  readmeText,
  validOverrides,
} from "./content";

const P = photoId(1);

/** Minimal CSV parser (RFC 4180) for the assertions. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && s[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  return rows;
}

describe("file names", () => {
  it("uses ids and a date only, never parent text", () => {
    expect(originalFileName("2026-06-14", P, "image/jpeg")).toBe(`originals/2026-06-14_${P}.jpg`);
    expect(originalFileName("2026-06-14", P, "image/heic")).toBe(`originals/2026-06-14_${P}.heic`);
    expect(originalFileName("2026-06-14", P, null)).toBe(`originals/2026-06-14_${P}.bin`);
    expect(originalFileName("../../x", P, "image/png")).toBe(`originals/undated_${P}.png`);
    expect(extensionFor("application/x-evil")).toBe("bin");
  });
});

describe("photos.csv", () => {
  it("omits the gps columns (not blank) without location", () => {
    const header = photosCsvHeader(false);
    expect(header.trim().split(",")).toEqual([...PHOTOS_CSV_COLUMNS]);
    expect(header).not.toContain("gps_");
    const row = parseCsv(
      photoCsvRow("f.jpg", metaRow({ id: P, lat: 47.6, lng: -122.3 } as never), false),
    )[0];
    expect(row).toHaveLength(PHOTOS_CSV_COLUMNS.length);
    expect(row?.join(",")).not.toContain("47.6");
  });

  it("has gps_lat,gps_lng last with location, values only when the photo had one", () => {
    const header = photosCsvHeader(true).trim().split(",");
    expect(header.slice(-2)).toEqual(["gps_lat", "gps_lng"]);
    const withGps = parseCsv(
      photoCsvRow("f.jpg", { ...metaRow({ id: P }), gps_lat: 47.6062, gps_lng: -122.3321 }, true),
    )[0] as string[];
    expect(withGps).toHaveLength(header.length);
    expect(withGps.slice(-2)).toEqual(["47.6062", "-122.3321"]);
    const without = parseCsv(photoCsvRow("f.jpg", metaRow({ id: P }), true))[0] as string[];
    expect(without.slice(-2)).toEqual(["", ""]);
  });

  it("never emits GPS when the row has none even with location on (no NaN, no 0,0)", () => {
    const r = parseCsv(
      photoCsvRow("f.jpg", { ...metaRow({ id: P }), gps_lat: null, gps_lng: 3 }, true),
    )[0] as string[];
    expect(r.slice(-2)).toEqual(["", ""]);
  });

  it("escapes notes: commas, quotes, newlines and formula starts", () => {
    const note = '=cmd|"x", 1\nline two';
    const csv = photoCsvRow("f.jpg", metaRow({ id: P, meta: { note } }), false);
    const cells = parseCsv(csv)[0] as string[];
    const idx = PHOTOS_CSV_COLUMNS.indexOf("note");
    expect(cells[idx]).toBe(`'${note}`);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("joins people with ';' and uses ISO UTC dates", () => {
    const cells = parseCsv(
      photoCsvRow("f.jpg", metaRow({ id: P, meta: { people: ["Mom", "Dad"] } }), false),
    )[0] as string[];
    expect(cells[PHOTOS_CSV_COLUMNS.indexOf("people")]).toBe("Mom;Dad");
    expect(cells[PHOTOS_CSV_COLUMNS.indexOf("taken_at")]).toBe("2026-06-14T10:00:00.000Z");
  });
});

describe("photos.json", () => {
  it("has no gps key without location, an exif.gps with it", () => {
    const off = photoJson("f.jpg", { ...metaRow({ id: P }), gps_lat: 1, gps_lng: 2 }, false);
    expect(JSON.stringify(off)).not.toContain("gps");
    const on = photoJson("f.jpg", { ...metaRow({ id: P }), gps_lat: 47.6, gps_lng: -122.3 }, true);
    expect((on.exif as { gps: unknown }).gps).toEqual({ lat: 47.6, lng: -122.3 });
    const none = photoJson("f.jpg", metaRow({ id: P }), true);
    expect((none.exif as { gps: unknown }).gps).toBeNull();
  });

  it("keeps the exact text of notes (no apostrophe guard)", () => {
    const j = photoJson("f.jpg", metaRow({ id: P, meta: { note: "=1+1" } }), false);
    expect((j.details as { note: string }).note).toBe("=1+1");
  });

  it("ai is null when never analysed, no raw model output otherwise", () => {
    expect(photoJson("f", metaRow({ id: P }), false).ai).toBeNull();
    const analysed = photoJson(
      "f",
      metaRow({ id: P, meta: { ai_model: "fake", ai_description: { junk: true } } }),
      false,
    );
    expect(analysed.ai).toMatchObject({ model: "fake", description: null });
    expect(JSON.stringify(analysed)).not.toContain("raw");
  });

  it("drops invalid overrides", () => {
    expect(validOverrides({ caption: 123, nope: "x" })).toEqual({});
    expect(validOverrides(null)).toEqual({});
  });
});

describe("milestones.csv / measurements.csv / album.json / README", () => {
  it("lists the baby's milestones always and presets only when used", () => {
    const rows = [
      { id: "m1", name: "First smile", category: "social", is_preset: true },
      { id: "m2", name: "Unused preset", category: "social", is_preset: true },
      { id: "m3", name: "Our trip", category: "custom", is_preset: false },
    ];
    const out = milestoneCsvRows(rows, new Map([["m1", 2]]));
    expect(out.count).toBe(2);
    expect(parseCsv(out.csv).map((r) => r[1])).toEqual(["First smile", "Our trip"]);
  });

  it("measurement rows link a photo file only when it is in the export", () => {
    const m = {
      id: "x",
      kind: "weight",
      value_metric: "3400",
      value_entered: "7.5",
      unit_entered: "lb",
      measured_at: new Date("2026-02-01T00:00:00Z"),
      cursor_at: "",
      note: null,
      photo_id: P,
    };
    expect(parseCsv(measurementCsvRow(m, () => "originals/a.jpg"))[0]?.at(-1)).toBe(
      "originals/a.jpg",
    );
    expect(parseCsv(measurementCsvRow(m, () => undefined))[0]?.at(-1)).toBe("");
  });

  it("album.json carries no ids of users, emails, plan or coordinates", () => {
    const json = albumJson({
      exportedAt: new Date("2026-10-10T10:00:00Z"),
      includeLocation: false,
      baby: {
        id: "b",
        name: "Maya",
        nickname: null,
        birth_date: "2026-01-30",
        birth_date_is_due_date: false,
        birth_weight_g: 3400,
        birth_length_mm: 500,
        home_label: null,
      },
      members: [{ display_name: "Mom", relationship_label: "mother", role: "admin" }],
      counts: { photos: 3, milestones: 1, measurements: 0 },
    });
    const parsed = JSON.parse(json);
    expect(parsed.counts.photos).toBe(3);
    expect(parsed.members).toEqual([
      { displayName: "Mom", relationshipLabel: "mother", role: "admin" },
    ]);
    for (const banned of ['"lat"', '"lng"', "email", "plan", "userId", "user_id"])
      expect(json).not.toContain(banned);
  });

  it("README states whether location is included", () => {
    const d = new Date("2026-10-10T10:00:00Z");
    expect(readmeText({ exportedAt: d, includeLocation: true })).toContain(
      "include_location: true",
    );
    expect(readmeText({ exportedAt: d, includeLocation: false })).toContain(
      "Photo locations were not included",
    );
    expect(readmeText({ exportedAt: d, includeLocation: true })).toContain("\r\n");
  });
});
