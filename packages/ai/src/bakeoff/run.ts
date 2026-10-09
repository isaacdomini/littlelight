/**
 * Vision bake-off skeleton (PRD "LLM selection and cost" → "Bake-off before launch";
 * docs/plans/step-6.md 2.5, D10: no Gemini adapter).
 *
 *   pnpm bakeoff -- --photos <dir> --providers openai,anthropic --mode batch|realtime \
 *     [--labels labels.json] [--limit 200] [--out report.md] [--poll-seconds 30] [--timeout-min 360] \
 *     [--openai-model gpt-6-luna] [--anthropic-model claude-haiku-5-5]
 *
 * Reads JPEG/WebP files that are ALREADY analysis copies (long edge ≤ 768 px, ≤ 400 KB; it never
 * resizes, the ingest pipeline does) and refuses the run otherwise. Optional labels:
 * `{ "<file>": { "sensitive": ["bath"], "milestone": "first steps", "context": {...} } }`.
 * Runs each provider through the same `VisionDescriber` interface the worker uses, validates
 * every output with `validateDescription`, deletes provider batch artifacts afterwards, and
 * prints a table per metric × provider: schema validity, refusals, sensitive-content
 * recall/precision, milestone hit rate, mean tokens (input/cached/output/image/reasoning),
 * measured cost per photo and per 1,000, wall time.
 *
 * Keys come from the shell env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), e.g.
 * `set -a; . ./.env.local; set +a`. `--providers fake` runs offline (tests, CI).
 * Relative paths resolve against the directory pnpm was invoked from (`INIT_CWD`), then the
 * workspace root.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AI_PROMPT_VERSION, AI_SCHEMA_VERSION } from "@littlelight/shared";
import { z } from "zod";
import { isTerminalBatchState } from "../batch-state";
import {
  ANALYSIS_LONG_EDGE_PX,
  ANALYSIS_MAX_BYTES,
  DEFAULT_VISION_MODEL,
  FALLBACK_ANTHROPIC_MODEL,
} from "../defaults";
import type { AiEnvInput } from "../env";
import { readImageInfo } from "../image";
import { createVisionDescriber } from "../index";
import { PRICE_TABLE_VERSION } from "../pricing";
import type { VisionContext, VisionDescriber, VisionRequest, VisionResult } from "../types";
import { validateDescription } from "../validate";

export const BAKEOFF_PROVIDERS = ["openai", "anthropic", "fake"] as const;
export type BakeoffProvider = (typeof BAKEOFF_PROVIDERS)[number];

export interface BakeoffOptions {
  photosDir: string;
  providers: BakeoffProvider[];
  mode: "batch" | "realtime";
  labelsPath?: string;
  limit?: number;
  outPath?: string;
  /** Env holding keys and model settings (default `process.env`). */
  env?: AiEnvInput;
  openaiModel?: string;
  anthropicModel?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Progress output (default stderr). Never receives image bytes or descriptions. */
  progress?: (line: string) => void;
  /** Tests: build the describer for a provider instead of the env factory. */
  describerFor?: (provider: BakeoffProvider) => VisionDescriber;
}

const labelSchema = z.record(
  z.string(),
  z.object({
    sensitive: z.array(z.string()).default([]),
    milestone: z.string().optional(),
    context: z
      .object({
        babyAgeDays: z.number().int().nullable().optional(),
        takenAt: z.string().nullable().optional(),
        placeLabel: z.string().nullable().optional(),
        people: z.array(z.string()).optional(),
        milestone: z.string().nullable().optional(),
        parentNotes: z.string().nullable().optional(),
      })
      .optional(),
  }),
);
type Labels = z.infer<typeof labelSchema>;

