import type { ApiErrorCode, ApiErrorResponse } from "@littlelight/shared";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

// API error model (docs/plans/step-3.md 2.4 "Error mapping"). Every non-2xx body is
// `apiErrorSchema`: `{ error: <code>, message, details? }`. Messages are user-safe: they never
// contain SQL, bind parameters, tokens, cookies or unmasked emails. Validation failures report
// field paths only. 429 responses carry `Retry-After`.

export interface ApiErrorOptions {
  /** Seconds; sets `Retry-After` (use with 429). */
  retryAfterSec?: number;
}

/** Throw from any handler or hook; the global error handler turns it into the response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;
  readonly retryAfterSec: number | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details?: unknown,
    options?: ApiErrorOptions,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSec =
      options?.retryAfterSec === undefined
        ? undefined
        : Math.max(1, Math.ceil(options.retryAfterSec));
  }

  toBody(): ApiErrorResponse {
    return this.details === undefined
      ? { error: this.code, message: this.message }
      : { error: this.code, message: this.message, details: this.details };
  }
}

/** Shorthands for the common cases. */
export const notFound = (message = "Not found") => new ApiError(404, "not_found", message);
export const forbidden = (message = "You don't have access to that") =>
  new ApiError(403, "forbidden", message);
export const rateLimited = (
  retryAfterSec: number,
  message = "Too many requests, try again later",
) => new ApiError(429, "rate_limited", message, undefined, { retryAfterSec });
export const internalError = () => new ApiError(500, "internal", "Something went wrong");

