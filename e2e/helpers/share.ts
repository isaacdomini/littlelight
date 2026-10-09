import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { request } from "@playwright/test";
import { jpegWithExif } from "../../apps/worker/src/testing/exif-writer";
import { sceneJpeg } from "../../apps/worker/src/testing/images";
import type { ApiClient } from "./api";
import { psql } from "./db";

// Shared by e2e/sharing/gate.ts and e2e/sharing/share.spec.ts: a fresh Plus baby with real
// ingested photos, link helpers, and a cookie-less/cookie-jar viewer client.

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
export const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;

/** Every GPS coordinate (4 decimals) written into an uploaded fixture, for log scans. */
export const GPS_COORDS: string[] = [];

export interface LinkBody {
  id: string;
  status: string;
  hasPasscode: boolean;
  photoCount: number;
  hiddenCount: number;
}
export interface Created {
  link: LinkBody;
  url: string;
}

/** The token is the last path segment of the one-time URL. */
export const tokenOf = (url: string): string => new URL(url).pathname.split("/").pop() as string;

/** Set a baby's plan with the same tool operators use (`db:plan`, through the migrate image). */
export async function setPlan(babyId: string, plan: "plus" | "free"): Promise<void> {
  await sh(
    "docker",
    [
      "compose",
      "-f",
      "docker-compose.dev.yml",
      "run",
      "--rm",
      "migrate",
      "pnpm",
      "db:plan",
      babyId,
      plan,
    ],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
}

/** Run a worker job in the worker container (`run-job`), e.g. `share.apply`. */
export async function runJob(name: string, payload?: unknown): Promise<Record<string, unknown>> {
  const { stdout } = await sh(
    "docker",
    [
      "compose",
      "-f",
      "docker-compose.dev.yml",
      "exec",
      "-T",
      "worker",
      "pnpm",
      "--silent",
      "--filter",
      "@littlelight/worker",
      "run-job",
      name,
      ...(payload === undefined ? [] : [JSON.stringify(payload)]),
    ],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  const line = stdout.split("\n").find((l) => l.startsWith('{"job":'));
  if (!line) throw new Error(`run-job ${name} printed no result`);
  return (JSON.parse(line) as { result?: Record<string, unknown> }).result ?? {};
}

interface RegFile {
  id: string;
  state: string;
  parts?: { partNumber: number; url: string }[];
  photo: { id: string } | null;
}

/** Upload `count` distinct synthetic JPEGs through the real API; resolves with the photo ids. */
export async function uploadPhotos(
  api: ApiClient,
  babyId: string,
  count: number,
  seedBase: number,
  opts: { gps?: boolean } = {},
): Promise<string[]> {
  const samples = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      let bytes = await sceneJpeg(1200, 900, seedBase + i, 85);
      if (opts.gps && i % 2 === 0) {
        const lat = Number((47 + ((seedBase + i * 7) % 900) / 1000 + 0.0001).toFixed(4));
        const lng = Number((-122 - ((seedBase + i * 13) % 900) / 1000 - 0.0001).toFixed(4));
        bytes = jpegWithExif(bytes, {
          make: "GateCam",
          model: "A1",
          dateTimeOriginal: `2026:04:${String(1 + (i % 27)).padStart(2, "0")} 10:${String(i % 60).padStart(2, "0")}:00`,
          gps: { lat, lng },
        });
        GPS_COORDS.push(lat.toFixed(4), lng.toFixed(4));
      }
      return {
        clientId: `share-${seedBase}-${i}`,
        bytes,
        sha: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  const created = await api.call<{ id: string }>("POST", `/babies/${babyId}/uploads`, {});
  if (created.status !== 201) throw new Error(`create upload session answered ${created.status}`);
  const sid = created.body.id;
  const reg = await api.call<{ files: (RegFile & { clientId: string })[] }>(
    "POST",
    `/uploads/${sid}/files`,
    {
      files: samples.map((s) => ({
        clientId: s.clientId,
        bytes: s.bytes.length,
        mime: "image/jpeg",
        clientSha256: s.sha,
      })),
    },
  );
  if (reg.status !== 200) throw new Error(`register answered ${reg.status}`);
  for (const f of reg.body.files) {
    const sample = samples.find((s) => s.clientId === f.clientId);
    if (!sample) continue;
    for (const part of f.parts ?? []) {
      const res = await fetch(part.url, { method: "PUT", body: new Uint8Array(sample.bytes) });
      if (!res.ok) throw new Error(`part PUT answered ${res.status}`);
      await res.arrayBuffer();
    }
    const c = await api.call("POST", `/uploads/${sid}/files/${f.id}/complete`);
    if (c.status !== 200) throw new Error(`complete answered ${c.status}`);
  }
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const r = await api.call<{
      summary: { registered: number; completed: number; ingested: number; failed: number };
      files: RegFile[];
    }>("GET", `/uploads/${sid}`);
    const s = r.body.summary;
    if (r.status === 200 && s.registered === 0 && s.completed === 0) {
      if (s.ingested !== count || s.failed !== 0) {
        throw new Error(`ingested ${s.ingested}/${count}, failed ${s.failed}`);
      }
      return r.body.files.flatMap((f) => (f.photo ? [f.photo.id] : []));
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("uploads did not finish ingesting in 120 s");
}

/** Wait until every photo has its thumb derivative (viewer thumbUrl needs it). */
export async function waitForThumbs(photoIds: string[]): Promise<void> {
  const list = photoIds.map((i) => `'${i}'`).join(",");
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    const [n] = await psql(
      `select count(distinct photo_id) from photo_derivatives where photo_id in (${list}) and kind = 'thumb'`,
    ).catch(() => ["0"]);
    if (Number(n) === photoIds.length) return;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("thumbs were not generated in 90 s");
}

/**
 * Give a photo an AI description row, as the pipeline would. Copies the seeded bath photo's
 * (already schema-valid) row; `sensitive` sets `sensitive_flags` (a trigger syncs
 * `photos.is_sensitive`) and the description's sensitive_content. The baby must be on Plus.
 */
export async function markAnalysed(photoId: string, sensitive: boolean): Promise<void> {
  const flags = sensitive ? "ARRAY['bath']::text[]" : "'{}'::text[]";
  const content = sensitive ? `'["bath"]'::jsonb` : `'[]'::jsonb`;
  await psql(
    `insert into photo_ai (photo_id, model, prompt_version, schema_version, description, sensitive_flags, confidence)
     select '${photoId}', model, prompt_version, schema_version,
            jsonb_set(description, '{sensitive_content}', ${content}), ${flags}, confidence
       from photo_ai where photo_id = '00000000-0000-4000-8000-000000000304'
     on conflict (photo_id) do update set sensitive_flags = excluded.sensitive_flags,
            description = excluded.description`,
  );
  await psql(`update photos set status = 'ready' where id = '${photoId}'`);
}

export interface FreshAlbum {
  api: ApiClient;
  babyId: string;
  /** [analysed non-sensitive, analysed sensitive, unanalysed] */
  photos: [string, string, string];
}

/** Fresh parent + Plus baby + three real photos: analysed, analysed-sensitive, unanalysed. */
export async function freshAlbum(
  api: ApiClient,
  babyName: string,
  seedBase: number,
): Promise<FreshAlbum> {
  await api.onboard("Share Mom");
  const babyId = await api.createBaby(babyName);
  // Upload while the baby is still Free so the AI pipeline never touches these photos; Plus
  // is switched on afterwards (needed for rules and the photo_ai paid-tier tripwire).
  const ids = await uploadPhotos(api, babyId, 3, seedBase);
  await waitForThumbs(ids);
  await setPlan(babyId, "plus");
  const [a, b, c] = ids as [string, string, string];
  await markAnalysed(a, false);
  await markAnalysed(b, true);
  return { api, babyId, photos: [a, b, c] };
}

/** A viewer: its own cookie jar, no parent session. */
export async function viewerClient() {
  const ctx = await request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { "X-Littlelight-Client": "web" },
  });
  return {
    ctx,
    async call<T = Record<string, unknown>>(
      method: string,
      p: string,
      data?: unknown,
      headers?: Record<string, string>,
    ) {
      const r = await ctx.fetch(`/api${p}`, { method, data, ...(headers ? { headers } : {}) });
      let body: unknown = null;
      try {
        body = await r.json();
      } catch {
        /* empty */
      }
      return { status: r.status(), body: body as T, headers: r.headers() };
    },
    /** `ip` is sent as CF-Connecting-IP (the API's client-IP source behind Cloudflare). */
    exchange(token: string, passcode?: string, ip?: string) {
      return this.call<{ error?: string; album?: Record<string, unknown> }>(
        "POST",
        "/share/session",
        passcode ? { token, passcode } : { token },
        ip ? { "CF-Connecting-IP": ip } : undefined,
      );
    },
  };
}