export interface ProviderReport {
  provider: BakeoffProvider;
  model: string;
  photos: number;
  results: number;
  valid: number;
  refusals: number;
  invalid: number;
  expiredOrMissing: number;
  errors: number;
  sensitive: { tp: number; fp: number; fn: number; labeled: number };
  milestone: { hits: number; labeled: number };
  tokens: {
    input: number;
    cached: number;
    output: number;
    image: number;
    /** Results whose usage reported image tokens (only some providers do). */
    withImage: number;
    reasoning: number;
    withUsage: number;
  };
  costUsd: number;
  wallMs: number;
  meanLatencyMs: number | null;
  /** Batch id kept when the batch did not finish before the timeout. */
  unfinishedBatchId?: string;
}

interface Photo {
  id: string;
  file: string;
  request: VisionRequest;
}

/** Nearest ancestor containing `pnpm-workspace.yaml`. */
export function findWorkspaceRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** Absolute path; relative ones resolve against `INIT_CWD`, then the workspace root, then cwd. */
export function resolveUserPath(p: string, mustExist = true): string {
  if (isAbsolute(p)) return p;
  const bases = [process.env.INIT_CWD, findWorkspaceRoot(), process.cwd()].filter(
    (b): b is string => !!b,
  );
  for (const b of bases) {
    const candidate = resolve(b, p);
    if (!mustExist || existsSync(candidate)) return candidate;
  }
  return resolve(bases[0] as string, p);
}

const MIME: Record<string, "image/jpeg" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

async function loadPhotos(dir: string, limit: number, labels: Labels): Promise<Photo[]> {
  const names = (await readdir(dir))
    .filter((n) => MIME[extname(n).toLowerCase()])
    .sort()
    .slice(0, limit);
  if (!names.length) throw new Error(`bakeoff: no .jpg/.jpeg/.webp files in ${dir}`);
  const refused: string[] = [];
  const photos: Photo[] = [];
  for (const [i, name] of names.entries()) {
    const path = join(dir, name);
    const size = (await stat(path)).size;
    const bytes = new Uint8Array(await readFile(path));
    const info = readImageInfo(bytes);
    const mimeType = MIME[extname(name).toLowerCase()] as "image/jpeg" | "image/webp";
    if (
      !info ||
      info.type !== mimeType ||
      Math.max(info.width, info.height) > ANALYSIS_LONG_EDGE_PX ||
      size > ANALYSIS_MAX_BYTES
    ) {
      refused.push(name);
      continue;
    }
    const ctx = labels[name]?.context ?? {};
    const context: VisionContext = {
      babyAgeDays: ctx.babyAgeDays ?? null,
      takenAt: ctx.takenAt ?? null,
      placeLabel: ctx.placeLabel ?? null,
      people: ctx.people ?? [],
      milestone: ctx.milestone ?? null,
      parentNotes: ctx.parentNotes ?? null,
    };
    const id = `photo-${String(i + 1).padStart(4, "0")}`;
    photos.push({
      id,
      file: name,
      request: {
        photoId: id,
        plan: "paid",
        image: { bytes, mimeType, width: info.width, height: info.height },
        context,
        promptVersion: AI_PROMPT_VERSION,
        schemaVersion: AI_SCHEMA_VERSION,
      },
    });
  }
  if (refused.length) {
    throw new Error(
      `bakeoff: ${refused.length} file(s) are not 768 px analysis copies (long edge > ${ANALYSIS_LONG_EDGE_PX}, > ${ANALYSIS_MAX_BYTES} bytes, or unreadable); resize them first: ${refused.slice(0, 10).join(", ")}`,
    );
  }
  return photos;
}

function emptyReport(provider: BakeoffProvider, model: string, photos: number): ProviderReport {
  return {
    provider,
    model,
    photos,
    results: 0,
    valid: 0,
    refusals: 0,
    invalid: 0,
    expiredOrMissing: 0,
    errors: 0,
    sensitive: { tp: 0, fp: 0, fn: 0, labeled: 0 },
    milestone: { hits: 0, labeled: 0 },
    tokens: { input: 0, cached: 0, output: 0, image: 0, withImage: 0, reasoning: 0, withUsage: 0 },
    costUsd: 0,
    wallMs: 0,
    meanLatencyMs: null,
  };
}

