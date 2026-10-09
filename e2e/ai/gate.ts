/**
 * Step-6 gate (docs/plans/step-6.md 4.1/4.2): the PRD check "50 sample photos produce
 * schema-valid JSON; `ai_batches.cost_usd` recorded; free-tier photos are never submitted".
 *
 *   docker compose -f docker-compose.dev.yml up -d --build --wait
 *   pnpm e2e:ai-gate [--provider fake|real] [--count 50] [--free-count 5] [--timeout-min N] [--keep]
 *
 * `--provider fake` (default, keyless): restarts the worker with `VISION_PROVIDER=fake
 * AI_BATCH_FLUSH_MINUTES=0` and restores it (no overrides) when done. `--provider real`: needs
 * OPENAI_API_KEY in the git-ignored `.env.local` (refuses to run without it); restarts the worker
 * with `AI_BATCH_FLUSH_MINUTES=0`, prints the spend estimate before uploading, waits up to
 * `--timeout-min` (default 1440 = 24 h, polling every 5 min; fake: 15) for the provider, and also checks tokens, cost per photo and that
 * the provider's input file is gone.
 *
 * What it does: signs a fresh user in (OTP from Mailpit), creates a "Paid" and a "Free" baby, sets
 * Paid to plus with `migrate pnpm db:plan`, uploads `--count` synthetic JPEGs (1200-2000 px, half
 * with EXIF GPS, a few with parent notes) to Paid and `--free-count` to Free through the real API,
 * waits for ingest and the analysis derivatives, then forces `ai.flush` and polls `ai.poll`
 * through `docker compose exec worker ... run-job` until every item is terminal. Then asserts:
 * every paid photo is `ready` through the API and its stored `photo_ai.description` parses with
 * `aiDescriptionV1Schema`; batch cost is recorded and equals the items' sum; provider files are
 * deleted; reindex jobs were sent; the Free baby has no `ai_batch_items`, no `photo_ai`, and its
 * photos are in no request (fake: the provider's request dump is read from the worker container;
 * real: the submitted custom ids are the item photo ids); no GPS, notes, keys or image data in the
 * worker/api logs. Prints a table and exits 1 on any miss. The summary is also written to
 * `e2e/ai-gate/results.json` (git-ignored output dir) for CI artifacts.
 *
 * Real runs can outlive the timeout (the Batch API has a 24 h window). On timeout the gate prints
 * what it knows, keeps the babies and writes `e2e/ai-gate/state.json`; finish later without
 * re-uploading with `pnpm e2e:ai-gate --provider real --resume <batchId>` (the provider batch id
 * or the `ai_batches.id`). The worker is always restored to the stack default (the project `.env`
 * `VISION_PROVIDER`), never to what the caller's environment says.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { jpegWithExif } from "../../apps/worker/src/testing/exif-writer";
import { rng, sceneJpeg } from "../../apps/worker/src/testing/images";
import { aiDescriptionV1Schema } from "../../packages/shared/src/ai-description";
import { ApiClient, uniqueEmail } from "../helpers/api";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const DC = ["compose", "-f", "docker-compose.dev.yml"];
const OUT_DIR = path.join(ROOT, "e2e/ai-gate");
const PERF_BABY = "00000000-0000-4000-8000-000000000900";
const FAKE_DIR = "/tmp/littlelight-fake-vision";
let NOTE = `GATE-NOTE-${Math.random().toString(36).slice(2, 10)}`;
let PLACE = `GatePlace${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------

interface Args {
  provider: "fake" | "real";
  count: number;
  freeCount: number;
  timeoutMin: number;
  keep: boolean;
  /** `ai_batches.id` or provider batch id of a timed-out real run to finish. */
  resume?: string;
}

