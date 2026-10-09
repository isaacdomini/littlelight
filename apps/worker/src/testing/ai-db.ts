import { randomUUID } from "node:crypto";
import * as SQL from "../ai/sql";
import { type Handler, type ScriptedPool, scriptedPool } from "./stubs";

// A small stateful model of the tables the AI pipeline touches, answering the pipeline's SQL by
// exact text (`ai/sql.ts` constants) through `scriptedPool`. It encodes the DB rules the pipeline
// relies on (eligibility, paid gate, idempotent result claim, tripwire errors) so the unit tests
// can assert behaviour instead of statement order. The real SQL is exercised in
// `ai/pipeline.integration.test.ts`. Test-only.

export interface FakePhoto {
  id: string;
  babyId: string;
  status: string;
  approval: "approved" | "pending";
  deleted: boolean;
  quarantined: boolean;
  analysis: boolean;
  hasAi: boolean;
  createdAt: Date;
  retryRequestedAt: Date | null;
  /** Context columns of LOAD_PENDING_SQL. */
  ctx: {
    age_days?: number | null;
    taken_at?: Date | null;
    taken_at_estimated?: boolean | null;
    exif_taken_at?: Date | null;
    tz_offset_minutes?: number | null;
    place_label?: string | null;
    people?: string[] | null;
    note?: string | null;
    location_label?: string | null;
    milestone_name?: string | null;
  };
}

export interface FakeItem {
  batchId: string;
  photoId: string;
  babyId: string;
  attempt: number;
  promptVersion: string;
  schemaVersion: string;
  state: "pending" | "submitted" | "succeeded" | "failed" | "dropped";
  failureKind: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  imageTokens: number | null;
  costUsd: number | null;
  createdAt: Date;
}

export interface FakeBatch {
  id: string;
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  status: string;
  photoCount: number;
  createdAt: Date;
  submittedAt: Date | null;
  providerBatchId: string | null;
  inputFileId: string | null;
  outputFileId: string | null;
  errorFileId: string | null;
  filesDeletedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  requestCounts: unknown;
  submittedBytes: number | null;
  costUsd: number | null;
  totals?: Record<string, number>;
}

export interface FakeAiDb {
  pool: ScriptedPool;
  photos: Map<string, FakePhoto>;
  paidBabies: Set<string>;
  batches: FakeBatch[];
  items: FakeItem[];
  photoAi: Map<string, { description: unknown; flags: string[]; batchId: string; model: string }>;
  /** `${baby}:${month}` of audit rows written. */
  budgetAudits: Set<string>;
  /** Month-to-date spend per baby (added to the sum of item costs). */
  extraSpend: Map<string, number>;
  /** Simulate another transaction holding the open building batch. */
  openBatchBusy: boolean;
  /** Make the next UPSERT_PHOTO_AI throw this SQLSTATE (tripwire simulation). */
  upsertError: string | null;
  now: Date;
  addPhoto(p: Partial<FakePhoto> & { babyId: string }): FakePhoto;
  addBaby(paid?: boolean): string;
  itemsOf(photoId: string): FakeItem[];
  photo(id: string): FakePhoto;
}

const u = (v: unknown) => v as unknown;