function score(report: ProviderReport, photos: Photo[], results: VisionResult[], labels: Labels) {
  const byId = new Map(results.map((r) => [r.photoId, r]));
  const latencies: number[] = [];
  for (const photo of photos) {
    const r = byId.get(photo.id);
    if (!r) {
      report.expiredOrMissing++;
      continue;
    }
    report.results++;
    if (r.usage) {
      const u = r.usage;
      report.tokens.withUsage++;
      report.tokens.input += u.inputTokens;
      report.tokens.cached += u.cachedInputTokens;
      report.tokens.output += u.outputTokens;
      if (u.imageTokens !== undefined) {
        report.tokens.image += u.imageTokens;
        report.tokens.withImage++;
      }
      report.tokens.reasoning += u.reasoningTokens ?? 0;
      report.costUsd += u.costUsd;
    }
    if (!r.ok) {
      if (r.failure === "refusal") report.refusals++;
      else if (r.failure === "invalid_output") report.invalid++;
      else if (r.failure === "expired") report.expiredOrMissing++;
      else report.errors++;
      continue;
    }
    if (r.latencyMs !== undefined) latencies.push(r.latencyMs);
    const v = validateDescription(r.raw);
    if (!v.ok) {
      report.invalid++;
      continue;
    }
    report.valid++;
    const label = labels[photo.file];
    if (label) {
      report.sensitive.labeled++;
      const truth = label.sensitive.length > 0;
      const predicted = v.value.sensitive_content.length > 0;
      if (truth && predicted) report.sensitive.tp++;
      else if (!truth && predicted) report.sensitive.fp++;
      else if (truth && !predicted) report.sensitive.fn++;
      if (label.milestone) {
        report.milestone.labeled++;
        const want = label.milestone.toLowerCase();
        const hit = v.value.possible_milestones.some((m) => {
          const got = m.name.toLowerCase();
          return got.includes(want) || want.includes(got);
        });
        if (hit) report.milestone.hits++;
      }
    }
  }
  if (latencies.length)
    report.meanLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  report.costUsd = Math.round(report.costUsd * 1e10) / 1e10;
}

