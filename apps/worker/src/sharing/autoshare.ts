import {
  type AiDescriptionV1,
  aiDescriptionV1Schema,
  applyAiOverrides,
  type ShareRuleFacts,
  type ShareRuleLike,
  searchTagsFor,
  shareRuleMatches,
  shareRuleModeSchema,
} from "@littlelight/shared";
import type pg from "pg";
import { errorCategory } from "../clients";
import { type PipelineClient, type PipelinePool, runAsPipeline, sqlState } from "../db";
import type { WorkerLog } from "../log-types";
import {
  ALL_RULES_SQL,
  BABIES_WITH_RULES_SQL,
  BABY_PHOTOS_PAGE_SQL,
  CHANGED_PHOTOS_PAGE_SQL,
  DELETE_RULE_ROWS_SQL,
  EXCLUSIONS_SQL,
  EXISTING_SQL,
  FACTS_SQL,
  INSERT_RULE_ROWS_SQL,
  MARK_EVALUATED_SQL,
  RULE_FOR_LINK_SQL,
  RULES_FOR_BABY_SQL,
} from "./autoshare-sql";

// Auto-share (PRD FR-9.4 rules, FR-9.5 sensitive gate, "AI pipeline" stage 6 "Post-process:
// auto-share rules run"; docs/plans/step-8.md 2.7, D3, D5, D16). No model call: rules read the
// stored AI description (override-merged) and the parent-tagged milestone.
//
// - evaluatePhotos(ids): the `photo.reindex` hook (runs after every new `photo_ai` row and every
//   details/milestone/override edit), before indexing. One transaction per baby that has rules.
// - applyLink(id): `share.apply` after a rule was set or changed: full sync of that link over the
//   baby's photos in pages of 500, then `share_rules.evaluated_at` = the start time.
// - reconcile(): `share.reconcile` (hourly): per rule, a full sync when the rule changed since its
//   last sync (or never synced), else only photos whose facts moved since `evaluated_at − 10 min`.
//
// Sync semantics (D5): a matching, eligible, analysed, non-sensitive, not-excluded photo gets a
// `rule` row (ON CONFLICT DO NOTHING: a hand-added row stays hand-added); a non-trashed photo that
// no longer matches loses its `rule` row; hand-added rows are never touched; trashed photos are
// left alone (viewers never see them; a restore brings them back); a link without a rule is never
// evaluated, so deleting a rule keeps what it added. Inserts happen only for babies on Plus (D3;
// the database's `shared_photos_gate` refuses unanalysed photos anyway, and free-tier photos are
// never analysed); removals of rows that stopped matching happen regardless.
//
// The database is the last guard: `shared_photos_gate` refuses a sensitive, unanalysed, excluded
// or released `rule` row even for this role. A refusal (a sensitive flag raced the insert) is
// counted as `skipped`: the batch insert runs in a savepoint and, if refused, each pair is retried
// alone in its own savepoint, so one refusal never aborts the rest.
//
// Logs: link ids, baby ids and counts only. Never a tag, a link name, a description or a note.

/** Photos per page (full sync and reconcile). */
export const AUTOSHARE_PAGE_SIZE = 500;
/** Reconcile overlap before `evaluated_at` (clock skew, long transactions). */
export const AUTOSHARE_RECONCILE_OVERLAP_MS = 10 * 60_000;

const MIN_UUID = "00000000-0000-0000-0000-000000000000";

export interface AutoSharerDeps {
  /** `runAsPipeline(pool, {}, …)` only — no encryption key is ever bound. */
  pool: PipelinePool;
  log: WorkerLog;
  /** Durations only; the sync watermark uses the database clock. */
  now?: () => Date;
}

export interface AutoShareResult {
  /** Rules evaluated. */
  links: number;
  /** Photos evaluated (per call, distinct per baby/page). */
  photos: number;
  /** `rule` rows inserted. */
  added: number;
  /** `rule` rows removed (no longer matching, excluded, or no longer eligible). */
  removed: number;
  /** Inserts the database refused or filtered (raced a sensitive flag, trash, exclusion). */
  skipped: number;
}

export interface AutoSharer {
  evaluatePhotos(photoIds: string[]): Promise<AutoShareResult>;
  applyLink(shareLinkId: string): Promise<AutoShareResult>;
  reconcile(): Promise<AutoShareResult>;
}

