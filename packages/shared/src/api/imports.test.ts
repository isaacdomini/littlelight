import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  googleConnectedQuerySchema,
  googleConnectionSchema,
  googleConnectRequestSchema,
  googleConnectResponseSchema,
  IMPORT_BATCH_ACTIVE_STATUSES,
  IMPORT_BATCH_ERRORS,
  IMPORT_BATCH_STATUSES,
  IMPORT_ITEM_ERRORS,
  IMPORT_SOURCE_ERRORS,
  importBatchCreateRequestSchema,
  importBatchCreateResponseSchema,
  importBatchesListQuerySchema,
  importBatchSchema,
  importSourceSchema,
  importSourcesListQuerySchema,
  patchImportSourceRequestSchema,
  upsertImportSourceRequestSchema,
} from "./imports";

const U = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-10T10:00:00.000Z";

const source = {
  id: U,
  babyId: U,
  userId: U,
  userName: "Mom",
  kind: "apple_photos",
  deviceId: D,
  deviceLabel: "Mom's iPhone",
  albumTitle: "Maya",
  wifiOnly: true,
  paused: false,
  isMine: true,
  isThisDevice: true,
  lastSyncAt: null,
  lastTrigger: null,
  importedCount: 0,
  duplicateCount: 0,
  failedCount: 0,
  skippedCount: 0,
  lastError: null,
  createdAt: NOW,
};

const batch = {
  id: U,
  babyId: U,
  kind: "google_picker",
  status: "picking",
  error: null,
  requestedBy: U,
  requestedByName: "Mom",
  isMine: true,
  itemsTotal: null,
  itemsImported: 0,
  itemsDuplicate: 0,
  itemsFailed: 0,
  itemsSkipped: 0,
  pollIntervalSec: 5,
  pickerExpiresAt: null,
  createdAt: NOW,
  startedAt: null,
  finishedAt: null,
};

describe("upsertImportSourceRequestSchema", () => {
  const body = {
    kind: "apple_photos",
    deviceId: D,
    deviceLabel: " Mom's iPhone ",
    albumTitle: "Maya",
    wifiOnly: true,
  };

  it("trims labels", () => {
    expect(upsertImportSourceRequestSchema.parse(body).deviceLabel).toBe("Mom's iPhone");
  });

  it.each([
    ["an asset id", { ...body, assetIds: ["A/L0/001"] }],
    ["a bad kind", { ...body, kind: "google_picker" }],
    ["a non-uuid device id", { ...body, deviceId: "iphone" }],
    ["an empty label", { ...body, deviceLabel: "  " }],
    ["a control character", { ...body, albumTitle: "bad\u0000title" }],
    ["a newline", { ...body, deviceLabel: "a\nb" }],
    ["a long label", { ...body, deviceLabel: "x".repeat(61) }],
    ["a long title", { ...body, albumTitle: "x".repeat(121) }],
    ["a missing wifiOnly", { ...body, wifiOnly: undefined }],
  ])("rejects %s", (_n, b) => {
    expect(upsertImportSourceRequestSchema.safeParse(b).success).toBe(false);
  });

  it("accepts the maximum lengths", () => {
    expect(
      upsertImportSourceRequestSchema.safeParse({
        ...body,
        deviceLabel: "x".repeat(60),
        albumTitle: "y".repeat(120),
      }).success,
    ).toBe(true);
  });
});

