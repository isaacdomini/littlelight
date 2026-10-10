import { aiDescriptionV1Schema, type PhotoAiOverridePatch } from "@tinyglow/shared";
import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../auth";
import { sampleDescription } from "../testing/ai";
import { loadPhotoAi, overrideChanges, photoAiOverrides } from "./ai-queries";
import { usageMonth } from "./ai-routes";
import { AI_STATUS_MAX_ATTEMPTS, AI_STATUS_SQL, toAiStatus } from "./queries";

const PHOTO = "22222222-2222-4222-8222-222222222222";

interface Script {
  overrides?: { field_path: string; value: unknown }[];
  aiRow?: {
    description: unknown;
    model?: string;
    prompt_version?: string;
    schema_version?: string;
  };
  failure?: string | null;
}

/** A Tx answering by the statement's table; records every statement. */
function fakeTx(s: Script = {}) {
  const sqls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      sqls.push(sql);
      if (sql.includes("photo_ai_overrides")) return { rows: s.overrides ?? [] };
      if (sql.includes("ai_batch_items")) {
        return { rows: s.failure === undefined ? [] : [{ failure_kind: s.failure }] };
      }
      if (sql.includes("FROM public.photo_ai")) {
        return {
          rows: s.aiRow
            ? [
                {
                  model: s.aiRow.model ?? "gpt-6-luna",
                  prompt_version: s.aiRow.prompt_version ?? "v1",
                  schema_version: s.aiRow.schema_version ?? "v1",
                  description: s.aiRow.description,
                  updated_at: new Date("2026-10-01T12:00:00Z"),
                },
              ]
            : [],
        };
      }
      return { rows: [] };
    }),
  };
  return { tx: client as unknown as Tx, sqls, client };
}

describe("toAiStatus", () => {
  it.each(["not_available", "pending", "queued", "analyzing", "ready", "failed"])(
    "keeps %s",
    (s) => {
      expect(toAiStatus(s)).toBe(s);
    },
  );
  it.each([null, undefined, "", "running", 5, {}])("reads %j as not_available", (v) => {
    expect(toAiStatus(v)).toBe("not_available");
  });
});

describe("AI_STATUS_SQL", () => {
  it("mirrors the worker: 2 attempts, current versions, since the retry request", () => {
    expect(AI_STATUS_MAX_ATTEMPTS).toBe(2);
    expect(AI_STATUS_SQL).toContain("prompt_version = 'v1'");
    expect(AI_STATUS_SQL).toContain("schema_version = 'v1'");
    expect(AI_STATUS_SQL).toContain("ai_retry_requested_at");
    expect(AI_STATUS_SQL).toContain(">= 2");
  });
  it("checks entitlement first and never reads the original or GPS", () => {
    expect(AI_STATUS_SQL.indexOf("baby_ai_enabled")).toBeLessThan(
      AI_STATUS_SQL.indexOf("photo_ai"),
    );
    expect(AI_STATUS_SQL).not.toMatch(/photo_exif|gps|storage_key/i);
  });
});

describe("overrideChanges", () => {
  it("returns set / clear ops in field order, skipping absent keys", () => {
    const patch: PhotoAiOverridePatch = {
      search_tags: ["a"],
      caption: null,
    };
    expect(overrideChanges(patch)).toEqual([
      { field: "caption", op: "clear" },
      { field: "search_tags", op: "set", value: ["a"] },
    ]);
    expect(overrideChanges({ detailed_description: "x" })).toEqual([
      { field: "detailed_description", op: "set", value: "x" },
    ]);
    expect(overrideChanges({})).toEqual([]);
  });
});