export function createFakeAiDb(now = new Date("2026-10-08T12:00:00Z")): FakeAiDb {
  const photos = new Map<string, FakePhoto>();
  const paidBabies = new Set<string>();
  const batches: FakeBatch[] = [];
  const items: FakeItem[] = [];
  const photoAi: FakeAiDb["photoAi"] = new Map();
  const budgetAudits = new Set<string>();
  const extraSpend = new Map<string, number>();
  const state: { db: FakeAiDb | null } = { db: null };

  const batch = (id: string) => batches.find((b) => b.id === id);
  const monthStart = () => new Date(Date.UTC(db.now.getUTCFullYear(), db.now.getUTCMonth(), 1));
  const failedCount = (p: FakePhoto, prompt: string, schema: string) =>
    items.filter(
      (i) =>
        i.photoId === p.id &&
        i.state === "failed" &&
        i.promptVersion === prompt &&
        i.schemaVersion === schema &&
        (!p.retryRequestedAt || i.createdAt > p.retryRequestedAt),
    ).length;
  const releaseStatus = (p: FakePhoto) => (p.hasAi ? "ready" : "ingested");
  const rowOf = (b: FakeBatch) => ({
    id: b.id,
    photo_count: b.photoCount,
    created_at: b.createdAt,
  });
  const batchRow = (b: FakeBatch) => ({
    id: b.id,
    provider: b.provider,
    model: b.model,
    provider_batch_id: b.providerBatchId,
    provider_input_file_id: b.inputFileId,
    provider_output_file_id: b.outputFileId,
    provider_error_file_id: b.errorFileId,
    submitted_at: b.submittedAt,
    photo_count: b.photoCount,
    prompt_version: b.promptVersion,
    schema_version: b.schemaVersion,
    status: b.status,
    completed_at: b.completedAt,
    expires_at: null,
  });

  const h: Record<string, Handler> = {
    [SQL.LOCK_STALE_SEALED_SQL]: ([provider, lease]) => ({
      rows: batches
        .filter(
          (b) =>
            b.status === "building" &&
            b.submittedAt &&
            b.provider === provider &&
            b.submittedAt.getTime() < db.now.getTime() - Number(lease) * 60_000,
        )
        .map((b) => ({ id: b.id })),
    }),
    [SQL.LOCK_OPEN_BATCH_SQL]: ([provider, model, prompt, schema]) => {
      if (db.openBatchBusy) return { rows: [] };
      const b = batches.find(
        (x) =>
          x.status === "building" &&
          !x.submittedAt &&
          x.provider === provider &&
          x.model === model &&
          x.promptVersion === prompt &&
          x.schemaVersion === schema,
      );
      return { rows: b ? [rowOf(b)] : [] };
    },
    [SQL.OPEN_BATCH_EXISTS_SQL]: () => ({ rows: [{ busy: db.openBatchBusy }] }),
    [SQL.INSERT_BATCH_SQL]: ([provider, model, prompt, schema]) => {
      const b: FakeBatch = {
        id: randomUUID(),
        provider: String(provider),
        model: String(model),
        promptVersion: String(prompt),
        schemaVersion: String(schema),
        status: "building",
        photoCount: 0,
        createdAt: db.now,
        submittedAt: null,
        providerBatchId: null,
        inputFileId: null,
        outputFileId: null,
        errorFileId: null,
        filesDeletedAt: null,
        completedAt: null,
        error: null,
        requestCounts: null,
        submittedBytes: null,
        costUsd: null,
      };
      batches.push(b);
      return { rows: [rowOf(b)] };
    },
    [SQL.ELIGIBLE_SQL]: ([limit, prompt, schema, babyId, reprocess, max, excluded]) => {
      const out = [...photos.values()]
        .filter(
          (p) =>
            p.approval === "approved" &&
            !p.deleted &&
            !p.quarantined &&
            (p.status === "ingested" || (reprocess === true && p.status === "ready")) &&
            paidBabies.has(p.babyId) &&
            (babyId === null || p.babyId === babyId) &&
            p.analysis &&
            !((excluded as string[] | undefined) ?? []).includes(p.id) &&
            (reprocess === true ? p.hasAi : !p.hasAi) &&
            !items.some(
              (i) => i.photoId === p.id && (i.state === "pending" || i.state === "submitted"),
            ) &&
            failedCount(p, String(prompt), String(schema)) < Number(max),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, Number(limit))
        .map((p) => ({ id: p.id }));
      return { rows: out };
    },
    [SQL.CLAIM_INFO_SQL]: ([ids, prompt, schema]) => ({
      rows: (ids as string[]).map((id) => {
        const p = db.photo(id);
        return {
          id,
          baby_id: p.babyId,
          failed_attempts: failedCount(p, String(prompt), String(schema)),
        };
      }),
    }),
    [SQL.BABY_MONTH_SPEND_SQL]: ([baby, , estimate]) => {
      const start = monthStart();
      const mine = items.filter((i) => i.babyId === baby && i.createdAt >= start);
      const done = mine.reduce((s, i) => s + (i.costUsd ?? 0), 0);
      const inflight = mine.filter(
        (i) => i.costUsd === null && (i.state === "pending" || i.state === "submitted"),
      ).length;
      return {
        rows: [{ spent: done + (extraSpend.get(String(baby)) ?? 0) + Number(estimate) * inflight }],
      };
    },
    [SQL.AUDIT_BUDGET_EXCEEDED_SQL]: ([baby, month]) => {
      const key = `${baby}:${month}`;
      const inserted = !budgetAudits.has(key);
      budgetAudits.add(key);
      return { rows: [{ inserted }] };
    },
    [SQL.INSERT_ITEMS_SQL]: ([batchId, photoIds, babyIds, attempts, prompt, schema]) => {
      (photoIds as string[]).forEach((pid, i) => {
        const p = db.photo(pid);
        if (!paidBabies.has(p.babyId)) {
          throw Object.assign(new Error("guard"), { code: "23514" });
        }
        items.push({
          batchId: String(batchId),
          photoId: pid,
          babyId: (babyIds as string[])[i] as string,
          attempt: (attempts as number[])[i] as number,
          promptVersion: String(prompt),
          schemaVersion: String(schema),
          state: "pending",
          failureKind: null,
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          imageTokens: null,
          costUsd: null,
          createdAt: db.now,
        });
      });
      return { rowCount: (photoIds as string[]).length };
    },
    [SQL.MARK_QUEUED_SQL]: ([ids]) => {
      for (const id of ids as string[]) {
        const p = db.photo(id);
        if (!paidBabies.has(p.babyId)) throw Object.assign(new Error("guard"), { code: "23514" });
        if (p.status === "ingested" || p.status === "ready") p.status = "queued";
      }
      return { rowCount: (ids as string[]).length };
    },
    [SQL.ADD_PHOTO_COUNT_SQL]: ([id, n]) => {
      const b = batch(String(id));
      if (b) b.photoCount += Number(n);
      return {};
    },
    [SQL.SEAL_BATCH_SQL]: ([id]) => {
      const b = batch(String(id));
      if (b && b.status === "building") b.submittedAt = db.now;
      return {};
    },
    [SQL.LOAD_PENDING_SQL]: ([batchId]) => ({
      rows: items
        .filter((i) => i.batchId === batchId && i.state === "pending")
        .map((i) => {
          const p = db.photo(i.photoId);
          return {
            photo_id: i.photoId,
            baby_id: i.babyId,
            attempt: i.attempt,
            storage_key: p.analysis ? `babies/${p.babyId}/derivatives/${p.id}/analysis.jpg` : null,
            age_days: null,
            taken_at: null,
            taken_at_estimated: null,
            exif_taken_at: null,
            tz_offset_minutes: null,
            place_label: null,
            people: null,
            note: null,
            location_label: null,
            milestone_name: null,
            ...p.ctx,
          };
        }),
    }),
    [SQL.RECHECK_SQL]: ([ids]) => ({
      rows: (ids as string[])
        .filter((id) => {
          const p = db.photo(id);
          return (
            p.approval === "approved" && !p.deleted && !p.quarantined && paidBabies.has(p.babyId)
          );
        })
        .map((id) => ({ id })),
    }),
    [SQL.DROP_ITEMS_SQL]: ([batchId, ids]) => {
      for (const i of items) {
        if (i.batchId === batchId && (ids as string[]).includes(i.photoId) && i.state === "pending")
          i.state = "dropped";
      }
      return {};
    },
    [SQL.FAIL_PENDING_ITEMS_SQL]: ([batchId, ids, kind]) => {
      for (const i of items) {
        if (
          i.batchId === batchId &&
          (ids as string[]).includes(i.photoId) &&
          i.state === "pending"
        ) {
          i.state = "failed";
          i.failureKind = String(kind);
        }
      }
      return {};
    },
    [SQL.RELEASE_ITEMS_SQL]: ([batchId, ids]) => {
      for (let k = items.length - 1; k >= 0; k--) {
        const i = items[k] as FakeItem;
        if (i.batchId === batchId && (ids as string[]).includes(i.photoId) && i.state === "pending")
          items.splice(k, 1);
      }
      return {};
    },
    [SQL.RELEASE_PHOTOS_SQL]: ([ids]) => {
      for (const id of ids as string[]) {
        const p = photos.get(id);
        if (p && (p.status === "queued" || p.status === "analyzing")) p.status = releaseStatus(p);
      }
      return {};
    },
    [SQL.MARK_SUBMITTED_SQL]: ([id, providerBatchId, inputFileId, submittedAt, , bytes, count]) => {
      const b = batch(String(id));
      if (b) {
        b.status = "submitted";
        b.providerBatchId = String(providerBatchId);
        b.inputFileId = inputFileId === null ? null : String(inputFileId);
        b.submittedAt = new Date(String(submittedAt));
        b.submittedBytes = Number(bytes);
        b.photoCount = Number(count);
        b.error = null;
        b.requestCounts = null;
      }
      return {};
    },
    [SQL.MARK_ITEMS_SUBMITTED_SQL]: ([batchId, ids]) => {
      for (const i of items) {
        if (i.batchId === batchId && (ids as string[]).includes(i.photoId) && i.state === "pending")
          i.state = "submitted";
      }
      return {};
    },
    [SQL.MARK_ANALYZING_SQL]: ([ids]) => {
      for (const id of ids as string[]) {
        const p = db.photo(id);
        if (p.status === "queued" && paidBabies.has(p.babyId)) p.status = "analyzing";
      }
      return {};
    },
    [SQL.SUBMIT_FAILED_SQL]: ([id, error, attempts, count]) => {
      const b = batch(String(id));
      if (b && b.status === "building") {
        b.submittedAt = null;
        b.error = String(error);
        b.requestCounts = { submit_attempts: Number(attempts) };
        b.photoCount = Number(count);
      }
      return {};
    },
    [SQL.BATCH_SUBMIT_ATTEMPTS_SQL]: ([id]) => {
      const rc = batch(String(id))?.requestCounts as { submit_attempts?: number } | null;
      return { rows: [{ attempts: rc?.submit_attempts ?? 0 }] };
    },
    [SQL.CLOSE_UNSUBMITTED_BATCH_SQL]: ([id, status, error, count]) => {
      const b = batch(String(id));
      if (b && b.status === "building") {
        b.status = String(status);
        b.error = String(error);
        b.completedAt = db.now;
        b.photoCount = Number(count);
      }
      return {};
    },
    [SQL.OPEN_BATCHES_SQL]: ([provider, limit]) => ({
      rows: batches
        .filter(
          (b) =>
            (b.status === "submitted" || b.status === "in_progress") &&
            b.provider === provider &&
            b.providerBatchId,
        )
        .slice(0, Number(limit))
        .map(batchRow),
    }),
    [SQL.OTHER_PROVIDER_OPEN_SQL]: ([provider]) => ({
      rows: [
        {
          n: batches.filter(
            (b) =>
              (b.status === "submitted" || b.status === "in_progress") && b.provider !== provider,
          ).length,
        },
      ],
    }),
    [SQL.UPDATE_PROGRESS_SQL]: ([id, status, counts, out, err]) => {
      const b = batch(String(id));
      if (b && (b.status === "submitted" || b.status === "in_progress")) {
        b.status = String(status);
        b.requestCounts = counts;
        if (out) b.outputFileId = String(out);
        if (err) b.errorFileId = String(err);
      }
      return {};
    },
    [SQL.CLAIM_RESULT_SQL]: ([
      batchId,
      photoId,
      state,
      kind,
      inTok,
      cached,
      outTok,
      reasoning,
      image,
      cost,
    ]) => {
      const i = items.find(
        (x) => x.batchId === batchId && x.photoId === photoId && x.state === "submitted",
      );
      if (!i) return { rows: [] };
      i.state = state as FakeItem["state"];
      i.failureKind = kind === null ? null : String(kind);
      i.inputTokens = u(inTok) as number | null;
      i.cachedInputTokens = u(cached) as number | null;
      i.outputTokens = u(outTok) as number | null;
      i.reasoningTokens = u(reasoning) as number | null;
      i.imageTokens = u(image) as number | null;
      i.costUsd = u(cost) as number | null;
      return { rows: [{ baby_id: i.babyId, ai_enabled: paidBabies.has(i.babyId) }] };
    },
    [SQL.UPSERT_PHOTO_AI_SQL]: ([photoId, model, , , description, flags, , batchId]) => {
      if (db.upsertError) {
        const code = db.upsertError;
        db.upsertError = null;
        throw Object.assign(new Error("tripwire"), { code });
      }
      const p = db.photo(String(photoId));
      if (!paidBabies.has(p.babyId)) throw Object.assign(new Error("tripwire"), { code: "23514" });
      p.hasAi = true;
      photoAi.set(p.id, {
        description: JSON.parse(String(description)),
        flags: flags as string[],
        batchId: String(batchId),
        model: String(model),
      });
      return {};
    },
    [SQL.MARK_READY_SQL]: ([id]) => {
      const p = photos.get(String(id));
      if (p && ["queued", "analyzing", "ingested"].includes(p.status)) p.status = "ready";
      return {};
    },
    [SQL.FAIL_MISSING_ITEMS_SQL]: ([batchId, kind]) => {
      const rows: { photo_id: string }[] = [];
      for (const i of items) {
        if (i.batchId === batchId && i.state === "submitted") {
          i.state = "failed";
          i.failureKind = String(kind);
          rows.push({ photo_id: i.photoId });
        }
      }
      return { rows };
    },
    [SQL.BATCH_TOTALS_SQL]: ([id, status, counts, out, err, error]) => {
      const b = batch(String(id));
      if (!b || !(b.status === "submitted" || b.status === "in_progress")) return { rows: [] };
      const mine = items.filter((i) => i.batchId === id);
      const sum = (f: (i: FakeItem) => number | null) => mine.reduce((s, i) => s + (f(i) ?? 0), 0);
      b.status = String(status);
      b.completedAt = db.now;
      b.requestCounts = counts;
      if (out) b.outputFileId = String(out);
      if (err) b.errorFileId = String(err);
      b.error = error === null ? null : String(error);
      b.costUsd = sum((i) => i.costUsd);
      b.totals = {
        input: sum((i) => i.inputTokens),
        cached: sum((i) => i.cachedInputTokens),
        output: sum((i) => i.outputTokens),
        reasoning: sum((i) => i.reasoningTokens),
        image: sum((i) => i.imageTokens),
      };
      return { rows: [{ cost_usd: b.costUsd, reasoning_tokens: b.totals.reasoning }] };
    },
    [SQL.UNDELETED_BATCHES_SQL]: ([provider, limit]) => ({
      rows: batches
        .filter(
          (b) =>
            ["completed", "failed", "expired", "cancelled"].includes(b.status) &&
            !b.filesDeletedAt &&
            b.providerBatchId &&
            b.provider === provider,
        )
        .slice(0, Number(limit))
        .map(batchRow),
    }),
    [SQL.MARK_FILES_DELETED_SQL]: ([id]) => {
      const b = batch(String(id));
      if (b && !b.filesDeletedAt) b.filesDeletedAt = db.now;
      return {};
    },
    [SQL.OLDEST_ELIGIBLE_SQL]: () => ({ rows: [] }),
    [SQL.OLDEST_OPEN_BATCH_SQL]: () => ({ rows: [{ minutes: null }] }),
  };

  // `SAVEPOINT ai_result` / `ROLLBACK TO SAVEPOINT ai_result` (the pipeline's per-result isolation):
  // snapshot and restore the tables a result touches, as Postgres would.
  let snap: { items: FakeItem[]; photos: [string, FakePhoto][]; ai: [string, unknown][] } | null =
    null;
  h["SAVEPOINT ai_result"] = () => {
    snap = {
      items: items.map((i) => ({ ...i })),
      photos: [...photos].map(([k, v]) => [k, { ...v }]),
      ai: [...photoAi],
    };
    return {};
  };
  h["ROLLBACK TO SAVEPOINT ai_result"] = () => {
    if (snap) {
      items.splice(0, items.length, ...snap.items);
      photos.clear();
      for (const [k, v] of snap.photos) photos.set(k, v);
      photoAi.clear();
      for (const [k, v] of snap.ai) photoAi.set(k, v as never);
    }
    return {};
  };
  // Inline statement of the pipeline: the baby went free after submission (billed, never stored).
  h["UPDATE ai_batch_items SET state = 'dropped' WHERE batch_id = $1 AND photo_id = $2"] = ([
    batchId,
    photoId,
  ]) => {
    for (const i of items) if (i.batchId === batchId && i.photoId === photoId) i.state = "dropped";
    return {};
  };

  const pool = scriptedPool(h);
  const db: FakeAiDb = {
    pool,
    photos,
    paidBabies,
    batches,
    items,
    photoAi,
    budgetAudits,
    extraSpend,
    openBatchBusy: false,
    upsertError: null,
    now,
    addBaby(paid = true) {
      const id = randomUUID();
      if (paid) paidBabies.add(id);
      return id;
    },
    addPhoto(p) {
      const id = p.id ?? randomUUID();
      const photo: FakePhoto = {
        id,
        status: "ingested",
        approval: "approved",
        deleted: false,
        quarantined: false,
        analysis: true,
        hasAi: false,
        createdAt: new Date(db.now.getTime() - 100_000 * 60_000 + photos.size * 60_000),
        retryRequestedAt: null,
        ctx: {},
        ...p,
        babyId: p.babyId,
      };
      photos.set(id, photo);
      return photo;
    },
    itemsOf: (photoId) => items.filter((i) => i.photoId === photoId),
    photo(id) {
      const p = photos.get(id);
      if (!p) throw new Error(`fake db: unknown photo ${id}`);
      return p;
    },
  };
  state.db = db;
  return db;
}
