import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { derivativeKey, originalKey, photoPrefixes } from "@tinyglow/shared";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleIngestJob } from "../queues";
import { jpegWithExif, webpWithExif } from "../testing/exif-writer";
import { createHarness, type Harness, integrationEnv } from "../testing/harness";
import { sceneJpeg, scenePng, sceneWebp } from "../testing/images";
import { sha256 } from "./hash";
import { ingestPhoto } from "./index";

// photo.ingest end to end against real Postgres + MinIO (docs/plans/step-4.md 2.13): every
// format, EXIF/GPS handling, duplicates, near-duplicates, unsupported files, quarantine and
// idempotence. Skipped unless DATABASE_URL and S3_ENDPOINT are set.

const HEIC_DIR =
  process.env.HEIC_FIXTURE_DIR ??
  path.resolve(import.meta.dirname, "../../../../e2e/fixtures/heic");
const heicFile = (n: string) => path.join(HEIC_DIR, n);

const SEATTLE = { lat: 47.6062, lng: -122.3321 };

describe.skipIf(!integrationEnv)("photo.ingest (real database + object storage)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const photo = (id: string) =>
    h.one<{
      status: string;
      mime: string | null;
      bytes: number | null;
      width: number | null;
      height: number | null;
      phash: string | null;
      taken_at: Date | null;
      taken_at_estimated: boolean;
      age_days: number | null;
      duplicate_of_photo_id: string | null;
      quarantined_at: Date | null;
      sha256_hex: string | null;
      created_at: Date;
    }>(
      `SELECT status, mime, bytes::int AS bytes, width, height, phash::text AS phash, taken_at,
              taken_at_estimated, age_days, duplicate_of_photo_id, quarantined_at,
              encode(sha256, 'hex') AS sha256_hex, created_at
         FROM public.photos WHERE id = $1`,
      [id],
    );
  const file = (id: string) =>
    h.one<{ state: string; error: string | null; duplicate_of_photo_id: string | null }>(
      "SELECT state, error, duplicate_of_photo_id FROM public.upload_files WHERE id = $1",
      [id],
    );
  const exifRow = (id: string) =>
    h.one<{
      taken_at: Date | null;
      tz_offset_minutes: number | null;
      has_lat: boolean;
      has_lng: boolean;
      place_label: string | null;
      camera_make: string | null;
      orientation: number | null;
      raw_json: Record<string, unknown>;
    }>(
      `SELECT taken_at, tz_offset_minutes, gps_lat_enc IS NOT NULL AS has_lat,
              gps_lng_enc IS NOT NULL AS has_lng, place_label, camera_make, orientation, raw_json
         FROM public.photo_exif WHERE photo_id = $1`,
      [id],
    );
  const derivs = async (id: string) =>
    (
      await h.admin.query(
        "SELECT kind, storage_key, width, height, bytes FROM public.photo_derivatives WHERE photo_id = $1 ORDER BY kind",
        [id],
      )
    ).rows as { kind: string; storage_key: string; width: number; height: number; bytes: number }[];

  const ingest = (id: string, babyId: string, tzHint?: string, over = {}) =>
    ingestPhoto(h.deps(over), { photoId: id, babyId, ...(tzHint ? { tzHint } : {}) });

  /** Everything a successful ingest must leave behind for `id`. */
  async function expectCleanDerivatives(
    babyId: string,
    id: string,
    original: { w: number; h: number },
  ) {
    const rows = await derivs(id);
    expect(rows.map((r) => r.kind)).toEqual(["analysis", "display", "thumb"]);
    const longEdge = (w: number, hh: number) => Math.max(w, hh);
    const expectEdge = { thumb: 320, display: 1600, analysis: 768 } as const;
    for (const r of rows) {
      const k = r.kind as keyof typeof expectEdge;
      expect(r.storage_key).toBe(derivativeKey(babyId, id, k));
      expect(longEdge(r.width, r.height)).toBe(
        Math.min(expectEdge[k], longEdge(original.w, original.h)),
      );
      const obj = await h.storage.getObject(r.storage_key);
      expect(obj.byteLength).toBe(Number(r.bytes));
      const m = await sharp(obj).metadata();
      expect(m.format).toBe("jpeg");
      expect([m.width, m.height]).toEqual([r.width, r.height]);
      expect(m.exif, `${k} exif`).toBeUndefined();
      expect(m.icc, `${k} icc`).toBeUndefined();
      expect(m.xmp, `${k} xmp`).toBeUndefined();
      expect(obj[0]).toBe(0xff);
      expect(obj[1]).toBe(0xd8);
      expect(obj.includes(Buffer.from("Exif"))).toBe(false);
    }
  }

  describe("JPEG with EXIF and GPS", () => {
    it("writes clean derivatives, encrypted GPS, EXIF row, age and hash", async () => {
      const baby = await h.baby({ birthDate: "2026-01-15" });
      const base = await sceneJpeg(2400, 1600, 101);
      const bytes = jpegWithExif(base, {
        make: "Acme",
        model: "Cam 9",
        orientation: 1,
        dateTimeOriginal: "2026:06:14 15:04:05",
        offsetTimeOriginal: "-07:00",
        imageDescription: "Mia at 12 Elm Street",
        artist: "Jane Parent",
        gps: SEATTLE,
      });
      const s = await h.seedUpload({ baby, bytes });
      const r = await ingest(s.id, baby.id);
      expect(r.outcome).toBe("ingested");

      const p = await photo(s.id);
      expect(p).toMatchObject({
        status: "ingested",
        mime: "image/jpeg",
        bytes: bytes.length,
        width: 2400,
        height: 1600,
        taken_at_estimated: false,
        duplicate_of_photo_id: null,
        sha256_hex: sha256(bytes).toString("hex"),
      });
      expect(p?.phash).toMatch(/^[01]{64}$/);
      expect(p?.taken_at?.toISOString()).toBe("2026-06-14T22:04:05.000Z");
      // 2026-01-15 -> local date 2026-06-14 (UTC-07:00): 150 days.
      expect(p?.age_days).toBe(150);
      expect(await file(s.id)).toMatchObject({ state: "ingested", error: null });

      await expectCleanDerivatives(baby.id, s.id, { w: 2400, h: 1600 });

      const e = await exifRow(s.id);
      expect(e).toMatchObject({
        has_lat: true,
        has_lng: true,
        tz_offset_minutes: -420,
        camera_make: "Acme",
        orientation: 1,
        place_label: null,
      });
      expect(e?.taken_at?.toISOString()).toBe("2026-06-14T22:04:05.000Z");
      const gps = await h.decrypt("photo_exif", s.id);
      expect(gps.lat).toBeCloseTo(SEATTLE.lat, 3);
      expect(gps.lng).toBeCloseTo(SEATTLE.lng, 3);

      // raw_json: whitelist only; no GPS, no free text.
      const raw = JSON.stringify(e?.raw_json);
      expect(raw).not.toMatch(/gps|latitude|longitude/i);
      expect(raw).not.toContain("Elm Street");
      expect(raw).not.toContain("Jane");
      expect(e?.raw_json).toMatchObject({ Make: "Acme", Model: "Cam 9" });

      // Plaintext coordinates are in no readable column and in no log line.
      const logs = JSON.stringify(h.log.lines);
      expect(logs).not.toMatch(/47\.6|122\.3|Elm Street/);
      // The original is untouched.
      expect((await h.storage.getObject(originalKey(baby.id, s.id))).equals(bytes)).toBe(true);
    });

    it("labels the photo 'Home' when it was taken within 150 m of the baby's home", async () => {
      const baby = await h.baby({ home: SEATTLE });
      const near = jpegWithExif(await sceneJpeg(640, 480, 102), {
        dateTimeOriginal: "2026:06:14 15:04:05",
        gps: { lat: SEATTLE.lat + 0.0005, lng: SEATTLE.lng },
      });
      const far = jpegWithExif(await sceneJpeg(640, 480, 103), {
        dateTimeOriginal: "2026:06:14 15:04:05",
        gps: { lat: SEATTLE.lat + 0.01, lng: SEATTLE.lng },
      });
      const a = await h.seedUpload({ baby, bytes: near });
      const b = await h.seedUpload({ baby, bytes: far });
      await ingest(a.id, baby.id);
      await ingest(b.id, baby.id);
      expect((await exifRow(a.id))?.place_label).toBe("Home");
      expect((await exifRow(b.id))?.place_label).toBeNull();
    });

    it("reads a wall time without an offset tag in the uploader's time zone (tzHint)", async () => {
      const baby = await h.baby();
      const bytes = jpegWithExif(await sceneJpeg(320, 240, 104), {
        dateTimeOriginal: "2026:01:14 15:04:05",
      });
      const s = await h.seedUpload({ baby, bytes });
      await ingest(s.id, baby.id, "America/Los_Angeles");
      const p = await photo(s.id);
      expect(p?.taken_at?.toISOString()).toBe("2026-01-14T23:04:05.000Z");
      expect((await exifRow(s.id))?.tz_offset_minutes).toBe(-480);
      expect(p?.taken_at_estimated).toBe(false);
    });

    it("EXIF orientation 6 stores the oriented dimensions and portrait derivatives", async () => {
      const baby = await h.baby();
      const bytes = jpegWithExif(await sceneJpeg(1200, 800, 105), {
        orientation: 6,
        dateTimeOriginal: "2026:06:14 15:04:05",
      });
      const s = await h.seedUpload({ baby, bytes });
      await ingest(s.id, baby.id);
      expect(await photo(s.id)).toMatchObject({ width: 800, height: 1200 });
      const rows = await derivs(s.id);
      const thumb = rows.find((r) => r.kind === "thumb");
      expect(thumb && thumb.height > thumb.width).toBe(true);
      expect((await exifRow(s.id))?.orientation).toBe(6);
    });
  });

  describe("other formats", () => {
    it("no EXIF: capture time is estimated from the upload time, no GPS, age still computed", async () => {
      const baby = await h.baby({ birthDate: "2026-01-15" });
      const bytes = await sceneJpeg(800, 600, 110);
      const s = await h.seedUpload({ baby, bytes });
      await ingest(s.id, baby.id);
      const p = await photo(s.id);
      expect(p?.status).toBe("ingested");
      expect(p?.taken_at_estimated).toBe(true);
      expect(p?.taken_at?.toISOString()).toBe(p?.created_at.toISOString());
      expect(typeof p?.age_days).toBe("number");
      const e = await exifRow(s.id);
      expect(e).toMatchObject({ has_lat: false, has_lng: false, camera_make: null });
      expect(e?.taken_at).toBeNull();
    });

    it("PNG", async () => {
      const baby = await h.baby();
      const bytes = await scenePng(900, 600, 111);
      const s = await h.seedUpload({ baby, bytes });
      expect((await ingest(s.id, baby.id)).outcome).toBe("ingested");
      expect(await photo(s.id)).toMatchObject({ mime: "image/png", width: 900, height: 600 });
      await expectCleanDerivatives(baby.id, s.id, { w: 900, h: 600 });
    });

    it("WebP with EXIF and GPS", async () => {
      const baby = await h.baby();
      const bytes = webpWithExif(
        await sceneWebp(700, 500, 112),
        {
          make: "WebCam",
          dateTimeOriginal: "2026:06:14 15:04:05",
          offsetTimeOriginal: "+02:00",
          gps: SEATTLE,
        },
        700,
        500,
      );
      const s = await h.seedUpload({ baby, bytes });
      expect((await ingest(s.id, baby.id)).outcome).toBe("ingested");
      expect(await photo(s.id)).toMatchObject({ mime: "image/webp", width: 700, height: 500 });
      const e = await exifRow(s.id);
      expect(e).toMatchObject({ has_lat: true, camera_make: "WebCam", tz_offset_minutes: 120 });
      expect((await photo(s.id))?.taken_at?.toISOString()).toBe("2026-06-14T13:04:05.000Z");
      await expectCleanDerivatives(baby.id, s.id, { w: 700, h: 500 });
    });

    it.skipIf(!existsSync(heicFile("plain-640x480.heic")))(
      "HEIC: mime image/heic, JPEG derivatives, dimensions",
      async () => {
        const baby = await h.baby();
        const bytes = readFileSync(heicFile("plain-640x480.heic"));
        const s = await h.seedUpload({ baby, bytes });
        expect((await ingest(s.id, baby.id)).outcome).toBe("ingested");
        expect(await photo(s.id)).toMatchObject({ mime: "image/heic", width: 640, height: 480 });
        await expectCleanDerivatives(baby.id, s.id, { w: 640, h: 480 });
        expect((await h.storage.getObject(originalKey(baby.id, s.id))).equals(bytes)).toBe(true);
      },
    );

    it.skipIf(!existsSync(heicFile("portrait-480x640.heic")))(
      "portrait HEIC keeps portrait orientation",
      async () => {
        const baby = await h.baby();
        const s = await h.seedUpload({
          baby,
          bytes: readFileSync(heicFile("portrait-480x640.heic")),
        });
        await ingest(s.id, baby.id);
        expect(await photo(s.id)).toMatchObject({ width: 480, height: 640 });
      },
    );

    it.skipIf(!existsSync(heicFile("gps-640x480.heic")))(
      "HEIC with GPS: coordinates encrypted, none in raw_json",
      async () => {
        const baby = await h.baby();
        const s = await h.seedUpload({ baby, bytes: readFileSync(heicFile("gps-640x480.heic")) });
        await ingest(s.id, baby.id);
        const e = await exifRow(s.id);
        expect(e).toMatchObject({ has_lat: true, has_lng: true });
        expect(JSON.stringify(e?.raw_json)).not.toMatch(/gps|latitude|longitude/i);
        const gps = await h.decrypt("photo_exif", s.id);
        expect(gps.lat).toBeCloseTo(47.6062, 2);
        expect(gps.lng).toBeCloseTo(-122.3321, 2);
      },
    );

    it.skipIf(!existsSync(heicFile("datetime-tz.heic")))(
      "HEIC with DateTimeOriginal and offset",
      async () => {
        const baby = await h.baby();
        const s = await h.seedUpload({ baby, bytes: readFileSync(heicFile("datetime-tz.heic")) });
        await ingest(s.id, baby.id);
        expect((await photo(s.id))?.taken_at?.toISOString()).toBe("2026-06-14T22:04:05.000Z");
      },
    );

    it.skipIf(!existsSync(heicFile("heif-mif1.heif")))("HEIF", async () => {
      const baby = await h.baby();
      const s = await h.seedUpload({ baby, bytes: readFileSync(heicFile("heif-mif1.heif")) });
      expect((await ingest(s.id, baby.id)).outcome).toBe("ingested");
      expect((await photo(s.id))?.mime).toMatch(/^image\/hei[cf]$/);
    });
  });

  describe("duplicates", () => {
    it("an exact duplicate leaves no photos row and no object versions; the first photo is untouched", async () => {
      const baby = await h.baby();
      const bytes = await sceneJpeg(800, 600, 120);
      const first = await h.seedUpload({ baby, bytes });
      const second = await h.seedUpload({ baby, bytes, versions: 2 });
      expect((await ingest(first.id, baby.id)).outcome).toBe("ingested");
      const r = await ingest(second.id, baby.id);
      expect(r).toMatchObject({ outcome: "duplicate", duplicateOf: first.id });

      expect(await photo(second.id)).toBeUndefined();
      expect(await file(second.id)).toMatchObject({
        state: "duplicate",
        duplicate_of_photo_id: first.id,
      });
      for (const prefix of photoPrefixes(baby.id, second.id)) {
        expect(await h.versionCount(prefix), prefix).toBe(0);
      }
      expect((await photo(first.id))?.status).toBe("ingested");
      expect(await h.versionCount(originalKey(baby.id, first.id))).toBeGreaterThan(0);
      expect((await derivs(first.id)).length).toBe(3);
    });

    it("the same bytes in another baby are not duplicates", async () => {
      const a = await h.baby();
      const b = await h.baby();
      const bytes = await sceneJpeg(400, 300, 121);
      const s1 = await h.seedUpload({ baby: a, bytes });
      const s2 = await h.seedUpload({ baby: b, bytes });
      expect((await ingest(s1.id, a.id)).outcome).toBe("ingested");
      expect((await ingest(s2.id, b.id)).outcome).toBe("ingested");
    });

    it("a trashed photo with the same bytes does not block a new upload", async () => {
      const baby = await h.baby();
      const bytes = await sceneJpeg(400, 300, 122);
      const old = await h.seedUpload({ baby, bytes });
      await ingest(old.id, baby.id);
      await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [old.id]);
      const again = await h.seedUpload({ baby, bytes });
      expect((await ingest(again.id, baby.id)).outcome).toBe("ingested");
    });

    it("a q60 recompression is flagged as a near-duplicate but kept", async () => {
      const baby = await h.baby();
      const original = await sceneJpeg(800, 600, 123, 95);
      const recompressed = await sharp(original).jpeg({ quality: 60 }).toBuffer();
      const a = await h.seedUpload({ baby, bytes: original });
      const b = await h.seedUpload({ baby, bytes: recompressed });
      await ingest(a.id, baby.id);
      const r = await ingest(b.id, baby.id);
      expect(r).toMatchObject({ outcome: "ingested", nearDuplicateOf: a.id });
      expect(await photo(b.id)).toMatchObject({ status: "ingested", duplicate_of_photo_id: a.id });
      expect((await photo(a.id))?.duplicate_of_photo_id).toBeNull();
    });

    it("different scenes are not flagged", async () => {
      const baby = await h.baby();
      const a = await h.seedUpload({ baby, bytes: await sceneJpeg(600, 400, 124) });
      const b = await h.seedUpload({ baby, bytes: await sceneJpeg(600, 400, 125) });
      await ingest(a.id, baby.id);
      await ingest(b.id, baby.id);
      expect((await photo(b.id))?.duplicate_of_photo_id).toBeNull();
    });

    it("two workers ingesting the same exact duplicates at once end in one surviving photo", async () => {
      const baby = await h.baby();
      const bytes = await sceneJpeg(500, 400, 126);
      const a = await h.seedUpload({ baby, bytes });
      const b = await h.seedUpload({ baby, bytes });
      const results = await Promise.all([ingest(a.id, baby.id), ingest(b.id, baby.id)]);
      expect(results.map((r) => r.outcome).sort()).toEqual(["duplicate", "ingested"]);
      const n = await h.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.photos WHERE baby_id = $1",
        [baby.id],
      );
      expect(n?.n).toBe(1);
    });
  });

  describe("rejects and failures", () => {
    it("a text file named .jpg fails as unsupported_media_type and its object is deleted", async () => {
      const baby = await h.baby();
      const s = await h.seedUpload({
        baby,
        bytes: Buffer.from("this is not a photo, just text\n".repeat(20)),
      });
      const r = await ingest(s.id, baby.id);
      expect(r).toMatchObject({ outcome: "failed", error: "unsupported_media_type" });
      expect(await photo(s.id)).toMatchObject({ status: "failed" });
      expect(await file(s.id)).toMatchObject({ state: "failed", error: "unsupported_media_type" });
      expect(await derivs(s.id)).toEqual([]);
      expect(await h.versionCount(originalKey(baby.id, s.id))).toBe(0);
    });

    it.each([
      ["GIF", Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(200)])],
      ["PDF", Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n")],
      [
        "SVG",
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        ),
      ],
    ])("%s is unsupported_media_type", async (_n, bytes) => {
      const baby = await h.baby();
      const s = await h.seedUpload({ baby, bytes });
      expect(await ingest(s.id, baby.id)).toMatchObject({
        outcome: "failed",
        error: "unsupported_media_type",
      });
    });

    it("a truncated JPEG fails as decode_failed and the original is kept (no derivatives)", async () => {
      const baby = await h.baby();
      const good = await sceneJpeg(1600, 1200, 130);
      const s = await h.seedUpload({ baby, bytes: good.subarray(0, Math.floor(good.length / 4)) });
      const r = await ingest(s.id, baby.id);
      expect(r).toMatchObject({ outcome: "failed", error: "decode_failed" });
      expect(await file(s.id)).toMatchObject({ state: "failed", error: "decode_failed" });
      expect(await derivs(s.id)).toEqual([]);
      expect(await h.versionCount(originalKey(baby.id, s.id))).toBeGreaterThan(0);
    });

    it("a missing object is transient: the error propagates and nothing is marked failed until the last attempt", async () => {
      const baby = await h.baby();
      const s = await h.seedUpload({ baby, bytes: Buffer.from("x"), noObject: true });
      await expect(ingest(s.id, baby.id)).rejects.toMatchObject({
        name: "StorageError",
        code: "NoSuchKey",
      });
      expect((await photo(s.id))?.status).toBe("uploaded");

      const payload = { photoId: s.id, babyId: baby.id };
      const job = (retryCount: number) => ({
        id: "j",
        data: payload,
        retryCount,
        retryLimit: 3,
        createdOn: new Date(),
      });
      await expect(handleIngestJob(h.deps(), job(1))).rejects.toBeTruthy();
      expect((await photo(s.id))?.status).toBe("uploaded");
      await expect(handleIngestJob(h.deps(), job(3))).rejects.toBeTruthy();
      expect(await photo(s.id)).toMatchObject({ status: "failed" });
      expect(await file(s.id)).toMatchObject({ state: "failed", error: "storage_error" });
    });

    it("a failed (storage_error) photo is re-ingested once the object is there", async () => {
      const baby = await h.baby();
      const bytes = await sceneJpeg(400, 300, 131);
      const s = await h.seedUpload({ baby, bytes, noObject: true });
      await expect(ingest(s.id, baby.id)).rejects.toBeTruthy();
      await handleIngestJob(h.deps(), {
        id: "j",
        data: { photoId: s.id, babyId: baby.id },
        retryCount: 3,
        retryLimit: 3,
        createdOn: new Date(),
      }).catch(() => undefined);
      expect((await photo(s.id))?.status).toBe("failed");
      await h.putObject(s.key, bytes);
      expect((await ingest(s.id, baby.id)).outcome).toBe("ingested");
      expect(await file(s.id)).toMatchObject({ state: "ingested", error: null });
    });

    it("a payload whose baby does not match the photo is ignored", async () => {
      const a = await h.baby();
      const b = await h.baby();
      const s = await h.seedUpload({ baby: a, bytes: await sceneJpeg(300, 200, 132) });
      const r = await ingest(s.id, b.id);
      expect(r.outcome).toBe("skipped");
      expect((await photo(s.id))?.status).toBe("uploaded");
    });

    it("an unknown, trashed or non-runnable photo is skipped", async () => {
      const baby = await h.baby();
      const s = await h.seedUpload({ baby, bytes: await sceneJpeg(300, 200, 133) });
      expect((await ingest("00000000-0000-4000-8000-00000000dead", baby.id)).outcome).toBe(
        "skipped",
      );
      await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [s.id]);
      expect((await ingest(s.id, baby.id)).outcome).toBe("skipped");
      expect((await photo(s.id))?.status).toBe("uploaded");
    });
  });

  describe("quarantine (CSAM hash match)", () => {
    it("a match quarantines the photo: no derivatives, original kept, audited, hidden from users", async () => {
      const baby = await h.baby();
      const bytes = await sceneJpeg(600, 400, 140);
      const s = await h.seedUpload({ baby, bytes });
      let seen: { image: Buffer; sha: Buffer } | undefined;
      const matcher = {
        name: "photodna" as const,
        check: async (i: { image: Buffer; sha256: Buffer }) => {
          seen = { image: i.image, sha: i.sha256 };
          return { matched: true, reference: "REF-1" };
        },
      };
      const r = await ingest(s.id, baby.id, undefined, { matcher });
      expect(r.outcome).toBe("quarantined");
      expect(seen?.sha.equals(sha256(bytes))).toBe(true);
      // The matcher got the 768-px analysis JPEG, not the original.
      expect(seen && (await sharp(seen.image).metadata()).format).toBe("jpeg");
      expect(seen?.image.equals(bytes)).toBe(false);

      const p = await photo(s.id);
      expect(p?.status).toBe("failed");
      expect(p?.quarantined_at).not.toBeNull();
      expect(await derivs(s.id)).toEqual([]);
      for (const kind of ["thumb", "display", "analysis"] as const) {
        expect(await h.versionCount(derivativeKey(baby.id, s.id, kind))).toBe(0);
      }
      expect(await h.versionCount(originalKey(baby.id, s.id))).toBeGreaterThan(0);
      expect(await file(s.id)).toMatchObject({ state: "failed", error: "rejected" });
      const audit = await h.one<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM public.audit_log WHERE baby_id = $1 AND event = 'safety.hash_match'",
        [baby.id],
      );
      expect(audit?.metadata).toEqual({ photo_id: s.id });
      expect(JSON.stringify(h.log.lines)).not.toContain("REF-1");
      expect(await exifRow(s.id)).toBeUndefined();

      // Invisible to the uploader/admin through RLS.
      const c = h.admin;
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: baby.ownerId, role: "authenticated" }),
        ]);
        const seenByAdmin = await c.query("SELECT 1 FROM public.photos WHERE id = $1", [s.id]);
        expect(seenByAdmin.rowCount).toBe(0);
      } finally {
        await c.query("ROLLBACK");
      }
    });

    it("a matcher outage is transient: the job fails (retry), nothing is published", async () => {
      const baby = await h.baby();
      const s = await h.seedUpload({ baby, bytes: await sceneJpeg(400, 300, 141) });
      const matcher = {
        name: "photodna" as const,
        check: async () => {
          throw new Error("provider down");
        },
      };
      await expect(ingest(s.id, baby.id, undefined, { matcher })).rejects.toThrow("provider down");
      expect(await derivs(s.id)).toEqual([]);
      expect((await photo(s.id))?.status).toBe("uploaded");
    });

    it("a quarantined photo is never re-ingested", async () => {
      const baby = await h.baby();
      const s = await h.seedUpload({ baby, bytes: await sceneJpeg(400, 300, 142) });
      await ingest(s.id, baby.id, undefined, {
        matcher: { name: "photodna", check: async () => ({ matched: true }) },
      });
      expect((await ingest(s.id, baby.id)).outcome).toBe("skipped");
      expect(await derivs(s.id)).toEqual([]);
    });
  });

  describe("idempotence", () => {
    it("re-running ingest on an ingested photo changes nothing", async () => {
      const baby = await h.baby();
      const s = await h.seedUpload({
        baby,
        bytes: jpegWithExif(await sceneJpeg(800, 600, 150), {
          dateTimeOriginal: "2026:06:14 15:04:05",
          gps: SEATTLE,
        }),
      });
      await ingest(s.id, baby.id);
      const before = {
        photo: await h.one("SELECT * FROM public.photos WHERE id = $1", [s.id]),
        derivs: await derivs(s.id),
        exif: await h.one("SELECT * FROM public.photo_exif WHERE photo_id = $1", [s.id]),
        versions: await h.versionCount(`babies/${baby.id}/`),
      };
      const again = await ingest(s.id, baby.id);
      expect(again.outcome).toBe("skipped");
      expect(await h.one("SELECT * FROM public.photos WHERE id = $1", [s.id])).toEqual(
        before.photo,
      );
      expect(await derivs(s.id)).toEqual(before.derivs);
      expect(await h.one("SELECT * FROM public.photo_exif WHERE photo_id = $1", [s.id])).toEqual(
        before.exif,
      );
      expect(await h.versionCount(`babies/${baby.id}/`)).toBe(before.versions);
    });

    it("two concurrent runs for the same photo both succeed and leave one consistent result", async () => {
      const baby = await h.baby();
      const s = await h.seedUpload({ baby, bytes: await sceneJpeg(800, 600, 151) });
      const rs = await Promise.all([ingest(s.id, baby.id), ingest(s.id, baby.id)]);
      expect(rs.map((r) => r.outcome)).toContain("ingested");
      expect((await photo(s.id))?.status).toBe("ingested");
      expect((await derivs(s.id)).length).toBe(3);
      expect(await file(s.id)).toMatchObject({ state: "ingested" });
    });
  });

  describe("log hygiene", () => {
    it("log lines carry ids, mime, sizes and categories only", async () => {
      const baby = await h.baby();
      const s = await h.seedUpload({
        baby,
        bytes: jpegWithExif(await sceneJpeg(300, 200, 160), {
          make: "SecretCam",
          imageDescription: "Mia's nursery",
          dateTimeOriginal: "2026:06:14 15:04:05",
          gps: SEATTLE,
        }),
      });
      await ingest(s.id, baby.id);
      const text = JSON.stringify(h.log.lines);
      expect(text).toContain(s.id);
      for (const secret of ["SecretCam", "nursery", "47.60", "122.33", "X-Amz", "Credential"]) {
        expect(text).not.toContain(secret);
      }
    });
  });
});
