import { babyPrefix, derivativeKey, originalKey } from "@littlelight/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeTrash } from "./purge";
import { reconcileIngest } from "./reconcile";
import { createHarness, type Harness, integrationEnv } from "./testing/harness";
import { sweepUploads } from "./uploads-sweep";

// purge.trash, uploads.sweep and ingest.reconcile against real Postgres + MinIO
// (docs/plans/step-4.md 2.8, 2.13): every object VERSION is gone, quarantined evidence stays.

describe.skipIf(!integrationEnv)(
  "purge.trash / uploads.sweep / ingest.reconcile (real stack)",
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await createHarness();
    });
    afterAll(async () => {
      await h?.close();
    });

    const row = (sql: string, params: unknown[]) => h.one<Record<string, unknown>>(sql, params);
    const photoExists = async (id: string) =>
      (await row("SELECT 1 AS x FROM public.photos WHERE id = $1", [id])) !== undefined;
    const run = () => purgeTrash({ pool: h.workerPool, storage: h.storage, log: h.log });

    /** A seeded photo with an original (3 versions + a delete marker is added by callers) and a thumb. */
    async function photoWithObjects(
      babyId: string,
      owner: { id: string; ownerId: string },
      opts: { trashedAgo?: string; quarantined?: boolean } = {},
    ) {
      const s = await h.seedUpload({
        baby: owner,
        bytes: Buffer.from("original-bytes"),
        versions: 2,
      });
      const thumb = derivativeKey(babyId, s.id, "thumb");
      await h.putObject(thumb, Buffer.from("thumb"));
      await h.putObject(thumb, Buffer.from("thumb2"));
      await h.admin.query(
        `UPDATE public.photos SET status = 'ingested',
              deleted_at = ${opts.trashedAgo ? `now() - interval '${opts.trashedAgo}'` : "NULL"},
              quarantined_at = ${opts.quarantined ? "now()" : "NULL"}
        WHERE id = $1`,
        [s.id],
      );
      await h.admin.query(
        "INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes) VALUES ($1, 'thumb', $2, 1, 1, 5)",
        [s.id, thumb],
      );
      return { ...s, thumb };
    }

    describe("purge.trash", () => {
      it("hard-deletes a photo trashed 31 days ago: row, derivative rows and EVERY object version", async () => {
        const baby = await h.baby();
        const p = await photoWithObjects(baby.id, baby, { trashedAgo: "31 days" });
        await h.deleteObject(p.key); // adds a delete marker on top of the 3 versions
        expect(await h.versionCount(p.key)).toBe(4);
        const res = await run();
        expect(res.photos).toBeGreaterThanOrEqual(1);
        expect(await photoExists(p.id)).toBe(false);
        expect(await h.versionCount(p.key)).toBe(0);
        expect(await h.versionCount(p.thumb)).toBe(0);
        expect(
          await row("SELECT 1 AS x FROM public.photo_derivatives WHERE photo_id = $1", [p.id]),
        ).toBeUndefined();
        const audit = await row(
          "SELECT metadata FROM public.audit_log WHERE baby_id = $1 AND event = 'photo.purged'",
          [baby.id],
        );
        expect(audit?.metadata).toEqual({ photo_id: p.id });
      });

      it("keeps a photo trashed 29 days ago and live photos, objects included", async () => {
        const baby = await h.baby();
        const recent = await photoWithObjects(baby.id, baby, { trashedAgo: "29 days" });
        const live = await photoWithObjects(baby.id, baby);
        await run();
        for (const p of [recent, live]) {
          expect(await photoExists(p.id)).toBe(true);
          expect(await h.versionCount(p.key)).toBe(3);
        }
      });

      it("never purges a quarantined photo (evidence), even when trashed long ago", async () => {
        const baby = await h.baby();
        const q = await photoWithObjects(baby.id, baby, {
          trashedAgo: "90 days",
          quarantined: true,
        });
        await run();
        expect(await photoExists(q.id)).toBe(true);
        expect(await h.versionCount(q.key)).toBe(3);
      });

      it("purges a baby trashed 31 days ago: whole prefix, rows cascade", async () => {
        const baby = await h.baby({ trashedAgo: "31 days" });
        const p = await photoWithObjects(baby.id, baby);
        await h.putObject(`${babyPrefix(baby.id)}misc/other`, Buffer.from("x"));
        const res = await run();
        expect(res.babies).toBeGreaterThanOrEqual(1);
        expect(
          await row("SELECT 1 AS x FROM public.babies WHERE id = $1", [baby.id]),
        ).toBeUndefined();
        expect(await photoExists(p.id)).toBe(false);
        expect(await h.versionCount(babyPrefix(baby.id))).toBe(0);
      });

      it("holds back a trashed baby that has a quarantined photo: rows and objects stay, and it is reported", async () => {
        const baby = await h.baby({ trashedAgo: "31 days" });
        const q = await photoWithObjects(baby.id, baby, { quarantined: true });
        const res = await run();
        expect(res.babiesHeldForQuarantine).toBeGreaterThanOrEqual(1);
        expect(
          await row("SELECT 1 AS x FROM public.babies WHERE id = $1", [baby.id]),
        ).toBeDefined();
        expect(await photoExists(q.id)).toBe(true);
        expect(await h.versionCount(q.key)).toBe(3);
      });

      it("does not touch a baby trashed only 29 days ago", async () => {
        const baby = await h.baby({ trashedAgo: "29 days" });
        const p = await photoWithObjects(baby.id, baby);
        await run();
        expect(
          await row("SELECT 1 AS x FROM public.babies WHERE id = $1", [baby.id]),
        ).toBeDefined();
        expect(await h.versionCount(p.key)).toBe(3);
      });

      it("removes a leftover exact-duplicate marker older than 10 minutes", async () => {
        const baby = await h.baby();
        const s = await h.seedUpload({ baby, bytes: Buffer.from("dup-bytes"), versions: 1 });
        // Updated 20 minutes ago (insert a fresh row so the updated_at trigger doesn't reset it).
        await h.admin.query("ALTER TABLE public.photos DISABLE TRIGGER USER");
        try {
          await h.admin.query(
            "UPDATE public.photos SET status = 'duplicate', updated_at = now() - interval '20 minutes' WHERE id = $1",
            [s.id],
          );
        } finally {
          await h.admin.query("ALTER TABLE public.photos ENABLE TRIGGER USER");
        }
        const res = await run();
        expect(res.duplicates).toBeGreaterThanOrEqual(1);
        expect(await photoExists(s.id)).toBe(false);
        expect(await h.versionCount(s.key)).toBe(0);
      });

      it("deletes the object of an unsupported upload that settled over an hour ago, keeps decode failures", async () => {
        const baby = await h.baby();
        const unsupported = await h.seedUpload({ baby, bytes: Buffer.from("text") });
        const decodeFail = await h.seedUpload({ baby, bytes: Buffer.from("garbage") });
        // Upload files carry the error; make them "settled 2 h ago" (trigger would reset updated_at).
        await h.admin.query("ALTER TABLE public.upload_files DISABLE TRIGGER USER");
        try {
          for (const [id, err] of [
            [unsupported.id, "unsupported_media_type"],
            [decodeFail.id, "decode_failed"],
          ] as const) {
            await h.admin.query(
              "UPDATE public.upload_files SET state = 'failed', error = $2, updated_at = now() - interval '2 hours' WHERE id = $1",
              [id, err],
            );
            await h.admin.query("UPDATE public.photos SET status = 'failed' WHERE id = $1", [id]);
          }
        } finally {
          await h.admin.query("ALTER TABLE public.upload_files ENABLE TRIGGER USER");
        }
        await run();
        expect(await h.versionCount(unsupported.key)).toBe(0);
        expect(await h.versionCount(decodeFail.key)).toBeGreaterThan(0);
      });

      it("is idempotent: a second run finds nothing more to do", async () => {
        await run();
        const again = await run();
        expect(again.errors).toBe(0);
        expect(again.photos).toBe(0);
        expect(again.babies).toBe(0);
      });
    });

    describe("uploads.sweep", () => {
      async function registeredFile(opts: { sessionExpired: boolean }) {
        const baby = await h.baby();
        const sessionId = crypto.randomUUID();
        const fileId = crypto.randomUUID();
        const key = originalKey(baby.id, fileId);
        await h.admin.query(
          "INSERT INTO public.upload_sessions (id, baby_id, created_by) VALUES ($1, $2, $3)",
          [sessionId, baby.id, baby.ownerId],
        );
        const uploadId = await h.startMultipart(key);
        await h.admin.query(
          `INSERT INTO public.upload_files (id, session_id, baby_id, declared_bytes, storage_key, multipart_upload_id, part_size, state)
         VALUES ($1, $2, $3, 100, $4, $5, 16777216, 'registered')`,
          [fileId, sessionId, baby.id, key, uploadId],
        );
        if (opts.sessionExpired) {
          // (the owner trigger refuses files in an expired session, so expire it afterwards)
          await h.admin.query(
            "UPDATE public.upload_sessions SET expires_at = now() - interval '1 hour' WHERE id = $1",
            [sessionId],
          );
        }
        return { baby, sessionId, fileId, key, uploadId };
      }

      it("aborts the multipart upload of a registered file in an expired session and marks it aborted/expired", async () => {
        const f = await registeredFile({ sessionExpired: true });
        expect(await h.openMultipartIds(f.key)).toContain(f.uploadId);
        const res = await sweepUploads({ pool: h.workerPool, storage: h.storage, log: h.log });
        expect(res.expiredFiles).toBeGreaterThanOrEqual(1);
        expect(await h.openMultipartIds(f.key)).not.toContain(f.uploadId);
        expect(
          await row("SELECT state, error FROM public.upload_files WHERE id = $1", [f.fileId]),
        ).toEqual({ state: "aborted", error: "expired" });
      });

      it("leaves files of open sessions alone", async () => {
        const f = await registeredFile({ sessionExpired: false });
        await sweepUploads({ pool: h.workerPool, storage: h.storage, log: h.log });
        expect(await h.openMultipartIds(f.key)).toContain(f.uploadId);
        expect(
          (await row("SELECT state FROM public.upload_files WHERE id = $1", [f.fileId]))?.state,
        ).toBe("registered");
      });

      it("aborts a stray multipart upload older than 48 h that no file references, but not a referenced one", async () => {
        const referenced = await registeredFile({ sessionExpired: false });
        const baby = await h.baby();
        const strayKey = originalKey(baby.id, crypto.randomUUID());
        const strayId = await h.startMultipart(strayKey);
        const future = () => new Date(Date.now() + 72 * 3_600_000);
        const res = await sweepUploads({
          pool: h.workerPool,
          storage: h.storage,
          log: h.log,
          now: future,
        });
        expect(res.strayUploads).toBeGreaterThanOrEqual(1);
        expect(await h.openMultipartIds(strayKey)).not.toContain(strayId);
        expect(await h.openMultipartIds(referenced.key)).toContain(referenced.uploadId);
      });

      it("does not abort anything younger than 48 h", async () => {
        const baby = await h.baby();
        const key = originalKey(baby.id, crypto.randomUUID());
        const id = await h.startMultipart(key);
        await sweepUploads({ pool: h.workerPool, storage: h.storage, log: h.log });
        expect(await h.openMultipartIds(key)).toContain(id);
      });
    });

    describe("ingest.reconcile", () => {
      it("re-sends photo.ingest for photos stuck in 'uploaded' longer than 2 minutes (and only those)", async () => {
        const baby = await h.baby();
        const stuck = await h.seedUpload({
          baby,
          bytes: Buffer.from("a"),
          createdAgo: "5 minutes",
        });
        const fresh = await h.seedUpload({ baby, bytes: Buffer.from("b") });
        const trashed = await h.seedUpload({
          baby,
          bytes: Buffer.from("c"),
          createdAgo: "5 minutes",
        });
        await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [
          trashed.id,
        ]);
        const quarantined = await h.seedUpload({
          baby,
          bytes: Buffer.from("d"),
          createdAgo: "5 minutes",
        });
        await h.admin.query("UPDATE public.photos SET quarantined_at = now() WHERE id = $1", [
          quarantined.id,
        ]);
        const ingested = await h.seedUpload({
          baby,
          bytes: Buffer.from("e"),
          createdAgo: "5 minutes",
          status: "ingested",
        });

        const sent: { photoId: string; babyId: string }[] = [];
        await reconcileIngest({
          pool: h.workerPool,
          log: h.log,
          send: async (job) => {
            sent.push(job);
            return "id";
          },
        });
        const mine = sent.filter((j) => j.babyId === baby.id).map((j) => j.photoId);
        expect(mine).toEqual([stuck.id]);
        expect(mine).not.toContain(fresh.id);
        expect(mine).not.toContain(ingested.id);
      });
    });
  },
);
