import { fakeDescription } from "@tinyglow/ai";
import { applyAiOverrides, buildSearchDocument } from "@tinyglow/shared";
import { describe, expect, it, vi } from "vitest";
import type { PipelineClient } from "../db";
import { type Handler, recordingLog, scriptedPool } from "../testing/stubs";
import {
  createAutoSharer,
  type ExistingRow,
  type FactsRow,
  insertRuleRows,
  isRowRefusal,
  planSync,
  type RuleRow,
  toFacts,
  toRule,
} from "./autoshare";
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

// Auto-share unit tests (docs/plans/step-8.md 2.7, 2.12). Pure planning (`planSync`, `toFacts`),
// the savepoint fallback of `insertRuleRows` against a scripted pool, and the sync driver's
// watermark guard. The real SQL and the database gate run in autoshare.integration.test.ts.

const LINK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LINK2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BABY = "11111111-1111-4111-8111-111111111111";
const P1 = "a1111111-1111-4111-8111-111111111111";
const P2 = "a2222222-2222-4222-8222-222222222222";
const P3 = "a3333333-3333-4333-8333-333333333333";

const desc = (tags: string[] = [], extra: Record<string, unknown> = {}) => ({
  ...fakeDescription("f0000000-0000-4000-8000-000000000001"),
  search_tags: tags,
  activities: [],
  sensitive_content: [],
  occasion: null,
  setting: { indoor_outdoor: "unknown", place_type: null, weather: null, time_of_day: null },
  ...extra,
});

function facts(photoId: string, o: Partial<FactsRow> = {}): FactsRow {
  return {
    photo_id: photoId,
    trashed: false,
    eligible: true,
    is_sensitive: false,
    analyzed: true,
    has_milestone: false,
    milestone_name: null,
    description: desc(["outdoor"]),
    overrides: null,
    ...o,
  };
}

function rule(o: Partial<RuleRow> = {}): RuleRow {
  return {
    share_link_id: LINK,
    baby_id: BABY,
    mode: "all",
    include_tags: [],
    exclude_tags: [],
    updated_at: new Date("2026-10-01T00:00:00Z"),
    rule_version: "2026-10-01 00:00:00+00",
    evaluated_at: null,
    needs_full: true,
    ai_enabled: true,
    db_now: new Date("2026-10-08T12:00:00Z"),
    ...o,
  };
}

const row = (photo: string, by: string, link = LINK): ExistingRow => ({
  share_link_id: link,
  photo_id: photo,
  added_by: by,
});

