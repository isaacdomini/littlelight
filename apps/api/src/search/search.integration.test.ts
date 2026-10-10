import { Writable } from "node:stream";
import { createFakeEmbedder, type Embedder, getAiStatus } from "@tinyglow/ai";
import { apiErrorSchema, searchFacetsResponseSchema, searchResponseSchema } from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loggerOptions } from "../app";
import type { AiServices } from "../plugins/ai";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedPhoto } from "../testing/photos";
import { seedDetails, seedSearchRow } from "../testing/search";
import { testConfig } from "../testing/support";

// Hybrid search + facets against a real database (docs/plans/step-7.md 2.12; PRD FR-7.3, FR-7.5,
// FR-7.7 admins of a paid baby only, FR-5.8). The fake embedder is injected through
// `BuildAppOptions.ai`; nothing here reads a provider key or calls a provider.

const SECRET_NOTE = "PRIVATE-PARENT-NOTE-5521";
const QUERY_SENTINEL = "SENTINEL-QUERY-7788";

describe.skipIf(!databaseUrl)("search routes (api + db)", () => {
  let h: Harness;
  let mom: TestUser;
  let dad: TestUser;
  let nanny: TestUser;
  let stranger: TestUser;
  let freeAdmin: TestUser;
  let baby: string; // plus
  let freeBaby: string;
  let expiredBaby: string;
  let otherBaby: string; // someone else's plus baby
  const ph: Record<string, string> = {};
  const logs: string[] = [];
  const embedSpy = vi.fn();
  const fakeEmbedder = createFakeEmbedder({ dims: 1024 });
  const ai: AiServices = {
    chat: null,
    embedder: {
      model: fakeEmbedder.model,
      dims: fakeEmbedder.dims,
      embed: async (texts: string[]) => {
        embedSpy(texts.length);
        return fakeEmbedder.embed(texts);
      },
    } satisfies Embedder,
    status: getAiStatus({ VISION_PROVIDER: "fake" }),
    chatReasoningEffort: "low",
  };

  const search = (u: TestUser | null, babyId: string, qs: string) =>
    h.inject(u, "GET", `/babies/${babyId}/search${qs}`);
  const ids = (res: { json(): unknown }) =>
    searchResponseSchema.parse(res.json()).photos.map((p) => p.id);

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    });
    const config = testConfig({ LOG_LEVEL: "info" });
    h = await createHarness({
      ai,
      config: { LOG_LEVEL: "info" },
      logger: { ...loggerOptions(config), level: "info", stream },
    });
    mom = await h.user();
    dad = await h.user();
    nanny = await h.user();
    stranger = await h.user();
    freeAdmin = await h.user();
    baby = await h.baby(mom, "Plus baby");
    freeBaby = await h.baby(freeAdmin, "Free baby");
    expiredBaby = await h.baby(mom, "Expired baby");
    otherBaby = await h.baby(stranger, "Other baby");
    await h.member(baby, dad, "admin");
    await h.member(baby, nanny, "contributor");
    await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = ANY($1::uuid[])", [
      [baby, otherBaby],
    ]);
    await h.admin.query(
      "UPDATE public.babies SET plan = 'plus', entitlement_expires_at = now() + interval '1 day' WHERE id = $1",
      [expiredBaby],
    );

    const mk = async (key: string, babyId: string, o: Parameters<typeof seedPhoto>[2] = {}) => {
      ph[key] = await seedPhoto(h.admin, babyId, {
        uploadedBy: mom.id,
        status: "ingested",
        withThumb: true,
        ...o,
      });
    };
    await mk("bath", baby, { takenAt: "2026-06-10T12:00:00Z" });
    await mk("park", baby, { takenAt: "2026-07-20T12:00:00Z" });
    await mk("steps", baby, { takenAt: "2026-08-15T12:00:00Z" });
    await mk("trashed", baby);
    await mk("pending", baby, { approval: "pending" });
    await mk("unembedded", baby, { takenAt: "2026-09-01T12:00:00Z" });
    await mk("other", otherBaby);
    await mk("expired", expiredBaby);

    await seedSearchRow(h.admin, {
      photoId: ph.bath as string,
      babyId: baby,
      text: "Baby splashing in the bath with a yellow duck.",
      tags: ["bath", "duck"],
      people: ["Dad"],
      place: "home",
      takenAt: "2026-06-10T12:00:00Z",
      ageDays: 101,
    });
    await seedSearchRow(h.admin, {
      photoId: ph.park as string,
      babyId: baby,
      text: `Walking in the park with Grandma. Note from parent: "${SECRET_NOTE}"`,
      tags: ["park", "outdoor"],
      people: ["Grandma"],
      place: "riverside park",
      takenAt: "2026-07-20T12:00:00Z",
      ageDays: 141,
    });
    await seedSearchRow(h.admin, {
      photoId: ph.steps as string,
      babyId: baby,
      text: "First steps on the grass toward Dad.",
      tags: ["first steps", "grass"],
      people: ["Dad", "Mom"],
      place: "riverside park",
      takenAt: "2026-08-15T12:00:00Z",
      ageDays: 167,
    });
    await seedSearchRow(h.admin, {
      photoId: ph.unembedded as string,
      babyId: baby,
      text: "Playing with blocks on the floor.",
      tags: ["blocks"],
      vector: false,
      takenAt: "2026-09-01T12:00:00Z",
      ageDays: 184,
    });
    await seedSearchRow(h.admin, {
      photoId: ph.other as string,
      babyId: otherBaby,
      text: "Other family bath photo with a duck.",
      tags: ["bath"],
    });
    await seedSearchRow(h.admin, {
      photoId: ph.expired as string,
      babyId: expiredBaby,
      text: "Bath at the lapsed baby.",
      tags: ["bath"],
    });
    await h.admin.query(
      "UPDATE public.babies SET entitlement_expires_at = now() - interval '1 hour' WHERE id = $1",
      [expiredBaby],
    );
    await seedDetails(h.admin, ph.park as string, {
      note: SECRET_NOTE,
      people: ["Grandma"],
      editedBy: mom.id,
    });
    // a trashed photo and a pending one never get a row (guard + cleanup); prove the API agrees
    await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [ph.trashed]);
  });

  afterAll(async () => {
    await h?.close();
  });

  describe("access", () => {
    it("the signed-in admin of a plus baby gets 200; a second admin too", async () => {
      expect((await search(mom, baby, "?q=bath")).statusCode).toBe(200);
      expect((await search(dad, baby, "?q=bath")).statusCode).toBe(200);
    });

    it("a contributor (nanny) gets 403 forbidden, before any embedding call", async () => {
      embedSpy.mockClear();
      const res = await search(nanny, baby, "?q=bath");
      expect(res.statusCode).toBe(403);
      expect(apiErrorSchema.parse(res.json()).error).toBe("forbidden");
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("the admin of a free baby gets 403 plan_required; so does a lapsed entitlement", async () => {
      embedSpy.mockClear();
      for (const [u, b] of [
        [freeAdmin, freeBaby],
        [mom, expiredBaby],
      ] as const) {
        const res = await search(u, b, "?q=bath");
        expect(res.statusCode).toBe(403);
        expect(apiErrorSchema.parse(res.json()).error).toBe("plan_required");
      }
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("a stranger gets 404, not 403 (no existence leak); so does a random baby id", async () => {
      embedSpy.mockClear();
      for (const id of [baby, "11111111-1111-4111-8111-111111111111"]) {
        const res = await search(stranger, id, "?q=bath");
        expect(res.statusCode).toBe(404);
        expect(apiErrorSchema.parse(res.json()).error).toBe("not_found");
      }
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("requires sign-in (401)", async () => {
      expect((await search(null, baby, "?q=bath")).statusCode).toBe(401);
      expect((await h.inject(null, "GET", `/babies/${baby}/search/facets`)).statusCode).toBe(401);
    });

    it("the same gate protects the facets", async () => {
      const get = (u: TestUser, b: string) => h.inject(u, "GET", `/babies/${b}/search/facets`);
      expect((await get(nanny, baby)).statusCode).toBe(403);
      expect((await get(freeAdmin, freeBaby)).json().error).toBe("plan_required");
      expect((await get(stranger, baby)).statusCode).toBe(404);
      expect((await get(mom, baby)).statusCode).toBe(200);
    });

    it("an admin of another baby cannot search this one even with a matching word", async () => {
      const res = await search(stranger, baby, "?q=bath");
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.json())).not.toContain(ph.bath as string);
    });
  });

  describe("validation", () => {
    it("an empty search is a 400 validation_failed", async () => {
      for (const qs of ["", "?q=", "?q=%20%20", "?limit=5"]) {
        const res = await search(mom, baby, qs);
        expect(res.statusCode, qs).toBe(400);
        expect(apiErrorSchema.parse(res.json()).error).toBe("validation_failed");
      }
    });

    it("rejects reversed ranges, bad dates, oversize queries and limits", async () => {
      for (const qs of [
        "?dateFrom=2026-07-01&dateTo=2026-06-01",
        "?ageFrom=50&ageTo=10",
        "?dateFrom=June",
        `?q=${"x".repeat(201)}`,
        "?q=bath&limit=51",
        "?q=bath&limit=0",
        "?milestoneId=nope",
      ]) {
        expect((await search(mom, baby, qs)).statusCode, qs).toBe(400);
      }
    });
  });

  describe("results", () => {
    it("q=bath ranks the bath photo first and never returns another baby's photo", async () => {
      const res = await search(mom, baby, "?q=bath");
      expect(res.statusCode).toBe(200);
      const out = searchResponseSchema.parse(res.json());
      expect(out.photos[0]?.id).toBe(ph.bath);
      expect(out.degraded).toBeNull();
      expect(out.tookMs).toBeGreaterThanOrEqual(0);
      expect(out.photos.map((p) => p.id)).not.toContain(ph.other);
      for (const p of out.photos) expect(p.babyId).toBe(baby);
    });

    it("unrelated text finds nothing (relevance floor): photos is empty, not the nearest photos", async () => {
      for (const q of ["xylophone%20zebra", "zebra%20submarine"]) {
        const res = await search(mom, baby, `?q=${q}`);
        expect(res.statusCode).toBe(200);
        const out = searchResponseSchema.parse(res.json());
        expect(out.photos, q).toEqual([]);
        expect(out.degraded).toBeNull();
      }
    });

    it("q=bath returns exactly the bath photo", async () => {
      expect(ids(await search(mom, baby, "?q=bath"))).toEqual([ph.bath]);
    });

    it("the semantic leg works through the fake embedder (shared words)", async () => {
      embedSpy.mockClear();
      const res = await search(mom, baby, "?q=walking%20park");
      expect(ids(res)[0]).toBe(ph.park);
      expect(embedSpy).toHaveBeenCalledTimes(1);
    });

    it("filters only (no q): newest first and no embedding call", async () => {
      embedSpy.mockClear();
      const res = await search(mom, baby, "?person=Dad");
      expect(ids(res)).toEqual([ph.steps, ph.bath]);
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("person, tag, place, date and age filters narrow the result", async () => {
      expect(ids(await search(mom, baby, "?person=grandma"))).toEqual([ph.park]);
      expect(ids(await search(mom, baby, "?tag=GRASS"))).toEqual([ph.steps]);
      expect(ids(await search(mom, baby, "?place=Riverside%20Park"))).toEqual([ph.steps, ph.park]);
      expect(ids(await search(mom, baby, "?dateFrom=2026-07-01&dateTo=2026-07-31"))).toEqual([
        ph.park,
      ]);
      expect(ids(await search(mom, baby, "?ageFrom=150&ageTo=170"))).toEqual([ph.steps]);
      // filters first, then rank: a text query never widens the filtered set, and the relevance
      // floor drops the filtered photo that has nothing to do with "bath"
      expect(ids(await search(mom, baby, "?q=bath&person=Grandma"))).toEqual([]);
      expect(ids(await search(mom, baby, "?q=park&person=Grandma"))).toEqual([ph.park]);
    });

    it("a milestone filter by id uses the tagged milestone", async () => {
      const m = (
        await h.admin.query(
          "INSERT INTO public.milestones (baby_id, name, category, created_by) VALUES ($1, 'First wave', 'custom', $2) RETURNING id",
          [baby, mom.id],
        )
      ).rows[0].id as string;
      await h.admin.query(
        "UPDATE public.photo_search SET milestone_ids = ARRAY[$1]::uuid[] WHERE photo_id = $2",
        [m, ph.park],
      );
      expect(ids(await search(mom, baby, `?milestoneId=${m}`))).toEqual([ph.park]);
      await h.admin.query(
        "UPDATE public.photo_search SET milestone_ids = '{}' WHERE photo_id = $1",
        [ph.park],
      );
    });

    it("limit caps the page", async () => {
      const res = await search(mom, baby, "?person=Dad&limit=1");
      expect(ids(res)).toHaveLength(1);
    });

    it("a trashed photo disappears at once (cleanup trigger + live join) and a pending one never appears", async () => {
      await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [ph.bath]);
      expect(ids(await search(mom, baby, "?q=bath"))).not.toContain(ph.bath);
      await h.admin.query("UPDATE public.photos SET deleted_at = NULL WHERE id = $1", [ph.bath]);
      // restoring makes the photo "missing" for the indexer: re-add its row as the worker would
      await seedSearchRow(h.admin, {
        photoId: ph.bath as string,
        babyId: baby,
        text: "Baby splashing in the bath with a yellow duck.",
        tags: ["bath", "duck"],
        people: ["Dad"],
        place: "home",
        takenAt: "2026-06-10T12:00:00Z",
        ageDays: 101,
      });
      for (const key of ["trashed", "pending"]) {
        const res = await search(mom, baby, "?q=photo%20baby%20bath%20park%20steps");
        expect(ids(res)).not.toContain(ph[key]);
      }
    });

    it("summaries are signed thumbs only; no search document, note, GPS or raw JSON anywhere", async () => {
      const res = await search(mom, baby, "?q=park");
      const body = res.body;
      expect(body).not.toContain(SECRET_NOTE);
      for (const word of [
        "search_text",
        "latitude",
        "longitude",
        "gps",
        "raw_json",
        "storage_key",
        "embedding",
      ]) {
        expect(body.toLowerCase(), word).not.toContain(word);
      }
      const photo = searchResponseSchema.parse(res.json()).photos[0];
      expect(photo?.thumbUrl).toMatch(/^https?:\/\//);
      expect(photo?.thumbUrl).not.toMatch(/analysis|original/);
      expect(Object.keys(photo ?? {})).not.toContain("storageKey");
    });
  });

  describe("degraded mode", () => {
    it("without an embedder: keyword + tag legs answer and degraded is no_embeddings", async () => {
      const saved = ai.embedder;
      embedSpy.mockClear();
      ai.embedder = null;
      try {
        const res = await search(mom, baby, "?q=bath");
        expect(res.statusCode).toBe(200);
        const out = searchResponseSchema.parse(res.json());
        expect(out.degraded).toBe("no_embeddings");
        expect(out.photos[0]?.id).toBe(ph.bath);
        // a person word still finds photos through the tag/people leg
        expect(ids(await search(mom, baby, "?q=Grandma"))).toContain(ph.park);
      } finally {
        ai.embedder = saved;
      }
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("when no candidate row has a vector, the query is degraded and the embedder is not called", async () => {
      embedSpy.mockClear();
      // only the unembedded photo matches this filter
      const res = await search(mom, baby, "?q=blocks&dateFrom=2026-09-01&dateTo=2026-09-30");
      const out = searchResponseSchema.parse(res.json());
      expect(out.degraded).toBe("no_embeddings");
      expect(out.photos.map((p) => p.id)).toEqual([ph.unembedded]);
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("a provider failure on the query embedding is a clean error, not a leak", async () => {
      const saved = ai.embedder;
      ai.embedder = {
        model: "fake",
        dims: 1024,
        embed: async () => {
          throw Object.assign(new Error(`provider said: ${QUERY_SENTINEL}`), {
            code: "server_error",
          });
        },
      };
      try {
        const res = await search(mom, baby, "?q=bath");
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain(QUERY_SENTINEL);
      } finally {
        ai.embedder = saved;
      }
    });
  });

  describe("facets", () => {
    it("lists people, tags, places and the indexed date range with counts, only for this baby", async () => {
      const res = await h.inject(mom, "GET", `/babies/${baby}/search/facets`);
      expect(res.statusCode).toBe(200);
      const f = searchFacetsResponseSchema.parse(res.json());
      expect(f.people[0]).toEqual({ name: "Dad", count: 2 });
      expect(f.people.map((p) => p.name).sort()).toEqual(["Dad", "Grandma", "Mom"]);
      expect(f.places).toEqual([
        { place: "riverside park", count: 2 },
        { place: "home", count: 1 },
      ]);
      expect(f.tags.map((t) => t.tag)).toContain("bath");
      expect(f.tags.every((t) => t.count >= 1)).toBe(true);
      expect(f.dateRange).toEqual({ from: "2026-06-10", to: "2026-09-01" });
      expect(JSON.stringify(f)).not.toContain("duck.");
      expect(JSON.stringify(f)).not.toContain(SECRET_NOTE);
    });

    it("an empty album has no date range", async () => {
      const empty = await h.baby(mom, "Empty plus");
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [empty]);
      const f = searchFacetsResponseSchema.parse(
        (await h.inject(mom, "GET", `/babies/${empty}/search/facets`)).json(),
      );
      expect(f).toEqual({ people: [], milestones: [], tags: [], places: [], dateRange: null });
    });
  });

  describe("privacy of logs", () => {
    it("the query string never reaches a log line", async () => {
      logs.length = 0;
      await search(mom, baby, `?q=${QUERY_SENTINEL}&person=SENTINEL-PERSON-1`);
      await search(nanny, baby, `?q=${QUERY_SENTINEL}`);
      await search(stranger, baby, `?q=${QUERY_SENTINEL}`);
      const dump = logs.join("");
      expect(dump.length).toBeGreaterThan(0);
      expect(dump).not.toContain(QUERY_SENTINEL);
      expect(dump).not.toContain("SENTINEL-PERSON-1");
      expect(dump).toContain('"msg":"search"');
    });
  });
});
