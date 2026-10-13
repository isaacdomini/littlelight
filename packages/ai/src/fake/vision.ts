/**
 * Deterministic in-process vision provider (`VISION_PROVIDER=fake`; docs/plans/step-6.md 2.5,
 * D1). No key, no network. Runs the same lifecycle as the real adapters (describe → poll →
 * results → delete) with schema-valid outputs and real price-table costs (1,400 input / 700
 * cached / 400 output tokens per photo on the configured model's batch tier ⇒ $0.0001385 on
 * `gpt-6-luna`; a video item adds 600 input tokens per extra frame, so a 4-image video is 3,200
 * input / 700 cached / 400 output ⇒ $0.0002285, the plan's ≈ $0.00023 per video), and enforces
 * the same runtime checks (`plan === "paid"`, 768 px analysis copy for every frame, context
 * schema + coordinate tripwire). The output is keyed on the item id (its first image's id), so
 * a video gets one deterministic description like a photo.
 *
 * Persistence: with `dir` (`FAKE_VISION_DIR`) set, each batch writes
 * - `<dir>/<batchId>.jsonl`: the request lines MINUS image bytes and text (photo id, plan,
 *   versions, every image's type/dimensions/byte count (`images`, `image_count`: 1 for a photo,
 *   up to 4 for a video), the video `media` facts, context field lengths), for the gate;
 * - `<dir>/<batchId>.state.json`: photo ids, scripted outcomes and the poll count, so a batch
 *   submitted by one process (`run-job ai.flush`) can be polled by another (`run-job ai.poll`).
 * Without `dir`, batches live in memory only.
 *
 * Refuses construction when `NODE_ENV=production` unless `AI_ALLOW_FAKE_IN_PRODUCTION=true`.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sumUsage } from "../batch-state";
import { DEFAULT_VISION_MODEL } from "../defaults";
import { AiNotConfiguredError } from "../errors";
import { assertPriced, costUsd, type PriceTierName } from "../pricing";
import { checkVisionBatch, checkVisionRequest, visionImages } from "../request";
import type {
  AiLogger,
  ModelUsage,
  VisionBatchHandle,
  VisionBatchStatus,
  VisionDescriber,
  VisionRequest,
  VisionResult,
} from "../types";
import { fakeDescription } from "./describe";

export type FakeOutcome = "ok" | "invalid_output" | "refusal" | "expired" | "provider_error";

export interface FakeVisionOptions {
  /** Model whose price table is used (default `gpt-6-luna`; must be priced). */
  model?: string;
  /** Polls answered `in_progress` before `completed` (default 1). */
  pollsUntilComplete?: number;
  /** `FAKE_VISION_DIR`: dump + state files (see module doc). */
  dir?: string;
  /** Tests only: scripted outcome per photo and attempt (1-based, per describer instance). */
  script?: (photoId: string, attempt: number) => FakeOutcome;
  log?: AiLogger;
  /** Process env used for the production guard (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** What the fake saw for each request. Never image bytes or context text. */
export interface FakeRecordedRequest {
  photoId: string;
  plan: string;
  /** Byte count of the analysis copy (a video's poster). */
  imageBytes: number;
  width: number;
  height: number;
  mimeType: string;
  /** Images in the request: 1 for a photo, up to `AI_VIDEO_MAX_FRAMES` for a video (step 12). */
  imageCount: number;
  /** Byte count of every image, in send order. */
  imageBytesEach: number[];
  /** Video facts of the context (null for a photo). */
  media: { kind: "video"; durationSeconds: number; frameCount: number } | null;
  /** Context keys that carried a value (non-null, non-empty). */
  contextKeys: string[];
  promptVersion: string;
  schemaVersion: string;
  /** `null` for `describeOne`. */
  batchId: string | null;
}

export interface FakeVisionDescriber extends VisionDescriber {
  readonly provider: "fake";
  readonly requests: FakeRecordedRequest[];
  readonly deleteCalls: string[];
  readonly cancelCalls: string[];
}

interface FakeBatchState {
  batchId: string;
  model: string;
  submittedAt: string;
  promptVersion: string;
  schemaVersion: string;
  photoIds: string[];
  outcomes: Record<string, FakeOutcome>;
  /** Images per item (absent in state files written before step 12 ⇒ 1). */
  imageCounts?: Record<string, number>;
  polls: number;
  cancelled: boolean;
  deleted: boolean;
}

/** Usage the fake reports per answered single-image request. */
export const FAKE_USAGE = { inputTokens: 1400, cachedInputTokens: 700, outputTokens: 400 } as const;

/**
 * Input tokens the fake adds per image beyond the first (PRD "Image compression for the model":
 * ~600 image tokens for a 768 px frame). A 4-image video item reports 3,200 input tokens.
 */
export const FAKE_TOKENS_PER_EXTRA_IMAGE = 600;