/** A rule as read by the worker. */
export interface RuleRow {
  share_link_id: string;
  baby_id: string;
  mode: string;
  include_tags: string[] | null;
  exclude_tags: string[] | null;
  updated_at: Date;
  rule_version: string;
  evaluated_at: Date | null;
  needs_full: boolean;
  ai_enabled: boolean;
  db_now: Date;
}

/** Rule facts of one photo as read by `FACTS_SQL`. */
export interface FactsRow {
  photo_id: string;
  trashed: boolean;
  eligible: boolean;
  is_sensitive: boolean;
  analyzed: boolean;
  has_milestone: boolean;
  milestone_name: string | null;
  description: unknown;
  overrides: Record<string, unknown> | null;
}

export interface ExistingRow {
  share_link_id: string;
  photo_id: string;
  added_by: string;
}

export interface Pair {
  shareLinkId: string;
  photoId: string;
}

export interface SyncPlan {
  inserts: Pair[];
  deletes: Pair[];
}

const emptyResult = (): AutoShareResult => ({
  links: 0,
  photos: 0,
  added: 0,
  removed: 0,
  skipped: 0,
});

function addInto(total: AutoShareResult, part: Omit<AutoShareResult, "links">): void {
  total.photos += part.photos;
  total.added += part.added;
  total.removed += part.removed;
  total.skipped += part.skipped;
}

/** The rule fields `shareRuleMatches` reads; an unknown mode never matches. */
export function toRule(
  row: Pick<RuleRow, "mode" | "include_tags" | "exclude_tags">,
): ShareRuleLike | null {
  const mode = shareRuleModeSchema.safeParse(row.mode);
  if (!mode.success) return null;
  return {
    mode: mode.data,
    includeTags: row.include_tags ?? [],
    excludeTags: row.exclude_tags ?? [],
  };
}

/**
 * `ShareRuleFacts` of one photo: tags are exactly `photo_search.tags` (`searchTagsFor` over the
 * override-merged description and the parent-tagged milestone's name). An unparseable stored
 * description contributes no AI tags (the photo still counts as analysed).
 */
export function toFacts(row: FactsRow): ShareRuleFacts {
  let ai: AiDescriptionV1 | null = null;
  if (row.analyzed) {
    const parsed = aiDescriptionV1Schema.safeParse(row.description);
    if (parsed.success) ai = applyAiOverrides(parsed.data, row.overrides ?? undefined);
  }
  return {
    analyzed: row.analyzed === true,
    isSensitive: row.is_sensitive !== false,
    hasMilestone: row.has_milestone === true,
    tags: searchTagsFor(ai, row.has_milestone ? row.milestone_name : null),
  };
}

const pairKey = (shareLinkId: string, photoId: string) => `${shareLinkId}/${photoId}`;

/**
 * Decide the writes for `rules` × `facts` (all of one baby). Pure; exported for tests.
 * - existing `user` row ⇒ untouched; trashed photo ⇒ untouched;
 * - wanted = eligible ∧ not excluded ∧ `shareRuleMatches` (analysed and not sensitive inside);
 * - wanted ∧ no row ∧ baby on Plus ⇒ insert; ¬wanted ∧ `rule` row ⇒ delete.
 */
export function planSync(
  rules: readonly Pick<
    RuleRow,
    "share_link_id" | "mode" | "include_tags" | "exclude_tags" | "ai_enabled"
  >[],
  facts: readonly FactsRow[],
  existing: readonly ExistingRow[],
  exclusions: readonly Pick<ExistingRow, "share_link_id" | "photo_id">[],
): SyncPlan {
  const rows = new Map(existing.map((r) => [pairKey(r.share_link_id, r.photo_id), r.added_by]));
  const excluded = new Set(exclusions.map((x) => pairKey(x.share_link_id, x.photo_id)));
  const inserts: Pair[] = [];
  const deletes: Pair[] = [];
  const photoFacts = facts.map((row) => ({ row, facts: toFacts(row) }));
  for (const ruleRow of rules) {
    const rule = toRule(ruleRow);
    for (const { row, facts: f } of photoFacts) {
      if (row.trashed) continue;
      const key = pairKey(ruleRow.share_link_id, row.photo_id);
      const current = rows.get(key);
      if (current !== undefined && current !== "rule") continue;
      const wanted =
        row.eligible === true && !excluded.has(key) && rule !== null && shareRuleMatches(rule, f);
      const pair = { shareLinkId: ruleRow.share_link_id, photoId: row.photo_id };
      if (wanted && current === undefined && ruleRow.ai_enabled === true) inserts.push(pair);
      else if (!wanted && current === "rule") deletes.push(pair);
    }
  }
  return { inserts, deletes };
}

