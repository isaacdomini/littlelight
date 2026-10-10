import { Readable } from "node:stream";
import { EXPORT_PROGRESS_EVERY } from "@tinyglow/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BABY_ID,
  EXPORT_ID,
  exportPool,
  exportStorageStub,
  fixtureBytes,
  listZip,
  photoId,
  readText,
  readZipEntry,
  STORAGE_KEY,
  sha256,
  zeroStream,
  zipTestsOk,
} from "../testing/export";
import { recordingLog } from "../testing/stubs";
import { runDataExport } from "./handler";
import { AUDIT_EXPORT_SQL, PROGRESS_SQL } from "./sql";

// The data.export ZIP builder against a streaming storage double (docs/plans/review-fixes.md
// 2.3): layout, compression, GPS, streaming, memory.

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers.splice(0)) await d();
});

async function setup(photoCount: number, o: { includeLocation?: boolean; gps?: boolean } = {}) {
  const storage = await exportStorageStub({ keepZip: true });
  disposers.push(storage.dispose);
  const photos = Array.from({ length: photoCount }, (_, i) => ({
    id: photoId(i + 1),
    mime: i === 1 ? "image/png" : "image/jpeg",
    bytes: 4096,
    lat: o.gps === false ? null : i < 2 ? 47.6062 + i : null,
    lng: o.gps === false ? null : i < 2 ? -122.3321 - i : null,
    meta: i === 0 ? { note: '=EVIL("x"), line\nbreak' } : {},
  }));
  photos.forEach((p, i) => {
    storage.objects.set(`babies/${BABY_ID}/originals/${p.id}`, () =>
      Readable.from([fixtureBytes(i)]),
    );
  });
  const pool = exportPool({ photos, includeLocation: o.includeLocation });
  return { storage, photos, pool };
}

const run = (
  d: Awaited<ReturnType<typeof setup>>,
  extra: Partial<Parameters<typeof runDataExport>[0]> = {},
) =>
  runDataExport(
    {
      pool: d.pool,
      storage: d.storage,
      dataKey: "k".repeat(40),
      maxBytes: 2 ** 40,
      mailer: null,
      log: recordingLog(),
      ...extra,
    },
    { exportId: EXPORT_ID, babyId: BABY_ID },
  );