/**
 * Cost model documented for the budget (docs/plans/step-12.md 2.7), gpt-6-luna Batch:
 * photo = 700 uncached + 700 cached + 400 out ⇒ $0.0001385; video (4 images) = 2,500 uncached
 * + 700 cached + 400 out ⇒ $0.0002285 (≈ $0.00023, about 2.3× a photo).
 */
function fakeUsage(
  model: string,
  tier: PriceTierName,
  outputTokens: number,
  imageCount = 1,
): ModelUsage {
  const extra = Math.max(0, imageCount - 1) * FAKE_TOKENS_PER_EXTRA_IMAGE;
  const u = { ...FAKE_USAGE, inputTokens: FAKE_USAGE.inputTokens + extra, outputTokens };
  return { ...u, reasoningTokens: 0, costUsd: costUsd(model, tier, u) };
}

function contextKeys(r: VisionRequest): string[] {
  return Object.entries(r.context)
    .filter(
      ([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0) && v !== "",
    )
    .map(([k]) => k);
}

function imageMeta(image: VisionRequest["image"]) {
  return {
    mime_type: image.mimeType,
    width: image.width,
    height: image.height,
    bytes: image.bytes.byteLength,
  };
}

function dumpLine(r: VisionRequest): string {
  const c = r.context;
  const images = visionImages(r);
  return JSON.stringify({
    custom_id: r.photoId,
    plan: r.plan,
    prompt_version: r.promptVersion,
    schema_version: r.schemaVersion,
    // `image` is the first image (kept for older readers); `images` lists every one sent.
    image: imageMeta(r.image),
    image_count: images.length,
    images: images.map(imageMeta),
    media: c.media
      ? {
          kind: c.media.kind,
          duration_seconds: c.media.durationSeconds,
          frame_count: c.media.frameCount,
        }
      : null,
    context_lengths: {
      babyAgeDays: c.babyAgeDays === null ? 0 : 1,
      takenAt: c.takenAt?.length ?? 0,
      placeLabel: c.placeLabel?.length ?? 0,
      people: c.people.length,
      milestone: c.milestone?.length ?? 0,
      parentNotes: c.parentNotes?.length ?? 0,
    },
  });
}

function resultFor(
  photoId: string,
  outcome: FakeOutcome,
  model: string,
  tier: PriceTierName,
  imageCount = 1,
): VisionResult | null {
  switch (outcome) {
    case "ok":
      return {
        photoId,
        ok: true,
        raw: fakeDescription(photoId),
        usage: fakeUsage(model, tier, 400, imageCount),
      };
    case "invalid_output":
      return {
        photoId,
        ok: true,
        raw: { caption: 42 },
        usage: fakeUsage(model, tier, 400, imageCount),
      };
    case "refusal":
      return {
        photoId,
        ok: false,
        failure: "refusal",
        detail: "refusal",
        usage: fakeUsage(model, tier, 20, imageCount),
      };
    case "provider_error":
      return { photoId, ok: false, failure: "provider_error", detail: "server_error" };
    case "expired":
      return null;
  }
}

export function createFakeVisionDescriber(options: FakeVisionOptions = {}): FakeVisionDescriber {
  const env = options.env ?? process.env;
  if (env.NODE_ENV === "production" && env.AI_ALLOW_FAKE_IN_PRODUCTION !== "true") {
    throw new AiNotConfiguredError(
      "AI disabled: VISION_PROVIDER=fake is refused in production (AI_ALLOW_FAKE_IN_PRODUCTION not set)",
    );
  }
  const model = options.model ?? DEFAULT_VISION_MODEL;
  assertPriced(model, "VISION_MODEL");
  const pollsUntilComplete = options.pollsUntilComplete ?? 1;
  const { dir, script, log } = options;
  const batches = new Map<string, FakeBatchState>();
  const attempts = new Map<string, number>();
  const requests: FakeRecordedRequest[] = [];
  const deleteCalls: string[] = [];
  const cancelCalls: string[] = [];

  const nextOutcome = (photoId: string): FakeOutcome => {
    const attempt = (attempts.get(photoId) ?? 0) + 1;
    attempts.set(photoId, attempt);
    return script ? script(photoId, attempt) : "ok";
  };

  const record = (r: VisionRequest, batchId: string | null) =>
    requests.push({
      photoId: r.photoId,
      plan: r.plan,
      imageBytes: r.image.bytes.byteLength,
      width: r.image.width,
      height: r.image.height,
      mimeType: r.image.mimeType,
      imageCount: visionImages(r).length,
      imageBytesEach: visionImages(r).map((i) => i.bytes.byteLength),
      media: r.context.media ? { ...r.context.media } : null,
      contextKeys: contextKeys(r),
      promptVersion: r.promptVersion,
      schemaVersion: r.schemaVersion,
      batchId,
    });

  async function save(state: FakeBatchState): Promise<void> {
    batches.set(state.batchId, state);
    if (dir) await writeFile(join(dir, `${state.batchId}.state.json`), JSON.stringify(state));
  }

  async function load(batchId: string): Promise<FakeBatchState | null> {
    const mem = batches.get(batchId);
    if (mem) return mem;
    if (!dir || !/^fakebatch_[a-f0-9]{32}$/.test(batchId)) return null;
    try {
      const state = JSON.parse(
        await readFile(join(dir, `${batchId}.state.json`), "utf8"),
      ) as FakeBatchState;
      batches.set(batchId, state);
      return state;
    } catch {
      return null;
    }
  }

  async function describeBatch(input: VisionRequest[]): Promise<VisionBatchHandle> {
    const { requests: checked, warnings } = checkVisionBatch(input);
    if (warnings.length) {
      log?.warn(
        {
          provider: "fake",
          photoIds: warnings.map((w) => w.photoId),
          warning: "context_coordinates_blanked",
        },
        "ai context field blanked",
      );
    }
    const batchId = `fakebatch_${randomUUID().replaceAll("-", "")}`;
    const first = checked[0] as VisionRequest;
    const state: FakeBatchState = {
      batchId,
      model,
      submittedAt: new Date().toISOString(),
      promptVersion: first.promptVersion,
      schemaVersion: first.schemaVersion,
      photoIds: checked.map((r) => r.photoId),
      outcomes: Object.fromEntries(checked.map((r) => [r.photoId, nextOutcome(r.photoId)])),
      imageCounts: Object.fromEntries(checked.map((r) => [r.photoId, visionImages(r).length])),
      polls: 0,
      cancelled: false,
      deleted: false,
    };
    for (const r of checked) record(r, batchId);
    if (dir) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${batchId}.jsonl`), `${checked.map(dumpLine).join("\n")}\n`);
    }
    await save(state);
    log?.info({ provider: "fake", batchId, count: checked.length }, "ai batch submitted");
    return {
      provider: "fake",
      batchId,
      model,
      submittedAt: state.submittedAt,
      requestCount: checked.length,
      promptVersion: state.promptVersion,
      schemaVersion: state.schemaVersion,
    };
  }

  async function pollBatch(handle: VisionBatchHandle): Promise<VisionBatchStatus> {
    const state = await load(handle.batchId);
    if (!state) {
      return {
        handle,
        state: "failed",
        providerStatus: "unknown_batch",
        results: [],
        failureCode: "fake_unknown_batch",
      };
    }
    const expiresAt = new Date(Date.parse(state.submittedAt) + 24 * 3600_000).toISOString();
    const total = state.photoIds.length;
    if (state.cancelled) {
      return {
        handle,
        state: "cancelled",
        providerStatus: "cancelled",
        results: [],
        requestCounts: { total, completed: 0, failed: total },
        expiresAt,
      };
    }
    state.polls += 1;
    await save(state);
    if (state.polls <= pollsUntilComplete) {
      return {
        handle,
        state: "in_progress",
        providerStatus: "in_progress",
        requestCounts: { total, completed: 0, failed: 0 },
        expiresAt,
      };
    }
    const results: VisionResult[] = [];
    let expired = 0;
    for (const photoId of state.photoIds) {
      const r = resultFor(
        photoId,
        state.outcomes[photoId] ?? "ok",
        state.model,
        "batch",
        state.imageCounts?.[photoId] ?? 1,
      );
      if (r) results.push(r);
      else expired++;
    }
    const failed = expired + results.filter((r) => !r.ok && r.failure === "provider_error").length;
    const status: VisionBatchStatus = {
      handle,
      state: expired > 0 ? "expired" : "completed",
      providerStatus: expired > 0 ? "expired" : "completed",
      results,
      requestCounts: { total, completed: total - failed, failed },
      expiresAt,
    };
    const usage = sumUsage(results);
    if (usage) status.usage = usage;
    log?.info(
      {
        provider: "fake",
        batchId: handle.batchId,
        state: status.state,
        results: results.length,
        expired,
      },
      "ai batch results",
    );
    return status;
  }

  async function deleteBatchArtifacts(handle: VisionBatchHandle): Promise<{ deleted: string[] }> {
    deleteCalls.push(handle.batchId);
    const state = await load(handle.batchId);
    if (state) {
      state.deleted = true;
      await save(state);
    }
    return { deleted: [handle.batchId] };
  }

  async function cancelBatch(handle: VisionBatchHandle): Promise<void> {
    cancelCalls.push(handle.batchId);
    const state = await load(handle.batchId);
    if (state) {
      state.cancelled = true;
      await save(state);
    }
  }

  async function describeOne(input: VisionRequest): Promise<VisionResult> {
    const { request } = checkVisionRequest(input);
    record(request, null);
    const outcome = nextOutcome(request.photoId);
    const r = resultFor(request.photoId, outcome, model, "standard", visionImages(request).length);
    if (!r) return { photoId: request.photoId, ok: false, failure: "expired", detail: "expired" };
    return r.ok ? { ...r, latencyMs: 0 } : r;
  }

  return {
    provider: "fake",
    model,
    requests,
    deleteCalls,
    cancelCalls,
    describeBatch,
    pollBatch,
    deleteBatchArtifacts,
    cancelBatch,
    describeOne,
  };
}
