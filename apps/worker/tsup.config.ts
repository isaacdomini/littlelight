import { defineConfig } from "tsup";

// Contract (docs/plans/step-1.md 2.13): bundle workspace packages (they export TS source),
// keep npm dependencies external so production node_modules supplies them.
export default defineConfig({
  entry: ["src/main.ts", "src/healthcheck.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@littlelight\//],
});