describe("planSync", () => {
  it("inserts every eligible, analysed, non-sensitive photo for an `all` rule", () => {
    const plan = planSync([rule()], [facts(P1), facts(P2)], [], []);
    expect(plan.inserts).toEqual([
      { shareLinkId: LINK, photoId: P1 },
      { shareLinkId: LINK, photoId: P2 },
    ]);
    expect(plan.deletes).toEqual([]);
  });

  it("never touches a hand-added (user) row: not deleted when it stops matching, not re-inserted", () => {
    const plan = planSync(
      [rule({ mode: "tags", include_tags: ["indoor-only"] })],
      [facts(P1), facts(P2, { description: desc(["indoor-only"]) })],
      [row(P1, "user"), row(P2, "user")],
      [],
    );
    expect(plan).toEqual({ inserts: [], deletes: [] });
  });

  it("a user row on a sensitive photo is left alone too", () => {
    const plan = planSync([rule()], [facts(P1, { is_sensitive: true })], [row(P1, "user")], []);
    expect(plan).toEqual({ inserts: [], deletes: [] });
  });

  it("skips trashed photos entirely (a rule row of a trashed photo stays; nothing is added)", () => {
    const plan = planSync(
      [rule()],
      [facts(P1, { trashed: true, eligible: false }), facts(P2, { trashed: true })],
      [row(P1, "rule")],
      [],
    );
    expect(plan).toEqual({ inserts: [], deletes: [] });
  });

  it("honours exclusions: never inserted, and an existing rule row is removed", () => {
    const plan = planSync(
      [rule()],
      [facts(P1), facts(P2)],
      [row(P2, "rule")],
      [
        { share_link_id: LINK, photo_id: P1 },
        { share_link_id: LINK, photo_id: P2 },
      ],
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.deletes).toEqual([{ shareLinkId: LINK, photoId: P2 }]);
  });

  it("an exclusion on one link does not affect another link of the same baby", () => {
    const plan = planSync(
      [rule(), rule({ share_link_id: LINK2 })],
      [facts(P1)],
      [],
      [{ share_link_id: LINK, photo_id: P1 }],
    );
    expect(plan.inserts).toEqual([{ shareLinkId: LINK2, photoId: P1 }]);
  });

  it("never inserts a sensitive photo, and removes the rule row of one that became sensitive", () => {
    const plan = planSync(
      [rule()],
      [facts(P1, { is_sensitive: true }), facts(P2, { is_sensitive: true })],
      [row(P2, "rule")],
      [],
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.deletes).toEqual([{ shareLinkId: LINK, photoId: P2 }]);
  });

  it("a missing is_sensitive flag fails closed (treated as sensitive)", () => {
    const plan = planSync(
      [rule()],
      [facts(P1, { is_sensitive: undefined as never }), facts(P2, { is_sensitive: null as never })],
      [],
      [],
    );
    expect(plan.inserts).toEqual([]);
  });

  it("never inserts an unanalysed photo (free-tier photos are never analysed)", () => {
    const plan = planSync([rule()], [facts(P1, { analyzed: false, description: null })], [], []);
    expect(plan.inserts).toEqual([]);
  });

  it("never inserts a photo that is not eligible (pending, failed, quarantined)", () => {
    const plan = planSync(
      [rule()],
      [facts(P1, { eligible: false }), facts(P2)],
      [row(P1, "rule")],
      [],
    );
    expect(plan.inserts).toEqual([{ shareLinkId: LINK, photoId: P2 }]);
    expect(plan.deletes).toEqual([{ shareLinkId: LINK, photoId: P1 }]);
  });

  it("inserts nothing when the baby is not on Plus, but still removes rule rows that stop matching", () => {
    const plan = planSync(
      [rule({ mode: "tags", include_tags: ["outdoor"], ai_enabled: false })],
      [
        facts(P1), // matches, no row: not inserted (free)
        facts(P2, { description: desc(["indoor"]) }), // stopped matching, has a rule row: removed
        facts(P3), // matches and already has a rule row: kept
      ],
      [row(P2, "rule"), row(P3, "rule")],
      [],
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.deletes).toEqual([{ shareLinkId: LINK, photoId: P2 }]);
  });

  it("a photo that stops matching loses its rule row; a still-matching one is not re-inserted", () => {
    const r = rule({ mode: "tags", include_tags: ["outdoor"], exclude_tags: ["bath"] });
    const plan = planSync(
      [r],
      [
        facts(P1, { description: desc(["outdoor", "bath"]) }), // now carries an exclude tag
        facts(P2, { description: desc(["outdoor"]) }), // still matches
        facts(P3, { description: desc(["indoor"]) }), // never matched, no row
      ],
      [row(P1, "rule"), row(P2, "rule")],
      [],
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.deletes).toEqual([{ shareLinkId: LINK, photoId: P1 }]);
  });

  it("milestones mode follows the parent-tagged milestone only (AI possible_milestones never count)", () => {
    const plan = planSync(
      [rule({ mode: "milestones" })],
      [
        facts(P1, { has_milestone: true, milestone_name: "First steps" }),
        facts(P2, {
          has_milestone: false,
          description: desc(["x"], { possible_milestones: ["first_steps"] }),
        }),
      ],
      [],
      [],
    );
    expect(plan.inserts).toEqual([{ shareLinkId: LINK, photoId: P1 }]);
  });

  it("an unknown stored mode never matches and removes its rule rows", () => {
    expect(toRule({ mode: "weird", include_tags: [], exclude_tags: [] })).toBeNull();
    const plan = planSync([rule({ mode: "weird" })], [facts(P1)], [row(P1, "rule")], []);
    expect(plan).toEqual({ inserts: [], deletes: [{ shareLinkId: LINK, photoId: P1 }] });
  });

  it("with no rules there is nothing to plan", () => {
    expect(planSync([], [facts(P1)], [row(P1, "rule")], [])).toEqual({ inserts: [], deletes: [] });
  });
});

