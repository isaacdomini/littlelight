import { createHash, randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  FREE_TIER_PHOTO_LIMIT,
  type IngestJob,
  originalKey,
  UPLOAD_MAX_FILES_PER_SESSION,
  UPLOAD_PART_BYTES,
  uploadFileSchema,
  uploadSessionSchema,
} from "@littlelight/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JobQueue } from "../plugins/jobs";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedManyPhotos, seedPhoto } from "../testing/photos";
import { createS3Stub, type S3Stub, s3Error } from "../testing/s3-stub";

// Upload sessions, registration, multipart resume, completion and abort against a real database
// (RLS and the upload_files_session_owner trigger decide) with an in-memory S3 and a recording
// job queue (docs/plans/step-4.md 2.4, 2.13; PRD FR-2, FR-3.1, FR-2.7).

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const err = (res: { json: () => unknown }) => apiErrorSchema.parse(res.json());

describe.skipIf(!databaseUrl)("uploads (api + db, stubbed S3 and jobs)", () => {
  let h: Harness;
  let s3: S3Stub;
  let enqueued: IngestJob[];
  let openTxAtEnqueue: number[];
  let mom: TestUser;
  let nanny: TestUser;
  let dad: TestUser; // second admin
  let stranger: TestUser;
  let baby: string;
  let other: string; // someone else's baby

  const jobs: JobQueue = {
    async enqueueIngest(job) {
      // The job must be sent after commit, never inside the claims transaction: no api
      // connection may be sitting `idle in transaction` right now, and the photo row is visible.
      const { rows } = await h.admin.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE usename = 'littlelight_api' AND state LIKE 'idle in transaction%'`,
      );
      openTxAtEnqueue.push(rows[0].n);
      const seen = await h.admin.query("SELECT 1 FROM public.photos WHERE id = $1", [job.photoId]);
      if (seen.rowCount !== 1) throw new Error("photo row not committed when job was sent");
      enqueued.push(job);
      return true;
    },
    enqueueReindex: async () => true,
    close: async () => undefined,
  };

  beforeAll(async () => {
    s3 = createS3Stub();
    enqueued = [];
    openTxAtEnqueue = [];
    h = await createHarness({ s3, jobs });
    mom = await h.user({ displayName: "Mom" });
    nanny = await h.user({ displayName: "Nanny" });
    dad = await h.user({ displayName: "Dad" });
    stranger = await h.user({ displayName: "Stranger" });
    baby = await h.baby(mom);
    await h.member(baby, nanny, "contributor");
    await h.member(baby, dad, "admin");
    const stranger2 = await h.user();
    other = await h.baby(stranger2, "Other");
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(() => {
    s3.calls.length = 0;
    s3.failAll("CreateMultipartUpload", undefined);
    enqueued.length = 0;
    openTxAtEnqueue.length = 0;
  });

  // ---- helpers ------------------------------------------------------------------------------

  async function newSession(user: TestUser, babyId = baby, details?: object) {
    const res = await h.inject(
      user,
      "POST",
      `/babies/${babyId}/uploads`,
      details ? { details } : {},
    );
    if (res.statusCode !== 201) throw new Error(`session ${res.statusCode} ${res.body}`);
    return uploadSessionSchema.parse(res.json());
  }
  const register = (
    user: TestUser,
    sessionId: string,
    files: { clientId: string; bytes: number; clientSha256?: string }[],
  ) => h.inject(user, "POST", `/uploads/${sessionId}/files`, { files });
  async function registerOne(
    user: TestUser,
    sessionId: string,
    bytes = 1000,
    clientSha256?: string,
  ) {
    const res = await register(user, sessionId, [
      {
        clientId: `c-${randomUUID().slice(0, 8)}`,
        bytes,
        ...(clientSha256 ? { clientSha256 } : {}),
      },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    return uploadFileSchema.parse(res.json().files[0]);
  }
  const keyOf = async (fileId: string) =>
    (await h.admin.query("SELECT storage_key FROM public.upload_files WHERE id = $1", [fileId]))
      .rows[0].storage_key as string;
  async function putAll(fileId: string, bytes: number) {
    const key = await keyOf(fileId);
    const n = Math.ceil(bytes / UPLOAD_PART_BYTES);
    for (let i = 1; i <= n; i++) {
      s3.putPart(key, i, i < n ? UPLOAD_PART_BYTES : bytes - (n - 1) * UPLOAD_PART_BYTES);
    }
  }
  const complete = (user: TestUser, sessionId: string, fileId: string) =>
    h.inject(user, "POST", `/uploads/${sessionId}/files/${fileId}/complete`);
  const fileRow = async (fileId: string) =>
    (
      await h.admin.query("SELECT state, error, photo_id FROM public.upload_files WHERE id = $1", [
        fileId,
      ])
    ).rows[0] as { state: string; error: string | null; photo_id: string | null };
  const photoRow = async (id: string) =>
    (
      await h.admin.query(
        "SELECT approval, status, bytes::int AS bytes, mime FROM public.photos WHERE id = $1",
        [id],
      )
    ).rows[0] as
      | { approval: string; status: string; bytes: number; mime: string | null }
      | undefined;
  /** A fresh baby (free plan) for the cap tests, owned by mom. */
  const freshBaby = () => h.baby(mom, "Cap");

  // ---- sessions -----------------------------------------------------------------------------

  describe("create session", () => {
    it("an admin and a contributor can start a session; the response matches the contract", async () => {
      const s = await newSession(mom, baby, {
        people: ["Grandma Rose", "Grandma Rose"],
        note: "Beach day",
      });
      expect(s).toMatchObject({
        babyId: baby,
        finishedAt: null,
        details: { people: ["Grandma Rose"], note: "Beach day" },
        summary: { registered: 0, completed: 0, ingested: 0, duplicates: 0, failed: 0, aborted: 0 },
        files: [],
      });
      const expires = Date.parse(s.expiresAt) - Date.parse(s.createdAt);
      expect(expires).toBeGreaterThan(23 * 3600_000);
      expect(expires).toBeLessThan(25 * 3600_000);
      expect((await newSession(nanny)).babyId).toBe(baby);
    });

    it("a stranger gets 404, an anonymous caller 401", async () => {
      const r = await h.inject(stranger, "POST", `/babies/${baby}/uploads`, {});
      expect(r.statusCode).toBe(404);
      expect(err(r).error).toBe("not_found");
      expect((await h.inject(null, "POST", `/babies/${baby}/uploads`, {})).statusCode).toBe(401);
    });

    it("rejects an unknown milestone and an unconsented user", async () => {
      const r = await h.inject(mom, "POST", `/babies/${baby}/uploads`, {
        details: { milestoneId: "00000000-0000-4000-8000-0000000fffff" },
      });
      expect(r.statusCode).toBe(400);
      const noConsent = await h.user({ consent: false });
      await h.member(baby, noConsent, "contributor");
      const c = await h.inject(noConsent, "POST", `/babies/${baby}/uploads`, {});
      expect(c.statusCode).toBeGreaterThanOrEqual(400);
      expect(c.statusCode).toBeLessThan(500);
    });

    it("free tier: refuses a new session at the 1000-photo cap, counting pending but not failed photos", async () => {
      const b = await freshBaby();
      await seedManyPhotos(h.admin, b, FREE_TIER_PHOTO_LIMIT - 1);
      await seedPhoto(h.admin, b, { status: "failed" });
      await seedPhoto(h.admin, b, { trashedAgo: "1 hour" });
      expect((await h.inject(mom, "POST", `/babies/${b}/uploads`, {})).statusCode).toBe(201);
      await seedPhoto(h.admin, b, { approval: "pending", status: "uploaded" });
      const full = await h.inject(mom, "POST", `/babies/${b}/uploads`, {});
      expect(full.statusCode).toBe(409);
      expect(err(full).error).toBe("free_tier_limit");
    });

    it("a paid baby has no cap", async () => {
      const b = await freshBaby();
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [b]);
      await seedManyPhotos(h.admin, b, FREE_TIER_PHOTO_LIMIT + 5);
      expect((await h.inject(mom, "POST", `/babies/${b}/uploads`, {})).statusCode).toBe(201);
    });
  });

  describe("get session", () => {
    it("the owner and every admin can read it; another contributor and strangers get 404", async () => {
      const s = await newSession(nanny);
      expect((await h.inject(nanny, "GET", `/uploads/${s.id}`)).statusCode).toBe(200);
      expect((await h.inject(mom, "GET", `/uploads/${s.id}`)).statusCode).toBe(200);
      expect((await h.inject(stranger, "GET", `/uploads/${s.id}`)).statusCode).toBe(404);
      const contrib2 = await h.user();
      await h.member(baby, contrib2, "contributor");
      expect((await h.inject(contrib2, "GET", `/uploads/${s.id}`)).statusCode).toBe(404);
      const momsSession = await newSession(mom);
      expect((await h.inject(nanny, "GET", `/uploads/${momsSession.id}`)).statusCode).toBe(404);
    });
  });

  // ---- register -----------------------------------------------------------------------------

  describe("register files", () => {
    it("books a file with part URLs on S3_PUBLIC_ENDPOINT, one key per URL, TTL 3600, no checksum", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, UPLOAD_PART_BYTES + 5);
      expect(f).toMatchObject({ state: "registered", partCount: 2, partSize: UPLOAD_PART_BYTES });
      expect(f.parts?.map((p) => p.partNumber)).toEqual([1, 2]);
      const key = originalKey(baby, f.id);
      expect(await keyOf(f.id)).toBe(key);
      for (const p of f.parts ?? []) {
        const u = new URL(p.url);
        expect(u.origin).toBe(new URL(h.config.S3_PUBLIC_ENDPOINT).origin);
        expect(u.pathname).toBe(`/${h.config.S3_BUCKET}/${key}`);
        expect(u.searchParams.get("partNumber")).toBe(String(p.partNumber));
        expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
        expect([...u.searchParams.keys()].some((k) => /checksum/i.test(k))).toBe(false);
      }
      expect(s3.count("CreateMultipartUpload")).toBe(1);
    });

    it("a re-register of the same clientId is idempotent (same file, no second multipart)", async () => {
      const s = await newSession(mom);
      const body = [{ clientId: "same", bytes: 1234 }];
      const a = (await register(mom, s.id, body)).json().files[0];
      const b = (await register(mom, s.id, body)).json().files[0];
      expect(b.id).toBe(a.id);
      expect(b.parts).toHaveLength(1);
      expect(s3.count("CreateMultipartUpload")).toBe(1);
      const n = await h.admin.query(
        "SELECT count(*)::int AS n FROM public.upload_files WHERE session_id = $1",
        [s.id],
      );
      expect(n.rows[0].n).toBe(1);
    });

    it("an exact duplicate of a live photo (server pre-check by clientSha256) is a 'duplicate' with no multipart", async () => {
      const hash = sha("seeded-live");
      const live = await seedPhoto(h.admin, baby, { sha256: hash });
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, 1000, hash);
      expect(f).toMatchObject({ state: "duplicate", duplicateOfPhotoId: live });
      expect(f.parts).toBeUndefined();
      expect(s3.count("CreateMultipartUpload")).toBe(0);
      expect(await photoRow(f.id)).toBeUndefined(); // exact duplicates never keep a photos row
    });

    it("a trashed photo with the same hash is not a duplicate (it can be uploaded again)", async () => {
      const hash = sha("seeded-trashed");
      await seedPhoto(h.admin, baby, { sha256: hash, trashedAgo: "1 hour" });
      const s = await newSession(mom);
      expect((await registerOne(mom, s.id, 1000, hash)).state).toBe("registered");
    });

    it("the same hash twice in one session: the second is a duplicate with duplicateOfPhotoId null", async () => {
      const hash = sha("in-session");
      const s = await newSession(mom);
      const res = await register(mom, s.id, [
        { clientId: "a", bytes: 1000, clientSha256: hash },
        { clientId: "b", bytes: 1000, clientSha256: hash },
      ]);
      const [a, b] = res.json().files;
      expect(a.state).toBe("registered");
      expect(b).toMatchObject({ state: "duplicate", duplicateOfPhotoId: null });
    });

    it("another baby's photo with the same hash is not a duplicate here (no cross-baby leak)", async () => {
      const hash = sha("other-baby");
      await seedPhoto(h.admin, other, { sha256: hash });
      const s = await newSession(mom);
      expect((await registerOne(mom, s.id, 1000, hash)).state).toBe("registered");
    });

    it("free tier: files beyond the remaining headroom fail with free_tier_limit; the rest upload", async () => {
      const b = await freshBaby();
      await seedManyPhotos(h.admin, b, FREE_TIER_PHOTO_LIMIT - 2);
      const s = await newSession(mom, b);
      const res = await register(
        mom,
        s.id,
        [1, 2, 3].map((i) => ({ clientId: `f${i}`, bytes: 100 })),
      );
      const files = res.json().files as { state: string; error: string | null }[];
      expect(files.map((f) => f.state)).toEqual(["registered", "registered", "failed"]);
      expect(files[2]?.error).toBe("free_tier_limit");
      expect(s3.count("CreateMultipartUpload")).toBe(2);
    });

    it("a session holds at most 500 files: the 501st request is 409 upload_session_full", async () => {
      const s = await newSession(mom);
      for (let i = 0; i < UPLOAD_MAX_FILES_PER_SESSION / 100; i++) {
        const res = await register(
          mom,
          s.id,
          Array.from({ length: 100 }, (_, k) => ({ clientId: `b${i}-${k}`, bytes: 10 })),
        );
        expect(res.statusCode, res.body).toBe(200);
      }
      const over = await register(mom, s.id, [{ clientId: "one-too-many", bytes: 10 }]);
      expect(over.statusCode).toBe(409);
      expect(err(over).error).toBe("upload_session_full");
      const n = await h.admin.query(
        "SELECT count(*)::int AS n FROM public.upload_files WHERE session_id = $1",
        [s.id],
      );
      expect(n.rows[0].n).toBe(500);
    });

    it("a partly overflowing batch is refused as a whole and leaves no multipart behind", async () => {
      const s = await newSession(mom);
      for (let i = 0; i < 4; i++) {
        await register(
          mom,
          s.id,
          Array.from({ length: 100 }, (_, k) => ({ clientId: `x${i}-${k}`, bytes: 10 })),
        );
      }
      await register(
        mom,
        s.id,
        Array.from({ length: 95 }, (_, k) => ({ clientId: `y-${k}`, bytes: 10 })),
      );
      const before = s3.uploads.size;
      const res = await register(
        mom,
        s.id,
        Array.from({ length: 6 }, (_, k) => ({ clientId: `z-${k}`, bytes: 10 })),
      );
      expect(res.statusCode).toBe(409);
      expect(s3.uploads.size).toBe(before);
    });

    it("validates the request: 0 and 101 files, too-large and malformed hashes are 400", async () => {
      const s = await newSession(mom);
      expect((await register(mom, s.id, [])).statusCode).toBe(400);
      expect(
        (
          await register(
            mom,
            s.id,
            Array.from({ length: 101 }, (_, k) => ({ clientId: `v${k}`, bytes: 1 })),
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (await register(mom, s.id, [{ clientId: "big", bytes: 100 * 1024 * 1024 + 1 }])).statusCode,
      ).toBe(400);
      expect((await register(mom, s.id, [{ clientId: "z", bytes: 0 }])).statusCode).toBe(400);
      expect(
        (await register(mom, s.id, [{ clientId: "h", bytes: 1, clientSha256: "ABC" }])).statusCode,
      ).toBe(400);
    });

    it("S3 failing to create a multipart upload marks that file failed/storage_error without failing the batch", async () => {
      const s = await newSession(mom);
      s3.failAll("CreateMultipartUpload", s3Error("InternalError", 500));
      const res = await register(mom, s.id, [{ clientId: "a", bytes: 10 }]);
      expect(res.statusCode).toBe(200);
      expect(res.json().files[0]).toMatchObject({ state: "failed", error: "storage_error" });
      expect(res.json().files[0].parts).toBeUndefined();
      // Retry works without registering again: GET parts revives it.
      s3.failAll("CreateMultipartUpload", undefined);
      const fid = res.json().files[0].id;
      const parts = await h.inject(mom, "GET", `/uploads/${s.id}/files/${fid}/parts`);
      expect(parts.statusCode, parts.body).toBe(200);
      expect(parts.json().parts).toHaveLength(1);
      expect((await fileRow(fid)).state).toBe("registered");
    });

    it("only the session's owner can register: other contributor 404, other admin 403, stranger 404", async () => {
      const s = await newSession(nanny);
      const body = [{ clientId: "a", bytes: 10 }];
      expect((await register(dad, s.id, body)).statusCode).toBe(403);
      expect((await register(stranger, s.id, body)).statusCode).toBe(404);
      const contrib2 = await h.user();
      await h.member(baby, contrib2, "contributor");
      expect((await register(contrib2, s.id, body)).statusCode).toBe(404);
      const momsSession = await newSession(mom);
      expect((await register(nanny, momsSession.id, body)).statusCode).toBe(404);
      expect(s3.count("CreateMultipartUpload")).toBe(0);
    });

    it("a finished or expired session accepts no more files (410 upload_session_expired)", async () => {
      const s = await newSession(mom);
      expect((await h.inject(mom, "POST", `/uploads/${s.id}/finish`)).statusCode).toBe(200);
      const closed = await register(mom, s.id, [{ clientId: "a", bytes: 10 }]);
      expect(closed.statusCode).toBe(410);
      expect(err(closed).error).toBe("upload_session_expired");

      const s2 = await newSession(mom);
      await h.admin.query(
        "UPDATE public.upload_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [s2.id],
      );
      const expired = await register(mom, s2.id, [{ clientId: "a", bytes: 10 }]);
      expect(expired.statusCode).toBe(410);
    });
  });

  // ---- parts / resume -----------------------------------------------------------------------

  describe("resume (GET parts)", () => {
    it("lists uploaded parts and returns URLs only for the missing ones; wrong-sized parts do not count", async () => {
      const s = await newSession(mom);
      const bytes = 2 * UPLOAD_PART_BYTES + 7;
      const f = await registerOne(mom, s.id, bytes);
      const key = await keyOf(f.id);
      s3.putPart(key, 1, UPLOAD_PART_BYTES);
      s3.putPart(key, 2, UPLOAD_PART_BYTES - 1); // truncated PUT
      const r = await h.inject(mom, "GET", `/uploads/${s.id}/files/${f.id}/parts`);
      expect(r.statusCode).toBe(200);
      expect(r.json().uploadedPartNumbers).toEqual([1]);
      expect(r.json().parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([2, 3]);
    });

    it("is owner-only; strangers and other contributors get 404", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id);
      expect(
        (await h.inject(stranger, "GET", `/uploads/${s.id}/files/${f.id}/parts`)).statusCode,
      ).toBe(404);
      expect(
        (await h.inject(nanny, "GET", `/uploads/${s.id}/files/${f.id}/parts`)).statusCode,
      ).toBe(404);
    });

    it("a swept multipart (NoSuchUpload) aborts the file as expired and answers 404", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id);
      s3.dropUpload(await keyOf(f.id));
      const r = await h.inject(mom, "GET", `/uploads/${s.id}/files/${f.id}/parts`);
      expect(r.statusCode).toBe(404);
      expect(await fileRow(f.id)).toMatchObject({ state: "aborted", error: "expired" });
    });

    it("409 for a file that is no longer accepting parts (completed)", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id);
      await putAll(f.id, 1000);
      expect((await complete(mom, s.id, f.id)).statusCode).toBe(200);
      expect((await h.inject(mom, "GET", `/uploads/${s.id}/files/${f.id}/parts`)).statusCode).toBe(
        409,
      );
    });
  });

  // ---- complete -----------------------------------------------------------------------------

  describe("complete", () => {
    it("rejects missing parts with 409 upload_incomplete and the missing part numbers; nothing is booked", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, UPLOAD_PART_BYTES + 5);
      s3.putPart(await keyOf(f.id), 1, UPLOAD_PART_BYTES);
      const r = await complete(mom, s.id, f.id);
      expect(r.statusCode).toBe(409);
      expect(err(r)).toMatchObject({
        error: "upload_incomplete",
        details: { missingPartNumbers: [2] },
      });
      expect(await photoRow(f.id)).toBeUndefined();
      expect(enqueued).toEqual([]);
      expect((await fileRow(f.id)).state).toBe("registered");
    });

    it("rejects a wrong-sized part as missing", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, UPLOAD_PART_BYTES + 5);
      const key = await keyOf(f.id);
      s3.putPart(key, 1, UPLOAD_PART_BYTES);
      s3.putPart(key, 2, 4);
      const r = await complete(mom, s.id, f.id);
      expect(r.statusCode).toBe(409);
      expect(err(r).details).toMatchObject({ missingPartNumbers: [2] });
    });

    it("an invalid-part answer from S3 on Complete is also 409 upload_incomplete", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, 100);
      await putAll(f.id, 100);
      s3.failNext("CompleteMultipartUpload", s3Error("InvalidPart", 400));
      const r = await complete(mom, s.id, f.id);
      expect(r.statusCode).toBe(409);
      expect(err(r).error).toBe("upload_incomplete");
    });

    it("an admin's upload becomes an approved photo; the job is sent once, after commit", async () => {
      const s = await newSession(mom, baby, {
        people: ["Grandpa"],
        note: "Zoo",
        locationLabel: "City Zoo",
      });
      const f = await registerOne(mom, s.id, 2048);
      await putAll(f.id, 2048);
      const r = await complete(mom, s.id, f.id);
      expect(r.statusCode, r.body).toBe(200);
      const body = uploadFileSchema.parse(r.json());
      expect(body.state).toBe("completed");
      expect(body.photo).toMatchObject({
        id: f.id,
        approval: "approved",
        status: "uploaded",
        babyId: baby,
      });
      expect(body.photo?.thumbUrl).toBeNull(); // nothing ingested yet
      expect(await photoRow(f.id)).toMatchObject({
        approval: "approved",
        status: "uploaded",
        bytes: 2048,
        mime: null,
      });
      expect(await fileRow(f.id)).toMatchObject({ state: "completed", photo_id: f.id });

      const details = await h.admin.query(
        "SELECT note, people, location_label FROM public.photo_details WHERE photo_id = $1",
        [f.id],
      );
      expect(details.rows[0]).toEqual({
        note: "Zoo",
        people: ["Grandpa"],
        location_label: "City Zoo",
      });

      expect(enqueued).toEqual([
        { photoId: f.id, babyId: baby, uploadFileId: f.id, tzHint: "UTC" },
      ]);
      expect(openTxAtEnqueue).toEqual([0]);
      expect(s3.objects.get(originalKey(baby, f.id))).toBe(2048);
    });

    it("a contributor's upload is pending (never approved by the API), and still ingested", async () => {
      const s = await newSession(nanny);
      const f = await registerOne(nanny, s.id, 500);
      await putAll(f.id, 500);
      const r = await complete(nanny, s.id, f.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().photo).toMatchObject({ approval: "pending" });
      expect((await photoRow(f.id))?.approval).toBe("pending");
      expect(enqueued.map((j) => j.photoId)).toEqual([f.id]);
    });

    it("no batch details means no photo_details row", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, 10);
      await putAll(f.id, 10);
      await complete(mom, s.id, f.id);
      const d = await h.admin.query("SELECT 1 FROM public.photo_details WHERE photo_id = $1", [
        f.id,
      ]);
      expect(d.rowCount).toBe(0);
    });

    it("a repeated complete is idempotent: same answer, one photo, one job", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, 300);
      await putAll(f.id, 300);
      const [a, b] = [await complete(mom, s.id, f.id), await complete(mom, s.id, f.id)];
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(b.json().state).not.toBe("registered");
      expect(enqueued).toHaveLength(1);
      expect(s3.count("CompleteMultipartUpload")).toBe(1);
    });

    it("concurrent completes book one photo and enqueue one job", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, 300);
      await putAll(f.id, 300);
      const rs = await Promise.all([1, 2, 3].map(() => complete(mom, s.id, f.id)));
      for (const r of rs) expect(r.statusCode, r.body).toBe(200);
      const n = await h.admin.query("SELECT count(*)::int AS n FROM public.photos WHERE id = $1", [
        f.id,
      ]);
      expect(n.rows[0].n).toBe(1);
      expect(enqueued.length).toBe(1);
    });

    it("recovers when the multipart was completed earlier but never booked (NoSuchUpload + object exists)", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, 777);
      const key = await keyOf(f.id);
      s3.dropUpload(key);
      s3.putObject(key, 777);
      const r = await complete(mom, s.id, f.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().state).toBe("completed");
      expect(enqueued.map((j) => j.photoId)).toEqual([f.id]);
    });

    it("NoSuchUpload with no object: the file fails as upload_incomplete (and no photo is booked)", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, 777);
      s3.dropUpload(await keyOf(f.id));
      const r = await complete(mom, s.id, f.id);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ state: "failed", error: "upload_incomplete" });
      expect(await photoRow(f.id)).toBeUndefined();
      expect(enqueued).toEqual([]);
    });

    it("an object whose size differs from the declared size is a failed upload_incomplete", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, 777);
      const key = await keyOf(f.id);
      s3.dropUpload(key);
      s3.putObject(key, 776);
      const r = await complete(mom, s.id, f.id);
      expect(r.json()).toMatchObject({ state: "failed", error: "upload_incomplete" });
      expect(await photoRow(f.id)).toBeUndefined();
    });

    it("free tier: the cap trigger rejects the booking with 409 free_tier_limit, the file fails, no job is sent", async () => {
      const b = await freshBaby();
      const s = await newSession(mom, b);
      const f = await registerOne(mom, s.id, 10);
      await putAll(f.id, 10);
      await seedManyPhotos(h.admin, b, FREE_TIER_PHOTO_LIMIT);
      const r = await complete(mom, s.id, f.id);
      expect(r.statusCode).toBe(409);
      expect(err(r).error).toBe("free_tier_limit");
      expect(await fileRow(f.id)).toMatchObject({ state: "failed", error: "free_tier_limit" });
      expect(await photoRow(f.id)).toBeUndefined();
      expect(enqueued).toEqual([]);
    });

    it("only the owner completes: other contributor 404, other admin 403, stranger 404", async () => {
      const s = await newSession(nanny);
      const f = await registerOne(nanny, s.id, 10);
      await putAll(f.id, 10);
      expect((await complete(stranger, s.id, f.id)).statusCode).toBe(404);
      expect((await complete(dad, s.id, f.id)).statusCode).toBe(403);
      const s2 = await newSession(mom);
      const f2 = await registerOne(mom, s2.id, 10);
      await putAll(f2.id, 10);
      expect((await complete(nanny, s2.id, f2.id)).statusCode).toBe(404);
      expect(enqueued).toEqual([]);
      expect(await photoRow(f.id)).toBeUndefined();
    });

    it("a file id under the wrong session is 404", async () => {
      const s1 = await newSession(mom);
      const s2 = await newSession(mom);
      const f = await registerOne(mom, s1.id, 10);
      expect((await complete(mom, s2.id, f.id)).statusCode).toBe(404);
    });

    it("a cancelled file cannot be completed (409)", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, 10);
      await h.inject(mom, "DELETE", `/uploads/${s.id}/files/${f.id}`);
      expect((await complete(mom, s.id, f.id)).statusCode).toBe(409);
    });
  });

  // ---- abort / finish / view ----------------------------------------------------------------

  describe("abort, finish and the session view", () => {
    it("DELETE aborts the multipart and marks the file aborted; idempotent; completed files cannot be cancelled", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, 10);
      const del = await h.inject(mom, "DELETE", `/uploads/${s.id}/files/${f.id}`);
      expect(del.statusCode).toBe(204);
      expect((await fileRow(f.id)).state).toBe("aborted");
      expect(s3.count("AbortMultipartUpload")).toBe(1);
      expect((await h.inject(mom, "DELETE", `/uploads/${s.id}/files/${f.id}`)).statusCode).toBe(
        204,
      );

      const g = await registerOne(mom, s.id, 10);
      await putAll(g.id, 10);
      await complete(mom, s.id, g.id);
      expect((await h.inject(mom, "DELETE", `/uploads/${s.id}/files/${g.id}`)).statusCode).toBe(
        409,
      );
    });

    it("only the owner can cancel", async () => {
      const s = await newSession(nanny);
      const f = await registerOne(nanny, s.id, 10);
      expect(
        (await h.inject(stranger, "DELETE", `/uploads/${s.id}/files/${f.id}`)).statusCode,
      ).toBe(404);
      expect((await h.inject(dad, "DELETE", `/uploads/${s.id}/files/${f.id}`)).statusCode).toBe(
        403,
      );
      expect((await fileRow(f.id)).state).toBe("registered");
    });

    it("finish is idempotent, audited once, and owner-only; the summary counts every state", async () => {
      const s = await newSession(nanny);
      const dupHash = sha("finish-dup");
      await seedPhoto(h.admin, baby, { sha256: dupHash });
      const ok = await registerOne(nanny, s.id, 10);
      await putAll(ok.id, 10);
      await complete(nanny, s.id, ok.id);
      await registerOne(nanny, s.id, 10, dupHash); // duplicate
      const gone = await registerOne(nanny, s.id, 10);
      await h.inject(nanny, "DELETE", `/uploads/${s.id}/files/${gone.id}`);
      await registerOne(nanny, s.id, 10); // still registered

      expect((await h.inject(dad, "POST", `/uploads/${s.id}/finish`)).statusCode).toBe(403);
      const a = await h.inject(nanny, "POST", `/uploads/${s.id}/finish`);
      const b = await h.inject(nanny, "POST", `/uploads/${s.id}/finish`);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(a.json().finishedAt).toBe(b.json().finishedAt);
      expect(a.json().summary).toMatchObject({
        registered: 1,
        completed: 1,
        duplicates: 1,
        aborted: 1,
        failed: 0,
      });
      const events = await h.audit({ event: "upload.session_finished", actor: nanny.id });
      expect(events.filter((e) => e.metadata.session_id === s.id)).toHaveLength(1);
      expect((await h.inject(stranger, "POST", `/uploads/${s.id}/finish`)).statusCode).toBe(404);
    });

    it("the session view never exposes keys, hashes, upload ids or GPS", async () => {
      const s = await newSession(mom);
      const f = await registerOne(mom, s.id, 10, sha("view"));
      await putAll(f.id, 10);
      await complete(mom, s.id, f.id);
      const view = (await h.inject(mom, "GET", `/uploads/${s.id}`)).body;
      expect(view).not.toMatch(/storage_key|multipart|upload-\d|originals\/|sha256|gps|latitude/i);
      expect(view).not.toContain(sha("view"));
    });

    it("audit: session creation is recorded", async () => {
      const s = await newSession(mom);
      const ev = await h.audit({ event: "upload.session_created", actor: mom.id, baby });
      expect(ev.some((e) => e.metadata.session_id === s.id)).toBe(true);
    });
  });
});
