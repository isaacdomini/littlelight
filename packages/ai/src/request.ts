/**
 * Provider-neutral request assembly (docs/plans/step-6.md 2.5). Pure functions: no network, no
 * logging. Every adapter (OpenAI, Anthropic, fake) runs `checkVisionRequest` on each request
 * before anything leaves the process:
 * - `plan === "paid"` at runtime (the type already forbids anything else);
 * - the image is a valid 768 px analysis copy (`assertAnalysisImage`);
 * - the context satisfies `aiVisionContextSchema`; a field that looks like coordinates is
 *   blanked (warning `context_coordinates_blanked`, a category, never the text; plan D9);
 * - prompt/schema versions are ones this package has a prompt for.
 */

import {
  AI_CONTEXT_COORDINATE_FIELDS,
  AI_DESCRIPTION_V1_JSON_SCHEMA,
  AI_DESCRIPTION_V1_SCHEMA_NAME,
  AI_PROMPT_VERSION,
  AI_SCHEMA_VERSION,
  AI_VISION_CONTEXT_LIMITS,
  aiVisionContextSchema,
  looksLikeCoordinates,
} from "@tinyglow/shared";
import type { ReasoningEffort } from "./defaults";
import { AiRequestError } from "./errors";
import { assertAnalysisImage, toBase64, toDataUrl } from "./image";
import { buildUserText, DESCRIBE_SYSTEM_PROMPT_V1 } from "./prompts/describe-v1";
import type { AnalysisImage, VisionContext, VisionRequest } from "./types";

export type ImageDetail = "auto" | "low" | "high";

export interface RequestBuildOptions {
  model: string;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  /** OpenAI only (`input_image.detail`). */
  imageDetail?: ImageDetail;
}

export type ContextWarning = "context_coordinates_blanked" | "context_taken_at_dropped";

/** Batch `custom_id`: OpenAI accepts any string, Anthropic `^[a-zA-Z0-9_-]{1,64}$`; a uuid fits both. */
export const CUSTOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** OpenAI `prompt_cache_key`: one routing key per prompt version (prefix cache accounting). */
export function promptCacheKey(promptVersion: string): string {
  return `tinyglow-describe-${promptVersion}`;
}

/** System prompt for a version pair; throws for versions this package cannot build. */
export function systemPromptFor(promptVersion: string, schemaVersion: string): string {
  if (promptVersion !== AI_PROMPT_VERSION || schemaVersion !== AI_SCHEMA_VERSION) {
    throw new AiRequestError("unsupported_version");
  }
  return DESCRIBE_SYSTEM_PROMPT_V1;
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max).trim() : t;
}

/**
 * Normalises a context (trims, clips to `AI_VISION_CONTEXT_LIMITS`, drops empty people, drops
 * an unparseable `takenAt`), blanks coordinate look-alikes, then validates with
 * `aiVisionContextSchema`. Throws `AiRequestError("invalid_context", fields)` otherwise.
 */
export function sanitizeVisionContext(context: VisionContext): {
  context: VisionContext;
  warnings: ContextWarning[];
} {
  const warnings: ContextWarning[] = [];
  const L = AI_VISION_CONTEXT_LIMITS;
  const ctx: VisionContext = {
    babyAgeDays:
      typeof context.babyAgeDays === "number" && Number.isFinite(context.babyAgeDays)
        ? Math.floor(context.babyAgeDays)
        : null,
    takenAt: clip(context.takenAt, 40),
    placeLabel: clip(context.placeLabel, L.placeLabel),
    people: (Array.isArray(context.people) ? context.people : [])
      .map((p) => clip(typeof p === "string" ? p : null, L.personName))
      .filter((p): p is string => p !== null)
      .slice(0, L.people),
    milestone: clip(context.milestone, L.milestone),
    parentNotes: clip(context.parentNotes, L.note),
  };
  for (const field of AI_CONTEXT_COORDINATE_FIELDS) {
    const value = ctx[field];
    if (value !== null && looksLikeCoordinates(value)) {
      ctx[field] = null;
      if (!warnings.includes("context_coordinates_blanked")) {
        warnings.push("context_coordinates_blanked");
      }
    }
  }
  // People names and the milestone get the same tripwire (blank the item, never forward it).
  const people = ctx.people.filter((p) => !looksLikeCoordinates(p));
  if (
    people.length !== ctx.people.length ||
    (ctx.milestone && looksLikeCoordinates(ctx.milestone))
  ) {
    ctx.people = people;
    if (ctx.milestone && looksLikeCoordinates(ctx.milestone)) ctx.milestone = null;
    if (!warnings.includes("context_coordinates_blanked")) {
      warnings.push("context_coordinates_blanked");
    }
  }
  let parsed = aiVisionContextSchema.safeParse(ctx);
  if (!parsed.success && parsed.error.issues.some((i) => i.path[0] === "takenAt")) {
    ctx.takenAt = null;
    warnings.push("context_taken_at_dropped");
    parsed = aiVisionContextSchema.safeParse(ctx);
  }
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "context")))];
    throw new AiRequestError("invalid_context", fields);
  }
  return { context: ctx, warnings };
}

/**
 * Runtime checks every adapter applies to each request before it can leave the process.
 * Returns the request with a sanitised context.
 */
