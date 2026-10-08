/**
 * Error types for `@littlelight/ai`. Messages name env fields and providers only; they never
 * include key values, prompts, parent notes or image bytes.
 */

/** AI is unavailable: the provider key is missing or the adapter is not implemented yet. */
export class AiNotConfiguredError extends Error {
  override readonly name: string = "AiNotConfiguredError";
}

/**
 * Step 1 stub: config is valid but the provider adapter does not exist yet (lands in step 6/7).
 * Subclass of `AiNotConfiguredError` so callers can treat both as "AI disabled".
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
