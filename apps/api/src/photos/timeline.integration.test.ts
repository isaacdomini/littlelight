import {
  ageGroupKey,
  MILESTONE_PRESETS,
  photoSchema,
  photosBatchDetailsResponseSchema,
  photosListResponseSchema,
  photosSummaryResponseSchema,
  photoUrlsResponseSchema,
  type ReindexJob,
} from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobQueue } from "../plugins/jobs";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedPhoto } from "../testing/photos";
import { createS3Stub, type S3Stub } from "../testing/s3-stub";

// Timeline, details and URL refresh against a real database (docs/plans/step-5.md 2.4, 2.10):
// bidirectional keyset paging, age-group summary, batch URLs, details PATCH/batch with RLS and
// the reindex hand-off. S3 and the job queue are stubs.

const FIRST_SMILE = MILESTONE_PRESETS[0]?.id as string;
const SECOND = MILESTONE_PRESETS[1]?.id as string;

describe.skipIf(!databaseUrl)("timeline + details (api + db)", () => {
  let h: Harness;
  let s3: S3Stub;
  let reindexed: ReindexJob[];
  let committedAtEnqueue: boolean[];
  let mom: TestUser;
  let nanny: TestUser;
  let stranger: TestUser;
  let baby: string;
  let other: string;

  const jobs: JobQueue = {
    enqueueIngest: async () => true,
    async enqueueReindex(job) {
      const { rows } = await h.admin.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE usename = 'tinyglow_api' AND state LIKE 'idle in transaction%'`,
      );
      committedAtEnqueue.push(rows[0].n === 0);
      reindexed.push(job);
      return true;
    },
    close: async () => undefined,
  };

  const get = (u: TestUser | null, url: string) => h.inject(u, "GET", url);
  const patchDetails = (u: TestUser, photo: string, body: unknown) =>
    h.inject(u, "PATCH", `/photos/${photo}/details`, body);
  const detailsRow = async (photo: string) =>
    (await h.admin.query("SELECT * FROM public.photo_details WHERE photo_id = $1", [photo]))
      .rows[0] as
      | {
          note: string | null;
          people: string[];
          location_label: string | null;
          milestone_id: string | null;
        }
      | undefined;

  beforeAll(async () => {
    s3 = createS3Stub();
    h = await createHarness({ jobs, s3 });
    mom = await h.user();
    nanny = await h.user();
    stranger = await h.user();
    baby = await h.baby(mom);
    other = await h.baby(await h.user(), "Other");
    await h.member(baby, nanny, "contributor");
    await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = ANY($1)", [
      [baby, other],
    ]);
  });
  afterAll(async () => {
    await h?.close();
  });
  const reset = () => {
    reindexed = [];
    committedAtEnqueue = [];
  };

  // -------------------------------------------------------------------------------------------
  describe("deep keyset pagination", () => {
    const N = 3000;
    let pager: string;
    let expected: string[];

    beforeAll(async () => {
      pager = await h.baby(mom, "Deep pager");
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [pager]);
      // Groups of three share a capture time: the id tie-break is exercised on every page edge.
      await h.admin.query(
        `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, status, approval, taken_at)
         SELECT $1::uuid, $2::uuid, 'deep/' || $1::text || '/' || g, 'ingested', 'approved',
                '2026-01-01T00:00:00Z'::timestamptz - (g / 3) * interval '1 minute'
           FROM generate_series(1, $3::int) g`,
        [pager, mom.id, N],
      );
      expected = (
        await h.admin.query(
          "SELECT id FROM public.photos WHERE baby_id = $1 ORDER BY sort_at DESC, id DESC",
          [pager],
        )
      ).rows.map((r) => r.id as string);
    });

    it("walking older pages of 200 yields every photo exactly once, in order", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await get(
          mom,
          `/babies/${pager}/photos?limit=200${cursor ? `&cursor=${cursor}` : ""}`,
        );
        expect(res.statusCode, res.body).toBe(200);
        const body = photosListResponseSchema.parse(res.json());
        seen.push(...body.photos.map((p) => p.id));
        cursor = body.nextCursor;
        pages++;
      } while (cursor && pages < 40);
      expect(pages).toBe(15);
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(N);
    });

    it("dir=newer from a deep cursor returns the items just above it, newest first, and walks to the top", async () => {
      // Cursor = last item of the 10th page (2000 items above it).
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const body = photosListResponseSchema.parse(
          (
            await get(mom, `/babies/${pager}/photos?limit=200${cursor ? `&cursor=${cursor}` : ""}`)
          ).json(),
        );
        cursor = body.nextCursor;
      }
      const collected: string[][] = [];
      let c: string | null = cursor;
      let guard = 0;
      while (c && guard++ < 20) {
        const res = await get(mom, `/babies/${pager}/photos?limit=200&dir=newer&cursor=${c}`);
        const body = photosListResponseSchema.parse(res.json());
        collected.push(body.photos.map((p) => p.id));
        c = body.prevCursor && body.photos.length === 200 ? body.prevCursor : null;
        // prevCursor is only set while more newer items exist
        if (body.photos.length < 200) c = null;
      }
      expect(collected[0]).toEqual(expected.slice(1799, 1999));
      const flat = collected.reverse().flat();
      expect(flat).toEqual(expected.slice(0, 1999)); // everything strictly above the cursor
    });

    it("dir=newer without a cursor behaves like the first page; prevCursor is null at the top of a newer walk", async () => {
      const a = photosListResponseSchema.parse(
        (await get(mom, `/babies/${pager}/photos?limit=5&dir=newer`)).json(),
      );
      expect(a.photos.map((p) => p.id)).toEqual(expected.slice(0, 5));
      const first = photosListResponseSchema.parse(
        (await get(mom, `/babies/${pager}/photos?limit=5`)).json(),
      );
      const up = photosListResponseSchema.parse(
        (
          await get(mom, `/babies/${pager}/photos?limit=5&dir=newer&cursor=${first.nextCursor}`)
        ).json(),
      );
      expect(up.photos.map((p) => p.id)).toEqual(expected.slice(0, 4)); // strictly above the cursor item
      expect(up.prevCursor).toBeNull();
      expect(up.nextCursor).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("summary", () => {
    let b: string;
    const ages: Array<number | null> = [-3, 0, 3, 6, 7, 83, 84, 100, 365, 729, 730, 1100, null];
    beforeAll(async () => {
      b = await h.baby(mom, "Grouped");
      for (const [i, age] of ages.entries()) {
        const id = await seedPhoto(h.admin, b, {
          uploadedBy: mom.id,
          takenAt: `2026-03-${String(10 + i).padStart(2, "0")}T10:00:00Z`,
        });
        await h.admin.query("UPDATE public.photos SET age_days = $2 WHERE id = $1", [id, age]);
      }
      // Never counted: trashed, failed, duplicate, rejected-and-trashed, foreign pending.
      await seedPhoto(h.admin, b, { trashedAgo: "1 day" });
      await seedPhoto(h.admin, b, { status: "failed" });
      await seedPhoto(h.admin, b, { status: "duplicate" });
      await seedPhoto(h.admin, b, { approval: "pending", uploadedBy: mom.id });
      await h.member(b, nanny, "contributor");
    });

    it("groups newest first, counts sum to total, and match ageGroupKey", async () => {
      const res = await get(mom, `/babies/${b}/photos/summary`);
      expect(res.statusCode, res.body).toBe(200);
      const body = photosSummaryResponseSchema.parse(res.json());
      expect(body.total).toBe(ages.length + 1); // + the admin-visible pending upload
      expect(body.groups.reduce((s, g) => s + g.count, 0)).toBe(body.total);
      const want = new Map<string, number>();
      for (const a of ages) want.set(ageGroupKey(a), (want.get(ageGroupKey(a)) ?? 0) + 1);
      want.set("unknown", (want.get("unknown") ?? 0) + 1); // the pending photo has no age yet
      expect(Object.fromEntries(body.groups.map((g) => [g.key, g.count]))).toEqual(
        Object.fromEntries(want),
      );
      expect(body.groups[0]?.key).toBe("unknown");
      expect(body.groups.at(-1)?.key).toBe("pre");
      expect(body.groups.map((g) => g.key).indexOf("y2")).toBeLessThan(
        body.groups.map((g) => g.key).indexOf("m24"),
      );
    });

    it("a contributor's summary counts the approved album only (foreign pending excluded)", async () => {
      const body = photosSummaryResponseSchema.parse(
        (await get(nanny, `/babies/${b}/photos/summary`)).json(),
      );
      expect(body.total).toBe(ages.length);
    });

    it("jumping with a group cursor starts at that group's newest item", async () => {
      const body = photosSummaryResponseSchema.parse(
        (await get(mom, `/babies/${b}/photos/summary`)).json(),
      );
      for (const g of body.groups) {
        const res = await get(mom, `/babies/${b}/photos?limit=200&cursor=${g.cursor}`);
        expect(res.statusCode, res.body).toBe(200);
        const page = photosListResponseSchema.parse(res.json());
        const first = page.photos[0];
        expect(first, g.key).toBeDefined();
        expect(ageGroupKey(first?.ageDays ?? null), g.key).toBe(g.key);
        // ... and it is the newest photo of that group.
        const newest = (
          await h.admin.query(
            `SELECT id FROM public.photos p WHERE baby_id = $1 AND deleted_at IS NULL
               AND status NOT IN ('failed','duplicate') AND public.age_group(age_days) = $2
             ORDER BY sort_at DESC, id DESC LIMIT 1`,
            [b, g.key],
          )
        ).rows[0].id;
        expect(first?.id, g.key).toBe(newest);
      }
    });

    it("trash summary is admin-only; strangers get 404", async () => {
      expect((await get(nanny, `/babies/${b}/photos/summary?view=trash`)).statusCode).toBe(403);
      expect((await get(stranger, `/babies/${b}/photos/summary`)).statusCode).toBe(404);
      expect((await get(null, `/babies/${b}/photos/summary`)).statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("milestoneId filter", () => {
    it("lists only the tagged photos, composes with the cursor", async () => {
      const b = await h.baby(mom, "Tagged");
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(
          await seedPhoto(h.admin, b, {
            uploadedBy: mom.id,
            takenAt: `2026-04-0${i + 1}T10:00:00Z`,
          }),
        );
      }
      for (const [i, id] of ids.entries()) {
        if (i !== 1) {
          await h.admin.query(
            "INSERT INTO public.photo_details (photo_id, milestone_id) VALUES ($1, $2)",
            [id, i === 3 ? SECOND : FIRST_SMILE],
          );
        }
      }
      const res = await get(mom, `/babies/${b}/photos?milestoneId=${FIRST_SMILE}`);
      const body = photosListResponseSchema.parse(res.json());
      expect(body.photos.map((p) => p.id)).toEqual([ids[2], ids[0]]);
      expect(body.photos.every((p) => p.milestoneId === FIRST_SMILE)).toBe(true);
      const page1 = photosListResponseSchema.parse(
        (await get(mom, `/babies/${b}/photos?milestoneId=${FIRST_SMILE}&limit=1`)).json(),
      );
      const page2 = photosListResponseSchema.parse(
        (
          await get(
            mom,
            `/babies/${b}/photos?milestoneId=${FIRST_SMILE}&limit=1&cursor=${page1.nextCursor}`,
          )
        ).json(),
      );
      expect([...page1.photos, ...page2.photos].map((p) => p.id)).toEqual([ids[2], ids[0]]);
      expect((await get(mom, `/babies/${b}/photos?milestoneId=nope`)).statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("POST /babies/:id/photos/urls", () => {
    let ready: string;
    let pendingMine: string;
    let trashed: string;
    let failed: string;
    let foreign: string;

    beforeAll(async () => {
      ready = await seedPhoto(h.admin, baby, {
        uploadedBy: mom.id,
        withThumb: true,
        withDisplay: true,
      });
      pendingMine = await seedPhoto(h.admin, baby, {
        uploadedBy: nanny.id,
        approval: "pending",
        withThumb: true,
      });
      trashed = await seedPhoto(h.admin, baby, {
        uploadedBy: mom.id,
        trashedAgo: "1 hour",
        withThumb: true,
      });
      failed = await seedPhoto(h.admin, baby, {
        uploadedBy: mom.id,
        status: "failed",
        withThumb: true,
      });
      foreign = await seedPhoto(h.admin, other, { withThumb: true, withDisplay: true });
    });

    const urls = async (u: TestUser, ids: string[], babyId = baby) => {
      const res = await h.inject(u, "POST", `/babies/${babyId}/photos/urls`, { photoIds: ids });
      return {
        res,
        urls: res.statusCode === 200 ? photoUrlsResponseSchema.parse(res.json()).urls : null,
      };
    };

    it("a non-admin gets neither trashed nor failed nor foreign photos; unknown ids are absent", async () => {
      const unknown = "99999999-9999-4999-8999-999999999999";
      const { urls: got } = await urls(nanny, [
        ready,
        pendingMine,
        trashed,
        failed,
        foreign,
        unknown,
      ]);
      expect(Object.keys(got ?? {}).sort()).toEqual([pendingMine, ready].sort());
      expect(got?.[ready]?.displayUrl).toContain("display");
      expect(got?.[pendingMine]?.displayUrl).toBeNull();
    });

    it("an admin also gets trashed and failed photos of their own baby, never another baby's", async () => {
      const { urls: got } = await urls(mom, [ready, trashed, failed, foreign]);
      expect(Object.keys(got ?? {}).sort()).toEqual([failed, ready, trashed].sort());
    });

    it("signs only thumb/display keys with a TTL of at most an hour", async () => {
      const { res, urls: got } = await urls(mom, [ready]);
      const set = got?.[ready];
      expect(set?.thumbUrl).toMatch(/derivatives\/.*thumb/);
      expect(set?.displayUrl).toMatch(/derivatives\/.*display/);
      expect(res.body).not.toMatch(/originals|analysis/);
      const ttl = new Date(set?.urlExpiresAt as string).getTime() - Date.now();
      expect(ttl).toBeLessThanOrEqual(3600_000);
    });

    it("strangers get 404, another baby's id in the path leaks nothing, anonymous 401, bad bodies 400", async () => {
      expect((await urls(stranger, [ready])).res.statusCode).toBe(404);
      expect((await urls(nanny, [foreign], other)).res.statusCode).toBe(404);
      expect(
        (await h.inject(null, "POST", `/babies/${baby}/photos/urls`, { photoIds: [ready] }))
          .statusCode,
      ).toBe(401);
      expect(
        (await h.inject(mom, "POST", `/babies/${baby}/photos/urls`, { photoIds: [] })).statusCode,
      ).toBe(400);
      expect(
        (await h.inject(mom, "POST", `/babies/${baby}/photos/urls`, { photoIds: ["x"] }))
          .statusCode,
      ).toBe(400);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("PATCH /photos/:id/details", () => {
    it("an admin saves details: persisted, returned, audited without values, reindex sent after commit", async () => {
      reset();
      const id = await seedPhoto(h.admin, baby, { uploadedBy: mom.id, withThumb: true });
      const res = await patchDetails(mom, id, {
        milestoneId: FIRST_SMILE,
        people: ["Grandma Rose", "Dad", "dad"],
        locationLabel: "Riverside Park",
        note: "  three wobbly steps  ",
      });
      expect(res.statusCode, res.body).toBe(200);
      const photo = photoSchema.parse(res.json());
      expect(photo.details).toEqual({
        milestoneId: FIRST_SMILE,
        note: "three wobbly steps",
        people: ["Grandma Rose", "Dad"],
        locationLabel: "Riverside Park",
      });
      expect(photo.milestoneId).toBe(FIRST_SMILE);
      expect(await detailsRow(id)).toMatchObject({
        note: "three wobbly steps",
        people: ["Grandma Rose", "Dad"],
        location_label: "Riverside Park",
      });
      expect(reindexed).toEqual([{ photoId: id, babyId: baby, reason: "details" }]);
      expect(committedAtEnqueue).toEqual([true]);
      const audit = await h.audit({ event: "photo.details_updated", actor: mom.id });
      const mine = audit.filter((a) => a.metadata.photo_id === id);
      expect(mine).toHaveLength(1);
      expect(Object.keys(mine[0]?.metadata ?? {})).toEqual(["photo_id"]);
      expect(res.body).not.toMatch(/"analysis"|"gps|raw_json/i);
    });

    it("only the provided fields change; null clears; people replaces", async () => {
      const id = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      await patchDetails(mom, id, { note: "n", people: ["A", "B"], locationLabel: "L" });
      const res = await patchDetails(mom, id, { note: null, people: ["C"] });
      expect(res.statusCode).toBe(200);
      expect(await detailsRow(id)).toMatchObject({
        note: null,
        people: ["C"],
        location_label: "L",
      });
    });

    it("the nanny edits her own pending upload (200) but not the admin's photo (403) or an invisible pending one (404)", async () => {
      const mine = await seedPhoto(h.admin, baby, { uploadedBy: nanny.id, approval: "pending" });
      const adminsApproved = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      const adminsPending = await seedPhoto(h.admin, baby, {
        uploadedBy: mom.id,
        approval: "pending",
      });
      expect((await patchDetails(nanny, mine, { note: "mine" })).statusCode).toBe(200);
      expect((await patchDetails(nanny, adminsApproved, { note: "x" })).statusCode).toBe(403);
      expect((await patchDetails(nanny, adminsPending, { note: "x" })).statusCode).toBe(404);
      expect(await detailsRow(adminsApproved)).toBeUndefined();
      expect(await detailsRow(adminsPending)).toBeUndefined();
    });

    it("once the admin approves, the nanny can no longer edit that photo", async () => {
      const mine = await seedPhoto(h.admin, baby, { uploadedBy: nanny.id, approval: "pending" });
      expect((await h.inject(mom, "POST", `/photos/${mine}/approve`)).statusCode).toBe(200);
      expect((await patchDetails(nanny, mine, { note: "late" })).statusCode).toBe(403);
    });

    it("an admin gets 403 on a trashed photo; a non-admin gets 404; a stranger 404", async () => {
      const t = await seedPhoto(h.admin, baby, { uploadedBy: mom.id, trashedAgo: "1 hour" });
      reset();
      expect((await patchDetails(mom, t, { note: "x" })).statusCode).toBe(403);
      expect((await patchDetails(nanny, t, { note: "x" })).statusCode).toBe(404);
      expect((await patchDetails(stranger, t, { note: "x" })).statusCode).toBe(404);
      expect(await detailsRow(t)).toBeUndefined();
      expect(reindexed).toEqual([]);
    });

    it("another baby's photo is invisible to a member of this baby (404), anonymous is 401", async () => {
      const f = await seedPhoto(h.admin, other);
      expect((await patchDetails(mom, f, { note: "x" })).statusCode).toBe(404);
      expect(
        (await h.inject(null, "PATCH", `/photos/${f}/details`, { note: "x" })).statusCode,
      ).toBe(401);
    });

    it("a milestone of another album is 409 and writes nothing; a deleted one too", async () => {
      const id = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      const foreignM = (
        await h.admin.query(
          "INSERT INTO public.milestones (baby_id, name, category) VALUES ($1, 'Foreign one', 'custom') RETURNING id",
          [other],
        )
      ).rows[0].id as string;
      reset();
      expect((await patchDetails(mom, id, { milestoneId: foreignM })).statusCode).toBe(409);
      expect(
        (await patchDetails(mom, id, { milestoneId: "99999999-9999-4999-8999-999999999999" }))
          .statusCode,
      ).toBe(409);
      expect(await detailsRow(id)).toBeUndefined();
      expect(reindexed).toEqual([]);
    });

    it("limits are 400: 21 people, a 2001-character note, a 121-character label, an empty patch", async () => {
      const id = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      reset();
      const bad = [
        { people: Array.from({ length: 21 }, (_, i) => `P${i}`) },
        { note: "x".repeat(2001) },
        { locationLabel: "x".repeat(121) },
        {},
        { people: [""] },
        { milestoneId: "nope" },
      ];
      for (const body of bad) {
        const res = await patchDetails(mom, id, body);
        expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
        expect(res.body).not.toContain("xxxxxxxx");
      }
      expect(reindexed).toEqual([]);
    });

    it("the note never appears in the audit log", async () => {
      const id = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      await patchDetails(mom, id, { note: "super private sentence", people: ["Secret Person"] });
      const all = JSON.stringify(await h.audit({ baby }));
      expect(all).not.toContain("super private");
      expect(all).not.toContain("Secret Person");
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("POST /babies/:id/photos/details (batch)", () => {
    it("merges people, skips what the caller cannot edit, reports updated/skipped, reindexes once per updated photo", async () => {
      const a1 = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      const a2 = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      const trashed = await seedPhoto(h.admin, baby, { uploadedBy: mom.id, trashedAgo: "1 hour" });
      const foreign = await seedPhoto(h.admin, other);
      const unknown = "99999999-9999-4999-8999-999999999999";
      await h.admin.query(
        "INSERT INTO public.photo_details (photo_id, people, note) VALUES ($1, '{Dad,Nanny}', 'keep')",
        [a2],
      );
      reset();
      const res = await h.inject(mom, "POST", `/babies/${baby}/photos/details`, {
        photoIds: [a1, a2, trashed, foreign, unknown, a1],
        addPeople: ["nanny", "Grandpa"],
        locationLabel: "Beach",
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = photosBatchDetailsResponseSchema.parse(res.json());
      expect(body.updated.sort()).toEqual([a1, a2].sort());
      expect(body.skipped.sort()).toEqual([trashed, foreign, unknown].sort());
      expect((await detailsRow(a1))?.people).toEqual(["nanny", "Grandpa"]);
      expect(await detailsRow(a2)).toMatchObject({
        people: ["Dad", "Nanny", "Grandpa"],
        note: "keep",
        location_label: "Beach",
      });
      expect(await detailsRow(foreign)).toBeUndefined();
      expect(reindexed.map((j) => j.photoId).sort()).toEqual([a1, a2].sort());
      expect(new Set(reindexed.map((j) => j.reason))).toEqual(new Set(["details"]));
      expect(reindexed.every((j) => j.babyId === baby)).toBe(true);
      const audit = (await h.audit({ event: "photos.details_batch_updated", baby })).at(-1);
      expect(audit?.metadata).toEqual({ count: 2 });
    });

    it("a photo whose union would exceed 20 people is skipped, not failed", async () => {
      const full = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      const ok = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      const nineteen = Array.from({ length: 19 }, (_, i) => `Person ${i}`);
      await h.admin.query("INSERT INTO public.photo_details (photo_id, people) VALUES ($1, $2)", [
        full,
        nineteen,
      ]);
      const res = await h.inject(mom, "POST", `/babies/${baby}/photos/details`, {
        photoIds: [full, ok],
        addPeople: ["New A", "New B"],
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = photosBatchDetailsResponseSchema.parse(res.json());
      expect(body).toEqual({ updated: [ok], skipped: [full] });
      expect((await detailsRow(full))?.people).toEqual(nineteen);
    });

    it("a contributor updates only her own pending uploads", async () => {
      const mine = await seedPhoto(h.admin, baby, { uploadedBy: nanny.id, approval: "pending" });
      const approved = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      const res = await h.inject(nanny, "POST", `/babies/${baby}/photos/details`, {
        photoIds: [mine, approved],
        note: "from nanny",
      });
      expect(res.statusCode).toBe(200);
      expect(photosBatchDetailsResponseSchema.parse(res.json())).toEqual({
        updated: [mine],
        skipped: [approved],
      });
    });

    it("strangers 404, anonymous 401, an empty change or >500 ids 400, cross-album milestone 409", async () => {
      const id = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      const url = `/babies/${baby}/photos/details`;
      expect(
        (await h.inject(stranger, "POST", url, { photoIds: [id], note: "x" })).statusCode,
      ).toBe(404);
      expect((await h.inject(null, "POST", url, { photoIds: [id], note: "x" })).statusCode).toBe(
        401,
      );
      expect((await h.inject(mom, "POST", url, { photoIds: [id] })).statusCode).toBe(400);
      const many = Array.from(
        { length: 501 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
      expect((await h.inject(mom, "POST", url, { photoIds: many, note: "x" })).statusCode).toBe(
        400,
      );
      const foreignM = (
        await h.admin.query(
          "INSERT INTO public.milestones (baby_id, name, category) VALUES ($1, 'Foreign two', 'custom') RETURNING id",
          [other],
        )
      ).rows[0].id as string;
      expect(
        (await h.inject(mom, "POST", url, { photoIds: [id], milestoneId: foreignM })).statusCode,
      ).toBe(409);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("GET /photos/:id/original when the object is missing", () => {
    it("is 404 and writes no photo.original_downloaded audit row", async () => {
      const id = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      const before = (await h.audit({ event: "photo.original_downloaded", actor: mom.id })).length;
      const res = await get(mom, `/photos/${id}/original`);
      expect(res.statusCode, res.body).toBe(404);
      expect((await h.audit({ event: "photo.original_downloaded", actor: mom.id })).length).toBe(
        before,
      );
      expect(s3.count("HeadObject")).toBeGreaterThan(0);
    });

    it("with the object present it signs and audits (control)", async () => {
      const id = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
      s3.putObject(`babies/${baby}/originals/${id}`, 10);
      const res = await get(mom, `/photos/${id}/original`);
      expect(res.statusCode, res.body).toBe(200);
      expect(
        (await h.audit({ event: "photo.original_downloaded", actor: mom.id })).some(
          (a) => a.metadata.photo_id === id,
        ),
      ).toBe(true);
    });
  });
});
