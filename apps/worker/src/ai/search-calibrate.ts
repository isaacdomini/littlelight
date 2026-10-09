/**
 * Relevance-floor calibration (`SEARCH_MIN_SIMILARITY`; see `defaultMinSimilarity` in
 * apps/api/src/search/hybrid.ts). Lives in the worker because it reads search documents, which
 * never appear in the API code (CI ai-hygiene).
 *
 *   pnpm search:calibrate [--provider fake|real] [--max-usd 0.01] [--baby <id>]
 *
 * Measures, for one embedding model, how similar UNRELATED queries get to the documents they share
 * no word with (the noise the floor must cut) versus how similar the golden queries and ~20
 * paraphrases (no shared word with their target) get to their TARGET document (the signal the
 * floor must keep), then recommends a threshold.
 *
 * Data: the Golden search seed (`pnpm search:seed`; the gate trashes it unless `--keep`), read with
 * the local superuser (`CALIBRATE_DATABASE_URL`, default postgres://postgres:dev@localhost:5432/
 * littlelight; local hosts only). Stored vectors are reused when they were written by the same
 * embedder (`embed_model` = the provider's tag), otherwise every document is embedded too.
 *
 * `--provider real` uses `createEmbedder` with `VISION_PROVIDER=openai` and the `OPENAI_API_KEY`
 * of the environment: it prints the estimated spend FIRST and refuses when it exceeds
 * `--max-usd` (default $0.01; ~110 queries cost ~$0.00002, re-embedding 2,000 documents ~$0.007).
 * Prints numbers only: never a document, a note or the key.
 */

import { pathToFileURL } from "node:url";
import {
  costUsd,
  createEmbedder,
  createFakeEmbedder,
  type Embedder,
  embedModelTag,
  planFakeToolCalls,
} from "@littlelight/ai";
import { EMBED_DIMS, SEARCH_SEED_IDS } from "@littlelight/shared";
import pg from "pg";
import { GOLDEN_TARGETS } from "./search-content";

/** Queries with nothing to do with a baby album (the floor must reject what they find). */
export const UNRELATED_QUERIES = [
  "zebra submarine",
  "quantum accountant",
  "tax return spreadsheet",
  "nuclear reactor maintenance",
  "stock market crash",
  "medieval castle siege",
  "football world cup final",
  "spaceship engine repair",
  "corporate merger agreement",
  "volcano lava flow",
  "parliament election results",
  "cryptocurrency mining rig",
  "submarine sonar",
  "oil refinery",
  "hockey playoff game",
  "chess tournament",
  "jet engine turbine",
  "arctic expedition",
  "concert stage lighting",
  "car engine oil change",
  "insurance claim form",
  "dentist drill",
  "printer toner cartridge",
  "mountain climbing gear",
  "laboratory microscope",
  "airport security line",
  "server rack cables",
  "construction crane",
  "museum dinosaur skeleton",
  "spreadsheet pivot table",
] as const;

/** Paraphrases of golden targets that avoid the target's planted signature word. */
export const PARAPHRASES: ReadonlyArray<{ index: number; query: string }> = [
  { index: 0, query: "a toy that flies on a string in the wind" },
  { index: 1, query: "building a little tower out of wet sand" },
  { index: 2, query: "a big orange squash" },
  { index: 3, query: "blowing into a small mouth instrument" },
  { index: 4, query: "a figure made of snow with a carrot nose" },
  { index: 5, query: "hitting colorful wooden bars that make music" },
  { index: 6, query: "riding a little three-wheeled bike" },
  { index: 8, query: "eating a big green striped fruit" },
  { index: 9, query: "a tall tower that guides ships at sea" },
  { index: 10, query: "riding painted horses that go round and round" },
  { index: 12, query: "strumming a tiny four-string guitar" },
  { index: 14, query: "holding a floating party decoration" },
  { index: 16, query: "sitting on a big farm vehicle" },
  { index: 17, query: "petting a fluffy animal with a long neck" },
  { index: 18, query: "a tall yellow flower taller than her" },
  { index: 19, query: "a red emergency vehicle with a ladder" },
  { index: 21, query: "playing with a young dog" },
  { index: 22, query: "cuddling a baby cat" },
  { index: 33, query: "roasting marshmallows by the fire outdoors" },
  { index: 39, query: "a small boat with a white sail on the water" },
];