describe("export ZIP", () => {
  it("contains the documented entries; originals are byte-identical and stored, text is deflated", async () => {
    const d = await setup(5, { includeLocation: true });
    const res = await run(d);
    expect(res).toMatchObject({ outcome: "ready", photos: 5 });
    const zip = d.storage.zipPath as string;
    expect(await zipTestsOk(zip)).toBe(true);

    const entries = await listZip(zip);
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
    expect(originals.map((e) => e.name)).toEqual(
      d.photos.map((p, i) => `originals/2026-06-14_${p.id}.${i === 1 ? "png" : "jpg"}`),
    );
    for (const e of originals) expect(e.method, e.name).toBe("stor");
    for (const e of entries.filter((x) => !x.name.startsWith("originals/")))
      expect(e.method, e.name).toBe("defN");

    for (let i = 0; i < 5; i++) {
      const name = originals[i]?.name as string;
      expect(sha256(await readZipEntry(zip, name))).toBe(sha256(fixtureBytes(i)));
    }
  });

  it("photos.csv has one row per photo and gps_lat/gps_lng with values only where known", async () => {
    const d = await setup(5, { includeLocation: true });
    await run(d);
    const csv = (await readZipEntry(d.storage.zipPath as string, "photos.csv")).toString("utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.split("\r\n")[0]?.endsWith("gps_lat,gps_lng")).toBe(true);
    expect(csv).toContain("47.6062,-122.3321");
    expect(csv).toContain("48.6062,-123.3321");
    // the note with a formula, comma and newline stayed in one quoted, guarded cell
    expect(csv).toContain(`"'=EVIL(""x""), line\nbreak"`);
    const records = csv.trimEnd().split("\r\n");
    expect(records.length).toBeGreaterThanOrEqual(6); // header + 5 rows (one note spans two lines)
  });

  it("without location the gps columns do not exist and no coordinate appears anywhere", async () => {
    const d = await setup(5, { includeLocation: false });
    await run(d);
    const zip = d.storage.zipPath as string;
    const csv = (await readZipEntry(zip, "photos.csv")).toString("utf8");
    expect(csv).not.toContain("gps_");
    for (const name of ["photos.csv", "photos.json", "album.json", "README.txt"]) {
      const text = (await readZipEntry(zip, name)).toString("utf8");
      expect(text, name).not.toContain("47.6062");
      expect(text, name).not.toContain("-122.3321");
    }
    expect((await readZipEntry(zip, "photos.json")).toString("utf8")).not.toContain('"gps"');
  });

  it("photos.json is valid JSON with one element per photo", async () => {
    const d = await setup(5, { includeLocation: true });
    await run(d);
    const json = JSON.parse(
      (await readZipEntry(d.storage.zipPath as string, "photos.json")).toString("utf8"),
    );
    expect(json).toHaveLength(5);
    expect(json[0].exif.gps).toEqual({ lat: 47.6062, lng: -122.3321 });
    expect(json[4].exif.gps).toBeNull();
  });

  it("an empty album still produces a valid ZIP with the metadata entries", async () => {
    const d = await setup(0);
    const res = await run(d);
    expect(res).toMatchObject({ outcome: "ready", photos: 0 });
    const names = (await listZip(d.storage.zipPath as string)).map((e) => e.name);
    expect(names).toContain("photos.csv");
    expect(names.some((n) => n.startsWith("originals/"))).toBe(false);
  });

  it("pages through large albums (page size smaller than the album)", async () => {
    const d = await setup(7);
    await run(d, { pageSize: 3 });
    expect(
      (await listZip(d.storage.zipPath as string)).filter((e) => e.name.startsWith("originals/")),
    ).toHaveLength(7);
    const csv = (await readZipEntry(d.storage.zipPath as string, "photos.csv")).toString("utf8");
    expect(csv.split("\r\n").filter((l) => l.startsWith("originals/"))).toHaveLength(7);
  });
});

describe("streaming discipline", () => {
  it("reads every original with getObjectStream, never getObject, one after another", async () => {
    const d = await setup(4);
    await run(d);
    expect(d.storage.calls.some((c) => c.startsWith("getObject:"))).toBe(false);
    const gets = d.storage.calls.filter((c) => c.startsWith("getObjectStream:"));
    expect(gets).toEqual(
      d.photos.map((p) => `getObjectStream:babies/${BABY_ID}/originals/${p.id}`),
    );
    expect(d.storage.calls).toContain(`put:${STORAGE_KEY}`);
    // the upload started before the first original was read (true streaming)
    expect(d.storage.calls.indexOf(`put:${STORAGE_KEY}`)).toBeLessThan(
      d.storage.calls.findIndex((c) => c.startsWith("getObjectStream:")),
    );
  });

  it("never holds more than one original open: the next GetObject waits for the previous entry", async () => {
    const d = await setup(4);
    let open = 0;
    let maxOpen = 0;
    d.photos.forEach((p, i) => {
      d.storage.objects.set(`babies/${BABY_ID}/originals/${p.id}`, () => {
        open++;
        maxOpen = Math.max(maxOpen, open);
        const r = Readable.from([fixtureBytes(i)]);
        r.on("close", () => {
          open--;
        });
        return r;
      });
    });
    await run(d);
    expect(maxOpen).toBe(1);
  });

  it("writes progress every EXPORT_PROGRESS_EVERY photos and stops when the export was expired", async () => {
    expect(EXPORT_PROGRESS_EVERY).toBe(50);
    const d = await setup(6);
    const seen: number[] = [];
    d.pool = exportPool({
      photos: d.photos,
      extra: {
        [PROGRESS_SQL]: (params) => {
          seen.push(Number(params[1]));
          return { rows: [{ live: seen.length < 2 }] };
        },
      },
    });
    const res = await run(d, { progressEvery: 2 });
    expect(seen).toEqual([2, 4]);
    expect(res.outcome).toBe("cancelled");
    expect(d.storage.calls.some((c) => c === `delete:${STORAGE_KEY}`)).toBe(true);
  });

  it("memory stays bounded: 200 synthetic 20 MiB originals stream through under 300 MiB extra", async () => {
    const storage = await exportStorageStub();
    disposers.push(storage.dispose);
    const COUNT = 200;
    const SIZE = 20 * 1024 * 1024;
    const photos = Array.from({ length: COUNT }, (_, i) => ({ id: photoId(i + 1), bytes: SIZE }));
    for (const p of photos) {
      storage.objects.set(`babies/${BABY_ID}/originals/${p.id}`, () => zeroStream(SIZE));
    }
    const pool = exportPool({ photos });
    global.gc?.();
    const base = process.memoryUsage();
    let peak = 0;
    const sample = () => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed - base.heapUsed + (m.arrayBuffers - base.arrayBuffers));
    };
    const timer = setInterval(sample, 25);
    try {
      const res = await runDataExport(
        {
          pool,
          storage,
          dataKey: "k".repeat(40),
          maxBytes: 2 ** 50,
          mailer: null,
          log: recordingLog(),
        },
        { exportId: EXPORT_ID, babyId: BABY_ID },
      );
      expect(res.outcome).toBe("ready");
    } finally {
      clearInterval(timer);
    }
    sample();
    expect(storage.uploadedBytes).toBeGreaterThan(COUNT * SIZE);
    // heapUsed alone would hide Buffer growth; count off-heap ArrayBuffers too.
    expect(peak).toBeLessThan(300 * 1024 * 1024);
  }, 240_000);
});

describe("ZIP audit and logs", () => {
  it("audits export.ready with the count only, and the log lines carry no key, URL or coordinate", async () => {
    const d = await setup(3, { includeLocation: true });
    const log = recordingLog();
    await run(d, { log });
    const audits = d.pool.log.filter(([sql]) => sql === AUDIT_EXPORT_SQL);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.[1]).toEqual([
      BABY_ID,
      "export.ready",
      JSON.stringify({ export_id: EXPORT_ID, count: 3 }),
    ]);
    const text = JSON.stringify(log.lines);
    for (const banned of [
      "47.6062",
      "-122.3321",
      "X-Amz",
      "babies/",
      ".zip",
      "@",
      "eyJ",
      "k".repeat(40),
    ])
      expect(text, banned).not.toContain(banned);
  });
});

// keep vi imported for future spies without lint noise
void vi;
void readText;
