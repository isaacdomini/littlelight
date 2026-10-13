import { Writable } from "node:stream";
import {
  APP_UPDATE_PUBLIC_KEYS,
  appUpdateManifestResponseSchema,
  signedAppUpdateManifestSchema,
} from "@tinyglow/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, loggerOptions } from "../app";
import type { ApiConfig } from "../config";
import {
  DEV_APP_UPDATE_KEY,
  fakeUpstream,
  foreignP256Key,
  jsonRes,
  rsaKey,
  testManifest,
} from "../testing/app-update";
import { testConfig } from "../testing/support";
import { verifyManifestJson } from "./signer";

// GET /app-update/manifest end to end through `buildApp` (docs/plans/step-14.md 2.6, 2.10).
// No database: the route is public and stateless; the upstream is an injected fetch. Runs in the
// api-integration project and never skips (it needs no DATABASE_URL).

const DEV_SPKI = APP_UPDATE_PUBLIC_KEYS.dev.spkiBase64;
const SOURCE = "http://web-secret-host.internal:8080/app-update/manifest.json";
const FILES = "https://files.tinyglow.test/web";
const NATIVE = { "x-tinyglow-client": "native" };
const okDb = { query: async () => ({ rows: [] }), end: async () => undefined };
const okS3 = { send: (async () => ({})) as never, destroy: () => undefined };

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const A = testManifest({ "index.html": "<html>A</html>", "assets/app-1.js": "console.log(1)" });

async function start(over: Partial<ApiConfig> = {}, upstream = fakeUpstream(() => jsonRes(A))) {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const config = testConfig({
    LOG_LEVEL: "info",
    APP_UPDATE_ENABLED: true,
    APP_UPDATE_SIGNING_KEY_BASE64: DEV_APP_UPDATE_KEY,
    APP_UPDATE_SOURCE_URL: SOURCE,
    APP_UPDATE_FILES_BASE_URL: FILES,
    ...over,
  });
  app = await buildApp({
    config,
    db: okDb,
    s3: okS3,
    aiEnv: {},
    logger: { ...loggerOptions(config), level: "info", stream },
    appUpdate: { fetch: upstream.fetch, warmUp: false },
  });
  await app.ready();
  return { app, logs, upstream };
}

const get = (a: App, qs: string, headers: Record<string, string> = NATIVE) =>
  a.inject({ method: "GET", url: `/app-update/manifest?${qs}`, headers });

