/**
 * Validation of model output against description schema v1 (README rule 5; PRD FR-5.3). Every
 * `VisionResult.raw` goes through `validateDescription` before anything is written to
 * `photo_ai`. Issues are zod paths + codes only; values are never echoed (they are model output
 * about children's photos).
 */

import {
  AI_EXPRESSION,
  AI_INDOOR_OUTDOOR,
  AI_POSE,
  AI_SENSITIVE_FLAGS,
  AI_SUBJECT_WHO,
  type AiDescriptionV1,
  type AiOverrideField,
  aiDescriptionV1Schema,
  applyAiOverrides,
} from "@littlelight/shared";

export type ValidationResult =
  | { ok: true; value: AiDescriptionV1 }
  | {
      ok: false;
      /** `path:code` strings, e.g. `caption:invalid_type`, `$:json_parse`. Never values. */
      issues: string[];
    };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lowercases/trims an enum value and maps spaces/dashes to `_`; returns it unchanged if not a string. */
function normEnum(value: unknown, allowed: readonly string[]): unknown {
  if (typeof value !== "string") return value;
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return allowed.includes(v) ? v : value;
}

/**
 * Lenient pre-pass (providers' strict modes make most of this a no-op): a JSON string is
 * parsed once; enum values are lowercased/trimmed (Anthropic notes casing may differ);
 * `confidence` is clamped to 0..1. Does not mutate the input.
 */
function prePass(raw: unknown): unknown {
  let value = raw;
  if (typeof value === "string") value = JSON.parse(value);
  if (!isObj(value)) return value;
  const out: Obj = { ...value };
  if (Array.isArray(out.subjects)) {
    out.subjects = out.subjects.map((s) =>
      isObj(s) ? { ...s, who: normEnum(s.who, AI_SUBJECT_WHO) } : s,
    );
  }
  if (isObj(out.baby_state)) {
    out.baby_state = {
      ...out.baby_state,
      pose: normEnum(out.baby_state.pose, AI_POSE),
      expression: normEnum(out.baby_state.expression, AI_EXPRESSION),
    };
  }
  if (isObj(out.setting)) {
    out.setting = {
      ...out.setting,
      indoor_outdoor: normEnum(out.setting.indoor_outdoor, AI_INDOOR_OUTDOOR),
    };
  }
  if (Array.isArray(out.sensitive_content)) {
    out.sensitive_content = out.sensitive_content.map((f) => normEnum(f, AI_SENSITIVE_FLAGS));
  }
  if (Array.isArray(out.possible_milestones)) {
    out.possible_milestones = out.possible_milestones.map((m) =>
      isObj(m) && typeof m.confidence === "number" && Number.isFinite(m.confidence)
        ? { ...m, confidence: Math.min(1, Math.max(0, m.confidence)) }
        : m,
    );
  }
  return out;
}

/** Validates and normalises one model output. Never throws. */
export function validateDescription(raw: unknown): ValidationResult {
  let candidate: unknown;
  try {
    candidate = prePass(raw);
  } catch {
    return { ok: false, issues: ["$:json_parse"] };
  }
  const parsed = aiDescriptionV1Schema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.map(
    (i) => `${i.path.length ? i.path.map(String).join(".") : "$"}:${i.code}`,
  );
  return { ok: false, issues: [...new Set(issues)].slice(0, 20) };
}

/**
 * Description with parent overrides applied (FR-5.6: overrides win). Thin alias of shared
 * `applyAiOverrides` so the worker and step-7 indexer import one name from `packages/ai`.
 */
export function mergeOverrides(
  desc: AiDescriptionV1,
  overrides: Partial<Record<AiOverrideField, unknown>> | null | undefined,
): AiDescriptionV1 {
  return applyAiOverrides(desc, overrides);
}
