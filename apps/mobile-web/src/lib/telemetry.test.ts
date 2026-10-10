import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../testing/native";

// Web error reporting (docs/plans/review-fixes.md 2.6, D8): off without a DSN, off in the native
// WebView, locked down and scrubbed otherwise.

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  globalHandlersIntegration: vi.fn(() => ({ name: "GlobalHandlers" })),
  linkedErrorsIntegration: vi.fn(() => ({ name: "LinkedErrors" })),
  dedupeIntegration: vi.fn(() => ({ name: "Dedupe" })),
}));
vi.mock("@sentry/react", () => sentry);

const DSN = "https://k@o1.ingest.sentry.io/2";

async function fresh() {
  vi.resetModules();
  return import("./telemetry");
}

beforeEach(() => {
  for (const f of Object.values(sentry)) f.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  setNativePlatform(null);
});

describe("web telemetry off", () => {
  it("without a DSN nothing is imported or initialised and capture is a no-op", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    const t = await fresh();
    await t.initTelemetry();
    t.captureWebError(new Error("x"));
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("inside the native app nothing is initialised even with a DSN", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    setNativePlatform("ios");
    const t = await fresh();
    await t.initTelemetry();
    t.captureWebError(new Error("x"));
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("web telemetry on", () => {
  it("initialises once with every collection category off and the scrubber as beforeSend", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const t = await fresh();
    await t.initTelemetry();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const o = sentry.init.mock.calls[0]?.[0] as Record<string, unknown> & {
      beforeSend: (e: unknown) => Record<string, unknown>;
      beforeBreadcrumb: () => unknown;
      integrations: { name: string }[];
    };
    expect(o.dsn).toBe(DSN);
    expect(o.defaultIntegrations).toBe(false);
    expect(o.tracesSampleRate).toBe(0);
    expect(o.maxBreadcrumbs).toBe(0);
    expect(o.beforeBreadcrumb()).toBeNull();
    expect(o.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });
    expect(o.integrations.map((i) => i.name).sort()).toEqual([
      "Dedupe",
      "GlobalHandlers",
      "LinkedErrors",
    ]);
    // no replay / feedback / browser tracing integration
    expect(JSON.stringify(o)).not.toMatch(/replay|feedback|browserTracing/i);

    const scrubbed = o.beforeSend({
      message: "token in https://app.test/s/Ab3dE6gH9jK2mN5pQ8sT1v by mom@example.com",
      request: { url: "https://app.test/s/Ab3dE6gH9jK2mN5pQ8sT1v" },
      breadcrumbs: [{ message: "x" }],
      user: { email: "mom@example.com" },
    });
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain("Ab3dE6gH9jK2mN5pQ8sT1v");
    expect(text).not.toContain("mom@example.com");
    expect(scrubbed).not.toHaveProperty("request");
    expect(scrubbed).not.toHaveProperty("breadcrumbs");
    expect(scrubbed).not.toHaveProperty("user");
  });

  it("errors raised before init are queued (max 10) and flushed once the SDK is ready", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const t = await fresh();
    for (let i = 0; i < 15; i++) t.captureWebError(new Error(`e${i}`));
    expect(sentry.captureException).not.toHaveBeenCalled();
    await t.initTelemetry();
    expect(sentry.captureException).toHaveBeenCalledTimes(10);
    t.captureWebError(new Error("later"));
    expect(sentry.captureException).toHaveBeenCalledTimes(11);
  });

  it("an SDK that fails to load never breaks the app", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    sentry.init.mockImplementationOnce(() => {
      throw new Error("sdk broke");
    });
    const t = await fresh();
    await expect(t.initTelemetry()).resolves.toBeUndefined();
    expect(() => t.captureWebError(new Error("x"))).not.toThrow();
  });
});
