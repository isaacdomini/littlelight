import { describe, expect, it } from "vitest";
import { type ExportRow, exportFileName, toDataExport } from "./queries";

const base = (over: Partial<ExportRow> = {}): ExportRow => ({
  id: "22222222-2222-4222-8222-222222222222",
  baby_id: "11111111-1111-4111-8111-111111111111",
  requested_by: "33333333-3333-4333-8333-333333333333",
  include_location: true,
  status: "ready",
  error: null,
  photo_count: 12,
  photos_done: 12,
  bytes: "123456789012",
  created_at: new Date("2026-10-10T10:00:00Z"),
  started_at: new Date("2026-10-10T10:00:05Z"),
  finished_at: new Date("2026-10-10T10:01:00Z"),
  expires_at: new Date("2026-10-17T10:00:00Z"),
  requested_by_name: "Mom",
  is_mine: true,
  can_download: true,
  ...over,
});

describe("toDataExport", () => {
  it("maps a row to the wire shape: ISO dates, bytes as a number, no storage key", () => {
    const e = toDataExport(base());
    expect(e).toMatchObject({
      status: "ready",
      bytes: 123456789012,
      createdAt: "2026-10-10T10:00:00.000Z",
      expiresAt: "2026-10-17T10:00:00.000Z",
      isMine: true,
      canDownload: true,
      requestedByName: "Mom",
    });
    expect(JSON.stringify(e)).not.toMatch(/storage|exports\/|\.zip/);
  });

  it("keeps nulls for a queued export and for a deleted requester", () => {
    const e = toDataExport(
      base({
        status: "queued",
        photo_count: null,
        photos_done: 0,
        bytes: null,
        started_at: null,
        finished_at: null,
        requested_by: null,
        requested_by_name: null,
        is_mine: false,
        can_download: false,
      }),
    );
    expect(e).toMatchObject({ photoCount: null, bytes: null, startedAt: null, requestedBy: null });
  });

  it("fails closed when a row claims a download it cannot have", () => {
    expect(() => toDataExport(base({ is_mine: false, can_download: true }))).toThrow();
    expect(() => toDataExport(base({ status: "running", can_download: true }))).toThrow();
  });

  it("never copies unknown row columns to the wire (storage_key)", () => {
    const row = { ...base(), storage_key: "babies/x/exports/y.zip" };
    // The mapper picks columns by name; the strict wire schema is the second lock.
    expect(JSON.stringify(toDataExport(row))).not.toContain("storage_key");
  });
});

describe("exportFileName", () => {
  const day = new Date("2026-10-10T23:59:00Z");
  it.each([
    ["Maya", "littlelight-maya-2026-10-10.zip"],
    ["Zoë & Léa", "littlelight-zoe-lea-2026-10-10.zip"],
    ["  ", "littlelight-album-2026-10-10.zip"],
    [null, "littlelight-album-2026-10-10.zip"],
    ["日本語", "littlelight-album-2026-10-10.zip"],
    ['Bad"; filename=evil.exe', "littlelight-bad-filename-evil-exe-2026-10-10.zip"],
    ["../../etc/passwd", "littlelight-etc-passwd-2026-10-10.zip"],
    ["Line\r\nbreak", "littlelight-line-break-2026-10-10.zip"],
  ])("%j -> %s", (name, out) => {
    expect(exportFileName(name, day)).toBe(out);
  });

  it("caps the slug and stays plain ASCII", () => {
    const out = exportFileName("a".repeat(200), day);
    expect(out).toBe(`littlelight-${"a".repeat(40)}-2026-10-10.zip`);
    expect(out).toMatch(/^[\x20-\x7e]+$/);
  });
});