describe("usageMonth", () => {
  it("defaults to the current UTC month and passes an explicit one through", () => {
    expect(usageMonth(undefined, new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    expect(usageMonth(undefined, new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
    expect(usageMonth("2025-02", new Date("2026-10-08T00:00:00Z"))).toBe("2025-02");
  });
});

describe("photoAiOverrides", () => {
  it("ignores non-overridable fields and values that fail their schema", async () => {
    const { tx } = fakeTx({
      overrides: [
        { field_path: "caption", value: "Mine" },
        { field_path: "objects", value: ["x"] },
        { field_path: "detailed_description", value: 12 },
        { field_path: "search_tags", value: ["A", "a"] },
      ],
    });
    expect(await photoAiOverrides(tx, PHOTO)).toEqual({ caption: "Mine", search_tags: ["a"] });
  });
});

describe("loadPhotoAi", () => {
  const ready = (over: Partial<Script> = {}) =>
    fakeTx({ aiRow: { description: sampleDescription(PHOTO) }, ...over });

  it("not_available / pending / queued / analyzing: no photo_ai read, no description", async () => {
    for (const status of ["not_available", "pending", "queued", "analyzing"]) {
      const { tx, sqls } = fakeTx();
      const block = await loadPhotoAi(tx, { photoId: PHOTO, aiStatus: status, isAdmin: true });
      expect(block).toMatchObject({
        status,
        description: null,
        raw: null,
        canRetry: false,
        failure: null,
      });
      expect(sqls.some((q) => q.includes("FROM public.photo_ai "))).toBe(false);
    }
  });

  it("failed: failure category, canRetry for admins only", async () => {
    const a = await loadPhotoAi(fakeTx({ failure: "refusal" }).tx, {
      photoId: PHOTO,
      aiStatus: "failed",
      isAdmin: true,
    });
    expect(a).toMatchObject({ status: "failed", failure: "refusal", canRetry: true });
    const c = await loadPhotoAi(fakeTx({ failure: "refusal" }).tx, {
      photoId: PHOTO,
      aiStatus: "failed",
      isAdmin: false,
    });
    expect(c).toMatchObject({ failure: "refusal", canRetry: false });
    const unknown = await loadPhotoAi(fakeTx({ failure: "made_up" }).tx, {
      photoId: PHOTO,
      aiStatus: "failed",
      isAdmin: true,
    });
    expect(unknown.failure).toBeNull();
  });

  it("ready: description, versions, analyzedAt; raw only for admins", async () => {
    const admin = await loadPhotoAi(ready().tx, {
      photoId: PHOTO,
      aiStatus: "ready",
      isAdmin: true,
    });
    expect(admin.description).toEqual(sampleDescription(PHOTO));
    expect(admin.raw).toEqual(admin.description);
    expect(admin).toMatchObject({
      model: "gpt-6-luna",
      promptVersion: "v1",
      schemaVersion: "v1",
      analyzedAt: "2026-10-01T12:00:00.000Z",
    });
    const member = await loadPhotoAi(ready().tx, {
      photoId: PHOTO,
      aiStatus: "ready",
      isAdmin: false,
    });
    expect(member.description).toEqual(admin.description);
    expect(member.raw).toBeNull();
  });

  it("overrides are applied to description but never to raw", async () => {
    const { tx } = ready({ overrides: [{ field_path: "caption", value: "Edited" }] });
    const b = await loadPhotoAi(tx, { photoId: PHOTO, aiStatus: "ready", isAdmin: true });
    expect(b.description?.caption).toBe("Edited");
    expect(b.raw?.caption).toBe(sampleDescription(PHOTO).caption);
    expect(b.overrides).toEqual({ caption: "Edited" });
    expect(aiDescriptionV1Schema.safeParse(b.description).success).toBe(true);
  });

  it("an invalid stored row gives description null and raw null, but keeps model and versions", async () => {
    const { tx } = fakeTx({ aiRow: { description: { caption: "legacy" }, schema_version: "v0" } });
    const b = await loadPhotoAi(tx, { photoId: PHOTO, aiStatus: "ready", isAdmin: true });
    expect(b).toMatchObject({
      status: "ready",
      description: null,
      raw: null,
      schemaVersion: "v0",
      model: "gpt-6-luna",
    });
  });

  it("a ready status with no row (race) degrades to an empty block", async () => {
    const { tx } = fakeTx();
    const b = await loadPhotoAi(tx, { photoId: PHOTO, aiStatus: "ready", isAdmin: true });
    expect(b).toMatchObject({ status: "ready", description: null, model: null });
  });

  it("never selects tokens, batch ids or storage keys", async () => {
    const { tx, sqls } = ready();
    await loadPhotoAi(tx, { photoId: PHOTO, aiStatus: "ready", isAdmin: true });
    for (const q of sqls)
      expect(q).not.toMatch(/input_tokens|output_tokens|batch_id|storage_key|gps/i);
  });
});
