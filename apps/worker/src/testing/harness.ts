import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { babyPrefix, originalKey } from "@littlelight/shared";
import pg from "pg";
import type { IngestDeps } from "../ingest";
import type { CsamMatcher } from "../ingest/safety";
import { createStorage, type ObjectStorage } from "../storage";
import { recordingLog } from "./stubs";

// Integration harness for apps/worker (docs/plans/step-4.md 4.8). Real Postgres (superuser
// `DATABASE_URL`; the worker uses its own `littlelight_worker` login and `runAsPipeline`) and a
// real S3 endpoint (MinIO; root or any key with bucket create + versioning + object rights).
//
//   DATABASE_URL, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET (created if missing,
//   versioning enabled), S3_REGION (us-east-1), S3_FORCE_PATH_STYLE (true), and optionally
//   AUTH_DB_PASSWORD / API_DB_PASSWORD / WORKER_DB_PASSWORD / DATA_ENCRYPTION_KEY (dev defaults).
//
// Suites `describe.skipIf(!integrationEnv)`. Every fixture id is random, so runs never collide;
// `close()` removes what the run created (rows by cascade, objects by baby prefix).

const dev = (name: string, fallback: string) => process.env[name] ?? fallback;

export const integrationEnv =
  process.env.DATABASE_URL && process.env.S3_ENDPOINT
    ? {
        databaseUrl: process.env.DATABASE_URL,
        endpoint: process.env.S3_ENDPOINT,
        accessKey: dev("S3_ACCESS_KEY", "dev"),
        secretKey: dev("S3_SECRET_KEY", "devdevdev"),
        bucket: dev("S3_BUCKET", "littlelight-test"),
        region: dev("S3_REGION", "us-east-1"),
        dataKey: dev("DATA_ENCRYPTION_KEY", "dev-only-data-encryption-key-32-chars-min"),
        workerPassword: dev("WORKER_DB_PASSWORD", "dev"),
      }
    : undefined;

/** Bootstrap roles + apply migrations (packages/db), stubbing auth.users on a bare Postgres. */
async function ensureMigrated(databaseUrl: string): Promise<void> {
  // Loaded by file URL so the worker package needs no dependency on @littlelight/db.
  const spec = pathToFileURL(
    path.resolve(import.meta.dirname, "../../../../packages/db/src/index.ts"),
  ).href;
  const db = (await import(/* @vite-ignore */ spec)) as {
    ensureAuthSchemaStub(c: pg.Client): Promise<void>;
    runMigrations(o: {
      direction: "up";
      databaseUrl: string;
      env: Record<string, string | undefined>;
      log: () => void;
    }): Promise<unknown>;
  };
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await db.ensureAuthSchemaStub(c);
  } finally {
    await c.end();
  }
  await db.runMigrations({
    direction: "up",
    databaseUrl,
    env: {
      ...process.env,
      AUTH_DB_PASSWORD: dev("AUTH_DB_PASSWORD", "dev"),
      API_DB_PASSWORD: dev("API_DB_PASSWORD", "dev"),
      WORKER_DB_PASSWORD: dev("WORKER_DB_PASSWORD", "dev"),
      DATA_ENCRYPTION_KEY: dev("DATA_ENCRYPTION_KEY", "dev-only-data-encryption-key-32-chars-min"),
    },
    log: () => undefined,
  });
}

export interface Baby {
  id: string;
  ownerId: string;
}

export interface SeedOptions {
  baby: Baby;
  /** Fixed photo id (default random); the fake AI provider flags ids starting with `0` as `bath`. */
  id?: string;
  bytes: Buffer;
  approval?: "approved" | "pending";
  /** Skip putting the object (simulates a lost upload). */
  noObject?: boolean;
  /** SQL interval: how long ago the photo row was created (reconcile tests). */
  createdAgo?: string;
  status?: string;
  /** Overwrite the object twice first, so the key has several versions. */
  versions?: number;
}

export interface Seeded {
  id: string;
  sessionId: string;
  key: string;
}