export function checkVisionRequest(request: VisionRequest): {
  request: VisionRequest;
  warnings: ContextWarning[];
} {
  if ((request as { plan: unknown }).plan !== "paid") throw new AiRequestError("not_paid");
  if (typeof request.photoId !== "string" || !CUSTOM_ID_RE.test(request.photoId)) {
    throw new AiRequestError("invalid_photo_id");
  }
  systemPromptFor(request.promptVersion, request.schemaVersion);
  assertAnalysisImage(request.image);
  const { context, warnings } = sanitizeVisionContext(request.context);
  return { request: { ...request, context }, warnings };
}

/** Checks a whole batch: non-empty, unique photo ids, one version pair, every request valid. */
export function checkVisionBatch(requests: readonly VisionRequest[]): {
  requests: VisionRequest[];
  warnings: { photoId: string; warning: ContextWarning }[];
} {
  if (requests.length === 0) throw new AiRequestError("batch_empty");
  const seen = new Set<string>();
  const out: VisionRequest[] = [];
  const warnings: { photoId: string; warning: ContextWarning }[] = [];
  const first = requests[0] as VisionRequest;
  for (const r of requests) {
    const checked = checkVisionRequest(r);
    if (seen.has(r.photoId)) throw new AiRequestError("duplicate_photo_id");
    seen.add(r.photoId);
    if (r.promptVersion !== first.promptVersion || r.schemaVersion !== first.schemaVersion) {
      throw new AiRequestError("unsupported_version");
    }
    out.push(checked.request);
    for (const w of checked.warnings) warnings.push({ photoId: r.photoId, warning: w });
  }
  return { requests: out, warnings };
}

export interface AssembleVisionRequestInput {
  photoId: string;
  plan: "paid";
  image: AnalysisImage;
  context: VisionContext;
  promptVersion?: string;
  schemaVersion?: string;
}

/**
 * Builds a checked `VisionRequest` (current prompt/schema versions by default). Throws
 * `AiRequestError` for a free-tier plan, a non-analysis image or an invalid context; blanks
 * coordinate look-alikes and reports them in `warnings` (categories only).
 */
export function assembleVisionRequest(input: AssembleVisionRequestInput): {
  request: VisionRequest;
  warnings: ContextWarning[];
} {
  return checkVisionRequest({
    photoId: input.photoId,
    plan: input.plan,
    image: input.image,
    context: input.context,
    promptVersion: input.promptVersion ?? AI_PROMPT_VERSION,
    schemaVersion: input.schemaVersion ?? AI_SCHEMA_VERSION,
  });
}

/**
 * OpenAI Responses API body (one Batch JSONL line's `body`, or a real-time `/v1/responses`
 * call). Pure. Order: model, instructions (static system prompt), structured-output schema,
 * reasoning, then the per-photo input (image first, then the context text).
 */
export function openAiResponsesBody(
  request: VisionRequest,
  opts: RequestBuildOptions,
): Record<string, unknown> {
  return {
    model: opts.model,
    instructions: systemPromptFor(request.promptVersion, request.schemaVersion),
    text: {
      format: {
        type: "json_schema",
        name: AI_DESCRIPTION_V1_SCHEMA_NAME,
        schema: AI_DESCRIPTION_V1_JSON_SCHEMA,
        strict: true,
      },
    },
    reasoning: { effort: opts.reasoningEffort },
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: toDataUrl(request.image),
            detail: opts.imageDetail ?? "auto",
          },
          { type: "input_text", text: buildUserText(request.context) },
        ],
      },
    ],
    max_output_tokens: opts.maxOutputTokens,
    prompt_cache_key: promptCacheKey(request.promptVersion),
    store: false,
  };
}

/**
 * Anthropic Messages params (one Message Batches request's `params`, or a real-time
 * `/v1/messages` call). Pure. Effort `none` ⇒ thinking disabled + `output_config.effort: "low"`;
 * `low|medium|high` ⇒ adaptive thinking at that effort. No temperature/top_p/top_k (Haiku 5.5
 * rejects them).
 */
export function anthropicMessageParams(
  request: VisionRequest,
  opts: RequestBuildOptions,
): Record<string, unknown> {
  const none = opts.reasoningEffort === "none";
  return {
    model: opts.model,
    max_tokens: opts.maxOutputTokens,
    system: [
      {
        type: "text",
        text: systemPromptFor(request.promptVersion, request.schemaVersion),
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    output_config: {
      format: { type: "json_schema", schema: AI_DESCRIPTION_V1_JSON_SCHEMA },
      effort: none ? "low" : opts.reasoningEffort,
    },
    thinking: none ? { type: "disabled" } : { type: "adaptive" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: request.image.mimeType,
              data: toBase64(request.image),
            },
          },
          { type: "text", text: buildUserText(request.context) },
        ],
      },
    ],
  };
}

/** Plan 2.5 names (same functions). */
export const OPENAI_RESPONSES_BODY = openAiResponsesBody;
export const ANTHROPIC_MESSAGE_PARAMS = anthropicMessageParams;

/**
 * Upper-bound estimate of one request's size in a batch upload (base64 image + prompt + schema
 * + context + JSON framing), so the worker can split before calling `describeBatch`.
 */
export function estimateVisionRequestBytes(request: Pick<VisionRequest, "image">): number {
  const base64 = Math.ceil(request.image.bytes.byteLength / 3) * 4;
  return base64 + 16_000;
}
