import {
  measurementSchema,
  measurementsListResponseSchema,
  type ReindexJob,
} from "@littlelight/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobQueue } from "../plugins/jobs";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedPhoto } from "../testing/photos";

// Measurements CRUD against a real database (docs/plans/step-5.md 2.4, 2.7): server-side
// normalization, unit/kind validation, admin-only writes, same-baby live photo, reindex hand-off.

describe.skipIf(!databaseUrl)("measurements (api + db)", () => {
  let h: Harness;
  let reindexed: ReindexJob[];
  let mom: TestUser;
  let nanny: TestUser;
  let stranger: TestUser;
  let baby: string;
  let other: string;
  let photo: string;

  const jobs: JobQueue = {
    enqueueIngest: async () => true,
    async enqueueReindex(job) {
      reindexed.push(job);
      return true;
    },
    close: async () => undefined,
  };
  const at = "2026-05-01T10:00:00.000Z";
  const create = (u: TestUser | null, body: unknown, babyId = baby) =>
    h.inject(u, "POST", `/babies/${babyId}/measurements`, body);
  const make = async (body: Record<string, unknown>) => {
    const res = await create(mom, { measuredAt: at, ...body });
    expect(res.statusCode, res.body).toBe(201);
    return measurementSchema.parse(res.json());
  };
  const reset = () => {
    reindexed = [];
  };

  beforeAll(async () => {
    h = await createHarness({ jobs });
    mom = await h.user();
    nanny = await h.user();
    stranger = await h.user();
    baby = await h.baby(mom);
    other = await h.baby(await h.user(), "Other");
    await h.member(baby, nanny, "contributor");
    photo = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
    reset();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("normalizes on the server: 7.5 lb and 7 lb 8 oz are 3401.943 g; 66 cm is 660 mm; the typed value is kept", async () => {
    const lb = await make({ kind: "weight", value: 7.5, unit: "lb" });
    expect(lb).toMatchObject({
      valueMetric: 3401.943,
      valueEntered: 7.5,
      unitEntered: "lb",
      photoId: null,
    });
    const oz = await make({ kind: "weight", value: 7 + 8 / 16, unit: "lb" });
    expect(oz.valueMetric).toBe(3401.943);
    expect(await make({ kind: "height", value: 66, unit: "cm" })).toMatchObject({
      valueMetric: 660,
      unitEntered: "cm",
    });
    expect(await make({ kind: "head", value: 13.5, unit: "in" })).toMatchObject({
      valueMetric: 342.9,
    });
    expect(await make({ kind: "weight", value: 3.4, unit: "kg" })).toMatchObject({
      valueMetric: 3400,
    });
    const stored = (
      await h.admin.query("SELECT value_metric::text AS v FROM public.measurements WHERE id = $1", [
        lb.id,
      ])
    ).rows[0].v;
    expect(stored).toBe("3401.943");
  });

  it("ignores a client-sent metric value (the server decides)", async () => {
    const m = await make({ kind: "weight", value: 4, unit: "kg", valueMetric: 1, value_metric: 1 });
    expect(m.valueMetric).toBe(4000);
  });

  it("rejects a unit that does not fit the kind, out-of-range, non-positive and malformed bodies with 400", async () => {
    const bad: Record<string, unknown>[] = [
      { kind: "weight", value: 5, unit: "in" },
      { kind: "height", value: 5, unit: "lb" },
      { kind: "weight", value: 51, unit: "kg" },
      { kind: "weight", value: 0.1, unit: "kg" },
      { kind: "height", value: 200, unit: "cm" },
      { kind: "head", value: 80, unit: "cm" },
      { kind: "weight", value: 0, unit: "kg" },
      { kind: "weight", value: -2, unit: "kg" },
      { kind: "girth", value: 2, unit: "kg" },
      { kind: "weight", value: 2, unit: "stone" },
      { kind: "weight", value: "2", unit: "kg" },
      { kind: "weight", unit: "kg" },
    ];
    for (const b of bad) {
      const res = await create(mom, { measuredAt: at, ...b });
      expect(res.statusCode, JSON.stringify(b)).toBe(400);
      expect(res.json().error).toBe("validation_failed");
    }
    expect((await create(mom, { kind: "weight", value: 3, unit: "kg" })).statusCode).toBe(400);
    expect(
      (
        await create(mom, {
          measuredAt: at,
          kind: "weight",
          value: 3,
          unit: "kg",
          note: "n".repeat(2001),
        })
      ).statusCode,
    ).toBe(400);
  });

  it("contributors cannot create (403); strangers 404; anonymous 401; members of another album 404", async () => {
    const body = { measuredAt: at, kind: "weight", value: 3, unit: "kg" };
    expect((await create(nanny, body)).statusCode).toBe(403);
    expect((await create(stranger, body)).statusCode).toBe(404);
    expect((await create(null, body)).statusCode).toBe(401);
    const otherAdmin = await h.user();
    await h.member(other, otherAdmin, "admin").catch(() => undefined);
    expect((await create(otherAdmin, body)).statusCode).toBe(404);
  });

  it("a linked photo must be a live photo of this album: another album's, a trashed one and an unknown one are 409", async () => {
    const foreign = await seedPhoto(h.admin, other);
    const trashed = await seedPhoto(h.admin, baby, { uploadedBy: mom.id, trashedAgo: "1 hour" });
    for (const id of [foreign, trashed]) {
      const res = await create(mom, {
        measuredAt: at,
        kind: "weight",
        value: 3,
        unit: "kg",
        photoId: id,
      });
      expect(res.statusCode, id).toBe(409);
    }
    const res = await create(mom, {
      measuredAt: at,
      kind: "weight",
      value: 3,
      unit: "kg",
      photoId: "99999999-9999-4999-8999-999999999999",
    });
    expect(res.statusCode).toBe(409);
  });

  it("a measurement linked to a photo is returned in GET /photos/:id and triggers one reindex", async () => {
    reset();
    const m = await make({ kind: "weight", value: 3.4, unit: "kg", photoId: photo });
    expect(reindexed).toEqual([{ photoId: photo, babyId: baby, reason: "measurement" }]);
    const res = await h.inject(nanny, "GET", `/photos/${photo}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().measurements.map((x: { id: string }) => x.id)).toContain(m.id);
  });

  it("list: ordered by measuredAt, filter by kind, readable by contributors, hidden from strangers", async () => {
    const b = await h.baby(mom, "Lister");
    const mk = (kind: string, value: number, unit: string, when: string) =>
      create(mom, { measuredAt: when, kind, value, unit }, b);
    await mk("weight", 5, "kg", "2026-03-01T00:00:00.000Z");
    await mk("height", 60, "cm", "2026-01-01T00:00:00.000Z");
    await mk("weight", 4, "kg", "2026-02-01T00:00:00.000Z");
    const all = measurementsListResponseSchema.parse(
      (await h.inject(mom, "GET", `/babies/${b}/measurements`)).json(),
    );
    expect(all.measurements.map((m) => m.measuredAt.slice(0, 7))).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    const w = measurementsListResponseSchema.parse(
      (await h.inject(mom, "GET", `/babies/${b}/measurements?kind=weight`)).json(),
    );
    expect(w.measurements.map((m) => m.valueMetric)).toEqual([4000, 5000]);
    expect((await h.inject(mom, "GET", `/babies/${b}/measurements?kind=bogus`)).statusCode).toBe(
      400,
    );
    expect((await h.inject(stranger, "GET", `/babies/${b}/measurements`)).statusCode).toBe(404);
    await h.member(b, nanny, "contributor");
    expect((await h.inject(nanny, "GET", `/babies/${b}/measurements`)).statusCode).toBe(200);
  });

  it("PATCH: a unit change re-normalizes; a unit that does not fit the STORED kind is 400", async () => {
    const m = await make({ kind: "weight", value: 3.4, unit: "kg" });
    const ok = await h.inject(mom, "PATCH", `/measurements/${m.id}`, { value: 8, unit: "lb" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(measurementSchema.parse(ok.json())).toMatchObject({
      valueMetric: 3628.739,
      valueEntered: 8,
      unitEntered: "lb",
    });
    const bad = await h.inject(mom, "PATCH", `/measurements/${m.id}`, { value: 30, unit: "in" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details).toEqual({ fields: ["body.unit"] });
    const range = await h.inject(mom, "PATCH", `/measurements/${m.id}`, { value: 99, unit: "kg" });
    expect(range.statusCode).toBe(400);
    expect(range.json().details).toEqual({ fields: ["body.value"] });
    const after = (
      await h.admin.query(
        "SELECT value_metric::float8 AS v, unit_entered FROM public.measurements WHERE id = $1",
        [m.id],
      )
    ).rows[0];
    expect(after).toEqual({ v: 3628.739, unit_entered: "lb" });
    expect((await h.inject(mom, "PATCH", `/measurements/${m.id}`, { value: 5 })).statusCode).toBe(
      400,
    );
    expect((await h.inject(mom, "PATCH", `/measurements/${m.id}`, {})).statusCode).toBe(400);
  });

  it("PATCH changing kind needs value + unit and validates against the new kind", async () => {
    const m = await make({ kind: "weight", value: 3, unit: "kg" });
    expect(
      (await h.inject(mom, "PATCH", `/measurements/${m.id}`, { kind: "height" })).statusCode,
    ).toBe(400);
    expect(
      (
        await h.inject(mom, "PATCH", `/measurements/${m.id}`, {
          kind: "height",
          value: 3,
          unit: "kg",
        })
      ).statusCode,
    ).toBe(400);
    const ok = await h.inject(mom, "PATCH", `/measurements/${m.id}`, {
      kind: "height",
      value: 55,
      unit: "cm",
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ kind: "height", valueMetric: 550 });
  });

  it("PATCH note/date/photo: reindexes both the old and the new photo; clearing the note stores NULL", async () => {
    const p2 = await seedPhoto(h.admin, baby, { uploadedBy: mom.id });
    const m = await make({ kind: "weight", value: 3, unit: "kg", photoId: photo, note: "hello" });
    reset();
    const res = await h.inject(mom, "PATCH", `/measurements/${m.id}`, {
      photoId: p2,
      note: "  ",
      measuredAt: "2026-05-02T00:00:00.000Z",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ photoId: p2, note: null });
    expect(reindexed.map((j) => j.photoId).sort()).toEqual([photo, p2].sort());
    expect(reindexed.every((j) => j.reason === "measurement")).toBe(true);
    reset();
    expect(
      (
        await h.inject(mom, "PATCH", `/measurements/${m.id}`, {
          photoId: "99999999-9999-4999-8999-999999999999",
        })
      ).statusCode,
    ).toBe(409);
    expect(reindexed).toEqual([]);
  });

  it("PATCH / DELETE: contributors 403, strangers 404, unknown 404", async () => {
    const m = await make({ kind: "weight", value: 3, unit: "kg" });
    expect(
      (await h.inject(nanny, "PATCH", `/measurements/${m.id}`, { note: "x" })).statusCode,
    ).toBe(403);
    expect((await h.inject(nanny, "DELETE", `/measurements/${m.id}`)).statusCode).toBe(403);
    expect(
      (await h.inject(stranger, "PATCH", `/measurements/${m.id}`, { note: "x" })).statusCode,
    ).toBe(404);
    expect((await h.inject(stranger, "DELETE", `/measurements/${m.id}`)).statusCode).toBe(404);
    const ghost = "99999999-9999-4999-8999-999999999999";
    expect((await h.inject(mom, "PATCH", `/measurements/${ghost}`, { note: "x" })).statusCode).toBe(
      404,
    );
    expect((await h.inject(mom, "DELETE", `/measurements/${ghost}`)).statusCode).toBe(404);
    expect(
      (await h.admin.query("SELECT 1 FROM public.measurements WHERE id = $1", [m.id])).rowCount,
    ).toBe(1);
  });

  it("DELETE: 204, row gone, reindex for the linked photo, audited with id + kind only", async () => {
    const m = await make({ kind: "head", value: 35, unit: "cm", photoId: photo, note: "private" });
    reset();
    const res = await h.inject(mom, "DELETE", `/measurements/${m.id}`);
    expect(res.statusCode).toBe(204);
    expect(
      (await h.admin.query("SELECT 1 FROM public.measurements WHERE id = $1", [m.id])).rowCount,
    ).toBe(0);
    expect(reindexed).toEqual([{ photoId: photo, babyId: baby, reason: "measurement" }]);
    const rows = (await h.audit({ event: "measurement.deleted", baby })).filter(
      (a) => a.metadata.measurement_id === m.id,
    );
    expect(rows[0]?.metadata).toEqual({ measurement_id: m.id, kind: "head" });
  });

  it("no value or note ever reaches the audit log; no analysis/gps in responses", async () => {
    const m = await make({ kind: "weight", value: 3.123, unit: "kg", note: "very private note" });
    // Random uuids can contain "3123" by chance: look at everything but ids.
    const log = JSON.stringify(await h.audit({ baby })).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "<id>",
    );
    expect(log).not.toContain("very private note");
    expect(log).not.toContain("3123");
    expect(log).not.toContain("3.123");
    const res = await h.inject(mom, "GET", `/babies/${baby}/measurements`);
    expect(res.body).not.toMatch(/analysis|gps|raw_json/i);
    expect(m.note).toBe("very private note");
    expect(
      (await h.audit({ event: "measurement.created", baby })).some(
        (a) => a.metadata.measurement_id === m.id && a.metadata.kind === "weight",
      ),
    ).toBe(true);
  });
});