describe("toFacts", () => {
  it("tags equal what photo_search.tags would hold (override-merged description + milestone name)", () => {
    const description = desc(["Outdoor", "park"], {
      activities: ["playing"],
      occasion: "Birthday",
    });
    const overrides = { search_tags: ["garden", "picnic"] };
    const f = toFacts(
      facts(P1, { description, overrides, has_milestone: true, milestone_name: "First Steps" }),
    );
    const merged = applyAiOverrides(description as never, overrides);
    const doc = buildSearchDocument({
      ageDays: null,
      takenAtLocal: null,
      takenAtEstimated: false,
      place: null,
      milestone: { id: "11111111-1111-4111-8111-111111111111", name: "First Steps" },
      people: [],
      note: null,
      measurements: [],
      ai: merged,
      isSensitive: false,
    });
    expect([...f.tags]).toEqual(doc.tags);
    expect(f.tags).toContain("garden");
    expect(f.tags).toContain("first steps");
    expect(f.tags).not.toContain("outdoor"); // replaced by the override
    expect(f).toMatchObject({ analyzed: true, isSensitive: false, hasMilestone: true });
  });

  it("an invalid AI description gives no AI tags but the photo still counts as analysed", () => {
    for (const bad of [null, {}, "x", { caption: 1 }, [], { ...desc(), search_tags: "nope" }]) {
      const f = toFacts(facts(P1, { description: bad }));
      expect(f.tags).toEqual([]);
      expect(f.analyzed).toBe(true);
    }
    // the milestone name is still a tag
    const f = toFacts(
      facts(P1, { description: null, has_milestone: true, milestone_name: "Rolled over" }),
    );
    expect(f.tags).toEqual(["rolled over"]);
  });

  it("an unanalysed photo has no tags from a stray description and is not analysed", () => {
    const f = toFacts(facts(P1, { analyzed: false, description: desc(["outdoor"]) }));
    expect(f.analyzed).toBe(false);
    expect(f.tags).toEqual([]);
  });

  it("a milestone name only counts when the milestone is tagged", () => {
    expect(
      toFacts(facts(P1, { has_milestone: false, milestone_name: "X", description: null })).tags,
    ).toEqual([]);
  });

  it("sensitive flags in the description show up as tags but the fact stays the photos flag", () => {
    const f = toFacts(
      facts(P1, {
        description: desc(["baby"], { sensitive_content: ["bath"] }),
        is_sensitive: true,
      }),
    );
    expect(f.tags).toContain("bath");
    expect(f.isSensitive).toBe(true);
  });
});

describe("isRowRefusal", () => {
  it("is true for check_violation and foreign_key_violation only", () => {
    expect(isRowRefusal({ code: "23514" })).toBe(true);
    expect(isRowRefusal({ code: "23503" })).toBe(true);
    for (const code of ["23505", "40001", "57014", "42501", "08006"]) {
      expect(isRowRefusal({ code })).toBe(false);
    }
    expect(isRowRefusal(new Error("x"))).toBe(false);
    expect(isRowRefusal(null)).toBe(false);
  });
});