/** A node-postgres `DatabaseError` (has a 5-character SQLSTATE). */
export interface PgErrorLike {
  code: string;
  message: string;
  severity?: string;
  constraint?: string;
  table?: string;
  column?: string;
  routine?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

export function isPgError(err: unknown): err is PgErrorLike {
  if (typeof err !== "object" || err === null) return false;
  const { code, message, severity } = err as Record<string, unknown>;
  return (
    typeof code === "string" &&
    SQLSTATE.test(code) &&
    typeof message === "string" &&
    typeof severity === "string"
  );
}

/**
 * Trigger messages (`RAISE … USING ERRCODE = 'check_violation'`, packages/db/migrations) mapped
 * to API errors. Matched by prefix of the trigger's own text; never echoed.
 */
const CHECK_VIOLATIONS: ReadonlyArray<readonly [string, () => ApiError]> = [
  [
    "baby already has two admins",
    () => new ApiError(409, "admins_full", "This album already has two admins"),
  ],
  [
    "baby must keep at least one admin",
    () => new ApiError(409, "last_admin", "An album must keep at least one admin"),
  ],
  [
    "invite rate limit",
    () =>
      new ApiError(
        429,
        "rate_limited",
        "Too many invites for this album today, try again tomorrow",
        undefined,
        {
          retryAfterSec: 3600,
        },
      ),
  ],
  [
    "invite is no longer valid",
    () => new ApiError(410, "invite_expired", "This invite is no longer valid"),
  ],
  // Step 4 (packages/db/migrations/1791700000100_uploads-and-ingest.sql, 1791520000300_photos.sql).
  ["free tier photo limit reached", () => freeTierLimit()],
  [
    "upload session is full",
    () =>
      new ApiError(409, "upload_session_full", "This upload already has the maximum of 500 photos"),
  ],
  [
    "upload session is closed",
    () => new ApiError(410, "upload_session_expired", "This upload session has ended"),
  ],
  ["upload session belongs to another user", () => forbidden()],
  // Tripwires: the API derives both values itself, so reaching these is a state conflict.
  [
    "upload file must belong to the baby of its session",
    () => new ApiError(409, "conflict", "That conflicts with the current state"),
  ],
  [
    "duplicate_of_photo_id must be a photo of the same baby",
    () => new ApiError(409, "conflict", "That conflicts with the current state"),
  ],
];

/** 409 `free_tier_limit` (DB trigger `photos_free_tier_cap` and the API pre-checks). */
export const freeTierLimit = () =>
  new ApiError(409, "free_tier_limit", "This album is on the free plan, which holds 1,000 photos");

/**
 * Map a Postgres error to an `ApiError`. SQLSTATE `23514` by trigger message, `42501` → 403
 * `forbidden` (privilege or RLS `WITH CHECK` failure), `23505` → 409 `conflict`; anything else →
 * 500 `internal`. The result never carries the SQL, parameters or the original message.
 */
export function mapPgError(err: PgErrorLike): ApiError {
  switch (err.code) {
    case "23514": {
      const hit = CHECK_VIOLATIONS.find(([prefix]) => err.message.startsWith(prefix));
      return hit ? hit[1]() : internalError();
    }
    case "42501":
      return forbidden();
    case "23505":
      return new ApiError(409, "conflict", "That already exists");
    default:
      return internalError();
  }
}

/** Field paths of a validation failure, never the received values. */
function zodIssuePaths(err: ZodError): string[] {
  return [...new Set(err.issues.map((i) => i.path.map(String).join(".") || "(root)"))];
}

function fastifyValidationPaths(err: FastifyError): string[] {
  const out = new Set<string>();
  for (const v of err.validation ?? []) {
    const ctx = err.validationContext ?? "body";
    const raw = (v as { instancePath?: string }).instancePath ?? "";
    const path = raw.replace(/^\//, "").replaceAll("/", ".");
    out.add(path ? `${ctx}.${path}` : ctx);
  }
  return [...out];
}

const STATUS_FALLBACK: Readonly<Record<number, readonly [ApiErrorCode, string]>> = {
  400: ["validation_failed", "The request is invalid"],
  401: ["unauthorized", "Sign in to continue"],
  403: ["forbidden", "You don't have access to that"],
  404: ["not_found", "Not found"],
  405: ["not_found", "Not found"],
  406: ["validation_failed", "The request is invalid"],
  409: ["conflict", "That conflicts with the current state"],
  413: ["validation_failed", "The request is too large"],
  415: ["validation_failed", "Unsupported content type"],
  429: ["rate_limited", "Too many requests, try again later"],
};

/** Convert anything thrown into an `ApiError`. Exported for unit tests. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) {
    return new ApiError(400, "validation_failed", "The request is invalid", {
      fields: zodIssuePaths(err),
    });
  }
  if (isPgError(err)) return mapPgError(err);
  if (typeof err === "object" && err !== null) {
    const fe = err as FastifyError;
    if (Array.isArray(fe.validation)) {
      return new ApiError(400, "validation_failed", "The request is invalid", {
        fields: fastifyValidationPaths(fe),
      });
    }
    const status = typeof fe.statusCode === "number" ? fe.statusCode : 500;
    if (status >= 400 && status < 500) {
      const [code, message] = STATUS_FALLBACK[status] ?? [
        "validation_failed",
        "The request is invalid",
      ];
      return new ApiError(status, code, message);
    }
  }
  return internalError();
}

/**
 * Log-safe description of an error. Postgres errors: SQLSTATE and schema identifiers only (their
 * messages can quote input values). ApiErrors: code. Anything else: name, code and stack, which
 * come from our own code paths (never put secrets, emails or claims in an Error message).
 */
export function safeErrorLog(err: unknown): Record<string, unknown> {
  if (err instanceof ApiError) return { name: err.name, code: err.code, status: err.status };
  if (isPgError(err)) {
    return {
      name: "DatabaseError",
      sqlstate: err.code,
      constraint: err.constraint,
      table: err.table,
      column: err.column,
      routine: err.routine,
    };
  }
  if (err instanceof ZodError) return { name: "ZodError", fields: zodIssuePaths(err) };
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: err.name, code: typeof code === "string" ? code : undefined, stack: err.stack };
  }
  return { name: typeof err };
}

function send(reply: FastifyReply, apiErr: ApiError) {
  if (apiErr.retryAfterSec !== undefined) reply.header("retry-after", String(apiErr.retryAfterSec));
  return reply.code(apiErr.status).type("application/json; charset=utf-8").send(apiErr.toBody());
}

/**
 * Global error and not-found handlers. Register on the root instance before any routes; child
 * plugins inherit them. Response bodies are already in `apiErrorSchema` shape; we bypass route
 * response schemas by serializing directly.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const apiErr = toApiError(err);
    if (apiErr.status >= 500) {
      request.log.error({ err: safeErrorLog(err) }, "request failed");
    } else {
      request.log.debug({ code: apiErr.code, status: apiErr.status }, "request rejected");
    }
    return send(reply, apiErr);
  });

  app.setNotFoundHandler((_request, reply) => send(reply, notFound()));
}
