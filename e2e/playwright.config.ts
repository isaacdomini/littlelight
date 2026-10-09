import { defineConfig, devices } from "@playwright/test";

// e2e against the running dev stack (`docker compose -f docker-compose.dev.yml up -d --build --wait`).
// The stack is NOT started from here. Override the URLs with E2E_BASE_URL / E2E_MAILPIT_URL.
export default defineConfig({
  // Restores the seeded dev state (Maya's AI rows, leftover babies, sign-in throttle) first.
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // The perf spec needs the 10,000-photo perf baby and has its own config (playwright.perf.config.ts).
  testIgnore: "**/perf/**",
  outputDir: "./test-results",
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "./report", open: "never" }]]
    : [["list"], ["html", { outputFolder: "./report", open: "never" }]],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Pixel 5"],
    viewport: { width: 375, height: 812 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