function parseArgs(argv: string[]): Args {
  const a = argv[0] === "--" ? argv.slice(1) : argv;
  const get = (k: string) => {
    const i = a.findIndex((x) => x === `--${k}` || x.startsWith(`--${k}=`));
    if (i < 0) return undefined;
    return a[i]?.includes("=") ? a[i]?.split("=")[1] : a[i + 1];
  };
  const provider = get("provider") ?? "fake";
  if (provider !== "fake" && provider !== "real") throw new Error("--provider is fake or real");
  const count = Number(get("count") ?? 50);
  const freeCount = Number(get("free-count") ?? 5);
  const timeoutMin = Number(get("timeout-min") ?? (provider === "real" ? 1440 : 15));
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("--count is 1..500");
  if (!Number.isInteger(freeCount) || freeCount < 1 || freeCount > 50) {
    throw new Error("--free-count is 1..50");
  }
  const resume = get("resume");
  if (resume !== undefined && !/^[A-Za-z0-9_-]{6,80}$/.test(resume)) {
    throw new Error("--resume needs a batch id (ai_batches.id or the provider batch id)");
  }
  return {
    provider,
    count,
    freeCount,
    timeoutMin,
    keep: a.includes("--keep"),
    ...(resume ? { resume } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  if (!ok) {
    failures.push(what);
    console.error(`  MISS: ${what}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function dc(args: string[], env: Record<string, string> = {}) {
  // The caller's VISION_PROVIDER must not leak into compose: the stack default comes from the
  // project .env (fake); a run that needs another provider passes it explicitly.
  const { VISION_PROVIDER: _inherited, ...inherited } = process.env;
  return sh("docker", [...DC, ...args], {
    cwd: ROOT,
    env: { ...inherited, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
}

async function psql(sql: string): Promise<string> {
  const { stdout } = await dc([
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "postgres",
    "-d",
    "littlelight",
    "-Atc",
    sql,
  ]);
  return stdout.trim();
}

/** Read a variable from the git-ignored .env.local (never printed). */
function envLocal(name: string): string | undefined {
  try {
    const text = readFileSync(path.join(ROOT, ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`).exec(line);
      if (m?.[1]) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env.local */
  }
  return undefined;
}

async function runJob(name: string, payload?: unknown): Promise<Record<string, unknown>> {
  const { stdout } = await dc([
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
  ]);
  // The worker's pretty logger shares stdout; the result is the one line that starts with {"job":
  const line = stdout.split("\n").find((l) => l.startsWith('{"job":'));
  if (!line) throw new Error(`run-job ${name} printed no result`);
  return (JSON.parse(line) as { result?: Record<string, unknown> }).result ?? {};
}

async function workerHealthy(): Promise<boolean> {
  const { stdout } = await dc(["ps", "worker", "--format", "json"]);
  const t = stdout.trim();
  const row = t.startsWith("[") ? JSON.parse(t)[0] : JSON.parse(t.split("\n")[0] ?? "{}");
  return row?.Health === "healthy";
}

async function restartWorker(env: Record<string, string>, expectLog: RegExp) {
  await dc(["up", "-d", "--no-deps", "worker"], env);
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const logs = (await dc(["logs", "--no-color", "worker"])).stdout;
    // only the newest container's lines matter: compose recreates the container, so its logs restart
    if (expectLog.test(logs) && /queues ready/.test(logs) && (await workerHealthy())) return;
    await sleep(2000);
  }
  throw new Error(`worker did not come up with ${expectLog}`);
}

// ---------------------------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------------------------

interface Sample {
  clientId: string;
  bytes: Buffer;
  sha: string;
  gps?: { lat: number; lng: number };
}

async function makeSamples(n: number, seedBase: number, withGps: boolean): Promise<Sample[]> {
  const r = rng(seedBase);
  const sizes: [number, number][] = [
    [1200, 900],
    [1600, 1200],
    [2000, 1500],
    [1200, 1600],
  ];
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const [w, h] = sizes[i % sizes.length] as [number, number];
    let bytes = await sceneJpeg(w, h, seedBase + i, 85);
    let gps: Sample["gps"];
    if (withGps && i % 2 === 0) {
      gps = { lat: Number((47 + r()).toFixed(4)), lng: Number((-122 - r()).toFixed(4)) };
      bytes = jpegWithExif(bytes, {
        make: "GateCam",
        model: "A1",
        dateTimeOriginal: `2026:04:${String(1 + (i % 27)).padStart(2, "0")} 10:${String(i % 60).padStart(2, "0")}:00`,
        gps,
      });
    }
    out.push({ clientId: `s${seedBase}-${i}`, bytes, sha: sha256(bytes), ...(gps ? { gps } : {}) });
  }
  return out;
}

