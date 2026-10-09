/**
 * Hybrid search benchmark (docs/plans/step-7.md 2.8 "bench.ts", 4.2; PRD "Non-functional
 * requirements → Performance": hybrid search < 300 ms DB time at 50k photos/baby).
 *
 *   pnpm search:bench [--baby <id>] [--runs 200] [--as <userId>]
 *
 * Host-run, dev only: connects as `littlelight_api` (`BENCH_DATABASE_URL`, else `DATABASE_URL`,
 * else `postgres://littlelight_api:dev@localhost:5432/littlelight`) and refuses any host other
 * than localhost. Every query runs exactly like the API's: `runAs(authenticated)` with the demo
 * mom's claims (RLS and `search_baby_ids()` apply), the same `hybridSearch` SQL, the same
 * indexes. Query vectors come from the deterministic fake embedder: real embeddings change
 * recall, not query cost. Runs a fixed mix (10 % filters only, 40 % text, 30 % text + date/age,
 * 20 % text + person/milestone/tag), prints p50/p95/max `tookMs` per class and the candidate
 * counts, then `EXPLAIN (ANALYZE, BUFFERS)` of one HNSW-path query (expects `Index Scan using
 * photo_search_embedding_idx`) and one full-text query (expects `photo_search_tsv_idx`).
 * Prints numbers and plans only, never a document.
 */

import { pathToFileURL } from "node:url";
import { createFakeEmbedder } from "@littlelight/ai";
import {
  claimsToSql,
  DEMO_IDS,
  EMBED_DIMS,
  SEARCH_DEFAULTS,
  SEARCH_SEED_IDS,
} from "@littlelight/shared";
import pg from "pg";
import { runAs } from "../plugins/db";
import { searchFacets } from "./facets";
import {
  candidateCall,
  filterSql,
  type HybridInput,
  hnswVectorSql,
  hybridSearch,
  setHnswLocals,
  vectorLiteral,
} from "./hybrid";

const QUERIES = [
  "bath",
  "splashing in the bath with a duck",
  "beach",
  "sleeping in the crib",
  "birthday cake",
  "yellow sundress",
  "park swing",
  "snow",
  "playing with the dog",
  "first steps on the grass",
  "crawling on the rug",
  "eating avocado",
];

type BenchClass = "filters" | "text" | "text+range" | "text+facet";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
}

/** Deterministic PRNG (mulberry32), so every run issues the same queries. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Superuser URL for auto_explain (`LOAD` needs it); local only, like `databaseUrl`. */
function adminUrl(): string {
  const url =
    process.env.BENCH_ADMIN_DATABASE_URL ?? "postgres://postgres:dev@localhost:5432/littlelight";
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) {
    throw new Error("search:bench only runs against a local database");
  }
  return url;
}

/**
 * Plan lines of the statements nested in `call` (a candidate function), via auto_explain with
 * `log_nested_statements`, run as `authenticated` under `claimsJson`. Nothing is written
 * (rolled back).
 */
async function explainNested(
  claimsJson: string,
  call: { text: string; values: unknown[] },
): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl() });
  const lines: string[] = [];
  client.on("notice", (n) => {
    if (typeof n.message === "string") lines.push(...n.message.split("\n"));
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOAD 'auto_explain'");
    await client.query(
      `SELECT set_config('auto_explain.log_min_duration', '0', true),
              set_config('auto_explain.log_analyze', 'on', true),
              set_config('auto_explain.log_buffers', 'on', true),
              set_config('auto_explain.log_nested_statements', 'on', true),
              set_config('auto_explain.log_level', 'notice', true),
              set_config('client_min_messages', 'notice', true)`,
    );
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claimsJson]);
    await client.query(call.text, call.values);
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
  // Keep only the plan blocks of the candidate query itself; never the parameters (claims).
  const blocks: string[][] = [];
  for (const l of lines) {
    if (l.startsWith("duration:")) blocks.push([]);
    if (!l.startsWith("Query Parameters:")) blocks.at(-1)?.push(l);
  }
  return blocks.filter((b) => b.some((l) => l.includes("photo_search s"))).flat();
}

/** Plan line without pgvector literals (1024 numbers each). */
function elide(line: string): string {
  return line.replace(/'\[[-0-9.,e]+\]'/g, "'[…]'");
}

function databaseUrl(): string {
  const url =
    process.env.BENCH_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://littlelight_api:dev@localhost:5432/littlelight";
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("search:bench only runs against a local database");
  }
  if (process.env.NODE_ENV === "production") throw new Error("search:bench refuses production");
  return url;
}