/** A refusal by the gate (check_violation) or a vanished link/photo (foreign key): skip the row. */
export function isRowRefusal(err: unknown): boolean {
  const state = sqlState(err);
  return state === "23514" || state === "23503";
}

const columns = (pairs: readonly Pair[]) => [
  pairs.map((p) => p.shareLinkId),
  pairs.map((p) => p.photoId),
];

/**
 * Insert `rule` rows. One statement in a savepoint; if the gate refuses any row (a concurrent
 * sensitive flag, trash or exclusion), the savepoint is rolled back and each pair is inserted
 * alone in its own savepoint, so the refusal skips that row only.
 */
export async function insertRuleRows(
  client: PipelineClient,
  pairs: readonly Pair[],
): Promise<{ added: number; skipped: number }> {
  if (pairs.length === 0) return { added: 0, skipped: 0 };
  await client.query("SAVEPOINT autoshare_batch");
  try {
    const res = await client.query(INSERT_RULE_ROWS_SQL, columns(pairs));
    await client.query("RELEASE SAVEPOINT autoshare_batch");
    const added = res.rowCount ?? 0;
    return { added, skipped: pairs.length - added };
  } catch (err) {
    if (!isRowRefusal(err)) throw err;
    await client.query("ROLLBACK TO SAVEPOINT autoshare_batch");
    await client.query("RELEASE SAVEPOINT autoshare_batch");
  }
  let added = 0;
  let skipped = 0;
  for (const pair of pairs) {
    await client.query("SAVEPOINT autoshare_row");
    try {
      const res = await client.query(INSERT_RULE_ROWS_SQL, columns([pair]));
      await client.query("RELEASE SAVEPOINT autoshare_row");
      if ((res.rowCount ?? 0) > 0) added += 1;
      else skipped += 1;
    } catch (err) {
      if (!isRowRefusal(err)) throw err;
      await client.query("ROLLBACK TO SAVEPOINT autoshare_row");
      await client.query("RELEASE SAVEPOINT autoshare_row");
      skipped += 1;
    }
  }
  return { added, skipped };
}

/** Remove `rule` rows (never a hand-added one). */
export async function deleteRuleRows(
  client: PipelineClient,
  pairs: readonly Pair[],
): Promise<number> {
  if (pairs.length === 0) return 0;
  const res = await client.query(DELETE_RULE_ROWS_SQL, columns(pairs));
  return res.rowCount ?? 0;
}

/**
 * Sync `rules` (all of baby `babyId`) over `photoIds` inside the caller's transaction: read facts,
 * existing rows and exclusions, plan, delete, insert.
 */
export async function syncRulesOverPhotos(
  client: PipelineClient,
  babyId: string,
  rules: readonly RuleRow[],
  photoIds: readonly string[],
): Promise<Omit<AutoShareResult, "links">> {
  if (rules.length === 0 || photoIds.length === 0) {
    return { photos: 0, added: 0, removed: 0, skipped: 0 };
  }
  const ids = [...photoIds];
  const linkIds = rules.map((r) => r.share_link_id);
  const facts = (await client.query<FactsRow>(FACTS_SQL, [babyId, ids])).rows;
  const factIds = facts.map((f) => f.photo_id);
  if (factIds.length === 0) return { photos: 0, added: 0, removed: 0, skipped: 0 };
  const existing = (await client.query<ExistingRow>(EXISTING_SQL, [linkIds, factIds])).rows;
  const exclusions = (await client.query<ExistingRow>(EXCLUSIONS_SQL, [linkIds, factIds])).rows;
  const plan = planSync(rules, facts, existing, exclusions);
  const removed = await deleteRuleRows(client, plan.deletes);
  const { added, skipped } = await insertRuleRows(client, plan.inserts);
  return { photos: facts.length, added, removed, skipped };
}

type PageQuery = (client: pg.PoolClient, afterId: string) => Promise<string[]>;

