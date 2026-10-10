import * as Sentry from "@sentry/node";
import { scrubTelemetryEvent } from "@tinyglow/shared";
import type { WorkerConfig } from "./config";
import { WORKER_VERSION } from "./version";

// Worker error telemetry (docs/plans/review-fixes.md 2.6, D7, D8; PRD "Architecture and tech
// stack → Observability"). Same setup as the api (`apps/api/src/plugins/telemetry.ts`): errors
// only, off unless `SENTRY_DSN` is set (dev sets none: nothing is initialised, no network, no log
// line), every `dataCollection` category off, default integrations off (no http/pg/console
// instrumentation, no breadcrumbs, no request/env/OS context), `tracesSampleRate: 0`, and every
// event passes the shared scrubber (`scrubTelemetryEvent`) as `beforeSend`.
//
// What can reach an event: the exception (type, message, stack frames) of a failed job handler,
// a pg-boss error, a start-up failure or an uncaught exception / unhandled rejection, with tags
// `{ service: "worker", queue }` only (never a job payload, id, key, URL, email or coordinate).
// Postgres errors are captured as a synthetic error naming the SQLSTATE only (their messages
// and `detail` can quote row values).

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
    release: `tinyglow-worker@${WORKER_VERSION}`,
    // Sentry 11 replaced `sendDefaultPii` with `dataCollection`: every category off.
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
 * Initialise Sentry when `SENTRY_DSN` is set; call first thing in `main.ts`. Returns whether
 * telemetry is on. Never logs or prints the DSN.
 */
export function initTelemetry(
  config: Pick<WorkerConfig, "SENTRY_DSN" | "SENTRY_ENVIRONMENT" | "NODE_ENV">,
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

/** True while a Sentry client is active. */
export function telemetryEnabled(): boolean {
  return Sentry.isInitialized();
}

/** A Postgres error as far as we can tell: a 5-character SQLSTATE plus a `severity`. */
function isPgError(err: unknown): err is { code: string; stack?: string } {
  if (typeof err !== "object" || err === null) return false;
  const { code, severity } = err as { code?: unknown; severity?: unknown };
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && typeof severity === "string";
}

/**
 * What is captured for `err`: Postgres errors become `DatabaseError: sqlstate <code>` with the
 * original stack frames (message dropped); everything else as is (the scrubber runs on it).
 */
export function capturableError(err: unknown): unknown {
  if (!isPgError(err)) return err;
  const safe = new Error(`sqlstate ${err.code}`);
  safe.name = "DatabaseError";
  if (typeof err.stack === "string") {
    const frames = err.stack
      .split("\n")
      .filter((line) => /^\s+at /.test(line))
      .join("\n");
    safe.stack = `${safe.name}: ${safe.message}${frames ? `\n${frames}` : ""}`;
  }
  return safe;
}

/** Capture one worker error with tags `{ service: "worker", queue }`. No-op while off. */
export function captureJobError(queue: string, err: unknown): void {
  if (!Sentry.isInitialized()) return;
  Sentry.withScope((scope) => {
    scope.setTags({ service: "worker", queue });
    Sentry.captureException(capturableError(err));
  });
}

/**
 * Wrap a `boss.work` callback: a thrown error is captured (tags `{service, queue}`) and
 * rethrown unchanged, so pg-boss retry/fail semantics are exactly as before.
 */
export function wrapHandler<A extends unknown[], R>(
  queue: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      captureJobError(queue, err);
      throw err;
    }
  };
}

/** Flush and stop (shutdown). Never throws. */
export async function closeTelemetry(): Promise<void> {
  if (!Sentry.isInitialized()) return;
  await Sentry.close(TELEMETRY_CLOSE_TIMEOUT_MS).catch(() => false);
}
