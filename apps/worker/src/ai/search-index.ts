import { createHash } from "node:crypto";
import type { Embedder } from "@littlelight/ai";
import {
  AI_PIPELINE_DEFAULTS,
  buildSearchDocument,
  EMBED_COST_PER_DOC_ESTIMATE_USD,
  type ReindexReason,
  type SearchBackfillJob,
  type SearchDocument,
} from "@littlelight/shared";
import { type PipelinePool, runAsPipeline } from "../db";
import type { WorkerLog } from "../log-types";
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

// Search indexer (docs/plans/step-7.md 2.6; PRD FR-6.3/6.4 "search document embedded + tsvector",
// "AI pipeline" stage 5 "Embed"). Serves `photo.reindex` (batches of 25), the hourly
// `search.reconcile` and `search.backfill`.
//
// reindex(ids): tx 1 (pipeline, no data key) reads everything with `SEARCH_DOC_SQL`; photos of a
// baby that is not `baby_ai_enabled` are skipped WITHOUT any embedding call and without touching
// their row (a downgraded baby keeps its rows, hidden by RLS, live again on re-upgrade); photos
// that may no longer be indexed (trashed, pending, rejected, quarantined, failed) lose their row.
// Documents are built with `buildSearchDocument` (no baby name, no coordinates, overrides win);
// a row whose `content_hash`, `embed_model` and `doc_version` already match (and that has a
// vector, or there is no embedder) is only touched. The per-baby monthly budget (vision + spend
// so far + this call's estimate) is checked: over budget ⇒ the row is written without a vector and
// `ai.budget_exceeded` is recorded once per month (text search keeps working). Outside any
// transaction the rest is embedded in chunks of `SEARCH_EMBED_BATCH`; tx 2 upserts the rows and
// one `ai_spend` (kind embed) row per baby per call. No embedder (no key) ⇒ rows are written with
// NULL vectors and one log line per process; the reconcile fills them once a key appears.
//
// Logs: ids, counts, token counts, cost, durations, reasons. Never a document, a note, a caption
// or a vector.

export interface SearchIndexerConfig {
  SEARCH_EMBED_BATCH: number;
  /** `photo_search.embed_model` of rows written now (`embedModelTag(embedder)`, e.g. `fake/1024`). */
  embedModelTag: string;
  /** `SEARCH_DOC_VERSION`. */
  docVersion: string;
  /** Per-baby monthly AI budget (default `AI_PIPELINE_DEFAULTS.AI_BABY_MONTHLY_BUDGET_USD`, $3). */
  AI_BABY_MONTHLY_BUDGET_USD?: number;
}

export interface SearchIndexerDeps {
  /** `runAsPipeline(pool, {}, …)` only — never with a data key. */
  pool: PipelinePool;
  /** null = no key: rows are written with embedding NULL (degraded keyword search). */
  embedder: Embedder | null;
  config: SearchIndexerConfig;
  log: WorkerLog;
  now?: () => Date;
}

export type IndexReason = ReindexReason | "reconcile" | "backfill";

export interface ReindexResult {
  requested: number;
  /** Rows upserted (with or without a vector). */
  written: number;
  /** Rows upserted with a fresh vector. */
  embedded: number;
  /** Unchanged documents: only `updated_at` moved. */
  unchanged: number;
  /** Not indexed: the baby is not on the paid tier, the photo is not ingested yet or is gone. */
  skipped: number;
  /** Rows removed (photo trashed, pending, rejected, quarantined or failed). */
  deleted: number;
  /** Rows written without a vector because of the monthly budget. */
  overBudget: number;
  embedCalls: number;
  inputTokens: number;
  costUsd: number;
}

export interface ReconcileResult {
  rounds: number;
  /** Stale or missing photos handed to `reindex` (each at most once per call). */
  reindexed: number;
  /** Orphan rows deleted. */
  orphansDeleted: number;
  written: number;
  embedded: number;
  costUsd: number;
}

