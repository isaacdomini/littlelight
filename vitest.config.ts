import { configDefaults, defineConfig } from "vitest/config";

// Root Vitest config (docs/plans/step-1.md 2.2).
// - `pnpm test` runs every project except `db-integration`/`api-integration`: unit tests only,
//   no DB or network.
// - `pnpm test:integration` runs `db-integration` (packages/db/**/*.integration.test.ts) and
//   `api-integration` (apps/api/**/*.integration.test.ts, docs/plans/step-3.md 3.1); those tests
//   skip themselves when DATABASE_URL is unset.
// Each folder in apps/* and packages/* is its own project; a package that needs special settings
// (e.g. jsdom for apps/mobile-web) adds its own vitest.config.ts and it is picked up automatically.
// Folder projects do NOT inherit root `test` options, while inline projects do, so the
// integration-test exclusion lives on the `pnpm test` CLI (`--exclude`), not here.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      "apps/*",
      "packages/*",
      {
        test: {
          name: "db-integration",
          root: "./packages/db",
          include: ["**/*.integration.test.ts"],
          exclude: [...configDefaults.exclude],
          environment: "node",
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "api-integration",
          root: "./apps/api",
          include: ["**/*.integration.test.ts"],
          exclude: [...configDefaults.exclude],
          environment: "node",
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
