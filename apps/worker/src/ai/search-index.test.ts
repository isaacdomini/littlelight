import { createFakeEmbedder, type Embedder } from "@tinyglow/ai";
import { buildSearchDocument, SEARCH_DOC_VERSION } from "@tinyglow/shared";
import { describe, expect, it, vi } from "vitest";
import { type QueryResult, recordingLog, scriptedPool } from "../testing/stubs";
import {
  BABY_MONTH_COST_SQL,
  DELETE_SEARCH_SQL,
  INSERT_EMBED_SPEND_SQL,
  ORPHANS_SQL,
  RECORD_BUDGET_EXCEEDED_SQL,
  SEARCH_DOC_SQL,
  type SearchDocRow,
  STALE_SQL,
  STATS_SQL,
  TOUCH_SEARCH_SQL,
  toDocumentInput,
  UPSERT_SEARCH_SQL,
} from "./search-doc-sql";
import {
  createSearchIndexer,
  RECONCILE_CHUNK,
  type SearchIndexerConfig,
  sha256Hex,
} from "./search-index";

// The indexer's decisions with a scripted pool (docs/plans/step-7.md 2.12). The real SQL, the
// guard trigger and the fake embedder against Postgres are in search-index.integration.test.ts.

const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BABY = "11111111-1111-4111-8111-111111111111";
const BABY2 = "22222222-2222-4222-8222-222222222222";
const MODEL = "fake/1024";
const config: SearchIndexerConfig = {
  SEARCH_EMBED_BATCH: 100,
  embedModelTag: MODEL,
  docVersion: SEARCH_DOC_VERSION,
  AI_BABY_MONTHLY_BUDGET_USD: 3,
};

function row(n: number, over: Partial<SearchDocRow> = {}): SearchDocRow {
  return {
    photo_id: P(n),
    baby_id: BABY,
    ai_enabled: true,
    live: true,
    status: "ingested",
    age_days: 100 + n,
    taken_at: new Date("2026-06-10T12:00:00Z"),
    taken_at_estimated: false,
    sort_at: new Date("2026-06-10T12:00:00Z"),
    is_sensitive: false,
    exif_taken_at: null,
    tz_offset_minutes: null,
    place_label: null,
    milestone_id: null,
    milestone_name: null,
    people: ["Dad"],
    note: `note ${n}`,
    location_label: "Home",
    description: null,
    overrides: null,
    measurements: null,
    has_row: false,
    has_vector: false,
    content_hash: null,
    embed_model: null,
    doc_version: null,
    ...over,
  };
}

const hashOf = (r: SearchDocRow) => sha256Hex(buildSearchDocument(toDocumentInput(r)).text);

interface World {
  rows: SearchDocRow[];
  spent?: Record<string, number>;
  stale?: { photo_id: string; baby_id: string; reason: string }[][];
  orphans?: string[][];
}