describe("insertRuleRows (savepoint fallback)", () => {
  const pairs = [
    { shareLinkId: LINK, photoId: P1 },
    { shareLinkId: LINK, photoId: P2 },
    { shareLinkId: LINK, photoId: P3 },
  ];
  const refused = () =>
    Object.assign(new Error("only analysed photos can be auto-shared"), { code: "23514" });

  async function client(handler: Handler) {
    const pool = scriptedPool({ [INSERT_RULE_ROWS_SQL]: handler });
    const c = (await pool.connect()) as unknown as PipelineClient;
    return { pool, c };
  }
  const sqls = (pool: ReturnType<typeof scriptedPool>) =>
    pool.log.map(([sql]) => (sql === INSERT_RULE_ROWS_SQL ? "INSERT" : sql));

  it("one statement in one savepoint when nothing is refused; unmatched rows count as skipped", async () => {
    const { pool, c } = await client(() => ({ rowCount: 2, rows: [{}, {}] }));
    expect(await insertRuleRows(c, pairs)).toEqual({ added: 2, skipped: 1 });
    expect(sqls(pool)).toEqual([
      "SAVEPOINT autoshare_batch",
      "INSERT",
      "RELEASE SAVEPOINT autoshare_batch",
    ]);
    expect(pool.log[1]?.[1]).toEqual([
      [LINK, LINK, LINK],
      [P1, P2, P3],
    ]);
  });

  it("an empty list runs nothing", async () => {
    const { pool, c } = await client(() => ({ rowCount: 0 }));
    expect(await insertRuleRows(c, [])).toEqual({ added: 0, skipped: 0 });
    expect(pool.log).toEqual([]);
  });

  it("a 23514 on the batch rolls back its savepoint and retries each pair in its own savepoint", async () => {
    let call = 0;
    const { pool, c } = await client((params) => {
      call += 1;
      if (call === 1) throw refused(); // the batch
      const photo = (params[1] as string[])[0];
      if (photo === P2) throw refused(); // the raced sensitive photo
      return { rowCount: 1, rows: [{}] };
    });
    expect(await insertRuleRows(c, pairs)).toEqual({ added: 2, skipped: 1 });
    expect(sqls(pool)).toEqual([
      "SAVEPOINT autoshare_batch",
      "INSERT",
      "ROLLBACK TO SAVEPOINT autoshare_batch",
      "RELEASE SAVEPOINT autoshare_batch",
      "SAVEPOINT autoshare_row",
      "INSERT",
      "RELEASE SAVEPOINT autoshare_row",
      "SAVEPOINT autoshare_row",
      "INSERT",
      "ROLLBACK TO SAVEPOINT autoshare_row",
      "RELEASE SAVEPOINT autoshare_row",
      "SAVEPOINT autoshare_row",
      "INSERT",
      "RELEASE SAVEPOINT autoshare_row",
    ]);
  });

  it("rows the fallback inserts that the statement filtered out (rowCount 0) are skipped too", async () => {
    let call = 0;
    const { c } = await client(() => {
      call += 1;
      if (call === 1) throw refused();
      return { rowCount: call === 3 ? 0 : 1, rows: [] };
    });
    expect(await insertRuleRows(c, pairs)).toEqual({ added: 2, skipped: 1 });
  });

  it("a vanished link or photo (23503) is a refusal as well", async () => {
    let call = 0;
    const { c } = await client(() => {
      call += 1;
      if (call <= 2) throw Object.assign(new Error("fk"), { code: "23503" });
      return { rowCount: 1, rows: [{}] };
    });
    expect(await insertRuleRows(c, pairs.slice(0, 2))).toEqual({ added: 1, skipped: 1 });
  });

  it("any other error is rethrown (no fallback, no swallowing)", async () => {
    for (const code of ["40001", "57014", "42501", undefined]) {
      const { pool, c } = await client(() => {
        throw Object.assign(new Error("boom"), code ? { code } : {});
      });
      await expect(insertRuleRows(c, pairs)).rejects.toThrow("boom");
      expect(sqls(pool)).toEqual(["SAVEPOINT autoshare_batch", "INSERT"]);
    }
  });

  it("a non-refusal error inside the per-row fallback is rethrown", async () => {
    let call = 0;
    const { c } = await client(() => {
      call += 1;
      if (call === 1) throw refused();
      throw Object.assign(new Error("deadlock"), { code: "40P01" });
    });
    await expect(insertRuleRows(c, pairs)).rejects.toThrow("deadlock");
  });
});