export interface Harness {
  admin: pg.Client;
  workerPool: pg.Pool;
  s3: S3Client;
  storage: ObjectStorage;
  bucket: string;
  dataKey: string;
  log: ReturnType<typeof recordingLog>;
  /** Ingest dependencies; override the matcher per test. */
  deps(over?: Partial<IngestDeps>): IngestDeps;
  baby(opts?: {
    plan?: "free" | "plus";
    birthDate?: string;
    home?: { lat: number; lng: number };
    trashedAgo?: string;
  }): Promise<Baby>;
  /** Insert session + upload file + photo row (status `uploaded`) and put the object. */
  seedUpload(o: SeedOptions): Promise<Seeded>;
  /** Count object versions and delete markers under `prefix`. */
  versionCount(prefix: string): Promise<number>;
  /** Plain delete (creates a delete marker on a versioned bucket). */
  deleteObject(key: string): Promise<void>;
  putObject(key: string, body: Buffer): Promise<void>;
  /** Start a real multipart upload (for sweep tests); returns its upload id. */
  startMultipart(key: string): Promise<string>;
  openMultipartIds(prefix: string): Promise<string[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Decrypt a stored coordinate ciphertext as the superuser with the data key set. */
  decrypt(
    table: "photo_exif",
    photoId: string,
  ): Promise<{ lat: number | null; lng: number | null }>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const env = integrationEnv;
  if (!env) throw new Error("DATABASE_URL and S3_ENDPOINT are required");
  await ensureMigrated(env.databaseUrl);

  const admin = new pg.Client({ connectionString: env.databaseUrl });
  await admin.connect();
  const url = new URL(env.databaseUrl);
  url.username = "littlelight_worker";
  url.password = env.workerPassword;
  const workerPool = new pg.Pool({ connectionString: url.toString(), max: 4 });

  const s3 = new S3Client({
    endpoint: env.endpoint,
    region: env.region,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    credentials: { accessKeyId: env.accessKey, secretAccessKey: env.secretKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: env.bucket }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
  }
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: env.bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  const storage = createStorage(s3, env.bucket);
  const log = recordingLog();

  const startedAt = new Date(Date.now() - 1_000);
  const users: string[] = [];
  const babies: string[] = [];
  const sessions: string[] = [];

  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows[0] as T | undefined;

  const h: Harness = {
    admin,
    workerPool,
    s3,
    storage,
    bucket: env.bucket,
    dataKey: env.dataKey,
    log,
    one,

    deps(over = {}) {
      const matcher: CsamMatcher = { name: "none", check: async () => ({ matched: false }) };
      return { pool: workerPool, storage, matcher, dataKey: env.dataKey, log, ...over };
    },

    async baby(o = {}) {
      const ownerId = randomUUID();
      await admin.query(
        `INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
         VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())`,
        [ownerId, `w-${ownerId}@worker.test`],
      );
      await admin.query("INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'W')", [
        ownerId,
      ]);
      users.push(ownerId);
      const id = randomUUID();
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT set_config('app.data_key', $1, true)", [env.dataKey]);
        await admin.query(
          `INSERT INTO public.babies (id, name, birth_date, plan, home_lat_enc, home_lng_enc, deleted_at)
           VALUES ($1, 'W', $2, $3,
                   ${o.home ? "public.encrypt_coord($4::float8)" : "NULL"},
                   ${o.home ? "public.encrypt_coord($5::float8)" : "NULL"},
                   ${o.trashedAgo ? `now() - interval '${o.trashedAgo}'` : "NULL"})`,
          [
            id,
            o.birthDate ?? "2026-01-15",
            o.plan ?? "plus",
            ...(o.home ? [o.home.lat, o.home.lng] : []),
          ],
        );
        await admin.query(
          "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
          [id, ownerId],
        );
        await admin.query("COMMIT");
      } catch (err) {
        await admin.query("ROLLBACK");
        throw err;
      }
      babies.push(id);
      return { id, ownerId };
    },

    async seedUpload(o) {
      const id = o.id ?? randomUUID();
      const key = originalKey(o.baby.id, id);
      const sessionId = randomUUID();
      sessions.push(sessionId);
      await admin.query(
        `INSERT INTO public.upload_sessions (id, baby_id, created_by) VALUES ($1, $2, $3)`,
        [sessionId, o.baby.id, o.baby.ownerId],
      );
      await admin.query(
        `INSERT INTO public.upload_files (id, session_id, baby_id, declared_bytes, storage_key, part_size, state)
         VALUES ($1, $2, $3, $4, $5, 16777216, 'registered')`,
        [id, sessionId, o.baby.id, o.bytes.byteLength, key],
      );
      await admin.query(
        `INSERT INTO public.photos
           (id, baby_id, uploaded_by, storage_key_original, bytes, approval, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ${o.createdAgo ? `now() - interval '${o.createdAgo}'` : "now()"})`,
        [
          id,
          o.baby.id,
          o.baby.ownerId,
          key,
          o.bytes.byteLength,
          o.approval ?? "approved",
          o.status ?? "uploaded",
        ],
      );
      await admin.query(
        `UPDATE public.upload_files SET state = 'completed', photo_id = id WHERE id = $1`,
        [id],
      );
      if (!o.noObject) {
        for (let i = 0; i < (o.versions ?? 0); i++) await h.putObject(key, Buffer.from(`old ${i}`));
        await h.putObject(key, o.bytes);
      }
      return { id, sessionId, key };
    },

    async versionCount(prefix) {
      let n = 0;
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      for (;;) {
        const r = await s3.send(
          new ListObjectVersionsCommand({
            Bucket: env.bucket,
            Prefix: prefix,
            KeyMarker: keyMarker,
            VersionIdMarker: versionMarker,
          }),
        );
        n += (r.Versions?.length ?? 0) + (r.DeleteMarkers?.length ?? 0);
        if (!r.IsTruncated) return n;
        keyMarker = r.NextKeyMarker;
        versionMarker = r.NextVersionIdMarker;
      }
    },

    async deleteObject(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: env.bucket, Key: key }));
    },

    async putObject(key, body) {
      await s3.send(
        new PutObjectCommand({
          Bucket: env.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
        }),
      );
    },

    async startMultipart(key) {
      const r = await s3.send(new CreateMultipartUploadCommand({ Bucket: env.bucket, Key: key }));
      if (!r.UploadId) throw new Error("no upload id");
      return r.UploadId;
    },

    async openMultipartIds(prefix) {
      const r = await s3.send(
        new ListMultipartUploadsCommand({ Bucket: env.bucket, Prefix: prefix }),
      );
      return (r.Uploads ?? []).flatMap((u) => (u.UploadId ? [u.UploadId] : []));
    },

    async decrypt(_table, photoId) {
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT set_config('app.data_key', $1, true)", [env.dataKey]);
        const r = await admin.query(
          `SELECT public.decrypt_coord(gps_lat_enc) AS lat, public.decrypt_coord(gps_lng_enc) AS lng
             FROM public.photo_exif WHERE photo_id = $1`,
          [photoId],
        );
        return (r.rows[0] ?? { lat: null, lng: null }) as {
          lat: number | null;
          lng: number | null;
        };
      } finally {
        await admin.query("ROLLBACK");
      }
    },

    async close() {
      try {
        for (const b of babies) {
          await storage.deleteAllVersions(babyPrefix(b)).catch(() => undefined);
        }
        // `ai_batches` are not baby-scoped (items cascade from the batch, not the baby): remove the
        // batches this run's babies had items in, plus any empty fake-provider batch it created.
        await admin.query(
          `DELETE FROM public.ai_batches
            WHERE id IN (SELECT batch_id FROM public.ai_batch_items WHERE baby_id = ANY($1::uuid[]))
               OR (provider = 'fake' AND created_at >= $2
                   AND NOT EXISTS (SELECT 1 FROM public.ai_batch_items i WHERE i.batch_id = ai_batches.id))`,
          [babies, startedAt],
        );
        await admin.query("DELETE FROM public.audit_log WHERE baby_id = ANY($1::uuid[])", [babies]);
        await admin.query("DELETE FROM public.babies WHERE id = ANY($1::uuid[])", [babies]);
        await admin.query("DELETE FROM public.upload_sessions WHERE id = ANY($1::uuid[])", [
          sessions,
        ]);
        await admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [users]);
      } finally {
        await workerPool.end();
        await admin.end();
        s3.destroy();
      }
    },
  };
  return h;
}