/** Stale photos per `search_stale_photos` call and per `reindex` chunk (plan 2.6). */
export const RECONCILE_FETCH = 500;
export const RECONCILE_CHUNK = 50;
/** Rounds per `search.reconcile` tick; a backfill runs until nothing new is left. */
export const RECONCILE_MAX_ROUNDS = 20;
const BACKFILL_MAX_ROUNDS = 10_000;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface Pending {
  row: SearchDocRow;
  doc: SearchDocument;
  hash: string;
  /** null = write without a vector. */
  embed: boolean;
}

function emptyResult(requested: number): ReindexResult {
  return {
    requested,
    written: 0,
    embedded: 0,
    unchanged: 0,
    skipped: 0,
    deleted: 0,
    overBudget: 0,
    embedCalls: 0,
    inputTokens: 0,
    costUsd: 0,
  };
}

export function createSearchIndexer(deps: SearchIndexerDeps) {
  const { pool, embedder, config, log } = deps;
  const now = deps.now ?? (() => new Date());
  const budget =
    config.AI_BABY_MONTHLY_BUDGET_USD ?? AI_PIPELINE_DEFAULTS.AI_BABY_MONTHLY_BUDGET_USD;
  let warnedNoEmbedder = false;

  async function reindex(photoIds: string[], reason: IndexReason): Promise<ReindexResult> {
    const ids = [...new Set(photoIds)];
    const result = emptyResult(ids.length);
    if (ids.length === 0) return result;
    const started = performance.now();
    const today = now();
    const month = today.toISOString().slice(0, 7);

    // ---- tx 1: read, decide, budget --------------------------------------------------------
    const plan = await runAsPipeline(pool, {}, async (client) => {
      const { rows } = await client.query<SearchDocRow>(SEARCH_DOC_SQL, [ids]);
      const toDelete: string[] = [];
      const touch: string[] = [];
      const pending: Pending[] = [];
      for (const row of rows) {
        if (!row.ai_enabled) {
          result.skipped++;
          continue;
        }
        if (!row.live) {
          if (row.has_row) toDelete.push(row.photo_id);
          else result.skipped++;
          continue;
        }
        const doc = buildSearchDocument(toDocumentInput(row));
        const hash = sha256Hex(doc.text);
        const same =
          row.has_row &&
          row.content_hash === hash &&
          row.embed_model === config.embedModelTag &&
          row.doc_version === config.docVersion;
        if (same && (row.has_vector || embedder === null)) {
          touch.push(row.photo_id);
          continue;
        }
        if (doc.warnings.length > 0) {
          log.debug(
            { photoId: row.photo_id, warnings: doc.warnings.map((w) => `${w.code}:${w.field}`) },
            "search: document warnings",
          );
        }
        pending.push({ row, doc, hash, embed: embedder !== null });
      }
      result.skipped += ids.length - rows.length;

      // Budget per baby: month-to-date spend + this call's estimate.
      if (embedder) {
        const perBaby = new Map<string, Pending[]>();
        for (const p of pending) {
          const list = perBaby.get(p.row.baby_id) ?? [];
          list.push(p);
          perBaby.set(p.row.baby_id, list);
        }
        for (const [babyId, list] of perBaby) {
          const spent = await client.query<{ spent: number }>(BABY_MONTH_COST_SQL, [
            babyId,
            today.toISOString().slice(0, 10),
          ]);
          const total = (spent.rows[0]?.spent ?? 0) + EMBED_COST_PER_DOC_ESTIMATE_USD * list.length;
          if (total > budget) {
            for (const p of list) p.embed = false;
            result.overBudget += list.length;
            const rec = await client.query<{ inserted: boolean }>(RECORD_BUDGET_EXCEEDED_SQL, [
              babyId,
              month,
            ]);
            log.warn(
              { babyId, month, docs: list.length, alertRecorded: rec.rows[0]?.inserted === true },
              "search: monthly AI budget reached, documents indexed without vectors",
            );
          }
        }
      }
      return { toDelete, touch, pending };
    });

    if (embedder === null && plan.pending.length > 0 && !warnedNoEmbedder) {
      warnedNoEmbedder = true;
      log.info(
        {},
        "search: embeddings skipped (OPENAI_API_KEY not set); keyword search and filters still work",
      );
    }

    // ---- embed, outside any transaction ------------------------------------------------------
    const vectors = new Map<string, number[]>();
    const spend: { babyId: string; tokens: number; items: number; cost: number }[] = [];
    const toEmbed = plan.pending.filter((p) => p.embed);
    if (embedder && toEmbed.length > 0) {
      const size = Math.max(1, config.SEARCH_EMBED_BATCH);
      for (let i = 0; i < toEmbed.length; i += size) {
        const chunk = toEmbed.slice(i, i + size);
        const { vectors: out, usage } = await embedder.embed(chunk.map((p) => p.doc.text));
        result.embedCalls++;
        result.inputTokens += usage.inputTokens;
        result.costUsd += usage.costUsd;
        chunk.forEach((p, j) => {
          const v = out[j];
          if (v && v.length === embedder.dims) vectors.set(p.row.photo_id, v);
        });
        // One spend row per baby per call, split by each baby's share of the characters.
        const chars = chunk.reduce((n, p) => n + p.doc.text.length, 0) || 1;
        const byBaby = new Map<string, { chars: number; items: number }>();
        for (const p of chunk) {
          const b = byBaby.get(p.row.baby_id) ?? { chars: 0, items: 0 };
          b.chars += p.doc.text.length;
          b.items++;
          byBaby.set(p.row.baby_id, b);
        }
        for (const [babyId, b] of byBaby) {
          const share = b.chars / chars;
          spend.push({
            babyId,
            tokens: Math.round(usage.inputTokens * share),
            items: b.items,
            cost: Math.round(usage.costUsd * share * 1e10) / 1e10,
          });
        }
      }
    }

    // ---- tx 2: write -------------------------------------------------------------------------
    await runAsPipeline(pool, {}, async (client) => {
      if (plan.toDelete.length > 0) {
        const del = await client.query(DELETE_SEARCH_SQL, [plan.toDelete]);
        result.deleted += del.rowCount ?? 0;
      }
      if (plan.touch.length > 0) {
        const t = await client.query(TOUCH_SEARCH_SQL, [plan.touch]);
        result.unchanged += t.rowCount ?? 0;
      }
      if (plan.pending.length > 0) {
        const p = plan.pending;
        const emb = p.map((x) => {
          const v = vectors.get(x.row.photo_id);
          return v ? `[${v.join(",")}]` : null;
        });
        const up = await client.query(UPSERT_SEARCH_SQL, [
          p.map((x) => x.row.photo_id),
          p.map((x) => x.doc.text),
          p.map((x) => x.hash),
          p.map((x) => x.doc.milestoneIds[0] ?? null),
          emb,
          p.map((x) => JSON.stringify(x.doc.people)),
          p.map((x) => JSON.stringify(x.doc.tags)),
          p.map((x) => x.doc.place),
          p.map((x) => x.doc.isSensitive),
          config.embedModelTag,
          config.docVersion,
        ]);
        result.written += up.rowCount ?? 0;
        result.embedded += emb.filter((e) => e !== null).length;
        result.skipped += p.length - (up.rowCount ?? 0);
      }
      for (const s of spend) {
        if (s.cost <= 0 && s.tokens <= 0) continue;
        await client.query(INSERT_EMBED_SPEND_SQL, [
          s.babyId,
          embedder?.model ?? "unknown",
          s.tokens,
          s.items,
          s.cost,
        ]);
      }
    });
    result.costUsd = Math.round(result.costUsd * 1e10) / 1e10;
    log.info(
      {
        reason,
        requested: result.requested,
        written: result.written,
        embedded: result.embedded,
        unchanged: result.unchanged,
        skipped: result.skipped,
        deleted: result.deleted,
        overBudget: result.overBudget,
        embedCalls: result.embedCalls,
        inputTokens: result.inputTokens,
        costUsd: result.costUsd,
        ms: Math.round(performance.now() - started),
      },
      "search: reindexed",
    );
    return result;
  }

  /**
   * Stale/missing rows (`search_stale_photos`) re-indexed in chunks, orphans deleted, up to
   * `maxRounds`. Each photo is handled at most once per call, so rows that stay "stale" (no
   * embedder, over budget) cannot loop. Without an embedder, rows only missing a vector are left
   * alone (they are already written).
   */
  async function sweep(opts: {
    babyId: string | null;
    maxRounds: number;
    limit: number;
    orphans: boolean;
    reason: IndexReason;
  }): Promise<ReconcileResult> {
    const out: ReconcileResult = {
      rounds: 0,
      reindexed: 0,
      orphansDeleted: 0,
      written: 0,
      embedded: 0,
      costUsd: 0,
    };
    const seen = new Set<string>();
    for (let round = 0; round < opts.maxRounds; round++) {
      out.rounds++;
      const { stale, orphans } = await runAsPipeline(pool, {}, async (client) => {
        const s = await client.query<{ photo_id: string; reason: string }>(STALE_SQL, [
          opts.limit,
          config.embedModelTag,
          config.docVersion,
          opts.babyId,
        ]);
        const o = opts.orphans
          ? await client.query<{ photo_id: string }>(ORPHANS_SQL, [opts.limit])
          : { rows: [] };
        return { stale: s.rows, orphans: o.rows.map((r) => r.photo_id) };
      });
      const fresh = stale
        .filter((r) => !(embedder === null && r.reason === "unembedded"))
        .map((r) => r.photo_id)
        .filter((id) => !seen.has(id));
      for (const id of fresh) seen.add(id);
      if (orphans.length > 0) {
        const n = await runAsPipeline(pool, {}, async (client) => {
          const d = await client.query(DELETE_SEARCH_SQL, [orphans]);
          return d.rowCount ?? 0;
        });
        out.orphansDeleted += n;
      }
      for (let i = 0; i < fresh.length; i += RECONCILE_CHUNK) {
        const r = await reindex(fresh.slice(i, i + RECONCILE_CHUNK), opts.reason);
        out.reindexed += r.requested;
        out.written += r.written;
        out.embedded += r.embedded;
        out.costUsd += r.costUsd;
      }
      if (fresh.length === 0 && orphans.length < opts.limit) break;
    }
    out.costUsd = Math.round(out.costUsd * 1e10) / 1e10;
    log.info({ reason: opts.reason, babyId: opts.babyId, ...out }, "search: sweep done");
    return out;
  }

  return {
    reindex,
    /** Cron `search.reconcile`: stale + orphans, at most `RECONCILE_MAX_ROUNDS` rounds. */
    reconcile(opts: { limit?: number } = {}): Promise<ReconcileResult> {
      return sweep({
        babyId: null,
        maxRounds: RECONCILE_MAX_ROUNDS,
        limit: opts.limit ?? RECONCILE_FETCH,
        orphans: true,
        reason: "reconcile",
      });
    },
    /**
     * `search.backfill`: `upgrade` / `manual` ⇒ the baby's (or every) stale and missing rows until
     * none are new; `model` ⇒ the same sweep, which picks up every `embed_model` / `doc_version`
     * mismatch. The paid-tier gate is in the SQL: a free baby yields nothing.
     */
    backfill(job: SearchBackfillJob): Promise<ReconcileResult> {
      return sweep({
        babyId: job.babyId ?? null,
        maxRounds: BACKFILL_MAX_ROUNDS,
        limit: RECONCILE_FETCH,
        orphans: job.babyId === undefined,
        reason: "backfill",
      });
    },
    /** Heartbeat details: stale/missing photos (vector-only gaps excluded) and rows without a vector. */
    async stats(): Promise<{ stale: number; unembedded: number }> {
      return runAsPipeline(pool, {}, async (client) => {
        const { rows } = await client.query<{ stale: number; unembedded: number }>(STATS_SQL, [
          config.embedModelTag,
          config.docVersion,
        ]);
        return { stale: rows[0]?.stale ?? 0, unembedded: rows[0]?.unembedded ?? 0 };
      });
    },
  };
}

export type SearchIndexer = ReturnType<typeof createSearchIndexer>;
