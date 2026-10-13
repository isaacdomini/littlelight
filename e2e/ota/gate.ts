/**
 * Step-14 OTA gate, api side (docs/plans/step-14.md 2.10, 4.3): live updates of the web bundle.
 *
 *   docker compose -f docker-compose.dev.yml up -d --wait
 *   pnpm e2e:ota-gate                      # builds the web once into a temp dir
 *   OTA_GATE_DIST=apps/mobile-web/dist pnpm e2e:ota-gate   # reuse a built dist (with manifest)
 *
 * Dev stack only. Serves bundle variants from a host static server on :18090 (`serve.ts`),
 * recreates the api with APP_UPDATE_SOURCE_URL / APP_UPDATE_FILES_BASE_URL pointing at it, asserts
 * through GET /api/app-update/manifest, verifies the signed envelope with the TS reference of the
 * phone's algorithm (`verify.ts`), and restores the api to the stack defaults in `finally`. No model
 * is involved (the AI provider stays as configured; VISION_PROVIDER is never set).
 *
 * Variants: A = the build; B = A + a comment in index.html (new content id); C = A without its
 * module script (boots blank, never calls notifyAppReady; used by the native gates).
 *
 * Checks:
 *  1. A web client (no / web X-Tinyglow-Client) gets `disabled`; a bad platform is 400.
 *  2. Serving B: native ios/android get an envelope; keyId dev; signature verifies with the dev
 *     SPKI (Node crypto) and not with prod; baseUrl = http://localhost:18090; version = B's id.
 *  3. B verifies end to end (signature -> parse -> rules -> download -> sha256); delta vs A < 2 MiB.
 *  4. current=<B> -> up_to_date; native build below minNativeBuild -> native_too_old (verify.ts too).
 *  5. A manifest with minNativeBuild.ios = 99 -> native_too_old for ios, an envelope for android.
 *  6. A tampered manifest (one hash edited) is still signed by the server (it signs what it is
 *     given), and verify.ts reports verify_failed; a flipped signature byte -> rejected.
 *  7. Upstream 404 -> unavailable.
 *  8. APP_UPDATE_ENABLED=false -> disabled.
 *  9. Log tap: the api's logs hold no signature, manifestJson, native=/current= values, URL of the
 *     OTA server or key material.
 * 10. Restore: after `finally` the api answers `unavailable` (Vite dev: no manifest; inert).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  APP_UPDATE_CELLULAR_MAX_BYTES,
  APP_UPDATE_PUBLIC_KEYS,
  type AppUpdateManifest,
  type AppUpdateManifestResponse,
  appUpdateManifestResponseSchema,
} from "../../packages/shared/src/index";
import { devSigningKey } from "./make-vectors";
import { startOtaServer } from "./serve";
import { verifyEnvelope, verifySignature } from "./verify";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const WEB = path.join(ROOT, "apps/mobile-web");
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;
const PORT = 18090;
const SOURCE_URL = `http://host.docker.internal:${PORT}/manifest.json`;
const FILES_URL = `http://localhost:${PORT}`;
const TTL_WAIT_MS = 61_000; // the api caches a good manifest for 60 s
const DEV = APP_UPDATE_PUBLIC_KEYS.dev;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
}
async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    check(`${name} (crashed)`, false, e instanceof Error ? e.message : String(e));
  }
}

const OTA_ENV = ["APP_UPDATE_SOURCE_URL", "APP_UPDATE_FILES_BASE_URL", "APP_UPDATE_ENABLED"];
async function dc(args: string[], env: Record<string, string> = {}) {
  // A caller's value must not leak into compose (the restore must give the stack defaults).
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !OTA_ENV.includes(k) && k !== "VISION_PROVIDER"),
  );
  return sh("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: ROOT,
    env: { ...inherited, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Recreate the api with `env` and wait until it answers through the web proxy. */
