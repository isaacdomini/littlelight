import { z } from "zod";

// Strict JSON Schema for providers (docs/plans/step-7.md 2.4; factored out of
// `ai-description.ts`, behaviour unchanged). One post-processor for every schema a model sees:
// the step-6 description schema (structured output) and the step-7 chat tool parameters
// (function calling with `strict: true`). Browser-safe: only `zod`.
//
// OpenAI strict mode and Anthropic structured outputs both need:
// - `additionalProperties: false` on every object and every property listed in `required`
//   ("absent" is expressed as a nullable type, never as a missing key);
// - nullable fields as `type: [T, "null"]`;
// - no length/numeric bounds, `pattern`, `format`, `default` (we validate those with zod after the
//   call instead), `minItems` at most 1.

/** Keywords neither strict mode accepts (or that we keep out to stay portable). */
export const STRICT_JSON_SCHEMA_FORBIDDEN_KEYWORDS = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "format",
  "maxItems",
  "uniqueItems",
  "default",
] as const;

type JsonObject = { [key: string]: unknown };

function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `anyOf: [{type: T, ...}, {type: "null"}]` → `{type: [T, "null"], ...}` (zod 4.6 already does
 * this for plain types). A nullable enum (`{type: "string", enum: [...]}`) becomes
 * `{type: ["string", "null"], enum: [..., null]}`, the form OpenAI's strict-mode docs use (step 7
 * tool arguments; the step-6 description schema has no nullable enum, so its bytes are unchanged).
 */
function collapseNullableAnyOf(node: JsonObject): JsonObject {
  const anyOf = node.anyOf;
  if (!Array.isArray(anyOf) || anyOf.length !== 2) return node;
  const nullIdx = anyOf.findIndex((s) => isJsonObject(s) && s.type === "null");
  if (nullIdx < 0) return node;
  const other = anyOf[1 - nullIdx];
  if (!isJsonObject(other) || typeof other.type !== "string") return node;
  const { anyOf: _drop, ...rest } = node;
  if ("enum" in other) {
    if (!Array.isArray(other.enum)) return node;
    const values = other.enum.includes(null) ? other.enum : [...other.enum, null];
    return { ...rest, ...other, type: [other.type, "null"], enum: values };
  }
  return { ...rest, ...other, type: [other.type, "null"] };
}

/**
 * Applies the strict-mode rules above to an already generated JSON Schema (pure; returns a new
 * tree). Exported for tests; use `toStrictJsonSchema` for zod schemas.
 */
export function strictJsonSchemaPostProcess(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictJsonSchemaPostProcess);
  if (!isJsonObject(node)) return node;
  let out: JsonObject = collapseNullableAnyOf(node);
  out = Object.fromEntries(
    Object.entries(out)
      .filter(([k]) => k !== "$schema" && k !== "$id")
      .filter(([k]) => !(STRICT_JSON_SCHEMA_FORBIDDEN_KEYWORDS as readonly string[]).includes(k))
      .map(([k, val]) => [k, strictJsonSchemaPostProcess(val)]),
  );
  if (typeof out.minItems === "number" && out.minItems > 1) out.minItems = 1;
  if (out.type === "object" && isJsonObject(out.properties)) {
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

/** Freezes `value` and everything reachable from it; returns `value`. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * JSON Schema (draft 2020-12 subset) of `schema` for providers' strict modes, deep-frozen.
 * Generate once at module load and reuse the same object: the bytes are part of the provider's
 * cached prompt prefix. Build the zod schema without transforms/preprocessing (keep a separate
 * "provider" variant, as `ai-description.ts` and `api/chat.ts` do): only the shape is emitted.
 */
export function toStrictJsonSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  return deepFreeze(
    strictJsonSchemaPostProcess(
      z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }),
    ) as Record<string, unknown>,
  );
}
