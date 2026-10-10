import { randomUUID } from "node:crypto";
import { createFakeEmbedder, type Embedder, fakeDescription } from "@tinyglow/ai";
import { SEARCH_DOC_VERSION } from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, integrationEnv } from "../testing/harness";
import { recordingLog } from "../testing/stubs";
import { createSearchIndexer, type SearchIndexerConfig, sha256Hex } from "./search-index";

// The search indexer against real Postgres with the in-process fake embedder (docs/plans/step-7.md
// 2.12). The real SQL, the guard and cleanup triggers, RLS of `pipeline` and the ledger are
// exercised; no provider is reachable and no key is read.

const MODEL = "fake/1024";
const baseConfig: SearchIndexerConfig = {
  SEARCH_EMBED_BATCH: 100,
  embedModelTag: MODEL,
  docVersion: SEARCH_DOC_VERSION,
  AI_BABY_MONTHLY_BUDGET_USD: 3,
};

describe.skipIf(!integrationEnv)("search indexer (real database)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.admin
      .query("ALTER TABLE public.photos ENABLE TRIGGER photos_search_cleanup")
      .catch(() => undefined);
    await h?.close();
  });

  const embedSpy = vi.fn();
  function spyEmbedder(onEmbed?: () => Promise<void>): Embedder {
    const inner = createFakeEmbedder({ dims: 1024 });
    return {
      model: inner.model,
      dims: inner.dims,
      embed: async (texts) => {
        embedSpy(texts.length);
        await onEmbed?.();
        return inner.embed(texts);
      },
    };
  }

  function indexer(
    embedder: Embedder | null = spyEmbedder(),
    cfg: Partial<SearchIndexerConfig> = {},
  ) {
    const log = recordingLog();
    return {
      log,
      ix: createSearchIndexer({
        pool: h.workerPool,
        embedder,
        config: { ...baseConfig, ...cfg },
        log,
      }),
    };
  }

  /** An ingested photo with a (fake) AI description; returns its id. */
  async function photo(
    baby: { id: string; ownerId: string },
    o: {
      described?: boolean;
      approval?: "approved" | "pending";
      note?: string;
      people?: string[];
      location?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await h.seedUpload({
      baby,
      id,
      bytes: Buffer.alloc(16),
      noObject: true,
      status: "ingested",
      approval: o.approval ?? "approved",
    });
    if (o.described !== false) {
      await h.admin.query(
        `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description)
         VALUES ($1, 'fake', 'v1', 'v1', $2::jsonb)`,
        [id, JSON.stringify(fakeDescription(id))],
      );
    }
    if (o.note || o.people || o.location) {
      await h.admin.query(
        `INSERT INTO public.photo_details (photo_id, note, people, location_label, edited_by)
         VALUES ($1, $2, $3::text[], $4, $5)`,
        [id, o.note ?? null, o.people ?? [], o.location ?? null, baby.ownerId],
      );
    }
    return id;
  }

  const row = async (id: string) =>
    (
      await h.admin.query(
        `SELECT search_text, content_hash, embed_model, doc_version, embedded_at, taken_at, age_days,
                tags, people, place, vector_dims(embedding) AS dims, embedding IS NULL AS no_vector, updated_at, baby_id
           FROM public.photo_search WHERE photo_id = $1`,
        [id],
      )
    ).rows[0] as
      | {
          search_text: string;
          content_hash: string | null;
          embed_model: string | null;
          doc_version: string | null;
          embedded_at: Date | null;
          taken_at: Date | null;
          age_days: number | null;
          tags: string[];
          people: string[];
          place: string | null;
          dims: number | null;
          no_vector: boolean;
          updated_at: Date;
          baby_id: string;
        }
      | undefined;
  const spendRows = async (babyId: string) =>
    (
      await h.admin.query(
        "SELECT kind, user_id, ref_id, model, input_tokens, item_count, cost_usd FROM public.ai_spend WHERE baby_id = $1 ORDER BY created_at",
        [babyId],
      )
    ).rows;

  describe("reindex", () => {
    it("writes rows with 1024-dim vectors, hash, model tag, tags, taken_at = sort_at and spend rows", async () => {
      const baby = await h.baby();
      const a = await photo(baby, { people: ["Dad"], note: "first bath", location: "Home" });
      const b = await photo(baby);
      embedSpy.mockClear();
      const { ix } = indexer();
      const r = await ix.reindex([a, b], "details");
      expect(r).toMatchObject({
        requested: 2,
        written: 2,
        embedded: 2,
        unchanged: 0,
        skipped: 0,
        embedCalls: 1,
      });
      expect(embedSpy).toHaveBeenCalledTimes(1);
      const ra = await row(a);
      expect(ra?.dims).toBe(1024);
      expect(ra?.embed_model).toBe(MODEL);
      expect(ra?.doc_version).toBe(SEARCH_DOC_VERSION);
      expect(ra?.content_hash).toBe(sha256Hex(ra?.search_text ?? ""));
      expect(ra?.embedded_at).toBeInstanceOf(Date);
      expect(ra?.people).toEqual(["Dad"]);
      expect(ra?.place).toBe("home");
      expect(ra?.search_text).toContain('Note from parent: "first bath"');
      expect(ra?.tags.length).toBeGreaterThan(0);
      const sortAt = (await h.admin.query("SELECT sort_at FROM public.photos WHERE id = $1", [a]))
        .rows[0].sort_at as Date;
      expect(ra?.taken_at?.getTime()).toBe(sortAt.getTime());
      // search_tags of the description became tags
      const desc = fakeDescription(a);
      for (const t of desc.search_tags.slice(0, 3)) expect(ra?.tags).toContain(t.toLowerCase());
      // the baby's name is not in the document
      expect(ra?.search_text).not.toContain("W,");
      // one spend row for the call, kind embed, no user, priced
      const spend = await spendRows(baby.id);
      expect(spend).toHaveLength(1);
      expect(spend[0]).toMatchObject({
        kind: "embed",
        user_id: null,
        ref_id: null,
        model: "fake",
        item_count: 2,
      });
      expect(Number(spend[0].cost_usd)).toBeGreaterThan(0);
      expect(spend[0].input_tokens).toBeGreaterThan(0);
      const month = await h.admin.query(
        "SELECT public.ai_baby_month_cost_usd($1, now()::date) AS c",
        [baby.id],
      );
      expect(Number(month.rows[0].c)).toBeCloseTo(Number(spend[0].cost_usd), 8);
    });

    it("unchanged hashes skip the embedding call and only touch updated_at", async () => {
      const baby = await h.baby();
      const a = await photo(baby);
      const { ix } = indexer();
      await ix.reindex([a], "details");
      const before = await row(a);
      embedSpy.mockClear();
      await new Promise((r) => setTimeout(r, 20));
      const again = await ix.reindex([a], "details");
      expect(again).toMatchObject({ unchanged: 1, written: 0, embedded: 0, embedCalls: 0 });
      expect(embedSpy).not.toHaveBeenCalled();
      const after = await row(a);
      expect(after?.content_hash).toBe(before?.content_hash);
      expect(after?.updated_at.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? 0);
      expect(await spendRows(baby.id)).toHaveLength(1);
    });

    it("a NULL hash is re-embedded; an edited note changes the hash", async () => {
      const baby = await h.baby();
      const a = await photo(baby, { note: "one" });
      const { ix } = indexer();
      await ix.reindex([a], "details");
      const first = await row(a);
      await h.admin.query(
        "UPDATE public.photo_search SET content_hash = NULL WHERE photo_id = $1",
        [a],
      );
      embedSpy.mockClear();
      expect((await ix.reindex([a], "details")).embedded).toBe(1);
      expect(embedSpy).toHaveBeenCalledTimes(1);
      expect((await row(a))?.content_hash).toBe(first?.content_hash);
      await h.admin.query("UPDATE public.photo_details SET note = 'two' WHERE photo_id = $1", [a]);
      await ix.reindex([a], "details");
      const edited = await row(a);
      expect(edited?.content_hash).not.toBe(first?.content_hash);
      expect(edited?.search_text).toContain('"two"');
    });

    it("a free baby is never indexed: no embedding call, no row, no spend, also via reconcile and backfill", async () => {
      const free = await h.baby({ plan: "free" });
      const a = await photo(free, { described: false });
      const paid = await h.baby();
      const b = await photo(paid);
      const { ix } = indexer();
      embedSpy.mockClear();
      const r = await ix.reindex([a], "backfill");
      expect(r).toMatchObject({ written: 0, embedded: 0, skipped: 1, embedCalls: 0 });
      expect(embedSpy).not.toHaveBeenCalled();
      expect(await row(a)).toBeUndefined();
      await ix.reconcile();
      await ix.backfill({ reason: "manual" });
      await ix.backfill({ reason: "upgrade", babyId: free.id });
      expect(await row(a)).toBeUndefined();
      expect(await spendRows(free.id)).toEqual([]);
      // the paid baby next door was indexed by the same sweeps
      expect(await row(b)).toBeDefined();
    });

    it("a downgrade keeps the rows hidden and touches nothing; re-upgrade restores without re-embedding", async () => {
      const baby = await h.baby();
      const a = await photo(baby);
      const { ix } = indexer();
      await ix.reindex([a], "details");
      await h.admin.query("UPDATE public.babies SET plan = 'free' WHERE id = $1", [baby.id]);
      embedSpy.mockClear();
      const r = await ix.reindex([a], "details");
      expect(r).toMatchObject({ skipped: 1, written: 0 });
      expect(await row(a)).toBeDefined();
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [baby.id]);
      expect((await ix.reindex([a], "details")).unchanged).toBe(1);
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("a pending photo is not indexed; a photo that stops being live loses its row", async () => {
      const baby = await h.baby();
      const pending = await photo(baby, { approval: "pending" });
      const live = await photo(baby);
      const { ix } = indexer();
      await ix.reindex([pending, live], "details");
      expect(await row(pending)).toBeUndefined();
      expect(await row(live)).toBeDefined();
      await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [live]);
      // the cleanup trigger already removed it; the indexer copes with that
      const r = await ix.reindex([live], "details");
      expect(r.written).toBe(0);
      expect(await row(live)).toBeUndefined();
    });

    it("a photo trashed while the batch is being embedded does not abort the batch", async () => {
      const baby = await h.baby();
      const keep = await photo(baby);
      const doomed = await photo(baby);
      const also = await photo(baby);
      const { ix, log } = indexer(
        spyEmbedder(async () => {
          await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [
            doomed,
          ]);
        }),
      );
      const r = await ix.reindex([keep, doomed, also], "details");
      expect(r.written).toBe(2);
      expect(r.skipped).toBe(1);
      expect(await row(doomed)).toBeUndefined();
      expect(await row(keep)).toBeDefined();
      expect(await row(also)).toBeDefined();
      expect(log.lines.filter((l) => l.level === "error")).toEqual([]);
    });

    it("over the monthly budget: rows are written without vectors, no embedding call, one audit row", async () => {
      const baby = await h.baby();
      const a = await photo(baby);
      const b = await photo(baby);
      await h.admin.query(
        "INSERT INTO public.ai_spend (baby_id, kind, model, cost_usd) VALUES ($1, 'embed', 'fake', 3.5)",
        [baby.id],
      );
      const { ix, log } = indexer();
      embedSpy.mockClear();
      const r = await ix.reindex([a, b], "details");
      expect(r).toMatchObject({ overBudget: 2, written: 2, embedded: 0, embedCalls: 0 });
      expect(embedSpy).not.toHaveBeenCalled();
      expect((await row(a))?.no_vector).toBe(true);
      expect((await row(a))?.search_text.length).toBeGreaterThan(10); // keyword search keeps working
      // a second call in the same month: still one audit row
      await ix.reindex([a], "details");
      const audit = await h.admin.query(
        "SELECT metadata FROM public.audit_log WHERE baby_id = $1 AND event = 'ai.budget_exceeded'",
        [baby.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].metadata.month).toBe(new Date().toISOString().slice(0, 7));
      expect(log.lines.some((l) => l.level === "warn")).toBe(true);
      // no extra spend row was written for the skipped embedding
      expect(await spendRows(baby.id)).toHaveLength(1);
    });

    it("without an embedder: NULL vectors, then filled by a later reconcile once one exists", async () => {
      const baby = await h.baby();
      const a = await photo(baby);
      const b = await photo(baby);
      const none = indexer(null);
      const r = await none.ix.reindex([a, b], "details");
      expect(r).toMatchObject({ written: 2, embedded: 0 });
      expect((await row(a))?.no_vector).toBe(true);
      expect((await row(a))?.embed_model).toBe(MODEL); // the model the rows are waiting for
      expect(none.log.lines.filter((l) => l.msg.includes("embeddings skipped"))).toHaveLength(1);
      // no key: the reconcile has nothing it may do for vector-only gaps
      const idle = await none.ix.reconcile();
      expect(idle.reindexed).toBe(0);
      // a key appears
      const withKey = indexer();
      const rec = await withKey.ix.backfill({ reason: "upgrade", babyId: baby.id });
      expect(rec.embedded).toBe(2);
      expect((await row(a))?.dims).toBe(1024);
      expect((await row(b))?.dims).toBe(1024);
    });

    it("never selects or stores a coordinate: the document has none even with GPS in EXIF", async () => {
      const baby = await h.baby({ home: { lat: 47.6062, lng: -122.3321 } });
      const a = await photo(baby, { location: "Seattle" });
      await h.insertEncryptedExif(a, {
        takenAt: "2026-06-10T14:30:00Z",
        tzOffsetMinutes: -420,
        lat: 47.6062,
        lng: -122.3321,
        placeLabel: "Seattle area",
      });
      await indexer().ix.reindex([a], "details");
      const r = await row(a);
      expect(r?.search_text).not.toMatch(/47\.6|122\.3/);
      // the parents' label wins over EXIF's place label
      expect(r?.place).toBe("seattle");
      expect(r?.search_text).toContain("2026-06-10");
    });
  });

  describe("reconcile and backfill", () => {
    it("a details edit makes the photo stale; the reconcile rebuilds it and the hash changes", async () => {
      const baby = await h.baby();
      const a = await photo(baby, { note: "before" });
      const { ix } = indexer();
      await ix.reindex([a], "details");
      const first = await row(a);
      await new Promise((r) => setTimeout(r, 20));
      await h.admin.query("UPDATE public.photo_details SET note = 'after' WHERE photo_id = $1", [
        a,
      ]);
      const stale = await h.admin.query(
        "SELECT * FROM public.search_stale_photos(NULL, $1, $2, $3)",
        [MODEL, SEARCH_DOC_VERSION, baby.id],
      );
      expect(stale.rows).toEqual([{ photo_id: a, baby_id: baby.id, reason: "stale" }]);
      const r = await ix.reconcile();
      expect(r.reindexed).toBeGreaterThanOrEqual(1);
      const second = await row(a);
      expect(second?.content_hash).not.toBe(first?.content_hash);
      expect(second?.search_text).toContain('"after"');
      expect(
        (
          await h.admin.query("SELECT * FROM public.search_stale_photos(NULL, $1, $2, $3)", [
            MODEL,
            SEARCH_DOC_VERSION,
            baby.id,
          ])
        ).rows,
      ).toEqual([]);
    });

    it("an override of the caption changes the document (overrides win)", async () => {
      const baby = await h.baby();
      const a = await photo(baby);
      const { ix } = indexer();
      await ix.reindex([a], "details");
      await new Promise((r) => setTimeout(r, 20));
      await h.admin.query(
        "INSERT INTO public.photo_ai_overrides (photo_id, field_path, value, edited_by) VALUES ($1, 'caption', '\"Override caption marker\"', $2)",
        [a, baby.ownerId],
      );
      await ix.reconcile();
      expect((await row(a))?.search_text).toContain("Override caption marker");
    });

    it("trashing a photo removes the row; a surviving orphan (trigger off) is swept by the reconcile", async () => {
      const baby = await h.baby();
      const a = await photo(baby);
      const b = await photo(baby);
      const { ix } = indexer();
      await ix.reindex([a, b], "details");
      await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [a]);
      expect(await row(a)).toBeUndefined();
      await h.admin.query("ALTER TABLE public.photos DISABLE TRIGGER photos_search_cleanup");
      try {
        await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [b]);
        expect(await row(b)).toBeDefined();
        const r = await ix.reconcile();
        expect(r.orphansDeleted).toBeGreaterThanOrEqual(1);
        expect(await row(b)).toBeUndefined();
      } finally {
        await h.admin.query("ALTER TABLE public.photos ENABLE TRIGGER photos_search_cleanup");
      }
    });

    it("an upgrade backfill indexes a baby that was free until now", async () => {
      const baby = await h.baby({ plan: "free" });
      const ids = [
        await photo(baby, { described: false }),
        await photo(baby, { described: false }),
        await photo(baby, { described: false }),
      ];
      const { ix } = indexer();
      expect((await ix.backfill({ reason: "upgrade", babyId: baby.id })).reindexed).toBe(0);
      for (const id of ids) expect(await row(id)).toBeUndefined();
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [baby.id]);
      const r = await ix.backfill({ reason: "upgrade", babyId: baby.id });
      expect(r.reindexed).toBe(3);
      expect(r.embedded).toBe(3);
      for (const id of ids) expect((await row(id))?.dims).toBe(1024);
      // idempotent: a second run finds nothing to do
      const again = await ix.backfill({ reason: "upgrade", babyId: baby.id });
      expect(again.reindexed).toBe(0);
      embedSpy.mockClear();
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("a model change re-embeds every row of the baby", async () => {
      const baby = await h.baby();
      const a = await photo(baby);
      await indexer().ix.reindex([a], "details");
      embedSpy.mockClear();
      const next = indexer(spyEmbedder(), { embedModelTag: "fake/1024-v2" });
      const r = await next.ix.backfill({ reason: "model", babyId: baby.id });
      expect(r.embedded).toBe(1);
      expect((await row(a))?.embed_model).toBe("fake/1024-v2");
    });

    it("stats count stale/missing photos and rows without a vector", async () => {
      const baby = await h.baby();
      const a = await photo(baby);
      const none = indexer(null);
      await none.ix.reindex([a], "details");
      const s = await none.ix.stats();
      expect(s.unembedded).toBeGreaterThanOrEqual(1);
      expect(s.stale).toBeGreaterThanOrEqual(0);
    });
  });

  describe("privacy", () => {
    it("logs never contain notes, documents or vectors", async () => {
      const baby = await h.baby();
      const a = await photo(baby, {
        note: "PRIVATE-NOTE-SENTINEL-8812",
        location: "SECRET-PLACE-8812",
      });
      const { ix, log } = indexer();
      await ix.reindex([a], "details");
      await ix.reconcile();
      const dump = JSON.stringify(log.lines);
      expect(dump).not.toContain("SENTINEL-8812");
      expect(dump).not.toContain("SECRET-PLACE");
      expect(dump).not.toMatch(/-?0\.\d+,-?0\.\d+,-?0\.\d+/);
    });
  });
});