async function runBatch(
  describer: VisionDescriber,
  photos: Photo[],
  pollIntervalMs: number,
  timeoutMs: number,
  progress: (line: string) => void,
): Promise<{ results: VisionResult[]; unfinishedBatchId?: string }> {
  const handle = await describer.describeBatch(photos.map((p) => p.request));
  progress(
    `  ${describer.provider}: batch ${handle.batchId} submitted (${handle.requestCount} requests)`,
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await describer.pollBatch(handle);
    if (isTerminalBatchState(status.state)) {
      progress(
        `  ${describer.provider}: batch ${status.state} (${status.results?.length ?? 0} results)`,
      );
      try {
        const { deleted } = await describer.deleteBatchArtifacts(handle, status);
        progress(`  ${describer.provider}: deleted ${deleted.length} provider artifact(s)`);
      } catch {
        progress(
          `  ${describer.provider}: WARNING provider artifacts not deleted for ${handle.batchId}; delete them by hand`,
        );
      }
      return { results: status.results ?? [] };
    }
    if (Date.now() > deadline) {
      progress(
        `  ${describer.provider}: timed out; batch ${handle.batchId} still ${status.state} (delete it when it ends)`,
      );
      return { results: [], unfinishedBatchId: handle.batchId };
    }
    if (pollIntervalMs > 0) await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

async function runRealtime(describer: VisionDescriber, photos: Photo[]): Promise<VisionResult[]> {
  const results: VisionResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < photos.length) {
      const photo = photos[next++] as Photo;
      results.push(await describer.describeOne(photo.request));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, photos.length) }, worker));
  return results;
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)} %` : "n/a");
const mean = (n: number, d: number) => (d ? (n / d).toFixed(0) : "n/a");
const usd = (n: number) => `$${n.toFixed(6)}`;

/** Markdown report: one row per metric, one column per provider. */
export function formatReport(
  reports: ProviderReport[],
  meta: { mode: string; photos: number },
): string {
  const header = `| Metric | ${reports.map((r) => `${r.provider} (${r.model})`).join(" | ")} |`;
  const sep = `| --- | ${reports.map(() => "---").join(" | ")} |`;
  const row = (name: string, f: (r: ProviderReport) => string) =>
    `| ${name} | ${reports.map(f).join(" | ")} |`;
  const lines = [
    `# Vision bake-off (${meta.mode}, ${meta.photos} photos, prompt ${AI_PROMPT_VERSION}, schema ${AI_SCHEMA_VERSION}, prices ${PRICE_TABLE_VERSION})`,
    "",
    header,
    sep,
    row("Schema-valid", (r) => `${r.valid}/${r.photos} (${pct(r.valid, r.photos)})`),
    row("Refusals", (r) => String(r.refusals)),
    row("Invalid output", (r) => String(r.invalid)),
    row("Expired / missing", (r) => String(r.expiredOrMissing)),
    row("Provider errors", (r) => String(r.errors)),
    row("Sensitive recall", (r) => pct(r.sensitive.tp, r.sensitive.tp + r.sensitive.fn)),
    row("Sensitive precision", (r) => pct(r.sensitive.tp, r.sensitive.tp + r.sensitive.fp)),
    row(
      "Milestone hit rate",
      (r) => `${pct(r.milestone.hits, r.milestone.labeled)} of ${r.milestone.labeled}`,
    ),
    row("Mean input tokens", (r) => mean(r.tokens.input, r.tokens.withUsage)),
    row("Mean cached input tokens", (r) => mean(r.tokens.cached, r.tokens.withUsage)),
    row("Mean output tokens", (r) => mean(r.tokens.output, r.tokens.withUsage)),
    row("Mean image tokens (if reported)", (r) => mean(r.tokens.image, r.tokens.withImage)),
    row("Mean reasoning tokens", (r) => mean(r.tokens.reasoning, r.tokens.withUsage)),
    row("Total cost", (r) => usd(r.costUsd)),
    row("Cost per photo", (r) => (r.photos ? usd(r.costUsd / r.photos) : "n/a")),
    row("Cost per 1,000 photos", (r) =>
      r.photos ? `$${((1000 * r.costUsd) / r.photos).toFixed(4)}` : "n/a",
    ),
    row("Cost per valid description", (r) => (r.valid ? usd(r.costUsd / r.valid) : "n/a")),
    row("Wall time", (r) => `${(r.wallMs / 1000).toFixed(1)} s`),
    row("Mean latency (realtime)", (r) =>
      r.meanLatencyMs === null ? "n/a" : `${r.meanLatencyMs.toFixed(0)} ms`,
    ),
  ];
  const unfinished = reports.filter((r) => r.unfinishedBatchId);
  if (unfinished.length) {
    lines.push(
      "",
      ...unfinished.map(
        (r) => `- ${r.provider}: batch ${r.unfinishedBatchId} did not finish before the timeout.`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

function describerFromEnv(provider: BakeoffProvider, opts: BakeoffOptions): VisionDescriber {
  const env: Record<string, unknown> = { ...(opts.env ?? process.env) };
  env.VISION_PROVIDER = provider;
  delete env.FAKE_VISION_DIR; // the bake-off never writes request dumps
  if (provider === "fake") {
    env.FAKE_VISION_POLLS = "0";
    env.VISION_MODEL = DEFAULT_VISION_MODEL;
  } else if (provider === "openai") {
    env.VISION_MODEL = opts.openaiModel ?? DEFAULT_VISION_MODEL;
  } else {
    env.VISION_MODEL = opts.anthropicModel ?? FALLBACK_ANTHROPIC_MODEL;
  }
  return createVisionDescriber(env);
}

export async function runBakeoff(
  opts: BakeoffOptions,
): Promise<{ reports: ProviderReport[]; markdown: string }> {
  const progress = opts.progress ?? ((l: string) => process.stderr.write(`${l}\n`));
  const labels: Labels = opts.labelsPath
    ? labelSchema.parse(JSON.parse(await readFile(opts.labelsPath, "utf8")))
    : {};
  const photos = await loadPhotos(opts.photosDir, opts.limit ?? 200, labels);
  const real = opts.providers.filter((p) => p !== "fake").length;
  if (real) {
    progress(
      `bakeoff: ${photos.length} photos × ${real} real provider(s); expected spend ≈ $${(photos.length * real * 0.0002 * (opts.mode === "realtime" ? 2 : 1)).toFixed(3)}`,
    );
  }
  const reports: ProviderReport[] = [];
  for (const provider of opts.providers) {
    const describer = opts.describerFor
      ? opts.describerFor(provider)
      : describerFromEnv(provider, opts);
    const report = emptyReport(provider, describer.model, photos.length);
    progress(`bakeoff: ${provider} (${describer.model}), ${opts.mode}`);
    const started = Date.now();
    const pollIntervalMs = opts.pollIntervalMs ?? (provider === "fake" ? 0 : 30_000);
    const out =
      opts.mode === "batch"
        ? await runBatch(
            describer,
            photos,
            pollIntervalMs,
            opts.timeoutMs ?? 6 * 3600_000,
            progress,
          )
        : { results: await runRealtime(describer, photos) };
    report.wallMs = Date.now() - started;
    if ("unfinishedBatchId" in out && out.unfinishedBatchId)
      report.unfinishedBatchId = out.unfinishedBatchId;
    score(report, photos, out.results, labels);
    reports.push(report);
  }
  const markdown = formatReport(reports, { mode: opts.mode, photos: photos.length });
  if (opts.outPath) await writeFile(opts.outPath, markdown);
  return { reports, markdown };
}

/** CLI args → options (a leading literal `--` from pnpm is ignored). */
export function parseBakeoffArgs(argv: readonly string[]): BakeoffOptions {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") continue;
    if (!a.startsWith("--")) throw new Error(`bakeoff: unexpected argument ${a}`);
    const [key, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    const value = inline ?? args[++i];
    if (value === undefined) throw new Error(`bakeoff: --${key} needs a value`);
    values.set(key, value);
  }
  const photos = values.get("photos");
  if (!photos) throw new Error("bakeoff: --photos <dir> is required");
  const providers = (values.get("providers") ?? "openai,anthropic").split(",").map((p) => p.trim());
  for (const p of providers) {
    if (!(BAKEOFF_PROVIDERS as readonly string[]).includes(p)) {
      throw new Error(`bakeoff: unknown provider ${p} (openai, anthropic, fake)`);
    }
  }
  const mode = values.get("mode") ?? "batch";
  if (mode !== "batch" && mode !== "realtime")
    throw new Error("bakeoff: --mode is batch or realtime");
  const num = (k: string) => (values.has(k) ? Number(values.get(k)) : undefined);
  const opts: BakeoffOptions = {
    photosDir: resolveUserPath(photos),
    providers: providers as BakeoffProvider[],
    mode,
  };
  const labels = values.get("labels");
  if (labels) opts.labelsPath = resolveUserPath(labels);
  const out = values.get("out");
  if (out) opts.outPath = resolveUserPath(out, false);
  const limit = num("limit");
  if (limit !== undefined) opts.limit = limit;
  const poll = num("poll-seconds");
  if (poll !== undefined) opts.pollIntervalMs = poll * 1000;
  const timeout = num("timeout-min");
  if (timeout !== undefined) opts.timeoutMs = timeout * 60_000;
  const om = values.get("openai-model");
  if (om) opts.openaiModel = om;
  const am = values.get("anthropic-model");
  if (am) opts.anthropicModel = am;
  return opts;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  runBakeoff(parseBakeoffArgs(process.argv.slice(2)))
    .then(({ markdown }) => {
      process.stdout.write(markdown);
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : "bakeoff failed"}\n`);
      process.exit(1);
    });
}
