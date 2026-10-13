import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { babyPrefix, DEMO_IDS, derivativeKey, photoPrefixes } from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestPhoto } from "../ingest";
import { purgeTrash } from "../purge";
import { createHarness, type Harness, integrationEnv } from "../testing/harness";
import {
  checkDemoMedia,
  checkPassed,
  ensureDemoMedia,
  isMetadataFree,
  reviewOriginalKey,
  writeReviewMedia,
} from "./media";

// Demo and review media against real Postgres + MinIO (docs/plans/step-9.md 2.11, 2.15): the
// seeded dev family gets real, metadata-free JPEG originals and three derivatives each,
// idempotently; the review family's originals sit under the baby prefix (so purge removes them)
// and feed the normal ingest.

const dbSrc = (f: string) =>
  pathToFileURL(path.resolve(import.meta.dirname, `../../../../packages/db/src/${f}`)).href;

describe.skipIf(!integrationEnv)("demo media (real database + object storage)", () => {
  let h: Harness;
  let db: {
    seed(o: object): Promise<unknown>;
    DEMO: { baby: string; photo(n: number): string };
  };
  let rf: {
    provisionReviewFamily(
      a: { email: string; confirmProduction: boolean },
      o: object,
    ): Promise<{ babyId: string; userId: string; photoIds: string[] }>;
    reviewOriginalKey(b: string, p: string): string;
  };
  const users: string[] = [];
  const quiet = () => undefined;
  const env = () => ({
    ...process.env,
    AUTH_DB_PASSWORD: process.env.AUTH_DB_PASSWORD ?? "dev",
    API_DB_PASSWORD: process.env.API_DB_PASSWORD ?? "dev",
    WORKER_DB_PASSWORD: process.env.WORKER_DB_PASSWORD ?? "dev",
    DATA_ENCRYPTION_KEY:
      process.env.DATA_ENCRYPTION_KEY ?? "dev-only-data-encryption-key-32-chars-min",
    SEED_DEMO_FAMILY: "true",
    NODE_ENV: "test",
  });
  const mediaDeps = () => ({
    pool: h.workerPool,
    s3: h.s3,
    bucket: h.bucket,
    storage: h.storage,
    log: h.log,
  });

  beforeAll(async () => {
    h = await createHarness();
    db = (await import(/* @vite-ignore */ dbSrc("seed.ts"))) as never;
    rf = (await import(/* @vite-ignore */ dbSrc("review-family.ts"))) as never;
    await db.seed({ env: env(), databaseUrl: integrationEnv?.databaseUrl, log: quiet });
  });
  afterAll(async () => {
    if (h) {
      // Leave nothing the AI pipeline could pick up in the shared test database: the demo photos
      // now have real analysis derivatives, which other suites' batch counts would include.
      await h.storage.deleteAllVersions(babyPrefix(db.DEMO.baby));
      await h.admin.query("DELETE FROM public.babies WHERE id = $1", [db.DEMO.baby]);
      await h.admin.query("DELETE FROM public.babies WHERE created_by = ANY($1::uuid[])", [users]);
      await h.admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [users]);
      await h.close();
    }
  });

  describe("ensureDemoMedia (dev family)", () => {
    it("writes 13 originals (12 JPEGs + the clip) and 43 derivatives, all metadata-free, rows matching", async () => {
      // start from nothing
      await h.storage.deleteAllVersions(babyPrefix(db.DEMO.baby));
      const r = await ensureDemoMedia(mediaDeps());
      expect(r).toMatchObject({
        photos: 13,
        originalsWritten: 13,
        derivativesWritten: 43,
        failed: 0,
      });

      const rows = await h.admin.query(
        "SELECT id, mime, storage_key_original AS key, width, height, bytes FROM public.photos WHERE baby_id = $1 ORDER BY id",
        [db.DEMO.baby],
      );
      expect(rows.rows).toHaveLength(13);
      for (const row of rows.rows) {
        if (row.mime === "video/mp4") {
          // the demo clip: original .mp4, poster derivatives + keyframes + the web rendition
          expect(row.key).toBe(`babies/${db.DEMO.baby}/originals/${row.id}.mp4`);
          const bytes = await h.storage.getObject(row.key);
          expect(bytes.byteLength).toBe(Number(row.bytes));
          for (const kind of ["thumb", "display", "analysis"] as const) {
            const d = await h.storage.getObject(derivativeKey(db.DEMO.baby, row.id, kind));
            expect(await isMetadataFree(d), `${row.id} ${kind}`).toBe(true);
          }
          continue;
        }
        expect(row.mime).toBe("image/jpeg");
        expect(row.key).toBe(`babies/${db.DEMO.baby}/originals/${row.id}.jpg`);
        const bytes = await h.storage.getObject(row.key);
        expect(bytes.byteLength).toBe(Number(row.bytes));
        expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
        expect(await isMetadataFree(bytes)).toBe(true);
        expect(row.width).toBe(1200);
        expect(row.height).toBe(1600);
        for (const kind of ["thumb", "display", "analysis"] as const) {
          const d = await h.storage.getObject(derivativeKey(db.DEMO.baby, row.id, kind));
          expect(await isMetadataFree(d), `${row.id} ${kind}`).toBe(true);
        }
      }
      const derivRows = await h.admin.query(
        "SELECT count(*)::int n FROM public.photo_derivatives WHERE photo_id = ANY($1::uuid[])",
        [[...DEMO_IDS.photos]],
      );
      expect(derivRows.rows[0]?.n).toBe(43);
      expect(checkPassed(await checkDemoMedia(mediaDeps()))).toBe(true);
    }, 120_000);

    it("is idempotent: a second run reads and HEADs only", async () => {
      const r = await ensureDemoMedia(mediaDeps());
      expect(r).toMatchObject({
        photos: 13,
        originalsWritten: 0,
        derivativesWritten: 0,
        derivativeRowsFixed: 0,
        photoRowsUpdated: 0,
        unchanged: 13,
        failed: 0,
      });
    }, 120_000);

    it("a re-seed keeps the real sizes (nothing to repair)", async () => {
      await db.seed({ env: env(), databaseUrl: integrationEnv?.databaseUrl, log: quiet });
      const r = await ensureDemoMedia(mediaDeps());
      expect(r.unchanged).toBe(13);
      expect(r.originalsWritten + r.derivativesWritten).toBe(0);
    }, 120_000);

    it("repairs a missing derivative object and a wrong row without touching the originals", async () => {
      const photo = db.DEMO.photo(3);
      await h.deleteObject(derivativeKey(db.DEMO.baby, photo, "display"));
      await h.admin.query(
        "UPDATE public.photo_derivatives SET bytes = 1 WHERE photo_id = $1 AND kind = 'thumb'",
        [photo],
      );
      const r = await ensureDemoMedia(mediaDeps());
      expect(r.originalsWritten).toBe(0);
      expect(r.derivativesWritten).toBe(1);
      expect(r.derivativeRowsFixed).toBe(1);
      expect(checkPassed(await checkDemoMedia(mediaDeps()))).toBe(true);
    }, 120_000);

    it("a missing original is redrawn and its derivatives rebuilt", async () => {
      const photo = db.DEMO.photo(5);
      const key = `babies/${db.DEMO.baby}/originals/${photo}.jpg`;
      await h.deleteObject(key);
      const r = await ensureDemoMedia(mediaDeps());
      expect(r.originalsWritten).toBe(1);
      expect(r.derivativesWritten).toBe(3);
      expect((await h.storage.getObject(key)).byteLength).toBeGreaterThan(5000);
    }, 120_000);

    it("the check fails (and says what) when an object is missing", async () => {
      const photo = db.DEMO.photo(7);
      await h.deleteObject(derivativeKey(db.DEMO.baby, photo, "thumb"));
      const c = await checkDemoMedia(mediaDeps());
      expect(c.derivatives).toBe(42);
      expect(checkPassed(c)).toBe(false);
      await ensureDemoMedia(mediaDeps());
      expect(checkPassed(await checkDemoMedia(mediaDeps()))).toBe(true);
    }, 120_000);
  });

  describe("writeReviewMedia (store-review family)", () => {
    async function provision() {
      const userId = randomUUID();
      const email = `rm-${userId.slice(0, 8)}@worker.test`;
      await h.admin.query(
        "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
        [userId, email],
      );
      await h.admin.query("INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'RM')", [
        userId,
      ]);
      users.push(userId);
      const r = await rf.provisionReviewFamily(
        { email, confirmProduction: false },
        { env: env(), databaseUrl: integrationEnv?.databaseUrl, log: quiet },
      );
      return r;
    }
    const reviewDeps = (sent: string[]) => ({
      ...mediaDeps(),
      sendIngest: async (job: { photoId: string }) => {
        sent.push(job.photoId);
        return `job-${job.photoId}`;
      },
    });

    it("the worker and db key helpers agree on babies/<baby>/originals/<photo>.jpg", () => {
      const b = randomUUID();
      const p = randomUUID();
      expect(reviewOriginalKey(b, p)).toBe(rf.reviewOriginalKey(b, p));
    });

    it("puts 24 metadata-free JPEGs at the rows' keys and enqueues ingest for each, once", async () => {
      const fam = await provision();
      const sent: string[] = [];
      const r = await writeReviewMedia(reviewDeps(sent), fam.babyId);
      expect(r).toMatchObject({
        photos: 24,
        waiting: 24,
        originalsWritten: 24,
        enqueued: 24,
        skippedForeignKey: 0,
      });
      expect(sent.sort()).toEqual([...fam.photoIds].sort());
      for (const id of fam.photoIds) {
        const key = `babies/${fam.babyId}/originals/${id}.jpg`;
        const bytes = await h.storage.getObject(key);
        expect(await isMetadataFree(bytes)).toBe(true);
      }
      // second run: nothing rewritten, jobs offered again (the queue's singleton key coalesces)
      const again = await writeReviewMedia(reviewDeps([]), fam.babyId);
      expect(again.originalsWritten).toBe(0);
    }, 180_000);

    it("the normal ingest accepts the .jpg original: derivatives written, dimensions filled", async () => {
      const fam = await provision();
      await writeReviewMedia(reviewDeps([]), fam.babyId);
      const id = fam.photoIds[0] as string;
      const res = await ingestPhoto(h.deps(), { photoId: id, babyId: fam.babyId });
      expect(res.outcome).toBe("ingested");
      const row = await h.admin.query(
        "SELECT status, width, height, mime FROM public.photos WHERE id = $1",
        [id],
      );
      expect(row.rows[0]).toMatchObject({
        status: "ingested",
        width: 1200,
        height: 1600,
        mime: "image/jpeg",
      });
      const d = await h.admin.query(
        "SELECT kind FROM public.photo_derivatives WHERE photo_id = $1 ORDER BY kind",
        [id],
      );
      expect(d.rows.map((x) => x.kind)).toEqual(["analysis", "display", "thumb"]);
    }, 180_000);

    it("never touches rows whose key is not exactly the review key", async () => {
      const fam = await provision();
      const real = fam.photoIds[0] as string;
      const foreignKey = `babies/${fam.babyId}/originals/${real}`; // a "real upload" key (no extension)
      await h.admin.query("UPDATE public.photos SET storage_key_original = $2 WHERE id = $1", [
        real,
        foreignKey,
      ]);
      const sent: string[] = [];
      const r = await writeReviewMedia(reviewDeps(sent), fam.babyId);
      expect(r.skippedForeignKey).toBe(1);
      expect(sent).not.toContain(real);
      await expect(h.storage.getObject(foreignKey)).rejects.toThrow();
    }, 180_000);

    it("a purged review baby leaves no objects behind (account deletion path)", async () => {
      const fam = await provision();
      await writeReviewMedia(reviewDeps([]), fam.babyId);
      const prefix = babyPrefix(fam.babyId);
      expect(await h.versionCount(prefix)).toBe(24);
      // every original is covered by the photo-level purge prefixes too
      for (const id of fam.photoIds) {
        const [orig] = photoPrefixes(fam.babyId, id);
        expect(`${orig}.jpg`.startsWith(orig)).toBe(true);
      }
      await h.admin.query(
        "UPDATE public.babies SET deleted_at = now() - interval '31 days' WHERE id = $1",
        [fam.babyId],
      );
      await purgeTrash({ pool: h.workerPool, storage: h.storage, log: h.log });
      expect(await h.versionCount(prefix)).toBe(0);
      const left = await h.admin.query("SELECT count(*)::int n FROM public.babies WHERE id = $1", [
        fam.babyId,
      ]);
      expect(left.rows[0]?.n).toBe(0);
    }, 180_000);
  });
});