interface RegFile {
  id: string;
  clientId: string | null;
  state: string;
  error: string | null;
  parts?: { partNumber: number; url: string }[];
  photo: { id: string } | null;
}
interface SessionBody {
  summary: {
    registered: number;
    completed: number;
    ingested: number;
    duplicates: number;
    failed: number;
  };
  files: RegFile[];
}

/** Upload through the real API and presigned multipart; resolves with the photo ids. */
async function uploadAll(api: ApiClient, babyId: string, samples: Sample[]): Promise<string[]> {
  const created = await api.call<{ id: string }>("POST", `/babies/${babyId}/uploads`, {});
  if (created.status !== 201) throw new Error(`create session answered ${created.status}`);
  const sid = created.body.id;
  const byClient = new Map(samples.map((s) => [s.clientId, s]));
  for (let i = 0; i < samples.length; i += 100) {
    const batch = samples.slice(i, i + 100);
    const reg = await api.call<{ files: RegFile[] }>("POST", `/uploads/${sid}/files`, {
      files: batch.map((s) => ({
        clientId: s.clientId,
        bytes: s.bytes.length,
        mime: "image/jpeg",
        clientSha256: s.sha,
      })),
    });
    if (reg.status !== 200) throw new Error(`register answered ${reg.status}`);
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < reg.body.files.length) {
          const f = reg.body.files[next++] as RegFile;
          if (f.state !== "registered") continue;
          const sample = byClient.get(f.clientId ?? "") as Sample;
          for (const part of f.parts ?? []) {
            const res = await fetch(part.url, {
              method: "PUT",
              body: new Uint8Array(sample.bytes),
            });
            check(res.ok, `part PUT answered ${res.status}`);
            await res.arrayBuffer();
          }
          const c = await api.call("POST", `/uploads/${sid}/files/${f.id}/complete`);
          check(c.status === 200, `complete answered ${c.status}`);
        }
      }),
    );
  }
  const end = Date.now() + 240_000;
  let body: SessionBody | undefined;
  while (Date.now() < end) {
    const r = await api.call<SessionBody>("GET", `/uploads/${sid}`);
    body = r.body;
    if (r.status === 200 && body.summary.registered === 0 && body.summary.completed === 0) break;
    await sleep(500);
  }
  if (!body) throw new Error("no upload session state");
  check(
    body.summary.ingested === samples.length,
    `ingested ${body.summary.ingested}/${samples.length}`,
  );
  check(body.summary.failed === 0, `${body.summary.failed} uploads failed`);
  return body.files.flatMap((f) => (f.photo ? [f.photo.id] : []));
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

interface BatchRow {
  id: string;
  provider_batch_id: string;
  status: string;
  cost_usd: string | null;
  input_tokens: string | null;
  cached_input_tokens: string | null;
  output_tokens: string | null;
  reasoning_tokens: string | null;
  image_tokens: string | null;
  files_deleted: boolean;
  provider_input_file_id: string | null;
  item_count: number;
  items_cost: string | null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  mkdirSync(OUT_DIR, { recursive: true });
  const real = args.provider === "real";
  const apiKey = real ? envLocal("OPENAI_API_KEY") : undefined;
  if (real && !apiKey) {
    console.error(
      "--provider real needs OPENAI_API_KEY in .env.local (git-ignored). Refusing to run without it.",
    );
    process.exit(2);
  }
  const estimate = args.count * 0.00014;
  if (real) {
    console.log(
      `real provider: ${args.count} photos on gpt-6-luna Batch API, expected spend about $${estimate.toFixed(4)} (budget cap $3/baby/month)`,
    );
  }

  console.log(`restarting the worker for the ${args.provider} provider ...`);
  try {
    await restartWorker(
      real
        ? { VISION_PROVIDER: "openai", AI_BATCH_FLUSH_MINUTES: "0" }
        : { VISION_PROVIDER: "fake", AI_BATCH_FLUSH_MINUTES: "0" },
      real ? /AI enabled: provider=openai vision=gpt-6-luna/ : /AI enabled: provider=fake vision=/,
    );
    await run(args, startedAt, apiKey);
  } finally {
    console.log("restoring the worker ...");
    await dc(["up", "-d", "--no-deps", "worker"], {}).catch((e) =>
      console.error(`restore failed: ${e}`),
    );
  }
  if (failures.length > 0) {
    console.error(`\nAI GATE FAILED (${failures.length} miss${failures.length === 1 ? "" : "es"})`);
    process.exit(1);
  }
  console.log("\nAI GATE PASSED");
}

