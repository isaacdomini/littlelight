import * as Sentry from "@sentry/node";
import { scrubTelemetryEvent } from "@tinyglow/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import pkg from "../../package.json" with { type: "json" };
import type { ApiConfig } from "../config";
import { isPgError, toApiError } from "../lib/errors";

// Error telemetry (docs/plans/review-fixes.md 2.6, D7, D8; PRD "Architecture and tech stack →
// Observability"). Errors only, off unless `SENTRY_DSN` is set (dev sets none: nothing is
// initialised, no network, no log line).
//
// What can reach an event, and only that:
// - the exception (type, message, stack frames) of a request that ended in a 5xx, or of an
//   uncaught exception / unhandled rejection (the two process integrations), plus linked causes;
// - tags `{ service, route, method, status }` where `route` is the route PATTERN
//   (`/babies/:id/exports`), never the actual URL (ids, tokens, query strings).
// Default integrations are off, so no request data, headers, cookies, bodies, http/pg/fastify
// spans, console breadcrumbs, modules, env or OS context are ever collected; `tracesSampleRate:
// 0` (no performance data), no breadcrumbs at all, and every event passes the shared scrubber
// (`scrubTelemetryEvent`) as `beforeSend`. Postgres errors are captured as a synthetic error
// naming the SQLSTATE only: their messages and `detail` can quote row values.

/** `Sentry.close` timeout on shutdown (ms). */
export const TELEMETRY_CLOSE_TIMEOUT_MS = 2000;

/** The exact options passed to `Sentry.init` (exported for tests and the hygiene check). */
export function sentryOptions(env: {
  SENTRY_DSN: string;
  SENTRY_ENVIRONMENT: string;
}): Sentry.NodeOptions {
  return {
    dsn: env.SENTRY_DSN,
    enabled: true,
    environment: env.SENTRY_ENVIRONMENT,
    release: `tinyglow-api@${pkg.version}`,
    // Sentry 11 replaced `sendDefaultPii` with `dataCollection`: every category off (user info,
    // cookies, headers, bodies, query params, DB/queue payloads, GraphQL, gen-AI I/O, local
    // variables, source context lines). No integration that would collect them is installed
    // anyway; this is the second lock.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    includeServerName: false,
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: false }),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
    ],
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubTelemetryEvent(event),
    attachStacktrace: true,
    normalizeDepth: 3,
    // No OpenTelemetry tracer provider and no module-load hooks: nothing is instrumented.
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
  };
}

/**
 * Initialise Sentry when `SENTRY_DSN` is set; call first thing in `server.ts`, before
 * `buildApp`. Returns whether telemetry is on. Never logs or prints the DSN.
 */
export function initTelemetry(
  config: Pick<ApiConfig, "SENTRY_DSN" | "SENTRY_ENVIRONMENT" | "NODE_ENV">,
): boolean {
  if (!config.SENTRY_DSN) return false;
  if (Sentry.isInitialized()) return true;
  Sentry.init(
    sentryOptions({
      SENTRY_DSN: config.SENTRY_DSN,
      SENTRY_ENVIRONMENT: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    }),
  );
  return Sentry.isInitialized();
}

/** True while a Sentry client is active (`initTelemetry` ran with a DSN). */
export function telemetryEnabled(): boolean {
  return Sentry.isInitialized();
}

/**
 * What is captured for `err`: Postgres errors become `DatabaseError: sqlstate <code>` with the
 * original stack frames (the message line dropped); everything else is captured as is (our own
 * messages, which never carry secrets; the scrubber runs on them anyway). Exported for tests.
 */
export function capturableError(err: unknown): unknown {
  if (!isPgError(err)) return err;
  const safe = new Error(`sqlstate ${err.code}`);
  safe.name = "DatabaseError";
  const stack = (err as { stack?: unknown }).stack;
  if (typeof stack === "string") {
    const frames = stack
      .split("\n")
      .filter((line) => /^\s+at /.test(line))
      .join("\n");
    safe.stack = `${safe.name}: ${safe.message}${frames ? `\n${frames}` : ""}`;
  }
  return safe;
}

/** Tags of a captured request error: the route pattern, never the URL. Exported for tests. */
export function requestErrorTags(
  request: Pick<FastifyRequest, "method" | "routeOptions">,
  status: number,
): Record<string, string> {
  return {
    service: "api",
    route: request.routeOptions?.url ?? "(unmatched)",
    method: request.method,
    status: String(status),
  };
}

/**
 * Capture `err` for a request that will be answered with `status` (>= 500 only). No-op while
 * telemetry is off.
 */
export function captureRequestError(
  request: Pick<FastifyRequest, "method" | "routeOptions">,
  err: unknown,
  status: number,
): void {
  if (status < 500 || !Sentry.isInitialized()) return;
  const tags = requestErrorTags(request, status);
  Sentry.withScope((scope) => {
    scope.setTags(tags);
    Sentry.captureException(capturableError(err));
  });
}

/**
 * Register the capture hook and the flush on close. Call in `buildApp` right after
 * `registerErrorHandling`. Without an initialised client (no DSN, or tests) nothing is added.
 */
export function registerTelemetry(app: FastifyInstance): void {
  if (!Sentry.isInitialized()) return;
  // `onError` runs before the error handler with the original error; the status is the one the
  // error handler will answer with (`toApiError`), so 4xx (validation, RLS denials, rate limits,
  // expected conflicts) are never captured.
  app.addHook("onError", async (request, _reply, err) => {
    captureRequestError(request, err, toApiError(err).status);
  });
  app.addHook("onClose", async () => {
    await Sentry.close(TELEMETRY_CLOSE_TIMEOUT_MS).catch(() => false);
  });
}