export function createAutoSharer(deps: AutoSharerDeps): AutoSharer {
  const { pool, log } = deps;
  const now = deps.now ?? (() => new Date());

  /** Sync one rule over pages of photo ids; each page is its own transaction. */
  async function syncRulePaged(rule: RuleRow, page: PageQuery): Promise<AutoShareResult> {
    const total = emptyResult();
    total.links = 1;
    let after = MIN_UUID;
    for (;;) {
      const done = await runAsPipeline(pool, {}, async (client) => {
        const ids = await page(client, after);
        if (ids.length === 0) return true;
        addInto(total, await syncRulesOverPhotos(client, rule.baby_id, [rule], ids));
        after = ids[ids.length - 1] as string;
        return ids.length < AUTOSHARE_PAGE_SIZE;
      });
      if (done) break;
    }
    return total;
  }

  /** Advance `evaluated_at` to the sync's start (database clock), unless the rule changed. */
  async function markEvaluated(rule: RuleRow, startedAt: Date): Promise<void> {
    await runAsPipeline(pool, {}, async (client) => {
      await client.query(MARK_EVALUATED_SQL, [rule.share_link_id, startedAt, rule.rule_version]);
    });
  }

  const fullPage =
    (babyId: string): PageQuery =>
    async (client, afterId) =>
      (
        await client.query<{ id: string }>(BABY_PHOTOS_PAGE_SQL, [
          babyId,
          afterId,
          AUTOSHARE_PAGE_SIZE,
        ])
      ).rows.map((r) => r.id);

  const changedPage =
    (babyId: string, since: Date): PageQuery =>
    async (client, afterId) =>
      (
        await client.query<{ id: string }>(CHANGED_PHOTOS_PAGE_SQL, [
          babyId,
          since,
          afterId,
          AUTOSHARE_PAGE_SIZE,
        ])
      ).rows.map((r) => r.id);

  /** Full sync (rule never synced or changed since) or the watermark sync of one rule. */
  async function syncRule(rule: RuleRow, full: boolean): Promise<AutoShareResult> {
    const startedAt = rule.db_now;
    const since =
      !full && rule.evaluated_at
        ? new Date(rule.evaluated_at.getTime() - AUTOSHARE_RECONCILE_OVERLAP_MS)
        : null;
    const result = await syncRulePaged(
      rule,
      since ? changedPage(rule.baby_id, since) : fullPage(rule.baby_id),
    );
    await markEvaluated(rule, startedAt);
    return result;
  }

  return {
    async evaluatePhotos(photoIds) {
      const total = emptyResult();
      const ids = [...new Set(photoIds)];
      if (ids.length === 0) return total;
      const started = now().getTime();
      const babies = await runAsPipeline(pool, {}, async (client) =>
        (await client.query<{ baby_id: string }>(BABIES_WITH_RULES_SQL, [ids])).rows.map(
          (r) => r.baby_id,
        ),
      );
      for (const babyId of babies) {
        await runAsPipeline(pool, {}, async (client) => {
          const rules = (await client.query<RuleRow>(RULES_FOR_BABY_SQL, [babyId])).rows;
          total.links += rules.length;
          addInto(total, await syncRulesOverPhotos(client, babyId, rules, ids));
        });
      }
      if (babies.length > 0) {
        log.debug(
          { ...total, babies: babies.length, ms: now().getTime() - started },
          "autoshare: photos evaluated",
        );
      }
      return total;
    },

    async applyLink(shareLinkId) {
      const started = now().getTime();
      const rule = await runAsPipeline(
        pool,
        {},
        async (client) => (await client.query<RuleRow>(RULE_FOR_LINK_SQL, [shareLinkId])).rows[0],
      );
      if (!rule) {
        log.info({ shareLinkId }, "autoshare: link has no rule, nothing to apply");
        return emptyResult();
      }
      const result = await syncRule(rule, true);
      log.info(
        { shareLinkId, babyId: rule.baby_id, ...result, ms: now().getTime() - started },
        "autoshare: link applied",
      );
      return result;
    },

    async reconcile() {
      const started = now().getTime();
      const total = emptyResult();
      const rules = await runAsPipeline(
        pool,
        {},
        async (client) => (await client.query<RuleRow>(ALL_RULES_SQL)).rows,
      );
      let full = 0;
      let failed = 0;
      let firstError: unknown;
      for (const rule of rules) {
        const isFull = rule.needs_full !== false || rule.evaluated_at === null;
        try {
          const part = await syncRule(rule, isFull);
          total.links += 1;
          addInto(total, part);
          if (isFull) full += 1;
        } catch (err) {
          // One bad rule must not block the others; the job still fails so pg-boss records it.
          failed += 1;
          firstError ??= err;
          log.warn(
            { shareLinkId: rule.share_link_id, err: errorCategory(err) },
            "autoshare: rule reconcile failed",
          );
        }
      }
      log.info(
        { ...total, rules: rules.length, full, failed, ms: now().getTime() - started },
        "autoshare: reconcile done",
      );
      if (firstError !== undefined) throw firstError;
      return total;
    },
  };
}
