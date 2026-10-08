import { configDefaults, defineConfig } from "vitest/config";

// Root Vitest config (docs/plans/step-1.md 2.2).
// - `pnpm test` runs every project except the `*-integration` ones: unit tests only, no DB or
//   network.
// - `pnpm test:integration` runs `db-integration` (packages/db/**/*.integration.test.ts),
//   `api-integration` (apps/api/**/*.integration.test.ts, docs/plans/step-3.md 3.1) and
//   `worker-integration` (apps/worker/**/*.integration.test.ts, docs/plans/step-4.md 4.1; 120 s
//   timeouts for image processing + MinIO); those tests skip themselves when DATABASE_URL is unset.
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
      {
        test: {
          name: "worker-integration",
          root: "./apps/worker",
          include: ["**/*.integration.test.ts"],
          exclude: [...configDefaults.exclude],
          environment: "node",
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