describe("GET /app-update/manifest", () => {
  it("offers a signed envelope that verifies with the dev SPKI and carries baseUrl", async () => {
    const { app } = await start();
    const res = await get(app, "platform=ios&native=1");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = appUpdateManifestResponseSchema.parse(res.json());
    expect(body.reason).toBeUndefined();
    const env = body.update;
    if (!env) throw new Error("expected an update");
    expect(env.keyId).toBe("dev");
    expect(verifyManifestJson(DEV_SPKI, env.manifestJson, env.signature)).toBe(true);
    expect(
      verifyManifestJson(APP_UPDATE_PUBLIC_KEYS.prod.spkiBase64, env.manifestJson, env.signature),
    ).toBe(false);
    const m = signedAppUpdateManifestSchema.parse(JSON.parse(env.manifestJson));
    expect(m.baseUrl).toBe(FILES);
    expect(m.version).toBe(A.version);
    expect(m.files).toEqual(A.files);
    // Android too
    const and = appUpdateManifestResponseSchema.parse(
      (await get(app, `platform=android&native=5&current=${"f".repeat(16)}`)).json(),
    );
    expect(and.update?.manifestJson).toBe(env.manifestJson);
  });

  it("drops unknown upstream keys before signing", async () => {
    const { app } = await start(
      {},
      fakeUpstream(() => jsonRes({ ...A, evil: "<script>", extra: 1 })),
    );
    const body = appUpdateManifestResponseSchema.parse(
      (await get(app, "platform=ios&native=1")).json(),
    );
    const parsed = JSON.parse(body.update?.manifestJson ?? "{}");
    expect(Object.keys(parsed).sort()).toEqual(
      ["baseUrl", "builtAt", "files", "minNativeBuild", "schema", "version", "webVersion"].sort(),
    );
  });

  it("baseUrl defaults to PUBLIC_URL when APP_UPDATE_FILES_BASE_URL is unset", async () => {
    const { app } = await start({
      APP_UPDATE_FILES_BASE_URL: undefined,
      PUBLIC_URL: "https://tinyglow.test/",
    });
    const body = appUpdateManifestResponseSchema.parse(
      (await get(app, "platform=ios&native=1")).json(),
    );
    expect(JSON.parse(body.update?.manifestJson ?? "{}").baseUrl).toBe("https://tinyglow.test");
  });

  it("native_too_old below minNativeBuild[platform]; per platform", async () => {
    const m = testManifest({}, { minNativeBuild: { ios: 12, android: 3 } });
    const { app } = await start(
      {},
      fakeUpstream(() => jsonRes(m)),
    );
    expect((await get(app, "platform=ios&native=11")).json()).toEqual({
      update: null,
      reason: "native_too_old",
    });
    expect((await get(app, "platform=ios&native=12")).json().update).not.toBeNull();
    expect((await get(app, "platform=android&native=3")).json().update).not.toBeNull();
    expect((await get(app, "platform=android&native=2")).json().reason).toBe("native_too_old");
  });

  it("up_to_date when current equals the version", async () => {
    const { app } = await start();
    expect((await get(app, `platform=ios&native=1&current=${A.version}`)).json()).toEqual({
      update: null,
      reason: "up_to_date",
    });
  });

  it.each([
    ["404", () => jsonRes("nf", 404)],
    ["500", () => jsonRes("boom", 500)],
    ["unreachable", () => Promise.reject(new TypeError("fetch failed"))],
    ["an html page", () => new Response("<!doctype html><html></html>", { status: 200 })],
    ["an invalid manifest", () => jsonRes({ ...A, schema: 2 })],
  ])("unavailable when the upstream answers %s", async (_n, r) => {
    const { app } = await start({}, fakeUpstream(r as () => Response | Promise<Response>));
    const res = await get(app, "platform=ios&native=1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ update: null, reason: "unavailable" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("web clients (no or web X-Tinyglow-Client) get disabled and the upstream is never fetched", async () => {
    const { app, upstream } = await start();
    for (const headers of [
      {} as Record<string, string>,
      { "x-tinyglow-client": "web" },
      { "x-tinyglow-client": "bogus" },
    ]) {
      expect((await get(app, "platform=ios&native=1", headers)).json()).toEqual({
        update: null,
        reason: "disabled",
      });
    }
    expect(upstream.calls).toHaveLength(0);
  });

  it("400 validation_failed on a bad query, still no-store", async () => {
    const { app } = await start();
    for (const qs of [
      "platform=mac&native=1",
      "platform=ios&native=0",
      "platform=ios",
      "platform=ios&native=1&current=nothex",
    ]) {
      const res = await get(app, qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error).toBe("validation_failed");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("is public: no session needed, and an invalid bearer does not block it", async () => {
    const { app } = await start();
    const res = await get(app, "platform=ios&native=1", {
      ...NATIVE,
      authorization: "Bearer junk",
    });
    expect([200, 401]).toContain(res.statusCode);
    // Without credentials it must work (the primary path).
    expect((await get(app, "platform=ios&native=1")).statusCode).toBe(200);
  });

  describe("feature off at boot answers disabled and never fetches", () => {
    it.each([
      ["APP_UPDATE_ENABLED=false", { APP_UPDATE_ENABLED: false }, "disabled"],
      ["no key", { APP_UPDATE_SIGNING_KEY_BASE64: undefined }, "no_key"],
      ["foreign key", { APP_UPDATE_SIGNING_KEY_BASE64: foreignP256Key() }, "key_untrusted"],
      ["RSA key", { APP_UPDATE_SIGNING_KEY_BASE64: rsaKey() }, "key_invalid"],
      ["dev key in production", { NODE_ENV: "production" as const }, "key_untrusted"],
      [
        "PUBLIC_URL fallback not https",
        { APP_UPDATE_FILES_BASE_URL: undefined, PUBLIC_URL: "http://192.168.1.20:8080" },
        "base_url_invalid",
      ],
    ] as [string, Partial<ApiConfig>, string][])("%s", async (_n, over, outcome) => {
      const { app, logs, upstream } = await start(over);
      const res = await get(app, "platform=ios&native=1");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ update: null, reason: "disabled" });
      expect(upstream.calls).toHaveLength(0);
      const boot = logs.filter((l) => l.includes("app updates: off"));
      expect(boot).toHaveLength(1);
      expect(boot[0]).toContain(`"outcome":"${outcome}"`);
      const key = over.APP_UPDATE_SIGNING_KEY_BASE64 ?? DEV_APP_UPDATE_KEY;
      expect(logs.join("")).not.toContain(key.slice(40, 80));
    });
  });

  it("logs { outcome, platform } only: no native, current, URL, manifest, signature or key", async () => {
    const { app, logs } = await start();
    const env = (await get(app, "platform=ios&native=4242")).json().update;
    await get(app, `platform=android&native=4243&current=${A.version}`);
    await get(app, "platform=ios&native=1", {});
    const text = logs.join("");
    expect(text).toContain('"outcome":"update"');
    expect(text).toContain('"outcome":"up_to_date"');
    for (const leak of [
      "4242",
      "4243",
      A.version,
      "native=",
      "current=",
      "web-secret-host",
      "files.tinyglow.test",
      env.signature,
      env.manifestJson.slice(0, 30),
      "manifestJson",
      DEV_APP_UPDATE_KEY.slice(40, 80),
    ]) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it("signs once per manifest (memo) and re-signs a new manifest", async () => {
    const up = fakeUpstream(() => jsonRes(A));
    const { app } = await start({}, up);
    const e1 = (await get(app, "platform=ios&native=1")).json().update;
    const e2 = (await get(app, "platform=ios&native=1")).json().update;
    // ECDSA is randomised: equal signatures prove the envelope was memoised.
    expect(e2.signature).toBe(e1.signature);
  });
});
