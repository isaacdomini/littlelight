// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_UPDATE_EXCLUDE_PREFIXES,
  APP_UPDATE_MANIFEST_PATH,
  appUpdateContentId,
  appUpdateManifestSchema,
} from "@tinyglow/shared";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without type declarations
import * as gen from "./app-update-manifest.mjs";

// Manifest generator (docs/plans/step-14.md 2.4, 2.10): runs the real script on a fixture dist.

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "app-update-manifest.mjs");
const CONFIG = JSON.parse(readFileSync(join(here, "..", "app-update.json"), "utf8")) as {
  webVersion: string;
  minNativeBuild: { ios: number; android: number };
};
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "tg-manifest-"));
  tmp.push(dir);
  const put = (p: string, body: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  };
  put("index.html", "<html><script type=module src=/assets/app-1.js></script></html>");
  put("assets/app-1.js", "console.log(1)");
  put("assets/Z.css", "body{}");
  put("favicon.ico", "\u0000\u0001");
  put(".well-known/apple-app-site-association", "{}");
  put("email-templates/magic.html", "<p>hi</p>");
  put("app-update/manifest.json", '{"stale":true}');
  return dir;
}

function run(dir: string, env: Record<string, string> = {}) {
  execFileSync(process.execPath, [SCRIPT, dir], { env: { ...process.env, ...env }, stdio: "pipe" });
  return JSON.parse(readFileSync(join(dir, APP_UPDATE_MANIFEST_PATH), "utf8"));
}

describe("app-update-manifest.mjs", () => {
  it("keeps the exclude list and content id in step with @tinyglow/shared", () => {
    expect(gen.EXCLUDE_PREFIXES).toEqual([...APP_UPDATE_EXCLUDE_PREFIXES]);
    expect(gen.MANIFEST_PATH).toBe(APP_UPDATE_MANIFEST_PATH);
    const files = [
      { path: "index.html", sha256: "0".repeat(64) },
      { path: "Z.txt", sha256: "1".repeat(64) },
      { path: "a.txt", sha256: "2".repeat(64) },
    ];
    expect(gen.contentId(files)).toBe("0d576c52526db35a");
    expect(gen.contentId(files)).toBe(appUpdateContentId(files));
  });

  it("writes a schema-valid, sorted manifest without excluded paths", () => {
    const dir = fixture();
    const m = run(dir);
    expect(appUpdateManifestSchema.safeParse(m).success).toBe(true);
    const paths = (m.files as { path: string }[]).map((f) => f.path);
    expect(paths).toEqual(["assets/Z.css", "assets/app-1.js", "favicon.ico", "index.html"]);
    expect(m.version).toBe(appUpdateContentId(m.files));
    expect(m.webVersion).toBe(CONFIG.webVersion);
    expect(m.minNativeBuild).toEqual(CONFIG.minNativeBuild);
    const js = (m.files as { path: string; sha256: string; size: number }[]).find(
      (f) => f.path === "assets/app-1.js",
    );
    expect(js?.sha256).toBe(createHash("sha256").update("console.log(1)").digest("hex"));
    expect(js?.size).toBe(14);
    const raw = readFileSync(join(dir, APP_UPDATE_MANIFEST_PATH), "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw).toContain('\n  "schema": 1');
  });

  it("is deterministic: re-running (manifest present) gives the same content; builtAt pinned by SOURCE_DATE_EPOCH", () => {
    const dir = fixture();
    const a = run(dir, { SOURCE_DATE_EPOCH: "1760000000" });
    const b = run(dir, { SOURCE_DATE_EPOCH: "1760000000" });
    expect(b).toEqual(a);
    expect(a.builtAt).toBe(new Date(1760000000 * 1000).toISOString());
    const c = run(dir, { SOURCE_DATE_EPOCH: "1760000999" });
    expect(c.version).toBe(a.version);
  });

  it("a one-byte content change gives a new version", () => {
    const dir = fixture();
    const a = run(dir);
    writeFileSync(
      join(dir, "index.html"),
      `${readFileSync(join(dir, "index.html"), "utf8")}<!--B-->`,
    );
    expect(run(dir).version).not.toBe(a.version);
  });

  it("fails without index.html and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-manifest-"));
    tmp.push(dir);
    writeFileSync(join(dir, "a.js"), "x");
    expect(() => run(dir)).toThrow();
    expect(existsSync(join(dir, APP_UPDATE_MANIFEST_PATH))).toBe(false);
  });

  it("parity on a real vite dist (when apps/mobile-web/dist exists)", () => {
    const dist = resolve(here, "..", "dist");
    if (!existsSync(join(dist, "index.html"))) return;
    const files = gen.collectFiles(dist) as { path: string; sha256: string }[];
    const m = gen.buildManifest(dist, CONFIG);
    expect(m.version).toBe(appUpdateContentId(files));
    expect(appUpdateManifestSchema.safeParse(m).success).toBe(true);
  });
});
