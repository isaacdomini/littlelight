import {
  AI_CONFLICT_MESSAGES,
  aiUsageResponseSchema,
  apiErrorSchema,
  photoSchema,
  type ReindexJob,
} from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobQueue } from "../plugins/jobs";
import { sampleDescription, seedItem, seedPhotoAi } from "../testing/ai";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedPhoto } from "../testing/photos";
import { listPhotosSql } from "./queries";

// AI block, overrides, retry and usage against a real database (docs/plans/step-6.md 2.8, 2.11;
// PRD FR-5.6 overrides, FR-5.8 paid tier only). RLS decides who may write; the stub job queue
// records `photo.reindex` hand-offs.

const SECRET_NOTE = "PRIVATE-PARENT-NOTE-7731";

describe.skipIf(!databaseUrl)("AI routes (api + db)", () => {
  let h: Harness;
  let reindexed: ReindexJob[];
  let mom: TestUser;
  let dad: TestUser;
  let nanny: TestUser;
  let stranger: TestUser;
  let baby: string; // plus
  let freeBaby: string;
  let expiredBaby: string;
  const ph: Record<string, string> = {};

  const jobs: JobQueue = {
    enqueueIngest: async () => true,
    async enqueueReindex(job) {
      reindexed.push(job);
      return true;
    },
    close: async () => undefined,
  };

  const get = (u: TestUser | null, id: string) => h.inject(u, "GET", `/photos/${id}`);
  const aiOf = async (u: TestUser, id: string) => {
    const res = await get(u, id);
    expect(res.statusCode, res.body).toBe(200);
    return photoSchema.parse(res.json()).ai;
  };
  const patch = (u: TestUser | null, id: string, body: unknown) =>
    h.inject(u, "PATCH", `/photos/${id}/ai`, body);
  const retry = (u: TestUser | null, id: string) => h.inject(u, "POST", `/photos/${id}/ai/retry`);
  const usage = (u: TestUser | null, babyId: string, q = "") =>
    h.inject(u, "GET", `/babies/${babyId}/ai/usage${q}`);
  const overridesOf = async (id: string) =>
    (
      await h.admin.query(
        "SELECT field_path, value FROM public.photo_ai_overrides WHERE photo_id = $1 ORDER BY field_path",
        [id],
      )
    ).rows as { field_path: string; value: unknown }[];

  beforeAll(async () => {
    h = await createHarness({ jobs, config: { AI_BABY_MONTHLY_BUDGET_USD: 5 } });
    mom = await h.user();
    dad = await h.user();
    nanny = await h.user();
    stranger = await h.user();
    baby = await h.baby(mom, "Plus baby");
    freeBaby = await h.baby(mom, "Free baby");
    expiredBaby = await h.baby(mom, "Expired baby");
    await h.member(baby, dad, "admin");
    await h.member(baby, nanny, "contributor");
    await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [baby]);
    await h.admin.query(
      "UPDATE public.babies SET plan = 'plus', entitlement_expires_at = now() - interval '1 day' WHERE id = $1",
      [expiredBaby],
    );

    const mk = (key: string, babyId: string, o: Parameters<typeof seedPhoto>[2] = {}) =>
      seedPhoto(h.admin, babyId, {
        uploadedBy: mom.id,
        status: "ingested",
        withThumb: true,
        withDisplay: true,
        withAnalysis: true,
        ...o,
      }).then((id) => {
        ph[key] = id;
      });

    await mk("pending", baby);
    await mk("noAnalysis", baby, { withAnalysis: false });
    await mk("queued", baby, { status: "queued" });
    await mk("analyzing", baby, { status: "analyzing" });
    await mk("ready", baby, { status: "ready" });
    await mk("failed", baby);
    await mk("failedAfterRetry", baby);
    await mk("failedOldVersion", baby);
    await mk("oneFailure", baby);
    await mk("badRow", baby, { status: "ready" });
    await mk("freePhoto", freeBaby);
    await mk("expiredPhoto", expiredBaby);

    await h.admin.query(
      `INSERT INTO public.photo_details (photo_id, note, people, edited_by) VALUES ($1, $2, '{Dad}', $3)`,
      [ph.ready, SECRET_NOTE, mom.id],
    );
    await h.admin.query(
      `INSERT INTO public.photo_exif (photo_id, taken_at, place_label) VALUES ($1, now(), 'Home')`,
      [ph.ready],
    );
    await seedPhotoAi(h.admin, ph.ready as string);
    await seedPhotoAi(
      h.admin,
      ph.badRow as string,
      { caption: "old shape", legacy: true },
      { schema: "v0" },
    );

    // failed: two failed attempts for the current versions
    for (const [a, kind] of [
      [1, "invalid_output"],
      [2, "refusal"],
    ] as const) {
      await seedItem(h.admin, {
        photoId: ph.failed as string,
        babyId: baby,
        attempt: a,
        failure: kind,
        ago: `${3 - a} hours`,
      });
    }
    // failedAfterRetry: two failures, then an admin retry request later
    for (const a of [1, 2]) {
      await seedItem(h.admin, {
        photoId: ph.failedAfterRetry as string,
        babyId: baby,
        attempt: a,
        ago: `${3 - a} hours`,
      });
    }
    await h.admin.query(
      "UPDATE public.photos SET ai_retry_requested_at = now() - interval '10 minutes' WHERE id = $1",
      [ph.failedAfterRetry],
    );
    // failedOldVersion: two failures against v0 (do not count)
    for (const a of [1, 2]) {
      await seedItem(h.admin, {
        photoId: ph.failedOldVersion as string,
        babyId: baby,
        attempt: a,
        prompt: "v0",
        ago: `${3 - a} hours`,
      });
    }
    await seedItem(h.admin, {
      photoId: ph.oneFailure as string,
      babyId: baby,
      attempt: 1,
    });
    // cost this month
    await seedItem(h.admin, {
      photoId: ph.ready as string,
      babyId: baby,
      state: "succeeded",
      cost: 0.0001385,
    });
  });

  afterAll(async () => {
    if (h) {
      await h.admin.query(
        "DELETE FROM public.ai_batches WHERE id IN (SELECT batch_id FROM public.ai_batch_items WHERE baby_id = $1)",
        [baby],
      );
      await h.close();
    }
  });

  const reset = () => {
    reindexed = [];
  };

  // -------------------------------------------------------------------------------------------
  describe("GET /photos/:id ai.status", () => {
    it.each([
      ["pending", "pending"],
      ["noAnalysis", "not_available"],
      ["queued", "queued"],
      ["analyzing", "analyzing"],
      ["ready", "ready"],
      ["failed", "failed"],
      ["failedAfterRetry", "pending"],
      ["failedOldVersion", "pending"],
      ["oneFailure", "pending"],
      ["freePhoto", "not_available"],
      ["expiredPhoto", "not_available"],
    ])("%s => %s", async (key, status) => {
      const ai = await aiOf(mom, ph[key] as string);
      expect(ai.status).toBe(status);
    });

    it("a failed photo gives the failure category and canRetry (admin only)", async () => {
      const ai = await aiOf(mom, ph.failed as string);
      expect(ai).toMatchObject({
        status: "failed",
        failure: "refusal",
        canRetry: true,
        description: null,
      });
      expect((await aiOf(nanny, ph.failed as string)).canRetry).toBe(false);
      expect((await aiOf(mom, ph.pending as string)).failure).toBeNull();
    });

    it("a ready photo has the description; raw is admin-only; model and versions are present", async () => {
      const admin = await aiOf(mom, ph.ready as string);
      expect(admin.status).toBe("ready");
      expect(admin.description).toEqual(sampleDescription(ph.ready as string));
      expect(admin.raw).toEqual(admin.description);
      expect(admin).toMatchObject({
        model: "gpt-6-luna",
        promptVersion: "v1",
        schemaVersion: "v1",
        canRetry: false,
      });
      expect(admin.analyzedAt).toMatch(/Z$/);
      const contributor = await aiOf(nanny, ph.ready as string);
      expect(contributor.description).toEqual(admin.description);
      expect(contributor.raw).toBeNull();
    });

    it("an old-version row that no longer validates is ready with description null (never an error)", async () => {
      const ai = await aiOf(mom, ph.badRow as string);
      expect(ai).toMatchObject({
        status: "ready",
        description: null,
        raw: null,
        schemaVersion: "v0",
      });
    });

    it("a stranger gets 404 and no AI data", async () => {
      const res = await get(stranger, ph.ready as string);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("gpt-6-luna");
    });

    it("no response carries latitude, raw_json, the analysis derivative or a parent note inside ai.*", async () => {
      const res = await get(mom, ph.ready as string);
      const text = res.body;
      expect(text).not.toMatch(/latitude|longitude|gps_|raw_json/i);
      expect(text).not.toContain("analysis.jpg");
      expect(text).not.toContain("/analysis");
      const ai = JSON.stringify(res.json().ai);
      expect(ai).not.toContain(SECRET_NOTE);
      expect(ai).not.toContain("Dad");
    });

    it("401 without a session", async () => {
      expect((await get(null, ph.ready as string)).statusCode).toBe(401);
    });

    it("list summaries carry aiStatus and the timeline query still uses photos_baby_id_sort_idx", async () => {
      const res = await h.inject(mom, "GET", `/babies/${baby}/photos?limit=50`);
      expect(res.statusCode).toBe(200);
      const byId = new Map(
        (res.json().photos as { id: string; aiStatus: string }[]).map((p) => [p.id, p.aiStatus]),
      );
      expect(byId.get(ph.ready as string)).toBe("ready");
      expect(byId.get(ph.failed as string)).toBe("failed");

      const pager = await h.baby(mom, "EXPLAIN baby");
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [pager]);
      await h.admin.query(
        `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, status, approval, taken_at)
         SELECT $1::uuid, $2::uuid, 'ai-explain/' || $1::text || '/' || g, 'ingested', 'approved',
                '2026-01-01T00:00:00Z'::timestamptz - g * interval '1 minute'
           FROM generate_series(1, 3000) g`,
        [pager, mom.id],
      );
      await h.admin.query("ANALYZE public.photos");
      const { text, values } = listPhotosSql({
        babyId: pager,
        view: "album",
        dir: "older",
        cursor: null,
        limit: 50,
        milestoneId: null,
      } as never);
      const plan = await h.admin.query(`EXPLAIN (FORMAT JSON) ${text}`, values);
      expect(JSON.stringify(plan.rows[0])).toContain("photos_baby_id_sort_idx");
      expect(JSON.stringify(plan.rows[0])).not.toContain("Seq Scan on photos");
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("PATCH /photos/:id/ai (overrides)", () => {
    it("an admin sets caption: 200, override wins in description, raw unchanged, reindex ai_override, audit has no value", async () => {
      reset();
      const res = await patch(mom, ph.ready as string, { caption: "Maya's first picnic" });
      expect(res.statusCode, res.body).toBe(200);
      const ai = photoSchema.parse(res.json()).ai;
      expect(ai.description?.caption).toBe("Maya's first picnic");
      expect(ai.raw?.caption).toBe(sampleDescription(ph.ready as string).caption);
      expect(ai.overrides).toEqual({ caption: "Maya's first picnic" });
      // the photo summary caption (timeline) follows the override too
      expect(res.json().caption).toBe("Maya's first picnic");
      expect(reindexed).toEqual([{ photoId: ph.ready, babyId: baby, reason: "ai_override" }]);
      const events = await h.audit({ event: "ai.override_updated", baby });
      expect(events.at(-1)).toMatchObject({
        actor_user_id: mom.id,
        metadata: { photo_id: ph.ready, field: "caption" },
      });
      expect(Object.keys(events.at(-1)?.metadata ?? {}).sort()).toEqual(["field", "photo_id"]);
      expect(JSON.stringify(events)).not.toContain("picnic");
    });

    it("also sets description and tags (normalised) in one request: one reindex job", async () => {
      reset();
      const res = await patch(dad, ph.ready as string, {
        detailed_description: "A long day.",
        search_tags: ["Picnic", " picnic ", "Summer"],
      });
      expect(res.statusCode, res.body).toBe(200);
      const ai = photoSchema.parse(res.json()).ai;
      expect(ai.overrides).toMatchObject({
        detailed_description: "A long day.",
        search_tags: ["picnic", "summer"],
      });
      expect(ai.description?.search_tags).toEqual(["picnic", "summer"]);
      expect(reindexed).toHaveLength(1);
      expect((await overridesOf(ph.ready as string)).map((r) => r.field_path)).toEqual([
        "caption",
        "detailed_description",
        "search_tags",
      ]);
    });

    it("clearing with null restores the AI value, audits cleared, and reindexes", async () => {
      reset();
      const res = await patch(mom, ph.ready as string, {
        caption: null,
        detailed_description: null,
        search_tags: null,
      });
      expect(res.statusCode, res.body).toBe(200);
      const ai = photoSchema.parse(res.json()).ai;
      expect(ai.overrides).toEqual({});
      expect(ai.description).toEqual(sampleDescription(ph.ready as string));
      expect(reindexed).toHaveLength(1);
      const cleared = await h.audit({ event: "ai.override_cleared", baby });
      expect(cleared.map((e) => e.metadata.field).sort()).toEqual([
        "caption",
        "detailed_description",
        "search_tags",
      ]);
      expect(await overridesOf(ph.ready as string)).toEqual([]);
    });

    it("clearing an override that does not exist changes nothing: no audit row, no reindex", async () => {
      reset();
      const before = (await h.audit({ event: "ai.override_cleared", baby })).length;
      const res = await patch(mom, ph.ready as string, { caption: null });
      expect(res.statusCode).toBe(200);
      expect(reindexed).toEqual([]);
      expect((await h.audit({ event: "ai.override_cleared", baby })).length).toBe(before);
    });

    it("a contributor gets 403 and nothing is written", async () => {
      reset();
      const res = await patch(nanny, ph.ready as string, { caption: "nope" });
      expect(res.statusCode).toBe(403);
      expect(apiErrorSchema.safeParse(res.json()).success).toBe(true);
      expect(await overridesOf(ph.ready as string)).toEqual([]);
      expect(reindexed).toEqual([]);
    });

    it("a stranger gets 404; no session gets 401", async () => {
      expect((await patch(stranger, ph.ready as string, { caption: "x" })).statusCode).toBe(404);
      expect((await patch(null, ph.ready as string, { caption: "x" })).statusCode).toBe(401);
    });

    it("409 for a free-tier baby (not available) and for an expired entitlement; never writes", async () => {
      for (const key of ["freePhoto", "expiredPhoto"]) {
        const res = await patch(mom, ph[key] as string, { caption: "x" });
        expect(res.statusCode, key).toBe(409);
        expect(res.json().message).toBe(AI_CONFLICT_MESSAGES.notAvailable);
        expect(await overridesOf(ph[key] as string)).toEqual([]);
      }
    });

    it("409 for a Plus photo without a description yet", async () => {
      const res = await patch(mom, ph.pending as string, { caption: "x" });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe(AI_CONFLICT_MESSAGES.noDescription);
    });

    it.each([
      ["an empty body", {}],
      ["an empty caption", { caption: "" }],
      ["a 201 char caption", { caption: "x".repeat(201) }],
      ["an empty tag list", { search_tags: [] }],
      ["a non-string description", { detailed_description: 5 }],
      ["only unknown fields", { objects: ["x"] }],
    ])("400 for %s", async (_n, body) => {
      reset();
      const res = await patch(mom, ph.ready as string, body);
      expect(res.statusCode, res.body).toBe(400);
      expect(reindexed).toEqual([]);
    });

    it("an invalid body is not echoed back in the error", async () => {
      const res = await patch(mom, ph.ready as string, {
        caption: `${SECRET_NOTE}${"x".repeat(300)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(SECRET_NOTE);
    });

    it("a trashed photo cannot be edited", async () => {
      const id = await seedPhoto(h.admin, baby, {
        uploadedBy: mom.id,
        status: "ready",
        trashedAgo: "1 hour",
        withAnalysis: true,
      });
      await seedPhotoAi(h.admin, id);
      const res = await patch(mom, id, { caption: "x" });
      expect([403, 404, 409]).toContain(res.statusCode);
      expect(await overridesOf(id)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("POST /photos/:id/ai/retry", () => {
    it("an admin retries a failed photo: 200 pending, flag set, audited, status flips to pending", async () => {
      const before = await h.admin.query(
        "SELECT ai_retry_requested_at FROM public.photos WHERE id = $1",
        [ph.failed],
      );
      expect(before.rows[0].ai_retry_requested_at).toBeNull();
      const res = await retry(mom, ph.failed as string);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ status: "pending" });
      const after = await h.admin.query(
        "SELECT ai_retry_requested_at, status FROM public.photos WHERE id = $1",
        [ph.failed],
      );
      expect(after.rows[0].ai_retry_requested_at).not.toBeNull();
      expect(after.rows[0].status).toBe("ingested");
      expect((await aiOf(mom, ph.failed as string)).status).toBe("pending");
      const ev = await h.audit({ event: "ai.retry_requested", baby });
      expect(ev.at(-1)).toMatchObject({ actor_user_id: mom.id, metadata: { photo_id: ph.failed } });
      // a second retry is now a conflict (no longer failed)
      expect((await retry(mom, ph.failed as string)).statusCode).toBe(409);
    });

    it("409 on a ready photo and on a pending photo, with the notFailed message", async () => {
      for (const key of ["ready", "pending"]) {
        const res = await retry(mom, ph[key] as string);
        expect(res.statusCode, key).toBe(409);
        expect(res.json().message).toBe(AI_CONFLICT_MESSAGES.notFailed);
      }
    });

    it("409 notAvailable on a free baby's photo", async () => {
      const res = await retry(mom, ph.freePhoto as string);
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe(AI_CONFLICT_MESSAGES.notAvailable);
    });

    it("403 for a contributor (flag untouched), 404 for a stranger, 401 without a session", async () => {
      await seedItem(h.admin, {
        photoId: ph.oneFailure as string,
        babyId: baby,
        attempt: 2,
      });
      expect((await aiOf(mom, ph.oneFailure as string)).status).toBe("failed");
      const res = await retry(nanny, ph.oneFailure as string);
      expect(res.statusCode).toBe(403);
      const row = await h.admin.query(
        "SELECT ai_retry_requested_at FROM public.photos WHERE id = $1",
        [ph.oneFailure],
      );
      expect(row.rows[0].ai_retry_requested_at).toBeNull();
      expect((await retry(stranger, ph.oneFailure as string)).statusCode).toBe(404);
      expect((await retry(null, ph.oneFailure as string)).statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("GET /babies/:id/ai/usage", () => {
    it("an admin sees month, cost, budget from config, counts per status, lastCompletedAt", async () => {
      const res = await usage(mom, baby);
      expect(res.statusCode, res.body).toBe(200);
      const body = aiUsageResponseSchema.parse(res.json());
      expect(body.month).toBe(new Date().toISOString().slice(0, 7));
      expect(body.budgetUsd).toBe(5);
      expect(body.costUsd).toBeCloseTo(0.0001385, 8);
      expect(body.lastCompletedAt).not.toBeNull();
      expect(body.photos.ready).toBe(2); // ready + badRow
      expect(body.photos.queued).toBe(1);
      expect(body.photos.analyzing).toBe(1);
      expect(body.photos.not_available).toBe(1); // no analysis derivative
      expect(Object.values(body.photos).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(9);
    });

    it("another month has zero cost; month validation", async () => {
      const res = await usage(mom, baby, "?month=2020-01");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ month: "2020-01", costUsd: 0 });
      expect((await usage(mom, baby, "?month=2020-13")).statusCode).toBe(400);
      expect((await usage(mom, baby, "?month=last")).statusCode).toBe(400);
    });

    it("a free baby: every photo not_available, cost 0", async () => {
      const res = await usage(mom, freeBaby);
      expect(res.statusCode).toBe(200);
      const b = aiUsageResponseSchema.parse(res.json());
      expect(b.photos).toMatchObject({
        not_available: 1,
        pending: 0,
        ready: 0,
        queued: 0,
        analyzing: 0,
        failed: 0,
      });
      expect(b.costUsd).toBe(0);
    });

    it("a contributor gets 403, a stranger 404, no session 401", async () => {
      expect((await usage(nanny, baby)).statusCode).toBe(403);
      expect((await usage(stranger, baby)).statusCode).toBe(404);
      expect((await usage(null, baby)).statusCode).toBe(401);
    });

    it("never exposes another baby's cost: an admin of another baby sees 404", async () => {
      const otherAdmin = await h.user();
      expect((await usage(otherAdmin, baby)).statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("share-link viewers and chat", () => {
    it("the AI routes do not accept a viewer-role token", async () => {
      // A viewer session is not an authenticated user session: no AI route may answer it.
      const res = await h.app.inject({
        method: "GET",
        url: `/photos/${ph.ready}`,
        headers: { authorization: "Bearer not-a-user-token" },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