function setup(
  world: World,
  embedder: Embedder | null = createFakeEmbedder({ dims: 1024 }),
  cfg: Partial<SearchIndexerConfig> = {},
) {
  const upserts: unknown[][] = [];
  const touches: unknown[][] = [];
  const deletes: unknown[][] = [];
  const spends: unknown[][] = [];
  const budgetRecords: unknown[][] = [];
  const staleCalls: unknown[][] = [];
  let staleRound = 0;
  let orphanRound = 0;
  let budgetAlertRecorded = false;
  const embedSpy = vi.fn();
  const wrapped: Embedder | null = embedder
    ? {
        model: embedder.model,
        dims: embedder.dims,
        embed: async (texts) => {
          embedSpy(texts);
          return embedder.embed(texts);
        },
      }
    : null;
  const pool = scriptedPool({
    [SEARCH_DOC_SQL]: (params): QueryResult => {
      const ids = params[0] as string[];
      return { rows: world.rows.filter((r) => ids.includes(r.photo_id)) };
    },
    [BABY_MONTH_COST_SQL]: (params): QueryResult => ({
      rows: [{ spent: world.spent?.[params[0] as string] ?? 0 }],
    }),
    [RECORD_BUDGET_EXCEEDED_SQL]: (params): QueryResult => {
      budgetRecords.push(params);
      const inserted = !budgetAlertRecorded;
      budgetAlertRecorded = true;
      return { rows: [{ inserted }] };
    },
    [UPSERT_SEARCH_SQL]: (params): QueryResult => {
      upserts.push(params);
      return { rowCount: (params[0] as string[]).length, rows: [] };
    },
    [TOUCH_SEARCH_SQL]: (params): QueryResult => {
      touches.push(params);
      return { rowCount: (params[0] as string[]).length, rows: [] };
    },
    [DELETE_SEARCH_SQL]: (params): QueryResult => {
      deletes.push(params);
      return { rowCount: (params[0] as string[]).length, rows: [] };
    },
    [INSERT_EMBED_SPEND_SQL]: (params): QueryResult => {
      spends.push(params);
      return { rowCount: 1, rows: [] };
    },
    [STALE_SQL]: (params): QueryResult => {
      staleCalls.push(params);
      return { rows: world.stale?.[staleRound++] ?? [] };
    },
    [ORPHANS_SQL]: (): QueryResult => ({
      rows: (world.orphans?.[orphanRound++] ?? []).map((photo_id) => ({ photo_id })),
    }),
    [STATS_SQL]: (): QueryResult => ({ rows: [{ stale: 2, unembedded: 5 }] }),
  });
  const log = recordingLog();
  const indexer = createSearchIndexer({
    pool,
    embedder: wrapped,
    config: { ...config, ...cfg },
    log,
    now: () => new Date("2026-10-09T10:00:00Z"),
  });
  return {
    indexer,
    pool,
    log,
    embedSpy,
    upserts,
    touches,
    deletes,
    spends,
    budgetRecords,
    staleCalls,
  };
}

describe("reindex: the free tier", () => {
  it("a photo of a baby without the entitlement is skipped: no embed call, no row, no spend", async () => {
    const w = setup({
      rows: [row(1, { ai_enabled: false }), row(2, { ai_enabled: false, has_row: true })],
    });
    const r = await w.indexer.reindex([P(1), P(2)], "details");
    expect(w.embedSpy).not.toHaveBeenCalled();
    expect(w.upserts).toEqual([]);
    expect(w.deletes).toEqual([]); // a downgraded baby keeps its rows
    expect(w.spends).toEqual([]);
    expect(w.touches).toEqual([]);
    expect(r).toMatchObject({ requested: 2, written: 0, embedded: 0, skipped: 2 });
  });

  it("only the paid photos of a mixed batch are embedded", async () => {
    const w = setup({ rows: [row(1, { ai_enabled: false }), row(2)] });
    const r = await w.indexer.reindex([P(1), P(2)], "backfill");
    expect(w.embedSpy).toHaveBeenCalledTimes(1);
    expect(w.embedSpy.mock.calls[0]?.[0]).toHaveLength(1);
    expect((w.upserts[0]?.[0] as string[]) ?? []).toEqual([P(2)]);
    expect(r).toMatchObject({ written: 1, embedded: 1, skipped: 1 });
  });

  it("an id the database does not know is skipped", async () => {
    const w = setup({ rows: [] });
    expect((await w.indexer.reindex([P(9)], "details")).skipped).toBe(1);
  });
});

describe("reindex: liveness", () => {
  it("a photo that may no longer be indexed loses its row; without a row it is just skipped", async () => {
    const w = setup({ rows: [row(1, { live: false, has_row: true }), row(2, { live: false })] });
    const r = await w.indexer.reindex([P(1), P(2)], "details");
    expect(w.deletes[0]).toEqual([[P(1)]]);
    expect(w.embedSpy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deleted: 1, skipped: 1, written: 0 });
  });
});

