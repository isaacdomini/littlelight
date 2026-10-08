import type { IngestEnv } from "@littlelight/shared";

// CSAM hash-matching seam (docs/plans/step-4.md 2.9, D8; PRD "Non-functional requirements →
// Privacy and child safety"). Default `none`: nothing is sent anywhere. `photodna` posts the
// 768-px analysis JPEG (never the original, never metadata: derivatives carry none) to the
// Microsoft PhotoDNA Cloud Service match endpoint; it needs the operator's enrolment and DPA.
// A positive match quarantines the photo (ingest step 8). Never log the image or the reference.

export interface CsamCheckInput {
  sha256: Buffer;
  image: Buffer;
  mime: "image/jpeg";
}

export interface CsamCheckResult {
  matched: boolean;
  /** Provider reference for the operator flow. Never logged, never stored by this step. */
  reference?: string;
}

export interface CsamMatcher {
  readonly name: "none" | "photodna";
  check(input: CsamCheckInput): Promise<CsamCheckResult>;
}

export interface SafetyLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export class NoopCsamMatcher implements CsamMatcher {
  readonly name = "none" as const;

  async check(): Promise<CsamCheckResult> {
    return { matched: false };
  }
}

export class CsamMatcherError extends Error {
  constructor(readonly code: string) {
    super(`csam matcher error: ${code}`);
    this.name = "CsamMatcherError";
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** PhotoDNA Cloud Service `Match` call. `endpoint` is the full Match URL from the enrolment. */
export class PhotoDnaMatcher implements CsamMatcher {
  readonly name = "photodna" as const;
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(opts: { apiKey: string; endpoint: string; fetch?: FetchLike; timeoutMs?: number }) {
    this.#apiKey = opts.apiKey;
    this.#endpoint = opts.endpoint;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async check(input: CsamCheckInput): Promise<CsamCheckResult> {
    let res: Response;
    try {
      res = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "Content-Type": input.mime,
          "Ocp-Apim-Subscription-Key": this.#apiKey,
        },
        body: new Uint8Array(input.image),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      throw new CsamMatcherError(name === "TimeoutError" ? "timeout" : "network");
    }
    if (!res.ok) throw new CsamMatcherError(`http_${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new CsamMatcherError("bad_response");
    }
    const b = body as {
      IsMatch?: unknown;
      Status?: { Code?: unknown };
      TrackingId?: unknown;
    } | null;
    // 3000 = OK in the PhotoDNA status table; anything else is a provider-side failure.
    if (!b || typeof b.IsMatch !== "boolean" || (b.Status?.Code ?? 3000) !== 3000) {
      throw new CsamMatcherError("bad_response");
    }
    return b.IsMatch
      ? { matched: true, reference: typeof b.TrackingId === "string" ? b.TrackingId : undefined }
      : { matched: false };
  }
}

/**
 * Build the configured matcher. `photodna` without `PHOTODNA_API_KEY` and `PHOTODNA_ENDPOINT`
 * throws (startup failure). `none` logs one line (`warn` in production).
 */
export function createCsamMatcher(
  env: Pick<IngestEnv, "CSAM_MATCHER" | "PHOTODNA_API_KEY" | "PHOTODNA_ENDPOINT"> & {
    NODE_ENV?: string;
  },
  log: SafetyLogger,
): CsamMatcher {
  if (env.CSAM_MATCHER === "photodna") {
    if (!env.PHOTODNA_API_KEY || !env.PHOTODNA_ENDPOINT) {
      throw new Error("CSAM_MATCHER=photodna needs PHOTODNA_API_KEY and PHOTODNA_ENDPOINT");
    }
    log.info({ csamMatcher: "photodna" }, "CSAM matching enabled (PhotoDNA)");
    return new PhotoDnaMatcher({ apiKey: env.PHOTODNA_API_KEY, endpoint: env.PHOTODNA_ENDPOINT });
  }
  const msg = "CSAM matching disabled (CSAM_MATCHER=none)";
  if (env.NODE_ENV === "production") log.warn({ csamMatcher: "none" }, msg);
  else log.info({ csamMatcher: "none" }, msg);
  return new NoopCsamMatcher();
}