async function recreateApi(env: Record<string, string>): Promise<void> {
  await dc(["up", "-d", "--no-deps", "--wait", "api"], env);
  for (const end = Date.now() + 120_000; Date.now() < end; ) {
    const ok = await fetch(`${BASE}/api/healthz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await sleep(1000);
  }
  throw new Error("api did not come up");
}

async function apiLogs(): Promise<string> {
  return (await dc(["logs", "--no-color", "api"])).stdout;
}

async function ask(
  qs: string,
  client: string | null = "native",
): Promise<{ status: number; body: AppUpdateManifestResponse | null; cache: string | null }> {
  const res = await fetch(`${BASE}/api/app-update/manifest?${qs}`, {
    headers: client ? { "X-Tinyglow-Client": client } : {},
  });
  const json = await res.json().catch(() => null);
  const parsed = appUpdateManifestResponseSchema.safeParse(json);
  return {
    status: res.status,
    body: parsed.success ? parsed.data : null,
    cache: res.headers.get("cache-control"),
  };
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function manifestOf(dir: string): AppUpdateManifest {
  return JSON.parse(readFileSync(path.join(dir, "app-update/manifest.json"), "utf8"));
}

/** Re-run the real generator on a variant dir (writes its app-update/manifest.json). */
async function generate(dir: string): Promise<AppUpdateManifest> {
  await sh(process.execPath, [path.join(WEB, "scripts/app-update-manifest.mjs"), dir], {
    cwd: WEB,
  });
  return manifestOf(dir);
}

async function buildWeb(out: string): Promise<void> {
  console.log("building the web once (vite build) ...");
  await sh("pnpm", ["exec", "vite", "build", "--outDir", out, "--emptyOutDir"], {
    cwd: WEB,
    env: { ...process.env, VITE_API_URL: "http://localhost:8080" },
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function main(): Promise<void> {
  const health = await fetch(`${BASE}/api/healthz`).catch(() => null);
  if (!health?.ok) {
    console.error(
      `dev stack not reachable at ${BASE}; run docker compose -f docker-compose.dev.yml up -d --wait`,
    );
    process.exit(1);
  }
  const tmp = mkdtempSync(path.join(tmpdir(), "tg-ota-gate-"));
  const A = path.join(tmp, "A");
  const B = path.join(tmp, "B");
  const C = path.join(tmp, "C");
  const reuse = process.env.OTA_GATE_DIST;
  if (reuse) {
    cpSync(path.resolve(ROOT, reuse), A, { recursive: true });
  } else {
    await buildWeb(A);
  }
  const mA = await generate(A);
  cpSync(A, B, { recursive: true });
  writeFileSync(
    path.join(B, "index.html"),
    `${readFileSync(path.join(B, "index.html"), "utf8")}<!-- ota-gate variant B ${Date.now()} -->\n`,
  );
  const mB = await generate(B);
  cpSync(A, C, { recursive: true });
  writeFileSync(
    path.join(C, "index.html"),
    readFileSync(path.join(C, "index.html"), "utf8").replace(
      /<script type="module"[^>]*><\/script>/g,
      "",
    ),
  );
  const mC = await generate(C);
  check(
    "variants A, B, C have distinct content ids",
    new Set([mA.version, mB.version, mC.version]).size === 3,
  );
  check(
    "C has no module script (blank boot, never notifyAppReady)",
    !readFileSync(path.join(C, "index.html"), "utf8").includes('type="module"'),
  );

  const server = await startOtaServer(B, PORT);
  let signatureSeen = "";
  let manifestJsonSeen = "";
  try {
    await recreateApi({ APP_UPDATE_SOURCE_URL: SOURCE_URL, APP_UPDATE_FILES_BASE_URL: FILES_URL });

    // ---- 1. web clients and bad queries -------------------------------------------------------
    await guarded("web clients", async () => {
      const none = await ask("platform=ios&native=1", null);
      const web = await ask("platform=ios&native=1", "web");
      check(
        "no X-Tinyglow-Client -> disabled",
        none.body?.update === null && none.body.reason === "disabled",
        JSON.stringify(none.body),
      );
      check("X-Tinyglow-Client: web -> disabled", web.body?.reason === "disabled");
      const bad = await ask("platform=mac&native=1");
      check("platform=mac -> 400", bad.status === 400);
      check(
        "Cache-Control: no-store on 200 and 400",
        none.cache === "no-store" && bad.cache === "no-store",
      );
    });

    // ---- 2. signed envelope for B -------------------------------------------------------------
    await guarded("envelope", async () => {
      const r = await ask(`platform=ios&native=1&current=${mA.version}`);
      const env = r.body?.update;
      check("native ios on A: an update is offered", !!env, JSON.stringify(r.body));
      if (!env) return;
      signatureSeen = env.signature;
      manifestJsonSeen = env.manifestJson;
      check("keyId is dev", env.keyId === DEV.keyId);
      check(
        "signature verifies with the dev SPKI",
        verifySignature(DEV.spkiBase64, env.manifestJson, env.signature),
      );
      check(
        "signature does not verify with the prod SPKI",
        !verifySignature(APP_UPDATE_PUBLIC_KEYS.prod.spkiBase64, env.manifestJson, env.signature),
      );
      check("DER signature <= 72 bytes", Buffer.from(env.signature, "base64").length <= 72);
      const m = JSON.parse(env.manifestJson);
      check("baseUrl is the OTA server", m.baseUrl === FILES_URL, m.baseUrl);
      check("version is B's content id", m.version === mB.version);
      const and = await ask(`platform=android&native=1&current=${mA.version}`);
      check(
        "native android gets the same envelope text",
        and.body?.update?.manifestJson === env.manifestJson,
      );

      // ---- 3. end to end + delta ----
      const v = await verifyEnvelope(env, { trusted: [DEV], platform: "ios", nativeBuild: 1 });
      check("B verifies end to end (signature, rules, download, sha256)", v.ok, v.ok ? "" : v.why);
      const have = new Map(mA.files.map((f) => [f.path, f.sha256]));
      const delta = await verifyEnvelope(env, {
        trusted: [DEV],
        platform: "ios",
        nativeBuild: 1,
        have,
      });
      check(
        `delta A -> B (${delta.ok ? delta.bytes : "?"} bytes) < 2 MiB`,
        delta.ok && delta.bytes > 0 && delta.bytes < APP_UPDATE_CELLULAR_MAX_BYTES,
      );
      const prodOnly = await verifyEnvelope(env, {
        trusted: [APP_UPDATE_PUBLIC_KEYS.prod],
        platform: "ios",
        nativeBuild: 1,
      });
      check(
        "a release build (prod key only) rejects the dev-signed envelope",
        !prodOnly.ok && prodOnly.outcome === "rejected",
      );
      const flipped = Buffer.from(env.signature, "base64");
      flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 1;
      const bad = await verifyEnvelope(
        { ...env, signature: flipped.toString("base64") },
        { trusted: [DEV], platform: "ios", nativeBuild: 1 },
      );
      check("flipped signature byte -> rejected", !bad.ok && bad.outcome === "rejected");
    });

    // ---- 4. up_to_date ------------------------------------------------------------------------
    await guarded("up_to_date", async () => {
      const r = await ask(`platform=ios&native=1&current=${mB.version}`);
      check("current=<B> -> up_to_date", r.body?.reason === "up_to_date", JSON.stringify(r.body));
    });

    // ---- 5. native_too_old (new manifest: wait for the api's 60 s cache) ---------------------
    await guarded("native_too_old", async () => {
      const old = {
        ...mB,
        minNativeBuild: { ios: 99, android: 1 },
        builtAt: new Date().toISOString(),
      };
      server.setManifest(JSON.stringify(old));
      console.log("waiting 61 s for the api's manifest cache ...");
      await sleep(TTL_WAIT_MS);
      const ios = await ask(`platform=ios&native=98&current=${mA.version}`);
      check(
        "minNativeBuild.ios 99, native 98 -> native_too_old",
        ios.body?.reason === "native_too_old",
        JSON.stringify(ios.body),
      );
      const ios99 = await ask(`platform=ios&native=99&current=${mA.version}`);
      check("native 99 -> offered", !!ios99.body?.update);
      const and = await ask(`platform=android&native=1&current=${mA.version}`);
      check("android (min 1) still offered", !!and.body?.update);
      if (ios99.body?.update) {
        const v = await verifyEnvelope(ios99.body.update, {
          trusted: [DEV],
          platform: "ios",
          nativeBuild: 12,
        });
        check(
          "verify.ts: native 12 < 99 -> native_too_old",
          !v.ok && v.outcome === "native_too_old",
        );
      }
    });

    // ---- 6. tampered manifest -----------------------------------------------------------------
    await guarded("tampered", async () => {
      const victim = mB.files.find((f) => f.path.endsWith(".js")) ?? mB.files[0];
      if (!victim) throw new Error("no file to tamper");
      const tampered = {
        ...mB,
        builtAt: new Date(Date.now() + 1000).toISOString(),
        files: mB.files.map((f) =>
          f.path === victim.path ? { ...f, sha256: sha(`evil ${f.path}`) } : f,
        ),
      };
      server.setManifest(JSON.stringify(tampered));
      console.log("waiting 61 s for the api's manifest cache ...");
      await sleep(TTL_WAIT_MS);
      const r = await ask(`platform=ios&native=1&current=${mA.version}`);
      const env = r.body?.update;
      check(
        "tampered manifest is still signed by the server",
        !!env && verifySignature(DEV.spkiBase64, env.manifestJson, env.signature),
      );
      if (env) {
        const v = await verifyEnvelope(env, { trusted: [DEV], platform: "ios", nativeBuild: 1 });
        check(
          "verify.ts: tampered hash -> verify_failed",
          !v.ok && v.outcome === "verify_failed",
          v.ok ? "ok" : v.why,
        );
      }
    });

    // ---- 7. upstream 404 ----------------------------------------------------------------------
    await guarded("unavailable", async () => {
      server.setManifest(null);
      server.setManifestStatus(404);
      await sleep(TTL_WAIT_MS);
      const r = await ask(`platform=ios&native=1&current=${mA.version}`);
      check(
        "upstream 404 -> unavailable",
        r.body?.reason === "unavailable",
        JSON.stringify(r.body),
      );
      server.setManifestStatus(null);
    });

    // ---- 9. log tap (before the recreate below drops this container's logs) ------------------
    await guarded("log tap", async () => {
      const logs = await apiLogs();
      const leaks: string[] = [];
      const needles: [string, string][] = [
        ["signature", signatureSeen],
        ["manifestJson text", manifestJsonSeen.slice(0, 40)],
        ["B content id", mB.version],
        ["OTA server URL", `:${PORT}`],
        ["host.docker.internal", "host.docker.internal"],
        ["native=", "native="],
        ["current=", "current="],
        ["signing key", devSigningKey().slice(40, 80)],
      ];
      for (const [name, needle] of needles) if (needle && logs.includes(needle)) leaks.push(name);
      check(
        "api logs: no signature, manifest, query values, OTA URL or key",
        leaks.length === 0,
        leaks.join(", "),
      );
      check(
        "api logs record the check outcomes",
        /app update check/.test(logs) && /outcome\W+update\b/.test(logs),
      );
    });

    // ---- 8. kill switch -----------------------------------------------------------------------
    await guarded("disabled", async () => {
      await recreateApi({
        APP_UPDATE_SOURCE_URL: SOURCE_URL,
        APP_UPDATE_FILES_BASE_URL: FILES_URL,
        APP_UPDATE_ENABLED: "false",
      });
      const before = server.requests.length;
      const r = await ask(`platform=ios&native=1&current=${mA.version}`);
      check(
        "APP_UPDATE_ENABLED=false -> disabled",
        r.body?.reason === "disabled",
        JSON.stringify(r.body),
      );
      check("disabled: the upstream is never fetched", server.requests.length === before);
    });
  } finally {
    await server.close();
    try {
      await recreateApi({});
      const r = await ask("platform=ios&native=1");
      check(
        "restored: api on stack defaults answers unavailable (inert)",
        r.body?.reason === "unavailable",
        JSON.stringify(r.body),
      );
      const { stdout } = await dc(["exec", "-T", "api", "printenv", "APP_UPDATE_SOURCE_URL"]);
      check(
        "restored: APP_UPDATE_SOURCE_URL is the stack default",
        stdout.trim() === "http://web:8080/app-update/manifest.json",
        stdout.trim(),
      );
    } catch (e) {
      check("restore api (crashed)", false, e instanceof Error ? e.message : String(e));
    }
    if (process.env.OTA_GATE_KEEP) console.log(`variants kept in ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed === results.length ? "PASS" : "FAIL"} ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}

if (!existsSync(path.join(ROOT, ".env.dev"))) throw new Error(".env.dev missing");
await main();
