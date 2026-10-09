import { defineConfig } from "tsup";

// Contract (docs/plans/step-1.md 2.13): bundle workspace packages (they export TS source),
// keep npm dependencies external so production node_modules supplies them.
export default defineConfig({
  // `demo-media` (docs/plans/step-9.md 2.11): `node dist/demo-media.js --review-baby <id> --confirm-production`.
  entry: {
    main: "src/main.ts",
    healthcheck: "src/healthcheck.ts",
    "run-job": "src/run-job.ts",
    "demo-media": "src/demo/demo-media.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@littlelight\//],
});
