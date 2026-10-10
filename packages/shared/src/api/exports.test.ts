import { describe, expect, it } from "vitest";
import { EXPORT_LIST_LIMIT } from "../constants";
import {
  createExportRequestSchema,
  dataExportSchema,
  EXPORT_ERRORS,
  EXPORT_STATUSES,
  exportDownloadUrlResponseSchema,
  exportParamsSchema,
  exportResponseSchema,
  exportsListResponseSchema,
} from "./exports";

const BABY = "11111111-1111-4111-8111-111111111111";
const EXP = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-10-10T10:00:00.000Z";

const row = (over: Record<string, unknown> = {}) => ({
  id: EXP,
  babyId: BABY,
  status: "ready",
  includeLocation: true,
  requestedBy: USER,
  requestedByName: "Mom",
  isMine: true,
  photoCount: 12,
  photosDone: 12,
  bytes: 1234,
  error: null,
  createdAt: NOW,
  startedAt: NOW,
  finishedAt: NOW,
  expiresAt: "2026-10-17T10:00:00.000Z",
  canDownload: true,
  ...over,
});

describe("export enums", () => {
  it("match the migration CHECKs literally and in order", () => {
    expect(EXPORT_STATUSES).toEqual(["queued", "running", "ready", "failed", "expired"]);
    expect(EXPORT_ERRORS).toEqual([
      "storage_error",
      "too_large",
      "requester_not_admin",
      "internal",
    ]);
  });
});

describe("dataExportSchema (strict)", () => {
  it("accepts a ready export of the requester", () => {
    expect(dataExportSchema.parse(row())).toEqual(row());
  });

  it("accepts a queued export with nulls", () => {
    const q = row({
      status: "queued",
      photoCount: null,
      photosDone: 0,
      bytes: null,
      startedAt: null,
      finishedAt: null,
      canDownload: false,
    });
    expect(dataExportSchema.safeParse(q).success).toBe(true);
  });

  it("accepts a deleted requester (requestedBy null)", () => {
    const r = row({ requestedBy: null, requestedByName: null, isMine: false, canDownload: false });
    expect(dataExportSchema.safeParse(r).success).toBe(true);
  });

  it.each([
    ["a storage key", { storage_key: `babies/${BABY}/exports/${EXP}.zip` }],
    ["a storageKey", { storageKey: "x" }],
    ["a URL", { url: "https://x.test/a.zip?X-Amz-Signature=abc" }],
    ["an email", { requestedByEmail: "mom@example.com" }],
    ["an unknown field", { downloads: 1 }],
  ])("rejects %s (a mapper bug fails instead of leaking)", (_n, extra) => {
    expect(dataExportSchema.safeParse(row(extra)).success).toBe(false);
  });

  it.each([
    ["not mine", { isMine: false }],
    ["not ready", { status: "running" }],
    ["expired", { status: "expired" }],
    ["failed", { status: "failed" }],
  ])("rejects canDownload true when %s", (_n, over) => {
    expect(dataExportSchema.safeParse(row(over)).success).toBe(false);
  });

  it.each([
    ["an unknown status", { status: "done" }],
    ["an unknown error", { error: "disk_on_fire" }],
    ["a negative byte count", { bytes: -1 }],
    ["a fractional photo count", { photoCount: 1.5 }],
    ["a non-uuid id", { id: "x" }],
    ["a date without time", { createdAt: "2026-10-10" }],
  ])("rejects %s", (_n, over) => {
    expect(dataExportSchema.safeParse(row(over)).success).toBe(false);
  });
});

describe("request, params and list schemas", () => {
  it("the request body needs includeLocation and nothing else", () => {
    expect(createExportRequestSchema.parse({ includeLocation: false })).toEqual({
      includeLocation: false,
    });
    expect(createExportRequestSchema.safeParse({}).success).toBe(false);
    expect(createExportRequestSchema.safeParse({ includeLocation: "yes" }).success).toBe(false);
    expect(
      createExportRequestSchema.safeParse({ includeLocation: true, babyId: BABY }).success,
    ).toBe(false);
  });

  it("params are two uuids", () => {
    expect(exportParamsSchema.safeParse({ id: BABY, exportId: EXP }).success).toBe(true);
    expect(exportParamsSchema.safeParse({ id: BABY, exportId: "x" }).success).toBe(false);
  });

  it("the response wraps one export; the list is capped", () => {
    expect(exportResponseSchema.safeParse({ export: row() }).success).toBe(true);
    expect(exportResponseSchema.safeParse({ export: row(), extra: 1 }).success).toBe(false);
    expect(exportsListResponseSchema.safeParse({ exports: [row()] }).success).toBe(true);
    expect(
      exportsListResponseSchema.safeParse({
        exports: Array.from({ length: EXPORT_LIST_LIMIT + 1 }, () => row()),
      }).success,
    ).toBe(false);
  });
});

describe("exportDownloadUrlResponseSchema", () => {
  const good = `http://localhost:9000/tinyglow/babies/${BABY}/exports/${EXP}.zip?X-Amz-Expires=600&X-Amz-Signature=abc`;
  it("accepts a presigned export ZIP URL", () => {
    expect(exportDownloadUrlResponseSchema.safeParse({ url: good, expiresAt: NOW }).success).toBe(
      true,
    );
  });

  it.each([
    ["an original", `http://h.test/tinyglow/babies/${BABY}/originals/${EXP}`],
    ["a derivative", `http://h.test/tinyglow/babies/${BABY}/derivatives/${EXP}/thumb.jpg`],
    ["a non-zip export key", `http://h.test/tinyglow/babies/${BABY}/exports/${EXP}.csv`],
    ["a javascript URL", "javascript:alert(1)"],
    ["a relative path", `/babies/${BABY}/exports/${EXP}.zip`],
  ])("rejects %s", (_n, url) => {
    expect(exportDownloadUrlResponseSchema.safeParse({ url, expiresAt: NOW }).success).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(
      exportDownloadUrlResponseSchema.safeParse({ url: good, expiresAt: NOW, key: "x" }).success,
    ).toBe(false);
  });
});