describe("createAutoSharer", () => {
  const ruleRow = rule({ rule_version: "2026-10-05 10:00:00.123456+00" });

  function sharer(handlers: Record<string, Handler>) {
    const pool = scriptedPool(handlers);
    const log = recordingLog();
    return { pool, log, s: createAutoSharer({ pool: pool as never, log }) };
  }

  it("applyLink: a link without a rule is a no-op (nothing else is queried)", async () => {
    const { pool, s } = sharer({ [RULE_FOR_LINK_SQL]: () => ({ rows: [] }) });
    expect(await s.applyLink(LINK)).toEqual({
      links: 0,
      photos: 0,
      added: 0,
      removed: 0,
      skipped: 0,
    });
    expect(pool.appQueries().map(([q]) => q)).toEqual([RULE_FOR_LINK_SQL]);
  });

  it("watermark guard: evaluated_at is advanced with the rule version it was read with (database clock)", async () => {
    const mark = vi.fn(() => ({ rowCount: 1 }));
    const { pool, s } = sharer({
      [RULE_FOR_LINK_SQL]: () => ({ rows: [ruleRow] }),
      [BABY_PHOTOS_PAGE_SQL]: () => ({ rows: [] }),
      [MARK_EVALUATED_SQL]: mark,
    });
    await s.applyLink(LINK);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith([LINK, ruleRow.db_now, ruleRow.rule_version]);
    // The statement itself only moves the watermark when the rule is unchanged and older.
    expect(MARK_EVALUATED_SQL).toMatch(/updated_at = \$3::timestamptz/);
    expect(MARK_EVALUATED_SQL).toMatch(/evaluated_at IS NULL OR evaluated_at < \$2/);
    expect(pool.appQueries().at(-1)?.[0]).toBe(MARK_EVALUATED_SQL);
  });

  it("applyLink syncs in pages of 500 until a short page, each page in its own transaction", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    }));
    const page = vi
      .fn()
      .mockReturnValueOnce({ rows: page1 })
      .mockReturnValueOnce({ rows: [{ id: P1 }] });
    const { pool, s } = sharer({
      [RULE_FOR_LINK_SQL]: () => ({ rows: [ruleRow] }),
      [BABY_PHOTOS_PAGE_SQL]: page,
      [FACTS_SQL]: () => ({ rows: [] }),
    });
    await s.applyLink(LINK);
    expect(page).toHaveBeenCalledTimes(2);
    expect(page.mock.calls[0]).toEqual([[BABY, "00000000-0000-0000-0000-000000000000", 500]]);
    expect(page.mock.calls[1]?.[0]?.[1]).toBe(page1[499]?.id);
    expect(pool.log.filter(([q]) => q === "BEGIN").length).toBeGreaterThanOrEqual(4);
  });

  it("every statement runs as pipeline and no data key is ever bound", async () => {
    const { pool, s } = sharer({
      [RULE_FOR_LINK_SQL]: () => ({ rows: [ruleRow] }),
      [BABY_PHOTOS_PAGE_SQL]: () => ({ rows: [{ id: P1 }] }),
      [FACTS_SQL]: () => ({ rows: [facts(P1)] }),
    });
    await s.applyLink(LINK);
    const sqlText = pool.log.map(([q]) => q);
    expect(sqlText.filter((q) => q.startsWith("SET LOCAL ROLE"))).not.toHaveLength(0);
    expect(sqlText.join("\n")).not.toMatch(/app\.data_key/);
    for (const q of [
      FACTS_SQL,
      BABY_PHOTOS_PAGE_SQL,
      CHANGED_PHOTOS_PAGE_SQL,
      RULES_FOR_BABY_SQL,
      ALL_RULES_SQL,
      EXISTING_SQL,
      EXCLUSIONS_SQL,
      INSERT_RULE_ROWS_SQL,
      DELETE_RULE_ROWS_SQL,
    ]) {
      expect(q).not.toMatch(/gps_|raw_json|\bnote\b|people|decrypt|passcode|token_hash/i);
    }
  });

  it("evaluatePhotos: photos of babies without rules cost one query and no writes", async () => {
    const { pool, s } = sharer({ [BABIES_WITH_RULES_SQL]: () => ({ rows: [] }) });
    expect(await s.evaluatePhotos([P1, P1, P2])).toMatchObject({ links: 0, added: 0, removed: 0 });
    expect(pool.appQueries().map(([q]) => q)).toEqual([BABIES_WITH_RULES_SQL]);
    expect(pool.appQueries()[0]?.[1]).toEqual([[P1, P2]]);
    expect((await s.evaluatePhotos([])).photos).toBe(0);
  });

  it("evaluatePhotos on a free baby (rule exists, ai_enabled false) inserts nothing", async () => {
    const insert = vi.fn(() => ({ rowCount: 1, rows: [{}] }));
    const { s } = sharer({
      [BABIES_WITH_RULES_SQL]: () => ({ rows: [{ baby_id: BABY }] }),
      [RULES_FOR_BABY_SQL]: () => ({ rows: [rule({ ai_enabled: false })] }),
      [FACTS_SQL]: () => ({ rows: [facts(P1)] }),
      [INSERT_RULE_ROWS_SQL]: insert,
    });
    const out = await s.evaluatePhotos([P1]);
    expect(insert).not.toHaveBeenCalled();
    expect(out).toMatchObject({ links: 1, photos: 1, added: 0 });
  });

  it("evaluatePhotos adds matching photos and removes stale rule rows, counting a refusal as skipped", async () => {
    const del = vi.fn(() => ({ rowCount: 1, rows: [{}] }));
    let insertCall = 0;
    const { s, log } = sharer({
      [BABIES_WITH_RULES_SQL]: () => ({ rows: [{ baby_id: BABY }] }),
      [RULES_FOR_BABY_SQL]: () => ({ rows: [rule()] }),
      [FACTS_SQL]: () => ({ rows: [facts(P1), facts(P2, { is_sensitive: true }), facts(P3)] }),
      [EXISTING_SQL]: () => ({ rows: [row(P2, "rule")] }),
      [DELETE_RULE_ROWS_SQL]: del,
      [INSERT_RULE_ROWS_SQL]: () => {
        insertCall += 1;
        if (insertCall === 1) throw Object.assign(new Error("raced"), { code: "23514" });
        if (insertCall === 3) throw Object.assign(new Error("raced"), { code: "23514" });
        return { rowCount: 1, rows: [{}] };
      },
    });
    const out = await s.evaluatePhotos([P1, P2, P3]);
    expect(del).toHaveBeenCalledWith([[LINK], [P2]]);
    expect(out).toMatchObject({ links: 1, photos: 3, added: 1, removed: 1, skipped: 1 });
    // log lines carry ids and counts only
    expect(JSON.stringify(log.lines)).not.toMatch(/outdoor|raced/);
  });

  it("reconcile: a failing rule does not stop the others, and the job still fails afterwards", async () => {
    const r1 = rule({ share_link_id: LINK });
    const r2 = rule({
      share_link_id: LINK2,
      evaluated_at: new Date("2026-10-08T00:00:00Z"),
      needs_full: false,
    });
    const calls: string[] = [];
    const { s, log } = sharer({
      [ALL_RULES_SQL]: () => ({ rows: [r1, r2] }),
      [BABY_PHOTOS_PAGE_SQL]: () => {
        calls.push("full");
        throw Object.assign(new Error("db hiccup"), { code: "57014" });
      },
      [CHANGED_PHOTOS_PAGE_SQL]: (params) => {
        calls.push("changed");
        // watermark minus the 10 minute overlap
        expect((params[1] as Date).toISOString()).toBe("2026-10-07T23:50:00.000Z");
        return { rows: [] };
      },
    });
    await expect(s.reconcile()).rejects.toThrow("db hiccup");
    expect(calls).toEqual(["full", "changed"]);
    const warn = log.lines.find((l) => l.level === "warn");
    expect(warn?.obj).toMatchObject({ shareLinkId: LINK });
    expect(JSON.stringify(log.lines)).not.toContain("db hiccup");
  });

  it("reconcile does a full sync for a rule that changed after its last sync, a watermark sync otherwise", async () => {
    const changed = rule({
      share_link_id: LINK,
      evaluated_at: new Date("2026-09-01T00:00:00Z"),
      needs_full: true,
    });
    const fresh = rule({
      share_link_id: LINK2,
      evaluated_at: new Date("2026-10-08T00:00:00Z"),
      needs_full: false,
    });
    const full = vi.fn(() => ({ rows: [] }));
    const part = vi.fn(() => ({ rows: [] }));
    const { s } = sharer({
      [ALL_RULES_SQL]: () => ({ rows: [changed, fresh] }),
      [BABY_PHOTOS_PAGE_SQL]: full,
      [CHANGED_PHOTOS_PAGE_SQL]: part,
    });
    expect(await s.reconcile()).toMatchObject({ links: 2 });
    expect(full).toHaveBeenCalledTimes(1);
    expect(part).toHaveBeenCalledTimes(1);
  });
});
