import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IngestJob } from "@littlelight/shared";
import {
  googleImportMediaAllowList,
  IMPORT_MAX_FILE_BYTES,
  originalKey,
} from "@littlelight/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkerStorage } from "../../storage";
import { createHarness, type Harness, integrationEnv } from "../../testing/harness";
import { sweepImports } from "../sweep";
import { createWorkerGoogleClient } from "./client";
import { type FakeGoogleServer, startFakeGoogleServer } from "./fake-server";
import { type ImportGoogleDeps, ImportRetryError, runImportGoogle } from "./handler";

// import.google end to end against real Postgres + MinIO + the in-process fake Google server
// (docs/plans/step-10.md 2.7, 10.13). Fake AI/none: booked photos only get a `photo.ingest` job
// (a recording stub); no model is involved.

const FIXTURES = path.resolve(import.meta.dirname, "../../../../../e2e/fixtures/heic");
const REDIRECT = "http://localhost:8080/api/import/google/callback";
const SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

describe.skipIf(!integrationEnv)(
  "import.google (real database + object storage + fake Google)",
  () => {
    let h: Harness;
    let fake: FakeGoogleServer;
    let tmp: string;
    const extraUsers: string[] = [];

    beforeAll(async () => {
      h = await createHarness();
      fake = await startFakeGoogleServer({ port: 0, fixturesDir: FIXTURES, nodeEnv: "test" });
      await fetch(`${fake.url}/__fake/consent`, {
        method: "POST",
        body: JSON.stringify({ decision: "allow" }),
        headers: { "content-type": "application/json" },
      });
    });
    afterAll(async () => {
      await fake?.close();
      if (extraUsers.length)
        await h.admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [extraUsers]);
      await h?.close();
    });
    afterEach(async () => {
      if (tmp) await rm(tmp, { recursive: true, force: true });
    });

    // --- fixtures -----------------------------------------------------------------------------

    const post = (p: string, body: unknown, form = false) =>
      fetch(`${fake.url}${p}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
        },
        body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
      });

    async function newUser(): Promise<string> {
      const id = randomUUID();
      await h.admin.query(
        "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
        [id, `imp-${id}@worker.test`],
      );
      await h.admin.query(
        "INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'Imp')",
        [id],
      );
      extraUsers.push(id);
      return id;
    }

    async function storeRefreshToken(userId: string, refreshToken: string) {
      await h.admin.query("BEGIN");
      try {
        await h.admin.query("SELECT set_config('app.data_key', $1, true)", [h.dataKey]);
        await h.admin.query(
          `INSERT INTO public.google_accounts (user_id, refresh_token_enc, scope)
         VALUES ($1, public.encrypt_secret($2), $3)
         ON CONFLICT (user_id) DO UPDATE SET refresh_token_enc = EXCLUDED.refresh_token_enc, needs_reconnect = false`,
          [userId, refreshToken, SCOPE],
        );
        await h.admin.query("COMMIT");
      } catch (e) {
        await h.admin.query("ROLLBACK");
        throw e;
      }
    }

    interface Setup {
      baby: { id: string; ownerId: string };
      requester: string;
      batchId: string;
      sessionId: string;
    }

    async function setup(o: {
      role?: "admin" | "contributor";
      plan?: "free" | "plus";
      pick: string[];
      status?: string;
      tz?: string;
      account?: string;
      server?: FakeGoogleServer;
    }): Promise<Setup> {
      const srv = o.server ?? fake;
      const baby = await h.baby({ plan: o.plan ?? "plus" });
      let requester = baby.ownerId;
      if (o.role === "contributor") {
        requester = await newUser();
        await h.admin.query(
          "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'contributor')",
          [baby.id, requester],
        );
      }
      const account = o.account ?? `acct-${randomUUID().slice(0, 8)}`;
      const auth = new URL(`${srv.url}/o/oauth2/v2/auth`);
      auth.searchParams.set("redirect_uri", REDIRECT);
      auth.searchParams.set("scope", SCOPE);
      auth.searchParams.set("account", account);
      const r = await fetch(auth, { redirect: "manual" });
      const code = new URL(r.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const tokRes = await fetch(`${srv.url}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
        }),
      });
      const tok = (await tokRes.json()) as { access_token: string; refresh_token: string };
      await storeRefreshToken(requester, tok.refresh_token);
      const s = (await (
        await fetch(`${srv.url}/v1/sessions`, {
          method: "POST",
          headers: { authorization: `Bearer ${tok.access_token}` },
        })
      ).json()) as { id: string };
      await fetch(`${srv.url}/picker/${s.id}?autopick=${o.pick.join(",")}`);
      const batchId = randomUUID();
      await h.admin.query(
        `INSERT INTO public.import_batches (id, baby_id, requested_by, kind, status, provider_session_id, tz_hint, picker_expires_at)
       VALUES ($1, $2, $3, 'google_picker', $4, $5, $6, now() + interval '20 minutes')`,
        [batchId, baby.id, requester, o.status ?? "queued", s.id, o.tz ?? null],
      );
      return { baby, requester, batchId, sessionId: s.id };
    }

    /** Back-date `updated_at` (the set_updated_at trigger is skipped with replica mode, superuser only). */
    async function backdate(
      table: "import_batches" | "import_items",
      id: string,
      interval: string,
    ) {
      await h.admin.query("BEGIN");
      try {
        await h.admin.query("SET LOCAL session_replication_role = replica");
        await h.admin.query(
          `UPDATE public.${table} SET updated_at = now() - interval '${interval}' WHERE id = $1`,
          [id],
        );
        await h.admin.query("COMMIT");
      } catch (e) {
        await h.admin.query("ROLLBACK");
        throw e;
      }
    }

    const ingests: IngestJob[] = [];
    function deps(
      over: Partial<ImportGoogleDeps> & { server?: FakeGoogleServer } = {},
    ): ImportGoogleDeps {
      const srv = over.server ?? fake;
      tmp = tmp ?? "";
      return {
        pool: h.workerPool,
        storage: h.storage,
        dataKey: h.dataKey,
        google: createWorkerGoogleClient(
          {
            GOOGLE_IMPORT_PROVIDER: "fake",
            GOOGLE_IMPORT_FAKE_URL: srv.url,
            GOOGLE_IMPORT_FAKE_PUBLIC_URL: srv.url,
            GOOGLE_IMPORT_CLIENT_ID: undefined,
            GOOGLE_IMPORT_CLIENT_SECRET: undefined,
          },
          { sleep: async () => undefined, attempts: 2 },
        ),
        download: {
          allowList: googleImportMediaAllowList({
            GOOGLE_IMPORT_PROVIDER: "fake",
            GOOGLE_IMPORT_FAKE_URL: srv.url,
            GOOGLE_IMPORT_MEDIA_HOSTS: ["googleusercontent.com"],
          }),
          maxBytes: IMPORT_MAX_FILE_BYTES,
          tmpDir: tmp,
          sleep: async () => undefined,
          attempts: 2,
        },
        concurrency: 2,
        sendIngest: async (j) => {
          ingests.push(j);
          return "job";
        },
        log: h.log,
        ...over,
      } as ImportGoogleDeps;
    }

    async function run(
      s: Setup,
      over: Partial<ImportGoogleDeps> & { server?: FakeGoogleServer } = {},
      lastAttempt = false,
    ) {
      tmp = await mkdtemp(path.join(os.tmpdir(), "ll-import-it-"));
      ingests.length = 0;
      h.log.lines.length = 0;
      return runImportGoogle(
        deps({ ...over, download: { ...deps(over).download, tmpDir: tmp } }),
        { batchId: s.batchId, babyId: s.baby.id },
        { lastAttempt },
      );
    }

    const batch = (id: string) =>
      h.one<{
        status: string;
        error: string | null;
        items_total: number | null;
        items_imported: number;
        items_duplicate: number;
        items_failed: number;
        items_skipped: number;
        finished_at: Date | null;
      }>(
        "SELECT status, error, items_total, items_imported, items_duplicate, items_failed, items_skipped, finished_at FROM public.import_batches WHERE id = $1",
        [id],
      );
    const items = async (batchId: string) =>
      (
        await h.admin.query<{
          pid: string;
          status: string;
          error: string | null;
          photo_id: string | null;
          id: string;
        }>(
          "SELECT i.id, i.status, i.error, i.photo_id, 'x' AS pid FROM public.import_items i WHERE batch_id = $1",
          [batchId],
        )
      ).rows;
    const objectCount = (babyId: string) => h.versionCount(`babies/${babyId}/originals/`);
    const catalogueSha = (id: string) => fake.catalogue.find((i) => i.id === id)?.sha256 ?? "";
    const leftovers = async () =>
      tmp ? (await readdir(tmp)).filter((n) => !n.startsWith(".")) : [];

    // --- the main run -----------------------------------------------------------------------------

    it("G-1..G-6 + V-1 + X-1 with G-3 already in the album: 5 booked, 1 duplicate, 1 skipped, 1 failed", async () => {
      const s = await setup({
        pick: ["G-1", "G-2", "G-3", "G-4", "G-5", "G-6", "V-1", "X-1"],
        tz: "Europe/Paris",
      });
      // G-3 is already in the album (another device uploaded the same file).
      const pre = await h.seedUpload({
        baby: s.baby,
        bytes: fake.catalogue.find((i) => i.id === "G-3")?.bytes ?? Buffer.alloc(1),
        status: "ready",
      });
      await h.admin.query("UPDATE public.photos SET sha256 = decode($2, 'hex') WHERE id = $1", [
        pre.id,
        catalogueSha("G-3"),
      ]);

      const r = await run(s);
      expect(r).toMatchObject({
        outcome: "done",
        imported: 5,
        duplicates: 1,
        failed: 1,
        skipped: 1,
      });
      const b = await batch(s.batchId);
      expect(b).toMatchObject({
        status: "done",
        error: null,
        items_total: 8,
        items_imported: 5,
        items_duplicate: 1,
        items_failed: 1,
        items_skipped: 1,
      });
      expect(b?.finished_at).not.toBeNull();

      const rows = await items(s.batchId);
      const byStatus = (st: string) => rows.filter((x) => x.status === st);
      expect(byStatus("booked")).toHaveLength(5);
      expect(byStatus("duplicate")).toHaveLength(1);
      expect(byStatus("skipped")[0]?.error).toBe("unsupported_media_type");
      expect(byStatus("failed")[0]?.error).toBe("file_too_large");

      // Photos: admin => approved by the requester and nobody else.
      const photos = (
        await h.admin.query<{
          id: string;
          approval: string;
          approved_by: string | null;
          uploaded_by: string;
          status: string;
          mime: string;
          taken_at: Date | null;
          taken_at_estimated: boolean;
          sha: string;
        }>(
          `SELECT id, approval, approved_by, uploaded_by, status, mime, taken_at, taken_at_estimated, encode(sha256,'hex') AS sha
         FROM public.photos WHERE id = ANY($1::uuid[])`,
          [byStatus("booked").map((x) => x.id)],
        )
      ).rows;
      expect(photos).toHaveLength(5);
      for (const p of photos) {
        expect(p).toMatchObject({
          approval: "approved",
          approved_by: s.requester,
          uploaded_by: s.requester,
          status: "uploaded",
          mime: "image/jpeg",
          taken_at_estimated: true,
        });
        expect(p.taken_at).toBeInstanceOf(Date);
      }
      // SHA-256 of what was stored equals the fake's catalogue.
      const expected = new Set(["G-1", "G-2", "G-4", "G-5", "G-6"].map(catalogueSha));
      expect(new Set(photos.map((p) => p.sha))).toEqual(expected);

      // photo.ingest once per booked photo, ids only (+ the batch's time zone).
      expect(ingests).toHaveLength(5);
      expect(new Set(ingests.map((j) => j.photoId))).toEqual(new Set(photos.map((p) => p.id)));
      for (const j of ingests)
        expect(j).toEqual({ photoId: j.photoId, babyId: s.baby.id, tzHint: "Europe/Paris" });

      // Objects exist only for booked items (+ the pre-seeded one).
      expect(await objectCount(s.baby.id)).toBe(5 + 1);
      for (const p of photos) expect(await h.versionCount(originalKey(s.baby.id, p.id))).toBe(1);
      for (const x of rows.filter((x) => x.status !== "booked"))
        expect(await h.versionCount(originalKey(s.baby.id, x.id))).toBe(0);

      // The picker session was deleted at Google; the audit row has counts only.
      expect(fake.sessions().find((x) => x.id === s.sessionId)?.deleted).toBe(true);
      const audit = await h.admin.query(
        "SELECT metadata, actor_user_id FROM public.audit_log WHERE baby_id = $1 AND event = 'import.batch_finished'",
        [s.baby.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.actor_user_id).toBeNull();
      expect(audit.rows[0]?.metadata).toEqual({
        batch_id: s.batchId,
        count: 5,
        duplicates: 1,
        failed: 1,
      });

      // Staging dir empty; no log line carries a token, a URL, a Google id or a file name.
      expect(await leftovers()).toEqual([]);
      const logs = JSON.stringify(h.log.lines);
      expect(logs).not.toMatch(
        /fake-(access|refresh|code|session)-|\/media\/|http:\/\/|https:\/\/|G-\d|IMG_|\.jpg/i,
      );
    });

    it("is idempotent: running a finished batch again does nothing", async () => {
      const s = await setup({ pick: ["G-1"] });
      expect((await run(s)).outcome).toBe("done");
      const again = await run(s);
      expect(again.outcome).toBe("skipped");
      expect(
        (
          await h.admin.query("SELECT count(*)::int AS n FROM public.photos WHERE baby_id = $1", [
            s.baby.id,
          ])
        ).rows[0]?.n,
      ).toBe(1);
      expect(ingests).toHaveLength(0);
    });

    it("png, webp and heic are accepted with the sniffed type", async () => {
      const s = await setup({ pick: ["P-1", "W-1", "H-1"] });
      const r = await run(s);
      expect(r).toMatchObject({ outcome: "done", imported: 3, failed: 0, skipped: 0 });
      const mimes = (
        await h.admin.query<{ mime: string }>(
          "SELECT mime FROM public.photos WHERE baby_id = $1 ORDER BY mime",
          [s.baby.id],
        )
      ).rows.map((x) => x.mime);
      expect(mimes).toEqual(["image/heic", "image/png", "image/webp"]);
    });

    // --- roles and plans -------------------------------------------------------------------------

    it("a contributor's import is pending with no approver", async () => {
      const s = await setup({ role: "contributor", pick: ["G-7", "P-1"] });
      expect((await run(s)).imported).toBe(2);
      const rows = (
        await h.admin.query<{
          approval: string;
          approved_by: string | null;
          approved_at: Date | null;
          uploaded_by: string;
        }>(
          "SELECT approval, approved_by, approved_at, uploaded_by FROM public.photos WHERE baby_id = $1",
          [s.baby.id],
        )
      ).rows;
      expect(rows).toHaveLength(2);
      for (const p of rows)
        expect(p).toMatchObject({
          approval: "pending",
          approved_by: null,
          approved_at: null,
          uploaded_by: s.requester,
        });
    });

    it("free tier: the cap stops the batch; the rest fail free_tier_limit and nothing is downloaded after", async () => {
      const s = await setup({ plan: "free", pick: ["G-1", "G-2", "G-3", "G-4"] });
      await h.admin.query(
        `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, bytes, approval, status)
       SELECT $1::uuid, $2::uuid, 'babies/' || $1::text || '/originals/' || gen_random_uuid()::text, 10, 'approved', 'ready'
         FROM generate_series(1, 999)`,
        [s.baby.id, s.baby.ownerId],
      );
      const r = await run(s, { concurrency: 1 });
      expect(r.outcome).toBe("done");
      const rows = await items(s.batchId);
      expect(rows.filter((x) => x.status === "booked")).toHaveLength(1);
      expect(
        rows.filter((x) => x.status === "failed" && x.error === "free_tier_limit").length,
      ).toBe(3);
      expect(
        (
          await h.admin.query(
            "SELECT count(*)::int AS n FROM public.photos WHERE baby_id = $1 AND deleted_at IS NULL",
            [s.baby.id],
          )
        ).rows[0]?.n,
      ).toBe(1000);
      // Only the booked object remains: the one that hit the cap was deleted again.
      expect(await objectCount(s.baby.id)).toBe(1);
      expect(ingests).toHaveLength(1);
      // No AI job is created by an import: the only job is photo.ingest.
      expect(ingests.every((j) => Object.keys(j).sort().join() === "babyId,photoId")).toBe(true);
    });

    it("a requester who left the album: the batch fails requester_not_member and books nothing", async () => {
      const s = await setup({ role: "contributor", pick: ["G-1", "G-2"] });
      await h.admin.query("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [
        s.baby.id,
        s.requester,
      ]);
      const r = await run(s);
      expect(r).toMatchObject({ outcome: "failed", error: "requester_not_member" });
      expect(
        (
          await h.admin.query("SELECT count(*)::int AS n FROM public.photos WHERE baby_id = $1", [
            s.baby.id,
          ])
        ).rows[0]?.n,
      ).toBe(0);
      expect(await objectCount(s.baby.id)).toBe(0);
      expect((await batch(s.batchId))?.status).toBe("failed");
    });

    it("a trashed album fails baby_trashed", async () => {
      const s = await setup({ pick: ["G-1"] });
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [s.baby.id]);
      expect(await run(s)).toMatchObject({ outcome: "failed", error: "baby_trashed" });
      expect(await objectCount(s.baby.id)).toBe(0);
    });

    it("a requester who disconnected (no google row) fails google_reconnect", async () => {
      const s = await setup({ pick: ["G-1"] });
      await h.admin.query("DELETE FROM public.google_accounts WHERE user_id = $1", [s.requester]);
      expect(await run(s)).toMatchObject({ outcome: "failed", error: "google_reconnect" });
    });

    // --- Google-side trouble ---------------------------------------------------------------------

    it("invalid_grant on refresh: the batch fails google_reconnect and the account is flagged", async () => {
      const s = await setup({ pick: ["G-1"] });
      fake.revokeAll();
      expect(await run(s)).toMatchObject({ outcome: "failed", error: "google_reconnect" });
      const acct = await h.one<{ needs_reconnect: boolean; refresh_failures: number }>(
        "SELECT needs_reconnect, refresh_failures FROM public.google_accounts WHERE user_id = $1",
        [s.requester],
      );
      expect(acct).toEqual({ needs_reconnect: true, refresh_failures: 1 });
      expect(await objectCount(s.baby.id)).toBe(0);
    });

    it("an expired Picker session (404) fails session_expired", async () => {
      const s = await setup({ pick: ["G-1"] });
      await post(`/__fake/sessions/${s.sessionId}/expire`, {});
      expect(await run(s)).toMatchObject({ outcome: "failed", error: "session_expired" });
    });

    it("a cross-host redirect on one item fails that item only; it is never followed", async () => {
      const s = await setup({ pick: ["G-1", "G-2", "G-4"] });
      await post("/__fake/faults", {
        route: "media",
        itemId: "G-2",
        redirect: "cross-host",
        times: "always",
      });
      try {
        const r = await run(s);
        expect(r).toMatchObject({ outcome: "done", imported: 2, failed: 1 });
        const failed = (await items(s.batchId)).filter((x) => x.status === "failed");
        expect(failed).toHaveLength(1);
        expect(failed[0]?.error).toBe("download_failed");
        expect(await objectCount(s.baby.id)).toBe(2);
      } finally {
        await fetch(`${fake.url}/__fake/faults`, { method: "DELETE" });
      }
    });

    it("a disallowed media host is never fetched: every item fails download_failed", async () => {
      // A second fake whose baseUrls point at an origin outside the allow-list.
      const evil = await startFakeGoogleServer({
        port: 0,
        nodeEnv: "test",
        internalUrl: "http://203.0.113.9:81",
      });
      try {
        await fetch(`${evil.url}/__fake/consent`, {
          method: "POST",
          body: JSON.stringify({ decision: "allow" }),
          headers: { "content-type": "application/json" },
        });
        const s = await setup({ pick: ["G-1", "G-2"], server: evil });
        const t0 = Date.now();
        const r = await run(s, { server: evil });
        expect(r).toMatchObject({ outcome: "done", imported: 0, failed: 2 });
        expect(Date.now() - t0).toBeLessThan(10_000); // nothing waited on an unroutable address
        expect((await items(s.batchId)).every((x) => x.error === "download_failed")).toBe(true);
        expect(await objectCount(s.baby.id)).toBe(0);
        expect(evil.requests().some((r) => r.path.startsWith("/media/"))).toBe(false);
      } finally {
        await evil.close();
      }
    });

    it("more picked items than the cap: the extra ones are skipped; with a zero cap the batch fails too_many_items", async () => {
      const s = await setup({ pick: ["G-1", "G-2", "G-4", "G-5", "G-6"] });
      const r = await run(s, { maxItems: 3 });
      expect(r).toMatchObject({ outcome: "done", imported: 3, skipped: 2 });
      expect((await batch(s.batchId))?.items_total).toBe(5);

      const z = await setup({ pick: ["G-1", "G-2"] });
      expect(await run(z, { maxItems: 0 })).toMatchObject({
        outcome: "failed",
        error: "too_many_items",
      });
      expect(await objectCount(z.baby.id)).toBe(0);
    });

    // --- cancel and retry ------------------------------------------------------------------------

    it("cancel requested before the run: cancelled, nothing downloaded", async () => {
      const s = await setup({ pick: ["G-1", "G-2"] });
      await h.admin.query(
        "UPDATE public.import_batches SET cancel_requested_at = now() WHERE id = $1",
        [s.batchId],
      );
      expect(await run(s)).toMatchObject({ outcome: "cancelled" });
      expect((await batch(s.batchId))?.status).toBe("cancelled");
      expect(await objectCount(s.baby.id)).toBe(0);
      // cancel is audited by the api (it has the actor), never by the worker
      expect(
        (
          await h.admin.query(
            "SELECT 1 FROM public.audit_log WHERE baby_id = $1 AND event LIKE 'import.batch_%'",
            [s.baby.id],
          )
        ).rowCount,
      ).toBe(0);
    });

    it("cancel between items: stops after the current item and finishes cancelled", async () => {
      const s = await setup({ pick: ["G-1", "G-2", "G-4", "G-5"] });
      let first = true;
      const r = await run(s, {
        concurrency: 1,
        sendIngest: async (j) => {
          ingests.push(j);
          if (first) {
            first = false;
            await h.admin.query(
              "UPDATE public.import_batches SET cancel_requested_at = now() WHERE id = $1",
              [s.batchId],
            );
          }
          return "job";
        },
      });
      expect(r.outcome).toBe("cancelled");
      expect(r.imported).toBe(1);
      expect(await objectCount(s.baby.id)).toBe(1);
    });

    it("a storage failure is rethrown for a retry (item stays downloaded); the retry finishes without duplicating", async () => {
      const s = await setup({ pick: ["G-1", "G-2"] });
      let fail = true;
      const flaky = {
        deleteAllVersions: (k: string) => h.storage.deleteAllVersions(k),
        putObjectStream: (...a: Parameters<WorkerStorage["putObjectStream"]>) => {
          if (fail) {
            fail = false;
            return Promise.reject(new Error("boom http://minio/secret?X-Amz-Signature=abc"));
          }
          return (h.storage as WorkerStorage).putObjectStream(...a);
        },
      };
      await expect(run(s, { storage: flaky as never, concurrency: 1 })).rejects.toBeInstanceOf(
        ImportRetryError,
      );
      expect((await batch(s.batchId))?.status).toBe("running");
      expect(JSON.stringify(h.log.lines)).not.toMatch(/X-Amz|secret|minio/);
      const r = await run(s, { concurrency: 1 });
      expect(r).toMatchObject({ outcome: "done", imported: 2 });
      expect(
        (
          await h.admin.query("SELECT count(*)::int AS n FROM public.photos WHERE baby_id = $1", [
            s.baby.id,
          ])
        ).rows[0]?.n,
      ).toBe(2);
      expect(await objectCount(s.baby.id)).toBe(2);
    });

    it("the last attempt fails the batch instead of rethrowing", async () => {
      const s = await setup({ pick: ["G-1"] });
      const broken = {
        deleteAllVersions: async () => 0,
        putObjectStream: async () => {
          throw new Error("down");
        },
      };
      const r = await run(s, { storage: broken as never }, true);
      expect(r).toMatchObject({ outcome: "failed", error: "storage_error" });
    });

    it("provider none (no Google client): the batch fails internal", async () => {
      const s = await setup({ pick: ["G-1"] });
      expect(await run(s, { google: null })).toMatchObject({
        outcome: "failed",
        error: "internal",
      });
    });

    // --- the sweep (back-dated rows) ------------------------------------------------------------

    it("import.sweep: expires pickers, re-sends stuck queued batches, fails stale running ones, cleans orphans and staging", async () => {
      const sendImportGoogle = vi.fn(async () => "job" as string | null);
      // picking, past its expiry
      const picking = await setup({ pick: ["G-1"], status: "picking" });
      await h.admin.query(
        "UPDATE public.import_batches SET picker_expires_at = now() - interval '1 minute' WHERE id = $1",
        [picking.batchId],
      );
      // queued for 20 minutes
      const queued = await setup({ pick: ["G-1"] });
      await backdate("import_batches", queued.batchId, "20 minutes");
      // running with no progress for 3 hours
      const running = await setup({ pick: ["G-1"], status: "running" });
      await backdate("import_batches", running.batchId, "3 hours");
      // an orphaned downloaded item (object, no photo row) older than an hour
      const orphan = await setup({ pick: ["G-1"], status: "running" });
      const itemId = randomUUID();
      await h.admin.query(
        `INSERT INTO public.import_items (id, batch_id, baby_id, provider_item_id, status, bytes, sha256, mime_hint)
       VALUES ($1, $2, $3, 'x', 'downloaded', 5, decode($4, 'hex'), 'image/jpeg')`,
        [itemId, orphan.batchId, orphan.baby.id, createHash("sha256").update("x").digest("hex")],
      );
      await h.admin.query(
        "UPDATE public.import_batches SET status = 'done', finished_at = now() WHERE id = $1",
        [orphan.batchId],
      );
      await h.putObject(originalKey(orphan.baby.id, itemId), Buffer.from("hello"));
      await backdate("import_items", itemId, "2 hours");
      // staging leftovers
      tmp = await mkdtemp(path.join(os.tmpdir(), "ll-import-sweep-"));
      const stale = path.join(tmp, "stale");
      await writeFile(stale, "x");
      await utimes(
        stale,
        new Date(Date.now() - 2 * 3_600_000),
        new Date(Date.now() - 2 * 3_600_000),
      );
      await writeFile(path.join(tmp, "fresh"), "x");

      const r = await sweepImports({
        pool: h.workerPool,
        storage: h.storage,
        sendImportGoogle,
        log: h.log,
        tmpDir: tmp,
      });
      expect(r.expired).toBeGreaterThanOrEqual(1);
      expect(r.failedRunning).toBeGreaterThanOrEqual(1);
      expect(r.orphans).toBeGreaterThanOrEqual(1);
      expect(r.tmpRemoved).toBe(1);
      expect((await batch(picking.batchId))?.status).toBe("expired");
      expect(await batch(running.batchId)).toMatchObject({ status: "failed", error: "internal" });
      expect(sendImportGoogle).toHaveBeenCalledWith({
        batchId: queued.batchId,
        babyId: queued.baby.id,
      });
      expect((await batch(queued.batchId))?.status).toBe("queued");
      expect(await h.versionCount(originalKey(orphan.baby.id, itemId))).toBe(0);
      expect(
        await h.one<{ status: string; error: string | null }>(
          "SELECT status, error FROM public.import_items WHERE id = $1",
          [itemId],
        ),
      ).toEqual({ status: "failed", error: "storage_error" });
      expect(await readdir(tmp)).toEqual(["fresh"]);
      // the failed running batch is audited with an id only
      const audit = await h.admin.query(
        "SELECT metadata FROM public.audit_log WHERE baby_id = $1 AND event = 'import.batch_failed'",
        [running.baby.id],
      );
      expect(audit.rows[0]?.metadata).toEqual({ batch_id: running.batchId });
    });

    it("import.sweep: a queued batch whose requester disconnected fails instead of being re-sent", async () => {
      const s = await setup({ pick: ["G-1"] });
      await backdate("import_batches", s.batchId, "20 minutes");
      await h.admin.query("DELETE FROM public.google_accounts WHERE user_id = $1", [s.requester]);
      const send = vi.fn(async () => "job" as string | null);
      tmp = await mkdtemp(path.join(os.tmpdir(), "ll-import-sweep-"));
      await sweepImports({
        pool: h.workerPool,
        storage: h.storage,
        sendImportGoogle: send,
        log: h.log,
        tmpDir: tmp,
      });
      expect(send).not.toHaveBeenCalledWith({ batchId: s.batchId, babyId: s.baby.id });
      expect(await batch(s.batchId)).toMatchObject({ status: "failed", error: "google_reconnect" });
    });

    it("import.sweep: old terminal items are deleted, recent ones and batches are kept", async () => {
      const s = await setup({ pick: ["G-1"], status: "running" });
      const old = randomUUID();
      const recent = randomUUID();
      for (const [id, pid] of [
        [old, "old"],
        [recent, "recent"],
      ] as const) {
        await h.admin.query(
          "INSERT INTO public.import_items (id, batch_id, baby_id, provider_item_id, status) VALUES ($1, $2, $3, $4, 'skipped')",
          [id, s.batchId, s.baby.id, pid],
        );
      }
      await h.admin.query(
        "UPDATE public.import_batches SET status = 'done', finished_at = now() WHERE id = $1",
        [s.batchId],
      );
      await backdate("import_items", old, "31 days");
      tmp = await mkdtemp(path.join(os.tmpdir(), "ll-import-sweep-"));
      await sweepImports({
        pool: h.workerPool,
        storage: h.storage,
        sendImportGoogle: async () => null,
        log: h.log,
        tmpDir: tmp,
      });
      const left = (
        await h.admin.query<{ id: string }>(
          "SELECT id FROM public.import_items WHERE batch_id = $1",
          [s.batchId],
        )
      ).rows.map((x) => x.id);
      expect(left).toContain(recent);
      expect(left).not.toContain(old);
      expect((await batch(s.batchId))?.status).toBe("done");
    });
  },
);
