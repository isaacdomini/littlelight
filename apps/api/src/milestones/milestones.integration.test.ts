import {
  MAX_CUSTOM_MILESTONES_PER_BABY,
  MILESTONE_PRESETS,
  milestoneSchema,
  milestonesListResponseSchema,
  type ReindexJob,
} from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobQueue } from "../plugins/jobs";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedPhoto } from "../testing/photos";

// Milestones CRUD against a real database (docs/plans/step-5.md 2.4, D7): presets immutable,
// custom ones admin-only, unique names (presets included), the 200 cap, reindex fan-out.

describe.skipIf(!databaseUrl)("milestones (api + db)", () => {
  let h: Harness;
  let reindexed: ReindexJob[];
  let mom: TestUser;
  let nanny: TestUser;
  let stranger: TestUser;
  let baby: string;
  let other: string;

  const jobs: JobQueue = {
    enqueueIngest: async () => true,
    async enqueueReindex(job) {
      reindexed.push(job);
      return true;
    },
    close: async () => undefined,
  };

  const create = (u: TestUser | null, babyId: string, body: unknown) =>
    h.inject(u, "POST", `/babies/${babyId}/milestones`, body);
  const make = async (name: string, babyId = baby, u = mom) => {
    const res = await create(u, babyId, { name });
    expect(res.statusCode, res.body).toBe(201);
    return milestoneSchema.parse(res.json());
  };

  beforeAll(async () => {
    h = await createHarness({ jobs });
    mom = await h.user();
    nanny = await h.user();
    stranger = await h.user();
    baby = await h.baby(mom);
    other = await h.baby(await h.user(), "Other");
    await h.member(baby, nanny, "contributor");
  });
  afterAll(async () => {
    await h?.close();
  });
  const reset = () => {
    reindexed = [];
  };

  it("lists the presets by sortOrder, then custom ones; members of any role may read; strangers 404", async () => {
    await make("Zebra day");
    await make("Apple day");
    for (const u of [mom, nanny]) {
      const res = await h.inject(u, "GET", `/babies/${baby}/milestones`);
      expect(res.statusCode, res.body).toBe(200);
      const list = milestonesListResponseSchema.parse(res.json()).milestones;
      expect(list.slice(0, MILESTONE_PRESETS.length).map((m) => m.name)).toEqual(
        MILESTONE_PRESETS.map((p) => p.name),
      );
      expect(
        list.slice(0, MILESTONE_PRESETS.length).every((m) => m.isPreset && m.babyId === null),
      ).toBe(true);
      expect(list.slice(MILESTONE_PRESETS.length).map((m) => m.name)).toEqual([
        "Zebra day",
        "Apple day",
      ]);
    }
    expect((await h.inject(stranger, "GET", `/babies/${baby}/milestones`)).statusCode).toBe(404);
    expect((await h.inject(null, "GET", `/babies/${baby}/milestones`)).statusCode).toBe(401);
  });

  it("another album's custom milestones are never listed", async () => {
    await h.admin.query(
      "INSERT INTO public.milestones (baby_id, name, category) VALUES ($1, 'Only in other', 'custom')",
      [other],
    );
    const res = await h.inject(mom, "GET", `/babies/${baby}/milestones`);
    expect(res.body).not.toContain("Only in other");
  });

  it("create: 201 with counts and no cover; audited by id only", async () => {
    reset();
    const m = await make("First swim");
    expect(m).toMatchObject({
      name: "First swim",
      category: "custom",
      isPreset: false,
      babyId: baby,
      photoCount: 0,
      coverPhoto: null,
      firstTakenAt: null,
    });
    const rows = (await h.audit({ event: "milestone.created", baby })).filter(
      (a) => a.metadata.milestone_id === m.id,
    );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]?.metadata ?? {})).toEqual(["milestone_id"]);
    expect(JSON.stringify(await h.audit({ baby }))).not.toContain("First swim");
    expect(reindexed).toEqual([]);
  });

  it("a contributor cannot create (403); a stranger gets 404", async () => {
    expect((await create(nanny, baby, { name: "Nanny made" })).statusCode).toBe(403);
    expect((await create(stranger, baby, { name: "Nope" })).statusCode).toBe(404);
    expect((await create(null, baby, { name: "Nope" })).statusCode).toBe(401);
    expect(
      (await h.admin.query("SELECT 1 FROM public.milestones WHERE name IN ('Nanny made','Nope')"))
        .rowCount,
    ).toBe(0);
  });

  it("duplicate names are 409, case-insensitively, and so are preset names", async () => {
    await make("Dup name");
    for (const name of ["dup NAME", "Dup name", "first steps", "FIRST SMILE"]) {
      const res = await create(mom, baby, { name });
      expect(res.statusCode, name).toBe(409);
      expect(res.json().error).toBe("conflict");
      expect(res.body).not.toMatch(/constraint|milestones_/);
    }
  });

  it("validates the body: empty, over-long and unknown category are 400", async () => {
    for (const body of [
      { name: "" },
      { name: "   " },
      { name: "x".repeat(81) },
      { name: "ok", category: "bogus" },
      {},
    ]) {
      expect((await create(mom, baby, body)).statusCode, JSON.stringify(body).slice(0, 30)).toBe(
        400,
      );
    }
    expect((await create(mom, baby, { name: "y".repeat(80) })).statusCode).toBe(201);
  });

  it("rename: 200 with the new name, duplicate/preset name 409, reindex for tagged live photos only", async () => {
    const m = await make("Before rename");
    const tagged = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
    const trashed = await seedPhoto(h.admin, baby, { uploadedBy: mom.id, trashedAgo: "1 hour" });
    for (const p of [tagged, trashed])
      await h.admin.query(
        "INSERT INTO public.photo_details (photo_id, milestone_id) VALUES ($1, $2)",
        [p, m.id],
      );
    reset();
    const res = await h.inject(mom, "PATCH", `/milestones/${m.id}`, {
      name: "After rename",
      category: "event",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(milestoneSchema.parse(res.json())).toMatchObject({
      name: "After rename",
      category: "event",
      photoCount: 1,
    });
    expect(reindexed).toEqual([{ photoId: tagged, babyId: baby, reason: "milestone" }]);
    expect(
      (await h.audit({ event: "milestone.updated", baby })).some(
        (a) => a.metadata.milestone_id === m.id,
      ),
    ).toBe(true);
    expect(
      (await h.inject(mom, "PATCH", `/milestones/${m.id}`, { name: "first word" })).statusCode,
    ).toBe(409);
    expect((await h.inject(mom, "PATCH", `/milestones/${m.id}`, {})).statusCode).toBe(400);
  });

  it("a milestone's cover is the earliest live approved tagged photo", async () => {
    const m = await make("Cover test");
    const early = await seedPhoto(h.admin, baby, {
      uploadedBy: mom.id,
      takenAt: "2026-02-01T10:00:00Z",
      withThumb: true,
    });
    const late = await seedPhoto(h.admin, baby, {
      uploadedBy: mom.id,
      takenAt: "2026-03-01T10:00:00Z",
      withThumb: true,
    });
    const pending = await seedPhoto(h.admin, baby, {
      uploadedBy: nanny.id,
      approval: "pending",
      takenAt: "2026-01-01T10:00:00Z",
    });
    for (const p of [early, late, pending])
      await h.admin.query(
        "INSERT INTO public.photo_details (photo_id, milestone_id) VALUES ($1, $2)",
        [p, m.id],
      );
    const list = milestonesListResponseSchema.parse(
      (await h.inject(nanny, "GET", `/babies/${baby}/milestones`)).json(),
    );
    const got = list.milestones.find((x) => x.id === m.id);
    expect(got?.photoCount).toBe(2);
    expect(got?.coverPhoto?.id).toBe(early);
    expect(got?.firstTakenAt).toBe("2026-02-01T10:00:00.000Z");
  });

  it("presets cannot be renamed or deleted (403) and stay intact; unknown ids are 404", async () => {
    const preset = MILESTONE_PRESETS[0]?.id as string;
    expect(
      (await h.inject(mom, "PATCH", `/milestones/${preset}`, { name: "Hacked" })).statusCode,
    ).toBe(403);
    expect((await h.inject(mom, "DELETE", `/milestones/${preset}`)).statusCode).toBe(403);
    expect(
      (
        await h.inject(mom, "PATCH", "/milestones/99999999-9999-4999-8999-999999999999", {
          name: "x",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await h.admin.query("SELECT name FROM public.milestones WHERE id = $1", [preset])).rows[0]
        .name,
    ).toBe("First smile");
  });

  it("a contributor cannot rename or delete (403); a stranger and another album's admin get 404", async () => {
    const m = await make("Guarded");
    expect(
      (await h.inject(nanny, "PATCH", `/milestones/${m.id}`, { name: "Hijack" })).statusCode,
    ).toBe(403);
    expect((await h.inject(nanny, "DELETE", `/milestones/${m.id}`)).statusCode).toBe(403);
    expect(
      (await h.inject(stranger, "PATCH", `/milestones/${m.id}`, { name: "Hijack" })).statusCode,
    ).toBe(404);
    expect((await h.inject(stranger, "DELETE", `/milestones/${m.id}`)).statusCode).toBe(404);
    const otherAdmin = await h.user();
    await h.member(other, otherAdmin, "admin").catch(() => undefined);
    expect((await h.inject(otherAdmin, "DELETE", `/milestones/${m.id}`)).statusCode).toBe(404);
    expect(
      (await h.admin.query("SELECT name FROM public.milestones WHERE id = $1", [m.id])).rows[0]
        .name,
    ).toBe("Guarded");
  });

  it("delete: 204, photos keep their other details, tagged photos are reindexed, audited", async () => {
    const m = await make("To delete");
    const p = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
    await h.admin.query(
      "INSERT INTO public.photo_details (photo_id, milestone_id, note) VALUES ($1, $2, 'keep me')",
      [p, m.id],
    );
    reset();
    const res = await h.inject(mom, "DELETE", `/milestones/${m.id}`);
    expect(res.statusCode, res.body).toBe(204);
    const d = (
      await h.admin.query(
        "SELECT milestone_id, note FROM public.photo_details WHERE photo_id = $1",
        [p],
      )
    ).rows[0];
    expect(d).toEqual({ milestone_id: null, note: "keep me" });
    expect(reindexed).toEqual([{ photoId: p, babyId: baby, reason: "milestone" }]);
    expect(
      (await h.audit({ event: "milestone.deleted", baby })).some(
        (a) => a.metadata.milestone_id === m.id,
      ),
    ).toBe(true);
    expect((await h.inject(mom, "DELETE", `/milestones/${m.id}`)).statusCode).toBe(404);
  });

  it("the 201st custom milestone is 409", async () => {
    const b = await h.baby(mom, "Capped");
    await h.admin.query(
      `INSERT INTO public.milestones (baby_id, name, category, created_by)
       SELECT $1, 'Cap ' || g, 'custom', $2 FROM generate_series(1, $3::int) g`,
      [b, mom.id, MAX_CUSTOM_MILESTONES_PER_BABY],
    );
    const res = await create(mom, b, { name: "One too many" });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toMatch(/200/);
  });

  it("responses never carry analysis, gps or raw_json", async () => {
    const res = await h.inject(mom, "GET", `/babies/${baby}/milestones`);
    expect(res.body).not.toMatch(/analysis|gps|raw_json|storage_key/i);
  });
});