describe("patchImportSourceRequestSchema", () => {
  it("rejects an empty patch", () => {
    expect(patchImportSourceRequestSchema.safeParse({}).success).toBe(false);
    expect(patchImportSourceRequestSchema.safeParse({ paused: undefined }).success).toBe(false);
  });

  it("accepts a lone null lastError (clear) and a full patch", () => {
    expect(patchImportSourceRequestSchema.safeParse({ lastError: null }).success).toBe(true);
    expect(
      patchImportSourceRequestSchema.safeParse({
        albumTitle: "New",
        wifiOnly: false,
        paused: true,
        lastSyncAt: NOW,
        lastTrigger: "background",
        importedDelta: 500,
        duplicateDelta: 0,
        failedDelta: 1,
        skippedDelta: 2,
        lastError: "free_tier_limit",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["delta over 500", { importedDelta: 501 }],
    ["negative delta", { failedDelta: -1 }],
    ["fractional delta", { duplicateDelta: 1.5 }],
    ["unknown error", { lastError: "boom" }],
    ["unknown trigger", { lastTrigger: "cron" }],
    ["unknown key", { importedCount: 5 }],
    ["bad date", { lastSyncAt: "yesterday" }],
  ])("rejects %s", (_n, b) => {
    expect(patchImportSourceRequestSchema.safeParse(b).success).toBe(false);
  });
});

describe("import source and batch responses are strict", () => {
  it("parse a well-formed row", () => {
    expect(importSourceSchema.parse(source)).toEqual(source);
    expect(importBatchSchema.parse(batch)).toEqual(batch);
  });

  it("refuse a leaked column", () => {
    expect(importSourceSchema.safeParse({ ...source, assetId: "x" }).success).toBe(false);
    expect(importBatchSchema.safeParse({ ...batch, providerSessionId: "s" }).success).toBe(false);
    expect(importBatchSchema.safeParse({ ...batch, pickerUri: "https://x.test/p" }).success).toBe(
      false,
    );
  });

  it("only the create response carries pickerUri", () => {
    expect(
      importBatchCreateResponseSchema.safeParse({
        batch,
        pickerUri: "https://photos.google.com/picker/a",
      }).success,
    ).toBe(true);
    expect(importBatchCreateResponseSchema.safeParse({ batch }).success).toBe(false);
    expect(
      importBatchCreateResponseSchema.safeParse({ batch, pickerUri: "javascript:1" }).success,
    ).toBe(false);
  });

  it("enum lists match the migration CHECKs", () => {
    expect(IMPORT_SOURCE_ERRORS).toEqual([
      "free_tier_limit",
      "permission_denied",
      "album_missing",
      "network",
      "storage_error",
      "baby_trashed",
      "signed_out",
      "pending_limit",
    ]);
    expect(IMPORT_BATCH_STATUSES).toEqual([
      "picking",
      "queued",
      "running",
      "done",
      "failed",
      "cancelled",
      "expired",
    ]);
    expect(IMPORT_BATCH_ACTIVE_STATUSES).toEqual(["picking", "queued", "running"]);
    expect(IMPORT_BATCH_ERRORS).toContain("too_many_items");
    expect(IMPORT_ITEM_ERRORS).toContain("file_too_large");
  });

  it("source and item error enums match the latest migration CHECKs (value and order)", () => {
    // Sources: last changed by migration 21; items: migration 22 (`1792500000100_video.sql`) adds
    // `video_too_long`. Up sections only.
    const up = (file: string) =>
      readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), "utf8").split(
        "-- Down Migration",
      )[0] as string;
    const values = (sql: string, constraint: string, column: string): string[] => {
      const m = new RegExp(`${constraint}\\s+CHECK \\(${column} IN \\(([^)]*)\\)`, "s").exec(sql);
      return [...(m?.[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
    };
    const m21 = up("1792400000100_free-tier-abuse.sql");
    const m22 = up("1792500000100_video.sql");
    expect([...IMPORT_SOURCE_ERRORS]).toEqual(
      values(m21, "import_sources_last_error_check", "last_error"),
    );
    expect([...IMPORT_ITEM_ERRORS]).toEqual(values(m22, "import_items_error_check", "error"));
    expect(IMPORT_SOURCE_ERRORS).toContain("pending_limit");
    expect(IMPORT_ITEM_ERRORS).toContain("pending_limit");
    expect(IMPORT_ITEM_ERRORS).toContain("video_too_long");
    // migration 21's item list is a prefix of migration 22's: nothing reordered or dropped
    const items21 = values(m21, "import_items_error_check", "error");
    expect([...IMPORT_ITEM_ERRORS].slice(0, items21.length)).toEqual(items21);
  });

  it("pollIntervalSec is 1..60", () => {
    expect(importBatchSchema.safeParse({ ...batch, pollIntervalSec: 0 }).success).toBe(false);
    expect(importBatchSchema.safeParse({ ...batch, pollIntervalSec: 61 }).success).toBe(false);
  });
});

describe("Google connection DTOs", () => {
  it("connect request: client required, returnTo allow-listed with a default", () => {
    expect(googleConnectRequestSchema.parse({ client: "web" })).toEqual({
      client: "web",
      returnTo: "/upload",
    });
    expect(
      googleConnectRequestSchema.parse({ client: "native", returnTo: "/settings/import" }).returnTo,
    ).toBe("/settings/import");
    for (const b of [
      {},
      { client: "desktop" },
      { client: "web", returnTo: "https://evil.test" },
      { client: "web", returnTo: "/admin" },
      { client: "web", x: 1 },
    ])
      expect(googleConnectRequestSchema.safeParse(b).success).toBe(false);
  });

  it("connect response and connection", () => {
    expect(
      googleConnectResponseSchema.safeParse({
        url: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
      }).success,
    ).toBe(true);
    expect(googleConnectResponseSchema.safeParse({ url: "javascript:1" }).success).toBe(false);
    expect(
      googleConnectionSchema.safeParse({
        available: true,
        connected: false,
        connectedAt: null,
        needsReconnect: false,
      }).success,
    ).toBe(true);
    expect(
      googleConnectionSchema.safeParse({
        available: true,
        connected: false,
        connectedAt: null,
        needsReconnect: false,
        token: "x",
      }).success,
    ).toBe(false);
  });

  it("connected page query falls back safely", () => {
    expect(
      googleConnectedQuerySchema.parse({ status: "ok", client: "native", returnTo: "/upload" }),
    ).toEqual({
      status: "ok",
      client: "native",
      returnTo: "/upload",
    });
    expect(
      googleConnectedQuerySchema.parse({ status: "weird", client: "tv", returnTo: "//evil" }),
    ).toEqual({
      status: "error",
      client: "web",
      returnTo: undefined,
    });
  });
});

describe("query and create bodies", () => {
  it("list queries", () => {
    expect(importSourcesListQuerySchema.safeParse({ babyId: U }).success).toBe(true);
    expect(importSourcesListQuerySchema.safeParse({}).success).toBe(false);
    expect(importBatchesListQuerySchema.parse({}).limit).toBe(10);
    expect(importBatchesListQuerySchema.parse({ limit: "20" }).limit).toBe(20);
    expect(importBatchesListQuerySchema.safeParse({ limit: "21" }).success).toBe(false);
  });

  it("batch create body is empty and strict", () => {
    expect(importBatchCreateRequestSchema.safeParse({}).success).toBe(true);
    expect(importBatchCreateRequestSchema.safeParse({ items: [] }).success).toBe(false);
  });
});