export async function main(): Promise<void> {
  const babyId = arg("baby") ?? SEARCH_SEED_IDS.baby;
  const runs = Number(arg("runs") ?? 200);
  const userId = arg("as") ?? DEMO_IDS.users.mom;
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 2 });
  const claimsJson = claimsToSql({
    sub: userId,
    role: "authenticated",
    session_id: "00000000-0000-4000-8000-00000000be0c",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const as = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    runAs(pool, "authenticated", { claimsJson }, fn);
  const embedder = createFakeEmbedder({ dims: EMBED_DIMS });
  const opts = {
    embedder,
    exactMax: Number(process.env.SEARCH_EXACT_MAX ?? SEARCH_DEFAULTS.SEARCH_EXACT_MAX),
    efSearch: Number(process.env.SEARCH_HNSW_EF_SEARCH ?? SEARCH_DEFAULTS.SEARCH_HNSW_EF_SEARCH),
  };
  try {
    const { indexed, facets } = await as(async (c) => {
      const n = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.photo_search WHERE baby_id = $1",
        [babyId],
      );
      return { indexed: n.rows[0]?.n ?? 0, facets: await searchFacets(c, babyId, "UTC") };
    });
    if (indexed === 0) {
      throw new Error(
        "no photo_search rows visible for this baby and user (run pnpm search:seed; is the baby plus?)",
      );
    }
    console.log(`baby ${babyId}: ${indexed} indexed photos visible to the user; ${runs} runs`);

    const random = rng(7);
    const pick = <T>(xs: readonly T[]): T | undefined =>
      xs.length ? xs[Math.floor(random() * xs.length)] : undefined;
    const times: Record<BenchClass, number[]> = {
      filters: [],
      text: [],
      "text+range": [],
      "text+facet": [],
    };
    const candidates: Record<BenchClass, number[]> = {
      filters: [],
      text: [],
      "text+range": [],
      "text+facet": [],
    };
    const paths = new Map<string, number>();
    for (let i = 0; i < runs; i++) {
      const roll = random();
      const cls: BenchClass =
        roll < 0.1 ? "filters" : roll < 0.5 ? "text" : roll < 0.8 ? "text+range" : "text+facet";
      const input: HybridInput = {
        babyId,
        query: cls === "filters" ? null : (pick(QUERIES) ?? "bath"),
        dateFrom: null,
        dateTo: null,
        ageFromDays: null,
        ageToDays: null,
        milestoneIds: [],
        people: [],
        tags: [],
        place: null,
        limit: 12,
        timezone: "UTC",
      };
      if (cls === "filters" || cls === "text+range") {
        const from = Math.floor(random() * 600);
        input.ageFromDays = from;
        input.ageToDays = from + 30 + Math.floor(random() * 60);
      }
      if (cls === "text+facet") {
        const which = random();
        if (which < 0.4 && facets.people.length) input.people = [pick(facets.people)?.name ?? ""];
        else if (which < 0.7 && facets.milestones.length)
          input.milestoneIds = [pick(facets.milestones)?.id ?? ""];
        else if (facets.tags.length) input.tags = [pick(facets.tags)?.tag ?? ""];
      }
      const r = await as((c) => hybridSearch(c, input, opts));
      times[cls].push(r.tookMs);
      candidates[cls].push(r.candidates);
      paths.set(r.path, (paths.get(r.path) ?? 0) + 1);
    }

    console.log("\nclass        runs   p50 ms   p95 ms   max ms   candidates p50");
    for (const cls of Object.keys(times) as BenchClass[]) {
      const t = times[cls];
      console.log(
        `${cls.padEnd(12)} ${String(t.length).padStart(4)} ${String(pct(t, 50)).padStart(8)} ${String(pct(t, 95)).padStart(8)} ${String(Math.max(0, ...t)).padStart(8)} ${String(pct(candidates[cls], 50)).padStart(16)}`,
      );
    }
    const all = Object.values(times).flat();
    console.log(
      `all          ${String(all.length).padStart(4)} ${String(pct(all, 50)).padStart(8)} ${String(pct(all, 95)).padStart(8)} ${String(Math.max(0, ...all)).padStart(8)}`,
    );
    console.log(`paths: ${[...paths.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);

    // EXPLAIN of the two index paths (no filters beyond the baby: the largest candidate set).
    const base: HybridInput = {
      babyId,
      query: "bath",
      dateFrom: null,
      dateTo: null,
      ageFromDays: null,
      ageToDays: null,
      milestoneIds: [],
      people: [],
      tags: [],
      place: null,
      limit: 12,
      timezone: "UTC",
    };
    const { where, values } = filterSql(base);
    const q = `$${values.length + 1}`;
    const qv = vectorLiteral((await embedder.embed(["bath"])).vectors[0] ?? []);
    const hnswPlan = await as(async (c) => {
      await setHnswLocals(c, opts.efSearch);
      const { rows } = await c.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE, BUFFERS) ${hnswVectorSql(where, q, 50)}`,
        [...values, qv],
      );
      return rows.map((r) => r["QUERY PLAN"]);
    });
    // The full-text leg runs inside a SECURITY DEFINER function: its plan is a nested statement,
    // captured with auto_explain (notices to this client) on a superuser connection that then
    // switches to `authenticated` with the same claims.
    const textPlan = await explainNested(claimsJson, candidateCall("text", base, 50));
    console.log("\n-- HNSW path --");
    for (const l of hnswPlan) console.log(elide(l));
    console.log("\n-- full-text path (photo_search_text_candidates body, via auto_explain) --");
    for (const l of textPlan) console.log(elide(l));
    const hnswOk = hnswPlan.some((l) => l.includes("photo_search_embedding_idx"));
    const textOk = textPlan.some((l) => l.includes("photo_search_tsv_idx"));
    console.log(
      `\nindex use: embedding_idx=${hnswOk ? "yes" : "NO"} tsv_idx=${textOk ? "yes" : "NO"}; p95 all=${pct(all, 50) >= 0 ? pct(all, 95) : 0} ms (target < 300 ms at 50k)`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`search:bench failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
