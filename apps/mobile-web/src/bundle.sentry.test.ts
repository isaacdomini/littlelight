import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

// Telemetry is opt-in at build time (docs/plans/review-fixes.md 2.6, R.7): without a
// VITE_SENTRY_DSN the production bundle must contain no Sentry code at all (no chunk, no
// dynamic import, no SDK string), so a self-hoster who sets nothing ships nothing. With a DSN the
// SDK is a lazy chunk, never part of the entry bundle.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(dsn: string): Promise<Rollup.OutputChunk[]> {
  const saved = process.env.VITE_SENTRY_DSN;
  if (dsn) process.env.VITE_SENTRY_DSN = dsn;
  else delete process.env.VITE_SENTRY_DSN;
  try {
    const out = await build({
      root,
      logLevel: "silent",
      mode: "production",
      envFile: false,
      build: { write: false, minify: false, reportCompressedSize: false },
    });
    const outputs = Array.isArray(out) ? out : [out];
    return outputs.flatMap((o) =>
      "output" in o ? o.output.filter((c): c is Rollup.OutputChunk => c.type === "chunk") : [],
    );
  } finally {
    if (saved === undefined) delete process.env.VITE_SENTRY_DSN;
    else process.env.VITE_SENTRY_DSN = saved;
  }
}

describe("web bundle and Sentry", () => {
  it("without a DSN: no Sentry code in any chunk, and no dynamic import of the SDK", async () => {
    const chunks = await bundle("");
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.code, c.fileName).not.toMatch(/@sentry|sentry\.io|Sentry\.init|captureException/i);
      expect(c.facadeModuleId ?? "", c.fileName).not.toMatch(/sentry/i);
      expect(Object.keys(c.modules).join("\n"), c.fileName).not.toMatch(/@sentry/);
    }
  }, 240_000);

  it("with a DSN: the SDK is a separate lazy chunk, absent from the entry chunk", async () => {
    const chunks = await bundle("https://k@o1.ingest.sentry.io/2");
    const withSdk = chunks.filter((c) => Object.keys(c.modules).some((m) => m.includes("@sentry")));
    expect(withSdk.length).toBeGreaterThan(0);
    const entries = chunks.filter((c) => c.isEntry);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(
        Object.keys(e.modules).some((m) => m.includes("@sentry")),
        e.fileName,
      ).toBe(false);
    }
  }, 240_000);
});
