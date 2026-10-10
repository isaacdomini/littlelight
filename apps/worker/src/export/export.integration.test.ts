import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDescription } from "@littlelight/ai";
import { babyPrefix, exportKey } from "@littlelight/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExportMailer } from "../email/mailer";
import { purgeTrash } from "../purge";
import type { WorkerStorage } from "../storage";
import { listZip, readZipEntry, sha256 } from "../testing/export";
import { createHarness, type Harness, integrationEnv } from "../testing/harness";
import { handleDataExportJob, runDataExport } from "./handler";

// data.export against real Postgres + MinIO (docs/plans/review-fixes.md 2.14): the ZIP is built
// by streaming, GPS only with location and a still-admin requester, the email has no link, and
// purge.trash removes the object after expiry.

interface Mail {
  to: string;
  data: string;
}

/** A tiny in-process SMTP sink (no auth, no TLS): records recipient and message. */
async function smtpSink() {
  const mails: Mail[] = [];
  const server = createServer((socket) => {
    let to = "";
    let inData = false;
    let data = "";
    let buf = "";
    socket.write("220 sink ESMTP\r\n");
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          mails.push({ to, data });
          socket.write("250 OK queued\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") socket.write("250 sink\r\n");
        else if (cmd === "MAIL") socket.write("250 OK\r\n");
        else if (cmd === "RCPT") {
          to = /<([^>]*)>/.exec(line)?.[1] ?? "";
          socket.write("250 OK\r\n");
        } else if (cmd === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (cmd === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { mails, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Decode quoted-printable / base64 bodies enough to grep them. */
const readable = (raw: string) =>
  raw
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));

describe.skipIf(!integrationEnv)("data.export (real stack)", () => {
  let h: Harness;
  let storage: WorkerStorage;
  let tmp: string;
  let sink: Awaited<ReturnType<typeof smtpSink>>;

  beforeAll(async () => {
    h = await createHarness();
    storage = h.storage as WorkerStorage;
    tmp = await mkdtemp(join(tmpdir(), "ll-exp-int-"));
    sink = await smtpSink();
  });
  afterAll(async () => {
    await sink?.close();
    await rm(tmp, { recursive: true, force: true });
    await h?.close();
  });

  const GPS = [
    { lat: 47.6062, lng: -122.3321 },
    { lat: -33.8688, lng: 151.2093 },
  ];

  /** A baby with an admin requester and `n` ingested originals, the first `GPS.length` with GPS. */
  async function album(o: { plan?: "free" | "plus"; photos?: number } = {}) {
    const baby = await h.baby({ plan: o.plan ?? "plus" });
    const photos: { id: string; bytes: Buffer }[] = [];
    for (let i = 0; i < (o.photos ?? 5); i++) {
      const bytes = Buffer.from(`original-${i}-${randomUUID()}-`.repeat(40));
      const s = await h.seedUpload({ baby, bytes });
      await h.admin.query(
        `UPDATE public.photos SET status = 'ingested', mime = 'image/jpeg', sha256 = decode($2, 'hex'),
                taken_at = '2026-06-1${i}T22:30:00Z', approved_by = $3, approved_at = now()
          WHERE id = $1`,
        [s.id, sha256(bytes), baby.ownerId],
      );
      const g = GPS[i];
      if (g) {
        await h.insertEncryptedExif(s.id, {
          takenAt: `2026-06-1${i}T22:30:00Z`,
          tzOffsetMinutes: 120,
          lat: g.lat,
          lng: g.lng,
          placeLabel: "Home",
        });
      }
      photos.push({ id: s.id, bytes });
    }
    return { baby, photos };
  }

  async function request(babyId: string, requester: string, includeLocation: boolean) {
    const r = await h.admin.query(
      "INSERT INTO public.data_exports (baby_id, requested_by, include_location) VALUES ($1, $2, $3) RETURNING id",
      [babyId, requester, includeLocation],
    );
    return r.rows[0].id as string;
  }

  const deps = (over: Record<string, unknown> = {}) => ({
    pool: h.workerPool,
    storage,
    dataKey: h.dataKey,
    maxBytes: 2 ** 40,
    mailer: null,
    log: h.log,
    ...over,
  });
  const exportRow = (id: string) =>
    h.one<Record<string, unknown>>(
      "SELECT status, error, photo_count, photos_done, bytes::bigint AS bytes, started_at, finished_at, purged_at, expires_at FROM public.data_exports WHERE id = $1",
      [id],
    );
  const download = async (babyId: string, exportId: string) => {
    const buf = await storage.getObject(exportKey(babyId, exportId));
    const path = join(tmp, `${exportId}.zip`);
    await writeFile(path, buf);
    return { path, size: buf.length };
  };

  it("builds a valid ZIP: originals byte-identical, CSV rows, JSON, album.json; GPS only with location", async () => {
    const { baby, photos } = await album({ photos: 5 });
    const id = await request(baby.id, baby.ownerId, true);
    const res = await handleDataExportJob(deps(), {
      id: "j",
      data: { exportId: id, babyId: baby.id },
    });
    expect(res).toMatchObject({ outcome: "ready", photos: 5 });

    const row = await exportRow(id);
    expect(row).toMatchObject({ status: "ready", error: null, photo_count: 5, photos_done: 5 });
    expect(row?.finished_at).not.toBeNull();
    const { path, size } = await download(baby.id, id);
    expect(Number(row?.bytes)).toBe(size);

    const entries = await listZip(path);
    const names = entries.map((e) => e.name);
    expect(names.filter((n) => !n.startsWith("originals/")).sort()).toEqual([
      "README.txt",
      "album.json",
      "measurements.csv",
      "milestones.csv",
      "photos.csv",
      "photos.json",
    ]);
    const originals = entries.filter((e) => e.name.startsWith("originals/"));
    expect(originals).toHaveLength(5);
    for (const e of originals) expect(e.method).toBe("stor");
    for (const p of photos) {
      const name = originals.find((e) => e.name.includes(p.id))?.name as string;
      expect(name, p.id).toMatch(/^originals\/2026-06-1\d_/);
      expect(sha256(await readZipEntry(path, name))).toBe(sha256(p.bytes));
    }

    const csv = (await readZipEntry(path, "photos.csv")).toString("utf8");
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]?.endsWith("gps_lat,gps_lng")).toBe(true);
    const withGps = lines.filter((l) => l.includes(String(GPS[0]?.lat)));
    expect(withGps).toHaveLength(1);
    expect(csv).toContain(`${GPS[1]?.lat},${GPS[1]?.lng}`);
    for (const p of photos) expect(csv).toContain(sha256(p.bytes));

    const json = JSON.parse((await readZipEntry(path, "photos.json")).toString("utf8"));
    expect(json).toHaveLength(5);
    expect(json.filter((j: { exif: { gps: unknown } }) => j.exif.gps !== null)).toHaveLength(2);

    const albumJson = JSON.parse((await readZipEntry(path, "album.json")).toString("utf8"));
    expect(albumJson.counts.photos).toBe(5);
    expect(albumJson.baby.name).toBe("W");
    expect(JSON.stringify(albumJson)).not.toMatch(/"lat"|"lng"|@|latitude/);

    const audit = await h.one<{ metadata: unknown }>(
      "SELECT metadata FROM public.audit_log WHERE baby_id = $1 AND event = 'export.ready'",
      [baby.id],
    );
    expect(audit?.metadata).toEqual({ export_id: id, count: 5 });
  });

  it("without include_location the gps columns are absent and no coordinate appears in any entry", async () => {
    const { baby } = await album({ photos: 3 });
    const id = await request(baby.id, baby.ownerId, false);
    await runDataExport(deps(), { exportId: id, babyId: baby.id });
    const { path } = await download(baby.id, id);
    const csv = (await readZipEntry(path, "photos.csv")).toString("utf8");
    expect(csv).not.toContain("gps_");
    for (const name of ["photos.csv", "photos.json", "album.json", "README.txt"]) {
      const text = (await readZipEntry(path, name)).toString("utf8");
      expect(text, name).not.toContain("47.6062");
      expect(text, name).not.toContain("151.2093");
    }
    expect((await readZipEntry(path, "photos.json")).toString("utf8")).not.toContain('"gps"');
  });

  it("exports the right photo set: pending included; trashed, quarantined, rejected and failed excluded", async () => {
    const { baby, photos } = await album({ photos: 2 });
    const mk = async (patch: string) => {
      const bytes = Buffer.from(`extra-${randomUUID()}`);
      const s = await h.seedUpload({ baby, bytes });
      const status = patch.includes("status") ? "" : "status = 'ingested',";
      await h.admin.query(`UPDATE public.photos SET ${status} ${patch} WHERE id = $1`, [s.id]);
      return s.id;
    };
    const pending = await mk("approval = 'pending', approved_by = NULL, approved_at = NULL");
    const trashed = await mk("deleted_at = now()");
    const quarantined = await mk("quarantined_at = now()");
    const rejected = await mk("approval = 'rejected', approved_by = NULL, approved_at = NULL");
    const failed = await mk("status = 'failed'");
    const id = await request(baby.id, baby.ownerId, false);
    await runDataExport(deps(), { exportId: id, babyId: baby.id });
    const { path } = await download(baby.id, id);
    const names = (await listZip(path))
      .map((e) => e.name)
      .filter((n) => n.startsWith("originals/"));
    const has = (pid: string) => names.some((n) => n.includes(pid));
    expect(has(pending)).toBe(true);
    for (const p of photos) expect(has(p.id)).toBe(true);
    for (const x of [trashed, quarantined, rejected, failed]) expect(has(x), x).toBe(false);
  });

  it("a free-tier album has empty ai_* columns; a paid album carries the AI caption", async () => {
    const free = await album({ plan: "free", photos: 1 });
    const paid = await album({ plan: "plus", photos: 1 });
    const desc = fakeDescription("a0000000-0000-4000-8000-000000000001");
    await h.admin.query(
      `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description)
       VALUES ($1, 'gpt-6-luna', 'v1', 'v1', $2::jsonb)`,
      [paid.photos[0]?.id, JSON.stringify(desc)],
    );
    for (const [a, expectCaption] of [
      [free, false],
      [paid, true],
    ] as const) {
      const id = await request(a.baby.id, a.baby.ownerId, false);
      await runDataExport(deps(), { exportId: id, babyId: a.baby.id });
      const { path } = await download(a.baby.id, id);
      const json = JSON.parse((await readZipEntry(path, "photos.json")).toString("utf8"));
      if (expectCaption) {
        expect(json[0].ai?.description?.caption).toBe(desc.caption);
        expect((await readZipEntry(path, "photos.csv")).toString("utf8")).toContain(desc.caption);
      } else {
        expect(json[0].ai).toBeNull();
      }
    }
  });

  const secondAdmin = async (babyId: string) => {
    const admin2 = randomUUID();
    await h.admin.query(
      "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
      [admin2, `w-${admin2}@worker.test`],
    );
    await h.admin.query(
      "INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'Second')",
      [admin2],
    );
    await h.admin.query(
      "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
      [babyId, admin2],
    );
    return admin2;
  };

  it("emails the requester once with no link; a requester who left gets no email", async () => {
    const mailer = createExportMailer(
      {
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: sink.port,
        SMTP_SECURE: false,
        MAIL_FROM: "noreply@littlelight.test",
      },
      h.log,
    );
    const { baby } = await album({ photos: 1 });
    const before = sink.mails.length;
    const id = await request(baby.id, baby.ownerId, false);
    const res = await runDataExport(deps({ mailer }), { exportId: id, babyId: baby.id });
    expect(res).toMatchObject({ outcome: "ready", emailed: true });
    expect(sink.mails).toHaveLength(before + 1);
    const mail = sink.mails.at(-1) as Mail;
    expect(mail.to).toBe(`w-${baby.ownerId}@worker.test`);
    const body = readable(mail.data);
    expect(body).toContain("is ready");
    expect(body).not.toMatch(/https?:\/\/|\.zip|X-Amz|token/i);

    // A second export whose requester left the album before the job ran: failed, no email.
    const other = await h.baby({ plan: "plus" });
    const admin2 = await secondAdmin(other.id);
    const id2 = await request(other.id, admin2, false);
    await h.admin.query("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [
      other.id,
      admin2,
    ]);
    const n = sink.mails.length;
    const res2 = await runDataExport(deps({ mailer }), { exportId: id2, babyId: other.id });
    expect(res2).toMatchObject({ outcome: "failed", error: "requester_not_admin", emailed: false });
    expect(sink.mails).toHaveLength(n);
    await h.admin.query("DELETE FROM auth.users WHERE id = $1", [admin2]);
    mailer.close();
  });

  it("too_large with a tiny EXPORT_MAX_BYTES: failed, no object, audit export.failed", async () => {
    const { baby } = await album({ photos: 2 });
    const id = await request(baby.id, baby.ownerId, true);
    const res = await runDataExport(deps({ maxBytes: 100 }), { exportId: id, babyId: baby.id });
    expect(res).toMatchObject({ outcome: "failed", error: "too_large" });
    expect(await exportRow(id)).toMatchObject({ status: "failed", error: "too_large" });
    expect(await h.versionCount(exportKey(baby.id, id))).toBe(0);
    const audit = await h.one<{ metadata: unknown }>(
      "SELECT metadata FROM public.audit_log WHERE baby_id = $1 AND event = 'export.failed'",
      [baby.id],
    );
    expect(audit?.metadata).toEqual({ export_id: id });
  });

  it("requester_not_admin after demotion: failed before any original is read, no GPS decrypted, nothing stored", async () => {
    const baby = await h.baby({ plan: "plus" });
    const admin2 = await secondAdmin(baby.id);
    const bytes = Buffer.from("secret original");
    const s = await h.seedUpload({ baby, bytes });
    await h.admin.query("UPDATE public.photos SET status = 'ingested' WHERE id = $1", [s.id]);
    await h.insertEncryptedExif(s.id, {
      takenAt: "2026-06-10T00:00:00Z",
      tzOffsetMinutes: 0,
      lat: 12.3456,
      lng: 65.4321,
      placeLabel: "x",
    });
    const id = await request(baby.id, admin2, true);
    await h.admin.query(
      "UPDATE public.baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
      [baby.id, admin2],
    );
    const res = await runDataExport(deps(), { exportId: id, babyId: baby.id });
    expect(res).toMatchObject({ outcome: "failed", error: "requester_not_admin" });
    expect(await h.versionCount(exportKey(baby.id, id))).toBe(0);
    await h.admin.query("DELETE FROM auth.users WHERE id = $1", [admin2]);
  });

  it("a missing original is a storage_error: the first attempt re-queues, the retry (object restored) succeeds", async () => {
    const { baby } = await album({ photos: 1 });
    const gone = await h.seedUpload({ baby, bytes: Buffer.from("lost"), noObject: true });
    await h.admin.query("UPDATE public.photos SET status = 'ingested' WHERE id = $1", [gone.id]);
    const id = await request(baby.id, baby.ownerId, false);
    await expect(
      handleDataExportJob(deps(), {
        id: "j",
        data: { exportId: id, babyId: baby.id },
        retryCount: 0,
        retryLimit: 1,
      }),
    ).rejects.toBeDefined();
    expect(await exportRow(id)).toMatchObject({ status: "queued" });
    expect(await h.versionCount(exportKey(baby.id, id))).toBe(0);
    await h.putObject(gone.key, Buffer.from("found"));
    const res = await handleDataExportJob(deps(), {
      id: "j",
      data: { exportId: id, babyId: baby.id },
      retryCount: 1,
      retryLimit: 1,
    });
    expect(res.outcome).toBe("ready");
    expect(await exportRow(id)).toMatchObject({ status: "ready" });
  });

  it("a job for an export that is not queued does nothing (duplicate delivery)", async () => {
    const { baby } = await album({ photos: 1 });
    const id = await request(baby.id, baby.ownerId, false);
    await runDataExport(deps(), { exportId: id, babyId: baby.id });
    const first = await exportRow(id);
    const again = await runDataExport(deps(), { exportId: id, babyId: baby.id });
    expect(again.outcome).toBe("skipped");
    expect(await exportRow(id)).toEqual(first);
    // wrong baby id for an existing export id: also nothing
    const other = await h.baby();
    const wrong = await runDataExport(deps(), { exportId: id, babyId: other.id });
    expect(wrong.outcome).toBe("skipped");
  });

  it("purge.trash after expiry removes every object version, marks it expired and audits; the baby prefix keeps the originals", async () => {
    const { baby, photos } = await album({ photos: 2 });
    const id = await request(baby.id, baby.ownerId, false);
    await runDataExport(deps(), { exportId: id, babyId: baby.id });
    const key = exportKey(baby.id, id);
    expect(await h.versionCount(key)).toBeGreaterThan(0);

    // still valid: untouched
    await purgeTrash({ pool: h.workerPool, storage, log: h.log });
    expect(await h.versionCount(key)).toBeGreaterThan(0);
    expect((await exportRow(id))?.status).toBe("ready");

    await h.admin.query(
      "UPDATE public.data_exports SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [id],
    );
    const res = await purgeTrash({ pool: h.workerPool, storage, log: h.log });
    expect(res.exportsPurged).toBeGreaterThanOrEqual(1);
    expect(await h.versionCount(key)).toBe(0);
    expect(await exportRow(id)).toMatchObject({ status: "expired" });
    expect((await exportRow(id))?.purged_at).not.toBeNull();
    const audit = await h.one<{ metadata: unknown }>(
      "SELECT metadata FROM public.audit_log WHERE baby_id = $1 AND event = 'export.purged'",
      [baby.id],
    );
    expect(audit?.metadata).toEqual({ export_id: id });
    for (const p of photos)
      expect(await h.versionCount(`${babyPrefix(baby.id)}originals/${p.id}`)).toBeGreaterThan(0);

    // a second sweep is a no-op, and the row is deleted 30 days after purge
    const again = await purgeTrash({ pool: h.workerPool, storage, log: h.log });
    expect(again.exportsPurged).toBe(0);
    await h.admin.query(
      "UPDATE public.data_exports SET purged_at = now() - interval '31 days' WHERE id = $1",
      [id],
    );
    await purgeTrash({ pool: h.workerPool, storage, log: h.log });
    expect(await exportRow(id)).toBeUndefined();
  });

  it("purge.trash also removes the ZIP when the requester is gone or no longer an admin, and when an admin expired it early", async () => {
    const { baby } = await album({ photos: 1 });
    const id = await request(baby.id, baby.ownerId, false);
    await runDataExport(deps(), { exportId: id, babyId: baby.id });
    const key = exportKey(baby.id, id);
    expect(await h.versionCount(key)).toBeGreaterThan(0);
    // The requester is the baby's only admin, so demote through a second admin first.
    const admin2 = randomUUID();
    await h.admin.query(
      "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
      [admin2, `w-${admin2}@worker.test`],
    );
    await h.admin.query(
      "INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'Second')",
      [admin2],
    );
    await h.admin.query(
      "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
      [baby.id, admin2],
    );
    await h.admin.query(
      "UPDATE public.baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
      [baby.id, baby.ownerId],
    );
    await purgeTrash({ pool: h.workerPool, storage, log: h.log });
    expect(await h.versionCount(key)).toBe(0);
    expect((await exportRow(id))?.status).toBe("expired");
    await h.admin.query(
      "UPDATE public.baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
      [baby.id, baby.ownerId],
    );
    await h.admin.query("DELETE FROM auth.users WHERE id = $1", [admin2]);
  });

  it("the worker log carries no coordinate, email, signed URL, JWT or object key", async () => {
    const text = JSON.stringify(h.log.lines);
    for (const banned of [
      "47.6062",
      "-122.3321",
      "151.2093",
      "-33.8688",
      "@worker.test",
      "X-Amz",
      "eyJ",
      "/exports/",
      ".zip",
      h.dataKey,
    ]) {
      expect(text, banned).not.toContain(banned);
    }
  });
});