describe("reindex: unchanged documents", () => {
  it("equal hash, model, version and a vector: no embed call, only a touch", async () => {
    const r1 = row(1);
    const full = row(1, {
      has_row: true,
      has_vector: true,
      content_hash: hashOf(r1),
      embed_model: MODEL,
      doc_version: SEARCH_DOC_VERSION,
    });
    const w = setup({ rows: [full] });
    const r = await w.indexer.reindex([P(1)], "details");
    expect(w.embedSpy).not.toHaveBeenCalled();
    expect(w.touches[0]).toEqual([[P(1)]]);
    expect(w.upserts).toEqual([]);
    expect(w.spends).toEqual([]);
    expect(r).toMatchObject({ unchanged: 1, written: 0, embedCalls: 0 });
  });

  it.each([
    ["a changed hash (parent edited the note)", { content_hash: "other" }],
    ["a NULL hash (a source row was deleted)", { content_hash: null }],
    ["another embedding model", { embed_model: "text-embedding-3-small/1024" }],
    ["another document version", { doc_version: "v0" }],
    ["a missing vector", { has_vector: false }],
  ])("%s is re-embedded", async (_n, patch) => {
    const base = row(1);
    const full = row(1, {
      has_row: true,
      has_vector: true,
      content_hash: hashOf(base),
      embed_model: MODEL,
      doc_version: SEARCH_DOC_VERSION,
      ...patch,
    });
    const w = setup({ rows: [full] });
    const r = await w.indexer.reindex([P(1)], "details");
    expect(w.embedSpy).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ written: 1, embedded: 1, unchanged: 0 });
  });

  it("without an embedder a row that only lacks a vector is left alone", async () => {
    const base = row(1);
    const full = row(1, {
      has_row: true,
      has_vector: false,
      content_hash: hashOf(base),
      embed_model: MODEL,
      doc_version: SEARCH_DOC_VERSION,
    });
    const w = setup({ rows: [full] }, null);
    const r = await w.indexer.reindex([P(1)], "details");
    expect(r).toMatchObject({ unchanged: 1, written: 0 });
  });

  it("the hash is the sha256 of the document text, which the upsert stores", async () => {
    const r1 = row(1);
    const w = setup({ rows: [r1] });
    await w.indexer.reindex([P(1)], "details");
    const [ids, texts, hashes] = w.upserts[0] as [string[], string[], string[]];
    expect(ids).toEqual([P(1)]);
    expect(hashes[0]).toBe(sha256Hex(texts[0] as string));
    expect(hashes[0]).toBe(hashOf(r1));
    expect(texts[0]).toContain("Note from parent");
  });
});

describe("reindex: no embedder", () => {
  it("writes the rows with NULL vectors and logs the missing key once per process", async () => {
    const w = setup({ rows: [row(1), row(2)] }, null);
    const r = await w.indexer.reindex([P(1), P(2)], "details");
    expect(w.upserts[0]?.[4]).toEqual([null, null]);
    expect(r).toMatchObject({ written: 2, embedded: 0, embedCalls: 0 });
    await w.indexer.reindex([P(1)], "details");
    const notes = w.log.lines.filter((l) => l.msg.includes("embeddings skipped"));
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(w.log.lines)).not.toMatch(/sk-/);
    // the row says which model a later reconcile has to match
    expect(w.upserts[0]?.[9]).toBe(MODEL);
    expect(w.upserts[0]?.[10]).toBe(SEARCH_DOC_VERSION);
  });
});

