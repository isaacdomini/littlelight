import { defineConfig } from "@playwright/test";

// Timeline scroll performance against the running dev stack with the perf baby seeded
// (`pnpm perf:seed`). Not part of `pnpm e2e`. Thresholds switch with PERF_CI=1 (shared runners).
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;

export default defineConfig({
  testDir: "./perf",
  testMatch: "**/*.perf.spec.ts",
  outputDir: "./test-results-perf",
  reporter: [["list"]],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "phone", use: { browserName: "chromium", viewport: { width: 375, height: 812 } } },
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
  ],
});