const STOP = new Set(
  "a an and are as at be but by for from her his in is it its me my of on or our she show the their them this to was with you your photo photos picture pictures".split(
    " ",
  ),
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** True when the document contains one of the query's content words (a lexical hit). */
function shares(docLower: string, query: string): boolean {
  return words(query).some((w) => new RegExp(`\\b${w}`, "u").test(docLower));
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function pct(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  ] as number;
}

const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "-");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function adminUrl(): string {
  const url =
    process.env.CALIBRATE_DATABASE_URL ?? "postgres://postgres:dev@localhost:5432/littlelight";
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) {
    throw new Error("search:calibrate only reads a local database");
  }
  return url;
}

async function embedAll(embedder: Embedder, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 256) {
    out.push(...(await embedder.embed(texts.slice(i, i + 256))).vectors);
  }
  return out;
}

export async function main(): Promise<void> {
  const provider = arg("provider") ?? "fake";
  if (provider !== "fake" && provider !== "real")
    throw new Error("--provider must be fake or real");
  const maxUsd = Number(arg("max-usd") ?? 0.01);
  const babyId = arg("baby") ?? SEARCH_SEED_IDS.baby;
  if (process.env.NODE_ENV === "production") throw new Error("search:calibrate refuses production");

  const embedder: Embedder =
    provider === "fake"
      ? createFakeEmbedder({ dims: EMBED_DIMS })
      : createEmbedder({ ...process.env, VISION_PROVIDER: "openai" });
  const tag = embedModelTag(embedder);
  const priceModel = provider === "fake" ? "text-embedding-3-small" : embedder.model;

  const db = new pg.Client({ connectionString: adminUrl() });
  await db.connect();
  let docs: { id: string; text: string; vector: string | null; model: string | null }[];
  try {
    docs = (
      await db.query<{ id: string; text: string; vector: string | null; model: string | null }>(
        `SELECT photo_id AS id, search_text AS text, embedding::text AS vector, embed_model AS model
           FROM public.photo_search WHERE baby_id = $1 ORDER BY photo_id`,
        [babyId],
      )
    ).rows;
  } finally {
    await db.end();
  }
  if (docs.length === 0)
    throw new Error("no photo_search rows for the baby (run pnpm search:seed)");

  const golden = GOLDEN_TARGETS.filter((g) => g.kind !== "fact");
  const today = new Date().toISOString().slice(0, 10);
  const goldenQueries = golden.map((g) => {
    const call = planFakeToolCalls(g.query, { today, birthDate: "2025-03-15" })[0];
    const q = (call?.arguments.query as string | null | undefined) ?? g.query;
    return { index: g.index, query: q };
  });
  const queries = [
    ...UNRELATED_QUERIES.map((q) => ({ kind: "unrelated" as const, index: -1, query: q })),
    ...goldenQueries.map((g) => ({ kind: "golden" as const, ...g })),
    ...PARAPHRASES.map((p) => ({ kind: "paraphrase" as const, ...p })),
  ];
  const reuse = docs.every((d) => d.model === tag && d.vector !== null);
  const tokens =
    queries.reduce((n, q) => n + Math.ceil(q.query.length / 4), 0) +
    (reuse ? 0 : docs.reduce((n, d) => n + Math.ceil(d.text.length / 4), 0));
  const estimate = costUsd(priceModel, "standard", {
    inputTokens: tokens,
    cachedInputTokens: 0,
    outputTokens: 0,
  });
  console.log(
    `provider=${provider} model=${tag} docs=${docs.length} (${reuse ? "stored vectors reused" : "documents re-embedded"}) queries=${queries.length}`,
  );
  console.log(
    `estimated spend: ~${tokens} tokens = $${estimate.toFixed(6)}${provider === "fake" ? " (fake: nothing is billed)" : ""}; cap $${maxUsd}`,
  );
  if (provider === "real" && estimate > maxUsd) {
    throw new Error(
      `estimated spend $${estimate.toFixed(6)} exceeds --max-usd ${maxUsd}; refusing`,
    );
  }

  const docVectors = reuse
    ? docs.map((d) => (d.vector as string).slice(1, -1).split(",").map(Number))
    : await embedAll(
        embedder,
        docs.map((d) => d.text),
      );
  const qVectors = await embedAll(
    embedder,
    queries.map((q) => q.query),
  );
  const docLower = docs.map((d) => d.text.toLowerCase());
  const target = (i: number) => SEARCH_SEED_IDS.photo(i);
  const docIndex = new Map(docs.map((d, i) => [d.id, i]));

  const noise: number[] = [];
  const signal: { kind: string; index: number; sim: number; rank: number; lexical: boolean }[] = [];
  queries.forEach((q, qi) => {
    const qv = qVectors[qi] as number[];
    const sims = docVectors.map((v) => cosine(qv, v));
    if (q.kind === "unrelated") {
      let m = Number.NEGATIVE_INFINITY;
      sims.forEach((s, di) => {
        if (!shares(docLower[di] as string, q.query) && s > m) m = s;
      });
      noise.push(m);
      return;
    }
    const di = docIndex.get(target(q.index));
    if (di === undefined) return;
    const sim = sims[di] as number;
    signal.push({
      kind: q.kind,
      index: q.index,
      sim,
      rank: sims.filter((s) => s > sim).length + 1,
      lexical: shares(docLower[di] as string, q.query),
    });
  });

  console.log(
    "\nunrelated probes: best vector-only similarity (a probe finds nothing when this is below the floor)",
  );
  UNRELATED_QUERIES.forEach((q, i) => {
    console.log(`  ${f3(noise[i] as number)}  ${JSON.stringify(q)}`);
  });
  noise.sort((a, b) => a - b);
  const vecOnly = signal
    .filter((s) => !s.lexical)
    .map((s) => s.sim)
    .sort((a, b) => a - b);
  const allSig = signal.map((s) => s.sim).sort((a, b) => a - b);
  console.log("\nunrelated queries: best vector-only similarity per query (the noise to cut)");
  console.log(
    `  n=${noise.length} p50 ${f3(pct(noise, 50))} p90 ${f3(pct(noise, 90))} p95 ${f3(pct(noise, 95))} max ${f3(noise.at(-1) ?? Number.NaN)}`,
  );
  for (const kind of ["golden", "paraphrase"]) {
    const s = signal.filter((x) => x.kind === kind);
    const sims = s.map((x) => x.sim).sort((a, b) => a - b);
    console.log(
      `${kind} targets: n=${s.length} similarity min ${f3(sims[0] ?? Number.NaN)} p10 ${f3(pct(sims, 10))} p50 ${f3(pct(sims, 50))}; lexical hit ${s.filter((x) => x.lexical).length}/${s.length}; target in top 5 by vector ${s.filter((x) => x.rank <= 5).length}/${s.length}`,
    );
  }
  console.log("\nper target (kind index similarity rank lexical):");
  for (const s of signal) {
    console.log(
      `  ${s.kind.padEnd(10)} ${String(s.index).padStart(2)} ${f3(s.sim)} #${s.rank} ${s.lexical ? "lexical" : "vector-only"}`,
    );
  }

  const noiseMax = noise.at(-1) ?? 0;
  const keepLow = pct(vecOnly.length ? vecOnly : allSig, 10);
  let recommended: number;
  let note: string;
  if (Number.isFinite(keepLow) && keepLow > noiseMax) {
    recommended = Math.round(((noiseMax + keepLow) / 2) * 100) / 100;
    note =
      "midpoint between the worst unrelated match and the 10th percentile of vector-only targets";
  } else {
    recommended = Math.ceil((noiseMax + 0.01) * 100) / 100;
    note =
      "distributions overlap: cut all measured noise; vector-only targets below it are lost unless a lexical leg finds them";
  }
  const lost = vecOnly.filter((s) => s < recommended).length;
  console.log(
    `\nrecommended SEARCH_MIN_SIMILARITY for ${tag}: ${recommended.toFixed(2)} (${note}); vector-only targets below it: ${lost}/${vecOnly.length}; current API defaults: 0.30 text-embedding-3-small, 0.60 fake (apps/api/src/search/hybrid.ts defaultMinSimilarity)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`search:calibrate failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