describe("reindex: embedding calls and spend", () => {
  it("embeds in chunks of SEARCH_EMBED_BATCH and writes vectors of the right width", async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(n));
    const w = setup({ rows }, undefined, { SEARCH_EMBED_BATCH: 2 });
    const r = await w.indexer.reindex(
      rows.map((x) => x.photo_id),
      "backfill",
    );
    expect(w.embedSpy.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([2, 2, 1]);
    expect(r.embedCalls).toBe(3);
    const vectors = w.upserts[0]?.[4] as string[];
    expect(vectors).toHaveLength(5);
    for (const v of vectors)
      expect(v.startsWith("[") && v.endsWith("]") && v.split(",").length === 1024).toBe(true);
  });

  it("records one ai_spend embed row per baby per call, with tokens, items and cost", async () => {
    const rows = [row(1), row(2), row(3, { baby_id: BABY2 })];
    const w = setup({ rows });
    const r = await w.indexer.reindex(
      rows.map((x) => x.photo_id),
      "backfill",
    );
    expect(w.spends).toHaveLength(2);
    const byBaby = Object.fromEntries(w.spends.map((s) => [s[0] as string, s]));
    expect(byBaby[BABY]?.[3]).toBe(2); // items
    expect(byBaby[BABY2]?.[3]).toBe(1);
    expect(byBaby[BABY]?.[1]).toBe("fake");
    const total = w.spends.reduce((n, s) => n + (s[4] as number), 0);
    expect(total).toBeCloseTo(r.costUsd, 8);
    const tokens = w.spends.reduce((n, s) => n + (s[2] as number), 0);
    expect(Math.abs(tokens - r.inputTokens)).toBeLessThanOrEqual(1);
    expect(w.spends.every((s) => (s[4] as number) > 0)).toBe(true);
  });

  it("a vector of the wrong width is not stored", async () => {
    const bad: Embedder = {
      model: "fake",
      dims: 1024,
      embed: async (texts) => ({
        vectors: texts.map(() => [1, 2, 3]),
        usage: { inputTokens: 1, costUsd: 0.001 },
      }),
    };
    const w = setup({ rows: [row(1)] }, bad);
    const r = await w.indexer.reindex([P(1)], "details");
    expect(w.upserts[0]?.[4]).toEqual([null]);
    expect(r.embedded).toBe(0);
    expect(r.written).toBe(1);
  });

  it("de-duplicates ids and does nothing for an empty list", async () => {
    const w = setup({ rows: [row(1)] });
    expect((await w.indexer.reindex([P(1), P(1), P(1)], "details")).requested).toBe(1);
    const before = w.pool.log.length;
    const r = await w.indexer.reindex([], "details");
    expect(r).toMatchObject({ requested: 0, written: 0 });
    expect(w.pool.log.length).toBe(before);
  });

  it("a provider failure propagates (pg-boss retries) and writes nothing", async () => {
    const broken: Embedder = {
      model: "fake",
      dims: 1024,
      embed: async () => {
        throw new Error("provider down");
      },
    };
    const w = setup({ rows: [row(1)] }, broken);
    await expect(w.indexer.reindex([P(1)], "details")).rejects.toThrow("provider down");
    expect(w.upserts).toEqual([]);
    expect(w.spends).toEqual([]);
  });
});

describe("reindex: the monthly budget", () => {
  it("over budget: rows are written without vectors, no embed call, one audit record, a warn", async () => {
    const w = setup({ rows: [row(1), row(2)], spent: { [BABY]: 3 } });
    const r = await w.indexer.reindex([P(1), P(2)], "details");
    expect(w.embedSpy).not.toHaveBeenCalled();
    expect(w.upserts[0]?.[4]).toEqual([null, null]);
    expect(r).toMatchObject({ overBudget: 2, written: 2, embedded: 0, embedCalls: 0 });
    expect(w.spends).toEqual([]);
    expect(w.budgetRecords).toEqual([[BABY, "2026-10"]]);
    const warn = w.log.lines.find((l) => l.level === "warn");
    expect(warn?.obj).toMatchObject({ babyId: BABY, month: "2026-10", docs: 2 });
  });

  it("is per baby: the other baby is still embedded", async () => {
    const w = setup({ rows: [row(1), row(2, { baby_id: BABY2 })], spent: { [BABY]: 5 } });
    const r = await w.indexer.reindex([P(1), P(2)], "details");
    expect(r).toMatchObject({ overBudget: 1, embedded: 1, written: 2 });
    expect(w.embedSpy.mock.calls[0]?.[0]).toHaveLength(1);
    expect(w.spends.map((s) => s[0])).toEqual([BABY2]);
  });

  it("exactly at the budget is allowed", async () => {
    // one document's estimate puts the total exactly at the budget
    const w = setup({ rows: [row(1)], spent: { [BABY]: 0 } }, undefined, {
      AI_BABY_MONTHLY_BUDGET_USD: 1,
    });
    expect((await w.indexer.reindex([P(1)], "details")).overBudget).toBe(0);
  });

  it("the budget is not checked without an embedder", async () => {
    const w = setup({ rows: [row(1)], spent: { [BABY]: 100 } }, null);
    expect((await w.indexer.reindex([P(1)], "details")).overBudget).toBe(0);
    expect(w.budgetRecords).toEqual([]);
  });
});

