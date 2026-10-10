/**
 * Error types for `@tinyglow/ai`. Messages name env fields, providers, operations, HTTP
 * statuses and provider error codes only; they never include key values, prompts, parent
 * notes, image bytes, model output or any provider response body.
 */

/** AI is unavailable: the provider key is missing or the adapter is not implemented yet. */
export class AiNotConfiguredError extends Error {
  override readonly name: string = "AiNotConfiguredError";
}

/**
 * Config is valid but the adapter does not exist yet (chat lands in step 7). Subclass of
 * `AiNotConfiguredError` so callers can treat both as "AI disabled".
 */
export class AiNotImplementedError extends AiNotConfiguredError {
  override readonly name: string = "AiNotImplementedError";
}

/** AI env vars are present but invalid (for example `VISION_PROVIDER=gemini`). */
export class AiConfigError extends Error {
  override readonly name: string = "AiConfigError";

  constructor(readonly fields: readonly string[]) {
    super(`Invalid AI config: ${fields.join(", ")}`);
  }
}

/**
 * Categories of a request the adapters refuse to send. Thrown before any network call.
 * - `not_paid`: `request.plan !== "paid"` (free-tier photos are never sent to a model).
 * - `image_*`: not a valid 768 px analysis copy (never an original or display derivative).
 * - `invalid_context`: the per-photo context does not satisfy `aiVisionContextSchema`.
 * - `invalid_photo_id` / `duplicate_photo_id`: not usable as a batch `custom_id`.
 * - `batch_empty` / `batch_too_large`: the worker splits batches over `AI_BATCH_MAX_BYTES`.
 * - `unsupported_version`: a prompt/schema version this package has no prompt for.
 */
export type AiRequestErrorCode =
  | "not_paid"
  | "image_too_large"
  | "image_too_many_bytes"
  | "image_bad_dimensions"
  | "image_bad_type"
  | "image_dimensions_mismatch"
  | "invalid_context"
  | "invalid_photo_id"
  | "duplicate_photo_id"
  | "batch_empty"
  | "batch_too_large"
  | "unsupported_version";

export class AiRequestError extends Error {
  override readonly name: string = "AiRequestError";

  constructor(
    readonly code: AiRequestErrorCode,
    /** Field names only (e.g. `["parentNotes"]`), never values. */
    readonly fields: readonly string[] = [],
  ) {
    super(`AI request refused: ${code}${fields.length ? ` (${fields.join(", ")})` : ""}`);
  }
}

/**
 * A provider HTTP call failed. `status` is the HTTP status (0 for network errors/timeouts);
 * `code` is the provider's short error code or type (`rate_limit_error`, `invalid_request_error`,
 * `timeout`, `network`), sanitised to `[A-Za-z0-9_.:-]{1,64}`. Never the response body.
 */
export class AiProviderError extends Error {
  override readonly name: string = "AiProviderError";

  constructor(
    readonly provider: string,
    readonly op: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`${provider} ${op} failed: ${status === 0 ? code : `HTTP ${status} ${code}`}`);
  }
}

/** Provider error codes are echoed into errors and results; keep only short identifier-like strings. */
export function safeCode(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : fallback;
}
