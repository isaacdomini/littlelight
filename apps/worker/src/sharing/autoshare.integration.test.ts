import { randomBytes, randomUUID } from "node:crypto";
import { fakeDescription } from "@tinyglow/ai";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordingLog } from "../testing/stubs";
import { createAutoSharer } from "./autoshare";
import { MARK_EVALUATED_SQL } from "./autoshare-sql";

// The auto-sharer against the real database as `tinyglow_worker` -> `pipeline`
// (docs/plans/step-8.md 2.12). PRD FR-9.5 / step-8 acceptance: sensitive photos never auto-share,
// even when a sensitive flag races the insert. Fake AI descriptions only; no model, no storage.
// Runs with only DATABASE_URL (no MinIO needed); every id is random and cleaned up afterwards.

const databaseUrl = process.env.DATABASE_URL;
const dev = (name: string, fallback: string) => process.env[name] ?? fallback;

describe.skipIf(!databaseUrl)("auto-share (real database)", () => {
  let admin: pg.Client;
  let admin2: pg.Client;
  let pool: pg.Pool;
  const users: string[] = [];
  const babies: string[] = [];

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    admin2 = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([admin.connect(), admin2.connect()]);
    const url = new URL(databaseUrl as string);
    url.username = "tinyglow_worker";
    url.password = dev("WORKER_DB_PASSWORD", "dev");
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  });

  afterAll(async () => {
    if (admin2) await admin2.query("ROLLBACK").catch(() => undefined);
    if (admin) {
      await admin.query("DELETE FROM public.audit_log WHERE baby_id = ANY($1::uuid[])", [babies]);
      await admin.query("DELETE FROM public.babies WHERE id = ANY($1::uuid[])", [babies]);
      await admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [users]);
    }
    await pool?.end();
    await admin?.end();
    await admin2?.end();
  });

  const sharer = () => createAutoSharer({ pool, log: recordingLog() });

  async function baby(plan: "free" | "plus" = "plus") {
    const ownerId = randomUUID();
    await admin.query(
      `INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
       VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())`,
      [ownerId, `as-${ownerId}@worker.test`],
    );
    await admin.query("INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'A')", [
      ownerId,
    ]);
    users.push(ownerId);
    const id = randomUUID();
    await admin.query(
      "INSERT INTO public.babies (id, name, birth_date, plan) VALUES ($1, 'AS', '2026-01-15', $2)",
      [id, plan],
    );
    await admin.query(
      "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
      [id, ownerId],
    );
    babies.push(id);
    return { id, ownerId };
  }

  interface PhotoOpts {
    tags?: string[];
    sensitive?: boolean;
    analysed?: boolean;
    approval?: "approved" | "pending";
    trashed?: boolean;
  }

  async function photo(b: { id: string; ownerId: string }, o: PhotoOpts = {}): Promise<string> {
    const id = randomUUID().replace(/^0/, "1"); // keep the fake provider's bath rule out of it
    await admin.query(
      `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, bytes, approval, status, deleted_at)
       VALUES ($1, $2, $3, $4, 16, $5, 'ingested', ${o.trashed ? "now()" : "NULL"})`,
      [id, b.id, b.ownerId, `as/${id}`, o.approval ?? "approved"],
    );
    if (o.analysed !== false) {
      const desc = {
        ...fakeDescription(id),
        search_tags: o.tags ?? ["baby"],
        activities: [],
        sensitive_content: o.sensitive ? ["bath"] : [],
        occasion: null,
        setting: { indoor_outdoor: "unknown", place_type: null, weather: null, time_of_day: null },
      };
      await admin.query(
        `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description, sensitive_flags)
         VALUES ($1, 'fake', 'v1', 'v1', $2::jsonb, $3::text[])`,
        [id, JSON.stringify(desc), o.sensitive ? ["bath"] : []],
      );
    }
    return id;
  }

  async function link(
    b: { id: string; ownerId: string },
    rule?: { mode: "all" | "milestones" | "tags"; include?: string[]; exclude?: string[] },
  ): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO public.share_links (id, baby_id, name, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'AS link', $4, now() + interval '24 hours', $3)`,
      [id, b.id, b.ownerId, randomBytes(32)],
    );
    if (rule) {
      await admin.query(
        "INSERT INTO public.share_rules (share_link_id, mode, include_tags, exclude_tags) VALUES ($1, $2, $3::text[], $4::text[])",
        [id, rule.mode, rule.include ?? [], rule.exclude ?? []],
      );
    }
    return id;
  }

  const rows = async (linkId: string, by?: "rule" | "user") =>
    (
      await admin.query<{ photo_id: string }>(
        `SELECT photo_id FROM public.shared_photos WHERE share_link_id = $1 ${by ? "AND added_by = $2" : ""} ORDER BY photo_id`,
        by ? [linkId, by] : [linkId],
      )
    ).rows.map((r) => r.photo_id);
  const sorted = (...ids: string[]) => [...ids].sort();

  async function milestone(b: { id: string; ownerId: string }, name = "Cousin visit") {
    const r = await admin.query<{ id: string }>(
      "INSERT INTO public.milestones (baby_id, name, category) VALUES ($1, $2, 'custom') RETURNING id",
      [b.id, name],
    );
    return r.rows[0]?.id as string;
  }
  async function tagMilestone(photoId: string, milestoneId: string, userId: string) {
    await admin.query(
      `INSERT INTO public.photo_details (photo_id, milestone_id, edited_by) VALUES ($1, $2, $3)
       ON CONFLICT (photo_id) DO UPDATE SET milestone_id = EXCLUDED.milestone_id`,
      [photoId, milestoneId, userId],
    );
  }
  const sensitiveRuleRows = async (babyId: string) =>
    (
      await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.shared_photos sp JOIN public.photos p ON p.id = sp.photo_id
          WHERE p.baby_id = $1 AND sp.added_by = 'rule' AND p.is_sensitive`,
        [babyId],
      )
    ).rows[0]?.n;

  it("rules all / milestones / tags(+exclude) produce exactly the expected rows; the sensitive photo is in none", async () => {
    const b = await baby();
    const ms = await milestone(b);
    const plain = await photo(b, { tags: ["baby", "outdoor"] });
    const bath = await photo(b, { tags: ["bath", "outdoor"], sensitive: true });
    const stepsPhoto = await photo(b, { tags: ["indoor"] });
    const excluded = await photo(b, { tags: ["outdoor", "nap"] });
    const pending = await photo(b, { approval: "pending" });
    const trashed = await photo(b, { trashed: true });
    const unanalysed = await photo(b, { analysed: false });
    await tagMilestone(stepsPhoto, ms, b.ownerId);
    const lAll = await link(b, { mode: "all" });
    const lMs = await link(b, { mode: "milestones" });
    const lTags = await link(b, { mode: "tags", include: ["outdoor"], exclude: ["nap"] });
    const lNone = await link(b);

    for (const l of [lAll, lMs, lTags]) await sharer().applyLink(l);

    expect(await rows(lAll)).toEqual(sorted(plain, stepsPhoto, excluded));
    expect(await rows(lMs)).toEqual([stepsPhoto]);
    expect(await rows(lTags)).toEqual([plain]);
    expect(await rows(lNone)).toEqual([]);
    for (const l of [lAll, lMs, lTags]) {
      const r = await rows(l);
      for (const never of [bath, pending, trashed, unanalysed]) expect(r).not.toContain(never);
    }
    expect(await sensitiveRuleRows(b.id)).toBe(0);
    // an exclusion
    void excluded;
  });

  it("applyLink advances evaluated_at; a second run is idempotent", async () => {
    const b = await baby();
    const p = await photo(b);
    const l = await link(b, { mode: "all" });
    const before = (
      await admin.query("SELECT evaluated_at FROM public.share_rules WHERE share_link_id = $1", [l])
    ).rows[0];
    expect(before.evaluated_at).toBeNull();
    const first = await sharer().applyLink(l);
    expect(first).toMatchObject({ links: 1, added: 1, removed: 0, skipped: 0 });
    const after = (
      await admin.query("SELECT evaluated_at FROM public.share_rules WHERE share_link_id = $1", [l])
    ).rows[0];
    expect(after.evaluated_at).not.toBeNull();
    expect(await sharer().applyLink(l)).toMatchObject({ added: 0, removed: 0 });
    expect(await rows(l)).toEqual([p]);
  });

  it("a details edit adding a milestone is picked up by evaluatePhotos (the reindex hook)", async () => {
    const b = await baby();
    const ms = await milestone(b);
    const p1 = await photo(b);
    const p2 = await photo(b);
    const l = await link(b, { mode: "milestones" });
    await sharer().applyLink(l);
    expect(await rows(l)).toEqual([]);
    await tagMilestone(p1, ms, b.ownerId);
    const out = await sharer().evaluatePhotos([p1, p2]);
    expect(out).toMatchObject({ links: 1, added: 1 });
    expect(await rows(l)).toEqual([p1]);
    // removing the milestone again drops the rule row
    await admin.query("UPDATE public.photo_details SET milestone_id = NULL WHERE photo_id = $1", [
      p1,
    ]);
    expect(await sharer().evaluatePhotos([p1])).toMatchObject({ removed: 1 });
    expect(await rows(l)).toEqual([]);
  });

  it("changing the rule re-syncs: adding an exclude tag removes rule rows but keeps hand-picked rows", async () => {
    const b = await baby();
    const keep = await photo(b, { tags: ["outdoor", "nap"] });
    const drop = await photo(b, { tags: ["outdoor", "nap"] });
    const stay = await photo(b, { tags: ["outdoor"] });
    const l = await link(b, { mode: "tags", include: ["outdoor"] });
    await sharer().applyLink(l);
    expect(await rows(l, "rule")).toEqual(sorted(keep, drop, stay));
    // an admin hand-picks `keep` (converts the rule row into a user row)
    await admin.query(
      "UPDATE public.shared_photos SET added_by = 'user', added_by_user_id = $3 WHERE share_link_id = $1 AND photo_id = $2",
      [l, keep, b.ownerId],
    );
    await admin.query(
      "UPDATE public.share_rules SET exclude_tags = '{nap}' WHERE share_link_id = $1",
      [l],
    );
    const out = await sharer().applyLink(l);
    expect(out.removed).toBe(1);
    expect(await rows(l, "rule")).toEqual([stay]);
    expect(await rows(l, "user")).toEqual([keep]);
    expect(await rows(l)).not.toContain(drop);
  });

  it("an admin-removed (excluded) photo is never re-added, by apply, evaluate or reconcile", async () => {
    const b = await baby();
    const p = await photo(b);
    const q = await photo(b);
    const l = await link(b, { mode: "all" });
    await admin.query(
      "INSERT INTO public.shared_photo_exclusions (share_link_id, photo_id, excluded_by) VALUES ($1, $2, $3)",
      [l, p, b.ownerId],
    );
    await sharer().applyLink(l);
    await sharer().evaluatePhotos([p, q]);
    await sharer().reconcile();
    expect(await rows(l)).toEqual([q]);
  });

  it("a later sensitive flag removes the rule row (database trigger) and the sync never re-adds it; user rows survive", async () => {
    const b = await baby();
    const p = await photo(b);
    const q = await photo(b);
    const l = await link(b, { mode: "all" });
    const l2 = await link(b);
    await sharer().applyLink(l);
    await admin.query(
      "INSERT INTO public.shared_photos (share_link_id, photo_id, added_by, added_by_user_id) VALUES ($1, $2, 'user', $3)",
      [l2, p, b.ownerId],
    );
    expect(await rows(l)).toEqual(sorted(p, q));
    await admin.query("UPDATE public.photos SET is_sensitive = true WHERE id = $1", [p]);
    expect(await rows(l)).toEqual([q]);
    await sharer().evaluatePhotos([p, q]);
    await sharer().applyLink(l);
    await sharer().reconcile();
    expect(await rows(l)).toEqual([q]);
    expect(await rows(l2, "user")).toEqual([p]);
    expect(await sensitiveRuleRows(b.id)).toBe(0);
  });

  it("a trashed photo keeps its rule row (a restore brings it back); nothing new is added for trash", async () => {
    const b = await baby();
    const p = await photo(b);
    const l = await link(b, { mode: "all" });
    await sharer().applyLink(l);
    await admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [p]);
    await sharer().applyLink(l);
    expect(await rows(l)).toEqual([p]);
  });

  it("free baby: nothing is ever added; rows that stop matching are still removed", async () => {
    const b = await baby("plus");
    const p = await photo(b);
    const l = await link(b, { mode: "all" });
    await sharer().applyLink(l);
    expect(await rows(l)).toEqual([p]);
    // downgrade: the rule stays (delete is always allowed), AI is off
    await admin.query("UPDATE public.babies SET plan = 'free' WHERE id = $1", [b.id]);
    const unanalysedNew = await photo(b, { analysed: false });
    const out = await sharer().applyLink(l);
    expect(out.added).toBe(0);
    expect(await rows(l)).not.toContain(unanalysedNew);
    // the photo stops matching (sensitive) -> its rule row goes even on a free baby
    await admin.query("UPDATE public.photos SET is_sensitive = true WHERE id = $1", [p]);
    await sharer().evaluatePhotos([p]);
    expect(await rows(l)).toEqual([]);
  });

  it("free-tier photos never reach a rule: an unanalysed photo is not shared even on a plus baby", async () => {
    const b = await baby("plus");
    const un = await photo(b, { analysed: false });
    const l = await link(b, { mode: "all" });
    await sharer().applyLink(l);
    await sharer().evaluatePhotos([un]);
    await sharer().reconcile();
    expect(await rows(l)).toEqual([]);
  });

  it("evaluatePhotos for a baby without any rule does nothing", async () => {
    const b = await baby();
    const p = await photo(b);
    await link(b);
    expect(await sharer().evaluatePhotos([p])).toMatchObject({ links: 0, added: 0, removed: 0 });
  });

  it("reconcile: a never-synced rule gets a full sync; a rule past its watermark evaluates only changed photos", async () => {
    const b = await baby();
    const p = await photo(b);
    const l = await link(b, { mode: "all" });
    const first = await sharer().reconcile();
    expect(first.added).toBeGreaterThanOrEqual(1);
    expect(await rows(l)).toEqual([p]);
    // watermark in the future: nothing has changed since it, so nothing is evaluated for this rule
    await admin.query(
      "UPDATE public.share_rules SET evaluated_at = now() + interval '2 hours' WHERE share_link_id = $1",
      [l],
    );
    const q = await photo(b);
    await sharer().reconcile();
    expect(await rows(l)).toEqual([p]); // q was not looked at: it is older than the watermark
    // watermark in the past: q (changed since) is picked up
    await admin.query(
      "UPDATE public.share_rules SET evaluated_at = now() - interval '1 hour' WHERE share_link_id = $1",
      [l],
    );
    await sharer().reconcile();
    expect(await rows(l)).toEqual(sorted(p, q));
  });

  it("watermark guard: evaluated_at only advances if the rule did not change during the sync", async () => {
    const b = await baby();
    await photo(b);
    const l = await link(b, { mode: "all" });
    const read = async () =>
      (
        await admin.query<{ updated_at: Date; v: string; evaluated_at: Date | null }>(
          "SELECT updated_at, updated_at::text AS v, evaluated_at FROM public.share_rules WHERE share_link_id = $1",
          [l],
        )
      ).rows[0] as { updated_at: Date; v: string; evaluated_at: Date | null };
    const stale = await read();
    // the rule is edited after it was read by the sync
    await admin.query(
      "UPDATE public.share_rules SET mode = 'milestones' WHERE share_link_id = $1",
      [l],
    );
    const when = new Date(Date.now() - 3_600_000);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE pipeline");
      const res = await c.query(MARK_EVALUATED_SQL, [l, when, stale.v]);
      await c.query("COMMIT");
      expect(res.rowCount).toBe(0);
    } finally {
      c.release();
    }
    expect((await read()).evaluated_at).toBeNull();
    // with the current version it does advance
    const fresh = await read();
    const c2 = await pool.connect();
    try {
      await c2.query("BEGIN");
      await c2.query("SET LOCAL ROLE pipeline");
      const res = await c2.query(MARK_EVALUATED_SQL, [l, when, fresh.v]);
      await c2.query("COMMIT");
      expect(res.rowCount).toBe(1);
    } finally {
      c2.release();
    }
    expect((await read()).evaluated_at).not.toBeNull();
    // and the next reconcile sees needs_full for a rule edited after its last sync
    await admin.query("UPDATE public.share_rules SET mode = 'all' WHERE share_link_id = $1", [l]);
    const needs = await admin.query(
      "SELECT (evaluated_at < updated_at) AS n FROM public.share_rules WHERE share_link_id = $1",
      [l],
    );
    expect(needs.rows[0].n).toBe(true);
  });

  it("RACE: a sensitive flag held open in another connection makes that photo skipped; the others are added and the batch is not aborted", async () => {
    const b = await baby();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await photo(b));
    const victim = ids[1] as string;
    const l = await link(b, { mode: "all" });

    await admin2.query("BEGIN");
    await admin2.query("UPDATE public.photos SET is_sensitive = true WHERE id = $1", [victim]);

    const apply = sharer().applyLink(l);
    // wait until the sync's insert is blocked on the photo row lock (the gate's FOR SHARE)
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const r = await admin.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO shared_photos%'`,
      );
      blocked = (r.rowCount ?? 0) > 0;
      if (!blocked) await new Promise((r2) => setTimeout(r2, 50));
    }
    expect(blocked).toBe(true);
    await admin2.query("COMMIT");

    const out = await apply;
    expect(out.skipped).toBe(1);
    expect(out.added).toBe(3);
    expect(await rows(l)).toEqual(sorted(...ids.filter((x) => x !== victim)));
    expect(await sensitiveRuleRows(b.id)).toBe(0);
  });

  it("after any apply, no sensitive photo has a rule row (sweep over a mixed baby, all rule modes)", async () => {
    const b = await baby();
    const ms = await milestone(b);
    for (let i = 0; i < 6; i++) {
      const p = await photo(b, {
        sensitive: i % 3 === 0,
        tags: ["outdoor", i % 2 ? "nap" : "play"],
      });
      if (i % 2 === 0) await tagMilestone(p, ms, b.ownerId);
    }
    const links = [
      await link(b, { mode: "all" }),
      await link(b, { mode: "milestones" }),
      await link(b, { mode: "tags", include: ["outdoor"] }),
    ];
    for (const l of links) await sharer().applyLink(l);
    await sharer().reconcile();
    expect(await sensitiveRuleRows(b.id)).toBe(0);
    expect((await rows(links[0] as string)).length).toBe(4);
  });
});