describe("reindex: privacy of logs", () => {
  it("logs ids, counts and reasons only: never a note, a document or a vector", async () => {
    const w = setup({
      rows: [row(1, { note: "PRIVATE-NOTE-SENTINEL", location_label: "SECRET-PLACE-SENTINEL" })],
    });
    await w.indexer.reindex([P(1)], "details");
    const dump = JSON.stringify(w.log.lines);
    expect(dump).not.toContain("PRIVATE-NOTE-SENTINEL");
    expect(dump).not.toContain("SECRET-PLACE-SENTINEL");
    expect(dump).not.toMatch(/\[0\.\d/);
    const line = w.log.lines.find((l) => l.msg === "search: reindexed");
    expect(Object.keys(line?.obj ?? {}).sort()).toEqual([
      "costUsd",
      "deleted",
      "embedCalls",
      "embedded",
      "inputTokens",
      "ms",
      "overBudget",
      "reason",
      "requested",
      "skipped",
      "unchanged",
      "written",
    ]);
  });

  it("runs every statement as pipeline without the data key", async () => {
    const w = setup({ rows: [row(1)] });
    await w.indexer.reindex([P(1)], "details");
    expect(w.pool.log.some(([sql]) => sql === "SET LOCAL ROLE pipeline")).toBe(true);
    expect(w.pool.log.some(([sql]) => sql.includes("app.data_key"))).toBe(false);
    for (const [sql] of w.pool.log) {
      expect(sql).not.toMatch(/gps_|raw_json|babies\.name|b\.name/);
    }
  });

  it("builds documents without the baby's name", async () => {
    const w = setup({ rows: [row(1)] });
    await w.indexer.reindex([P(1)], "details");
    // the doc SQL does not select babies at all
    expect(SEARCH_DOC_SQL).not.toMatch(/FROM babies|JOIN babies/);
  });
});

describe("reconcile and backfill", () => {
  it("reindexes stale photos in chunks of 50, each photo at most once, and deletes orphans", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => P(i + 1));
    const w = setup({
      rows: ids.map((id, i) => row(i + 1, { photo_id: id })),
      stale: [
        ids.map((photo_id) => ({ photo_id, baby_id: BABY, reason: "stale" })),
        ids.map((photo_id) => ({ photo_id, baby_id: BABY, reason: "stale" })),
        [],
      ],
      orphans: [[P(900)]],
    });
    const r = await w.indexer.reconcile({ limit: 500 });
    expect(r.reindexed).toBe(120);
    expect(r.orphansDeleted).toBe(1);
    expect(w.deletes.some((d) => (d[0] as string[]).includes(P(900)))).toBe(true);
    // 120 photos => chunks of 50, 50, 20
    expect(RECONCILE_CHUNK).toBe(50);
    expect(w.embedSpy.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([50, 50, 20]);
    // the second round saw the same photos and did not repeat them
    expect(r.rounds).toBeGreaterThanOrEqual(2);
  });

  it("stale lookups carry the embed model tag and the document version", async () => {
    const w = setup({ rows: [] });
    await w.indexer.reconcile();
    expect(w.staleCalls[0]).toEqual([500, MODEL, SEARCH_DOC_VERSION, null]);
  });

  it("without an embedder, photos that only lack a vector are not retried", async () => {
    const w = setup(
      { rows: [row(1)], stale: [[{ photo_id: P(1), baby_id: BABY, reason: "unembedded" }]] },
      null,
    );
    const r = await w.indexer.reconcile();
    expect(r.reindexed).toBe(0);
  });

  it("a backfill for one baby passes the baby id and skips the global orphan sweep", async () => {
    const w = setup({ rows: [], orphans: [[P(900)]] });
    await w.indexer.backfill({ reason: "upgrade", babyId: BABY });
    expect(w.staleCalls[0]?.[3]).toBe(BABY);
    expect(w.deletes).toEqual([]);
  });

  it("a global backfill also sweeps orphans", async () => {
    const w = setup({ rows: [], orphans: [[P(900)]] });
    const r = await w.indexer.backfill({ reason: "manual" });
    expect(r.orphansDeleted).toBe(1);
  });

  it("stats are the two counts", async () => {
    const w = setup({ rows: [] });
    expect(await w.indexer.stats()).toEqual({ stale: 2, unembedded: 5 });
  });
});