const STATE_FILE = path.join(OUT_DIR, "state.json");

interface GateState {
  email: string;
  paid: string;
  free: string;
  paidIds: string[];
  freeIds: string[];
  coords: string[];
  note: string;
  place: string;
  count: number;
  freeCount: number;
  startedAt: string;
}

async function run(argsIn: Args, startedAtIn: Date, apiKey: string | undefined) {
  let args = argsIn;
  let startedAt = startedAtIn;
  const real = args.provider === "real";
  let api: ApiClient;
  let paid: string;
  let free: string;
  let paidIds: string[];
  let freeIds: string[];
  let coords: string[];

  if (args.resume) {
    // Finish a timed-out real run: no new upload, no new flush.
    const st = JSON.parse(readFileSync(STATE_FILE, "utf8")) as GateState;
    const owner = await psql(
      `select distinct i.baby_id from ai_batch_items i join ai_batches b on b.id=i.batch_id where b.id::text='${args.resume}' or b.provider_batch_id='${args.resume}'`,
    );
    if (owner !== st.paid) {
      throw new Error(`batch ${args.resume} does not belong to the paid baby of ${STATE_FILE}`);
    }
    args = { ...args, count: st.count, freeCount: st.freeCount };
    startedAt = new Date(st.startedAt);
    paid = st.paid;
    free = st.free;
    paidIds = st.paidIds;
    freeIds = st.freeIds;
    coords = st.coords;
    NOTE = st.note;
    PLACE = st.place;
    api = await ApiClient.create(st.email);
    console.log(`resuming: paid baby ${paid}, batch ${args.resume}`);
  } else {
    console.log(`generating ${args.count} + ${args.freeCount} synthetic photos ...`);
    const paidSamples = await makeSamples(args.count, 710_000, true);
    const freeSamples = await makeSamples(args.freeCount, 720_000, false);
    coords = paidSamples.flatMap((x) =>
      x.gps ? [x.gps.lat.toFixed(4), x.gps.lng.toFixed(4)] : [],
    );

    const email = uniqueEmail("aigate");
    api = await ApiClient.create(email);
    await api.onboard("AI Gate Parent");
    paid = await api.createBaby("Paid");
    free = await api.createBaby("Free");
    console.log(`paid baby ${paid}, free baby ${free}`);
    const plan = await dc(["run", "--rm", "migrate", "pnpm", "db:plan", paid, "plus"]);
    check(/plan free -> plus/.test(plan.stdout), "db:plan did not report free -> plus");
    check(
      (await psql(`select plan from babies where id='${paid}'`)) === "plus",
      "paid baby is not plus",
    );
    check(
      (await psql(`select plan from babies where id='${free}'`)) === "free",
      "free baby is not free",
    );

    console.log("uploading ...");
    const t0 = Date.now();
    paidIds = await uploadAll(api, paid, paidSamples);
    freeIds = await uploadAll(api, free, freeSamples);
    console.log(`uploaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    check(paidIds.length === args.count, `${paidIds.length} paid photos, expected ${args.count}`);
    check(
      freeIds.length === args.freeCount,
      `${freeIds.length} free photos, expected ${args.freeCount}`,
    );
    const state: GateState = {
      email,
      paid,
      free,
      paidIds,
      freeIds,
      coords,
      note: NOTE,
      place: PLACE,
      count: args.count,
      freeCount: args.freeCount,
      startedAt: startedAt.toISOString(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(state));

    // parent notes on some paid photos: they reach the model (real) but must never reach logs
    for (const id of paidIds.slice(0, 8)) {
      const r = await api.call("PATCH", `/photos/${id}/details`, {
        note: `${NOTE} first splash`,
        people: ["Grandma"],
        locationLabel: PLACE,
      });
      check(r.status === 200, `details PATCH answered ${r.status}`);
    }
  }

  if (!args.resume) {
    // every photo ingested with an analysis copy
    const wantAnalysis = args.count + args.freeCount;
    const analysisSql = `select count(*) from photos p where p.baby_id in ('${paid}','${free}') and p.status='ingested' and exists (select 1 from photo_derivatives d where d.photo_id=p.id and d.kind='analysis')`;
    for (const end = Date.now() + 120_000; Date.now() < end; ) {
      if (Number(await psql(analysisSql)) === wantAnalysis) break;
      await sleep(1000);
    }
    check(
      Number(await psql(analysisSql)) === wantAnalysis,
      `not all ${wantAnalysis} photos reached ingested + analysis`,
    );
  }

  // ---- flush and poll through the worker container
  const timeoutMs = args.timeoutMin * 60_000;
  if (!args.resume) {
    const flush = await runJob("ai.flush", { force: true });
    console.log(`ai.flush: ${JSON.stringify(flush)}`);
    const freeFlush = await runJob("ai.flush", { force: true, babyId: free });
    check(
      freeFlush.claimed === 0,
      `forced flush for the free baby claimed ${String(freeFlush.claimed)}`,
    );
  }

  const openSql = `select count(*) from ai_batch_items where baby_id='${paid}' and state in ('pending','submitted')`;
  const doneAt = Date.now() + timeoutMs;
  let polls = 0;
  let timedOut = false;
  for (;;) {
    const poll = await runJob("ai.poll");
    polls++;
    const open = Number(await psql(openSql));
    const ready = Number(
      await psql(
        `select count(*) from photo_ai a join photos p on p.id=a.photo_id where p.baby_id='${paid}'`,
      ),
    );
    console.log(
      `ai.poll #${polls}: ${JSON.stringify(poll)} open=${open} ready=${ready}/${args.count}`,
    );
    if (open === 0) break;
    if (Date.now() > doneAt) {
      check(false, `batch not terminal after ${args.timeoutMin} minutes (open items: ${open})`);
      timedOut = true;
      break;
    }
    // a failed first attempt is retried by the next flush; keep the pipeline moving
    await sleep(real ? 300_000 : 3_000);
    if (!real && polls % 4 === 0) await runJob("ai.flush", { force: true });
  }
  if (timedOut) {
    const open = await psql(
      `select coalesce(string_agg(distinct b.provider_batch_id || ' (' || b.status || ')', ', '), 'none') from ai_batches b join ai_batch_items i on i.batch_id=b.id where i.baby_id='${paid}' and i.state in ('pending','submitted')`,
    );
    console.log(`\nAI GATE (${args.provider}): TIMED OUT, nothing was lost`);
    console.log(`  open batches                 ${open}`);
    console.log(`  paid baby / free baby        ${paid} / ${free} (kept)`);
    console.log(
      `  finish later with            pnpm e2e:ai-gate --provider real --resume <batchId>   (state: ${STATE_FILE})`,
    );
    writeFileSync(
      path.join(OUT_DIR, "results.json"),
      JSON.stringify({ args, timedOut: true, failures }, null, 2),
    );
    await api.dispose();
    return;
  }
  // photos whose first attempt failed (none expected) get their second pass here
  for (let round = 0; round < 3; round++) {
    const missing = Number(
      await psql(
        `select count(*) from photos p where p.baby_id='${paid}' and not exists (select 1 from photo_ai a where a.photo_id=p.id)`,
      ),
    );
    if (missing === 0) break;
    await runJob("ai.flush", { force: true, babyId: paid });
    for (const end = Date.now() + (real ? timeoutMs : 60_000); Date.now() < end; ) {
      await runJob("ai.poll");
      if (Number(await psql(openSql)) === 0) break;
      await sleep(real ? 60_000 : 3_000);
    }
  }

  // ---- assertions
  console.log("checking results ...");
  // 1. API: ready + schema-valid for every paid photo
  let apiReady = 0;
  let apiValid = 0;
  let apiLeak = 0;
  for (const id of paidIds) {
    const r = await api.call<{ ai?: { status: string; description: unknown; raw: unknown } }>(
      "GET",
      `/photos/${id}`,
    );
    if (r.body.ai?.status === "ready") apiReady++;
    if (aiDescriptionV1Schema.safeParse(r.body.ai?.description).success) apiValid++;
    const text = JSON.stringify(r.body);
    if (/latitude|longitude|raw_json|analysis\.jpg/i.test(text) || text.includes(NOTE)) {
      // The photo's own `details.note` may carry the note; only `ai.*` must not.
      if (
        /latitude|longitude|raw_json|analysis\.jpg/i.test(text) ||
        JSON.stringify(r.body.ai ?? {}).includes(NOTE)
      )
        apiLeak++;
    }
  }
  check(apiReady === args.count, `API ai.status ready ${apiReady}/${args.count}`);
  check(apiValid === args.count, `API descriptions schema-valid ${apiValid}/${args.count}`);
  check(
    apiLeak === 0,
    `${apiLeak} API responses carry GPS/raw_json/analysis key or a note inside ai.*`,
  );

  // 2. DB rows
  const rows = JSON.parse(
    (await psql(
      `select coalesce(json_agg(json_build_object('id', a.photo_id, 'd', a.description, 'flags', a.sensitive_flags, 'model', a.model, 'pv', a.prompt_version, 'sv', a.schema_version)), '[]'::json) from photo_ai a join photos p on p.id=a.photo_id where p.baby_id='${paid}'`,
    )) || "[]",
  ) as { id: string; d: unknown; flags: string[]; model: string; pv: string; sv: string }[];
  const dbValid = rows.filter((r) => aiDescriptionV1Schema.safeParse(r.d).success).length;
  check(rows.length === args.count, `photo_ai rows ${rows.length}/${args.count}`);
  check(dbValid === args.count, `photo_ai.description schema-valid ${dbValid}/${args.count}`);
  check(
    rows.every((r) => r.pv === "v1" && r.sv === "v1"),
    "photo_ai versions are not v1/v1",
  );
  const sensitive = rows.filter((r) => r.flags.length > 0).length;
  const flagged = Number(
    await psql(`select count(*) from photos where baby_id='${paid}' and is_sensitive`),
  );
  check(
    flagged >= sensitive,
    `is_sensitive (${flagged}) does not follow the model's flags (${sensitive})`,
  );
  const readyStatus = Number(
    await psql(`select count(*) from photos where baby_id='${paid}' and status='ready'`),
  );
  check(readyStatus === args.count, `photos.status ready ${readyStatus}/${args.count}`);

  // 3. batches that carried the paid photos
  const batches = JSON.parse(
    (await psql(`select coalesce(json_agg(t), '[]'::json) from (
      select b.id, b.provider_batch_id, b.status, b.cost_usd::text, b.input_tokens::text, b.cached_input_tokens::text,
             b.output_tokens::text, b.reasoning_tokens::text, b.image_tokens::text,
             (b.files_deleted_at is not null) as files_deleted, b.provider_input_file_id,
             (select count(*)::int from ai_batch_items i where i.batch_id=b.id and i.baby_id='${paid}') as item_count,
             (select sum(i.cost_usd)::text from ai_batch_items i where i.batch_id=b.id) as items_cost
        from ai_batches b
       where exists (select 1 from ai_batch_items i where i.batch_id=b.id and i.baby_id='${paid}')
       order by b.created_at) t`)) || "[]",
  ) as BatchRow[];
  check(batches.length >= 1, "no ai_batches for the paid baby");
  check(
    batches.every((b) => b.status === "completed"),
    `batch statuses: ${batches.map((b) => b.status).join(",")}`,
  );
  check(
    batches.every((b) => Number(b.cost_usd) > 0),
    "an ai_batches.cost_usd is missing or 0",
  );
  check(
    batches.every((b) => Math.abs(Number(b.cost_usd) - Number(b.items_cost ?? 0)) < 2e-6),
    "ai_batches.cost_usd differs from the sum of its items",
  );
  check(
    batches.every((b) => Number(b.input_tokens) > 0 && Number(b.output_tokens) > 0),
    "batch token totals are 0",
  );
  check(
    batches.every((b) => b.files_deleted),
    "provider files_deleted_at is not set on every batch",
  );
  const totalItems = batches.reduce((s, b) => s + b.item_count, 0);
  const succeeded = Number(
    await psql(`select count(*) from ai_batch_items where baby_id='${paid}' and state='succeeded'`),
  );
  check(
    succeeded === args.count,
    `succeeded items ${succeeded}/${args.count} (total ${totalItems})`,
  );
  const totalCost = batches.reduce((s, b) => s + Number(b.cost_usd), 0);
  if (!real) {
    check(
      Math.abs(totalCost - args.count * 0.0001385) < 3e-5 * Math.max(1, batches.length),
      `fake cost ${totalCost} != ${args.count} x 0.0001385`,
    );
  }
  const itemRows = (
    await psql(
      `select avg(input_tokens), avg(cached_input_tokens), avg(output_tokens), avg(reasoning_tokens), avg(image_tokens), avg(cost_usd) from ai_batch_items where baby_id='${paid}' and state='succeeded'`,
    )
  ).split("|");

  // 4. reindex jobs sent (one per photo; the exclusive queue keeps one per photo)
  const reindex = Number(
    await psql(
      `select count(*) from pgboss.job where name='photo.reindex' and data->>'reason'='ai' and data->>'babyId'='${paid}'`,
    ),
  );
  check(reindex >= args.count, `photo.reindex jobs (reason ai) ${reindex}/${args.count}`);

  // 5. free-tier photos are never submitted
  const freeItems = Number(
    await psql(`select count(*) from ai_batch_items where baby_id='${free}'`),
  );
  const freeAi = Number(
    await psql(
      `select count(*) from photo_ai a join photos p on p.id=a.photo_id where p.baby_id='${free}'`,
    ),
  );
  const freeStatuses = await psql(`select distinct status from photos where baby_id='${free}'`);
  const anyFreeItems = Number(
    await psql(
      `select count(*) from ai_batch_items i join babies b on b.id=i.baby_id where b.plan='free'`,
    ),
  );
  const anyDisabledAi = Number(
    await psql(
      `select count(*) from photo_ai a join photos p on p.id=a.photo_id join babies b on b.id=p.baby_id where not baby_ai_enabled(b.id) and b.deleted_at is null`,
    ),
  );
  const perfItems = Number(
    await psql(`select count(*) from ai_batch_items where baby_id='${PERF_BABY}'`),
  );
  check(freeItems === 0, `free baby has ${freeItems} ai_batch_items`);
  check(freeAi === 0, `free baby has ${freeAi} photo_ai rows`);
  check(freeStatuses === "ingested", `free photo statuses: ${freeStatuses}`);
  check(anyFreeItems === 0, `${anyFreeItems} ai_batch_items belong to free babies`);
  check(anyDisabledAi === 0, `${anyDisabledAi} photo_ai rows belong to babies without AI`);
  check(perfItems === 0, `perf baby has ${perfItems} items`);
  const submittedIds = (
    await psql(`select photo_id from ai_batch_items where baby_id='${paid}' order by photo_id`)
  )
    .split("\n")
    .filter(Boolean);
  check(
    paidIds.every((id) => submittedIds.includes(id)),
    "a paid photo is missing from the submitted custom ids",
  );
  check(
    freeIds.every((id) => !submittedIds.includes(id)),
    "a free photo id is among the submitted custom ids",
  );

  let dumpInfo = "n/a (real provider: the item photo ids are the submitted custom_ids)";
  if (!real) {
    let paidIn = 0;
    let freeIn = 0;
    let gpsHits = 0;
    let noteHits = 0;
    for (const b of batches) {
      const dump = (
        await dc(["exec", "-T", "worker", "cat", `${FAKE_DIR}/${b.provider_batch_id}.jsonl`])
      ).stdout;
      paidIn += paidIds.filter((id) => dump.includes(id)).length;
      freeIn += freeIds.filter((id) => dump.includes(id)).length;
      gpsHits += (dump.match(/latitude|longitude|gps/gi) ?? []).length;
      noteHits += dump.split(NOTE).length - 1;
    }
    check(paidIn === args.count, `request dump holds ${paidIn}/${args.count} paid ids`);
    check(freeIn === 0, `request dump holds ${freeIn} free ids`);
    check(gpsHits === 0, `request dump has ${gpsHits} latitude/longitude/gps matches`);
    check(noteHits === 0, `request dump contains the parent note ${noteHits} times`);
    dumpInfo = `${paidIn} paid ids, ${freeIn} free ids, ${gpsHits} gps matches`;
  }

  // 6. logs: no GPS, notes, keys, signed URLs or image data
  const since = startedAt.toISOString();
  const logs = (await dc(["logs", "--no-color", "--since", since, "worker", "api"])).stdout;
  const leaks: string[] = [];
  if (logs.includes(NOTE)) leaks.push("parent note");
  if (logs.includes(PLACE)) leaks.push("location label");
  if (/latitude|longitude/i.test(logs)) leaks.push("latitude/longitude");
  if (/sk-[A-Za-z0-9]{8}/.test(logs)) leaks.push("api key");
  if (/X-Amz-Signature/i.test(logs)) leaks.push("signed url");
  if (/data:image|base64,/.test(logs)) leaks.push("image data");
  if (coords.some((c) => logs.includes(c))) leaks.push("coordinate value");
  check(leaks.length === 0, `logs leak: ${leaks.join(", ")}`);

  // 7. real provider extras
  const extra: [string, string][] = [];
  if (real) {
    const per = {
      input: Number(itemRows[0]),
      cached: Number(itemRows[1]),
      output: Number(itemRows[2]),
      reasoning: Number(itemRows[3]),
      image: Number(itemRows[4]),
      cost: Number(itemRows[5]),
    };
    extra.push([
      "tokens_per_photo",
      `in ${per.input.toFixed(0)} (cached ${per.cached.toFixed(0)}, image ${per.image.toFixed(0)}) out ${per.output.toFixed(0)} reasoning ${per.reasoning.toFixed(0)}`,
    ]);
    extra.push(["cost_per_photo", `$${per.cost.toFixed(6)}`]);
    check(per.reasoning === 0, `reasoning tokens per photo ${per.reasoning}, expected 0`);
    check(per.cost <= 0.001, `cost per photo $${per.cost} exceeds $0.001`);
    for (const b of batches) {
      if (!b.provider_input_file_id || !apiKey) continue;
      const res = await fetch(`https://api.openai.com/v1/files/${b.provider_input_file_id}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      check(
        res.status === 404,
        `provider input file ${b.provider_input_file_id} answered ${res.status}, expected 404`,
      );
    }
    const sample = rows[0]?.d as { caption?: string } | undefined;
    extra.push(["sample_caption", sample?.caption ?? "n/a"]);
  }

  // ---- table
  const table: [string, string][] = [
    ["provider", args.provider],
    ["ready (API)", `${apiReady}/${args.count}`],
    ["schema-valid (API)", `${apiValid}/${args.count}`],
    ["schema-valid (DB rows)", `${dbValid}/${args.count}`],
    [
      "batches (all completed)",
      `${batches.length}: ${batches.map((b) => `${b.status}/${b.item_count} items`).join(", ")}`,
    ],
    [
      "cost_usd (batches)",
      `$${totalCost.toFixed(6)} (items sum $${batches.reduce((s, b) => s + Number(b.items_cost ?? 0), 0).toFixed(6)})`,
    ],
    [
      "tokens in/out (batches)",
      `${batches.reduce((s, b) => s + Number(b.input_tokens), 0)} / ${batches.reduce((s, b) => s + Number(b.output_tokens), 0)}`,
    ],
    ["files_deleted_at set", `${batches.filter((b) => b.files_deleted).length}/${batches.length}`],
    ["reindex jobs (ai)", `${reindex}`],
    ["sensitive flagged", `${sensitive} (photos.is_sensitive ${flagged})`],
    ["free baby: items / photo_ai", `${freeItems} / ${freeAi}; statuses ${freeStatuses}`],
    ["free-tier items anywhere", `${anyFreeItems}`],
    ["perf baby items", `${perfItems}`],
    ["request dump", dumpInfo],
    ["log leaks", leaks.length ? leaks.join(", ") : "none"],
    ...extra,
  ];
  console.log(`\nAI GATE (${args.provider}, ${args.count} paid + ${args.freeCount} free photos)`);
  for (const [k, v] of table) console.log(`  ${k.padEnd(28)} ${v}`);
  writeFileSync(
    path.join(OUT_DIR, "results.json"),
    JSON.stringify({ args, table: Object.fromEntries(table), failures }, null, 2),
  );

  if (!args.keep) {
    for (const id of [paid, free]) {
      const r = await api.call("DELETE", `/babies/${id}`);
      if (r.status !== 204) console.warn(`could not trash baby ${id}: ${r.status}`);
    }
  }
  await api.dispose();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
