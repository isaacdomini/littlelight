import { isNative } from "../platform/platform";

// Web error reporting (docs/plans/review-fixes.md 2.6, D8). Errors only: no default integrations,
// no tracing, no breadcrumbs, no replay, no PII. Every event goes through the shared scrubber.
// The SDK is a lazy chunk loaded only when a DSN was baked into the build and we are not inside a
// Capacitor WebView (the native apps send nothing). With no DSN, the dynamic import below is
// dead code under `import.meta.env` replacement, so the bundle contains no Sentry at all.

type CaptureFn = (error: unknown) => void;
let capture: CaptureFn | null = null;
const pending: unknown[] = [];

/** Report an error that React or the window surfaced. A no-op when telemetry is off. */
export function captureWebError(error: unknown): void {
  if (!import.meta.env.VITE_SENTRY_DSN || isNative()) return;
  if (capture) capture(error);
  else if (pending.length < 10) pending.push(error);
}

export async function initTelemetry(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn || isNative()) return;
  try {
    const [Sentry, { scrubTelemetryEvent }] = await Promise.all([
      import("@sentry/react"),
      import("@littlelight/shared"),
    ]);
    Sentry.init({
      dsn,
      enabled: true,
      environment: import.meta.env.MODE,
      // Sentry 11 `dataCollection`, every category off (same lock as the API): no user info,
      // cookies, headers, bodies, query params or source context lines.
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
      defaultIntegrations: false,
      integrations: [
        Sentry.globalHandlersIntegration(),
        Sentry.linkedErrorsIntegration(),
        Sentry.dedupeIntegration(),
      ],
      tracesSampleRate: 0,
      maxBreadcrumbs: 0,
      beforeBreadcrumb: () => null,
      beforeSend: (event) => scrubTelemetryEvent(event),
      attachStacktrace: true,
      normalizeDepth: 3,
      initialScope: { tags: { service: "web" } },
    });
    capture = (error) => {
      Sentry.captureException(error);
    };
    for (const e of pending.splice(0)) capture(e);
  } catch {
    // Reporting must never break the app.
  }
}
