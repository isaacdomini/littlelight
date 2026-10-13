import {
  APP_UPDATE_MANIFEST_JSON_MAX_CHARS,
  type AppUpdateEnvelope,
  type AppUpdateManifest,
  type AppUpdateManifestResponse,
  type AppUpdatePlatform,
  appUpdateManifestQuerySchema,
  appUpdateManifestResponseSchema,
  signedAppUpdateManifestSchema,
} from "@tinyglow/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { type AppUpdateSettings, appUpdateSettings } from "../config";
import { clientKindHeader } from "../lib/request";
import { type AppUpdateSigner, createAppUpdateSigner } from "./signer";
import { createManifestSource, type ManifestSource, type ManifestSourceOptions } from "./source";

// Live-update manifest endpoint (docs/plans/step-14.md 2.6, D7, D9).
// `GET /app-update/manifest?platform&native&current` (browser path `/api/app-update/manifest`):
// public, no auth, no database, no per-device state, `Cache-Control: no-store`.
//
// Order: not `X-Tinyglow-Client: native`, `APP_UPDATE_ENABLED=false` or no usable signing key
// → `disabled`; upstream manifest missing/invalid → `unavailable`; `native <
// minNativeBuild[platform]` → `native_too_old`; `current === version` → `up_to_date`; else the
// signed envelope. A bad query is the shared 400 `validation_failed`.
//
// Logs `{ outcome, platform }` per check and one line at boot for the feature state. Never
// `native`, `current`, the manifest, the signature, the key or a URL (the request logger drops
// the query string: `redactUrl`).

export type AppUpdateOutcome = AppUpdateManifestResponse["reason"] | "update";

export interface AppUpdateRoutesOptions {
  /** Override the upstream fetch (tests). */
  fetch?: typeof fetch;
  /** Clock in ms for the source cache (tests). */
  now?: () => number;
  /** Source cache/timeout overrides (tests). */
  source?: Pick<ManifestSourceOptions, "ttlMs" | "staleMs" | "retryMs" | "timeoutMs">;
  /**
   * Fetch the upstream once in the background when the app is ready, so a bad source shows up
   * in the log at boot (default: true when the feature is on). Tests pass false.
   */
  warmUp?: boolean;
}

/** Feature state resolved once at boot. */
export type AppUpdateFeature =
  | { on: true; signer: AppUpdateSigner; source: ManifestSource; baseUrl: string }
  | {
      on: false;
      outcome: "disabled" | "no_key" | "key_invalid" | "key_untrusted" | "base_url_invalid";
    };

/** Resolve the feature from the settings, logging exactly one line. Never throws. */
export function resolveAppUpdateFeature(
  settings: AppUpdateSettings,
  log: FastifyBaseLogger,
  opts: AppUpdateRoutesOptions = {},
): AppUpdateFeature {
  const off = (
    outcome: "disabled" | "no_key" | "key_invalid" | "key_untrusted" | "base_url_invalid",
  ): AppUpdateFeature => {
    const level = outcome === "disabled" || outcome === "no_key" ? "info" : "warn";
    log[level]({ outcome }, "app updates: off");
    return { on: false, outcome };
  };
  if (!settings.enabled) return off("disabled");
  const signer = createAppUpdateSigner(settings.signingKeyBase64, {
    production: settings.production,
  });
  if (!signer.ok) return off(signer.outcome);
  if (settings.filesBaseUrl === null) return off("base_url_invalid");
  log.info({ outcome: "on", keyId: signer.signer.keyId }, "app updates: on");
  return {
    on: true,
    signer: signer.signer,
    baseUrl: settings.filesBaseUrl,
    source: createManifestSource({
      url: settings.sourceUrl,
      log,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...opts.source,
    }),
  };
}

/**
 * The signed envelope of `manifest` + `baseUrl`: `manifestJson` is serialised once (known keys
 * only, as parsed), checked against `signedAppUpdateManifestSchema` and the size cap, then
 * signed. `null` when it does not pass (logged once by the caller's memo).
 */
export function buildEnvelope(
  manifest: AppUpdateManifest,
  baseUrl: string,
  signer: AppUpdateSigner,
): AppUpdateEnvelope | null {
  const manifestJson = JSON.stringify({ ...manifest, baseUrl });
  if (manifestJson.length > APP_UPDATE_MANIFEST_JSON_MAX_CHARS) return null;
  if (!signedAppUpdateManifestSchema.safeParse(JSON.parse(manifestJson)).success) return null;
  return { manifestJson, signature: signer.sign(manifestJson), keyId: signer.keyId };
}

export function appUpdateRoutes(app: FastifyInstance, opts: AppUpdateRoutesOptions = {}): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const feature = resolveAppUpdateFeature(appUpdateSettings(app.config), app.log, opts);

  // One envelope per fetched manifest object (the source keeps the object while version and
  // builtAt are unchanged; `baseUrl` is fixed for the process).
  const envelopes = new WeakMap<AppUpdateManifest, AppUpdateEnvelope | null>();
  function envelopeFor(manifest: AppUpdateManifest): AppUpdateEnvelope | null {
    if (!feature.on) return null;
    if (envelopes.has(manifest)) return envelopes.get(manifest) ?? null;
    const envelope = buildEnvelope(manifest, feature.baseUrl, feature.signer);
    if (envelope === null) {
      app.log.warn({ outcome: "invalid_manifest" }, "app updates: source unavailable");
    }
    envelopes.set(manifest, envelope);
    return envelope;
  }

  if (feature.on && (opts.warmUp ?? true)) {
    app.addHook("onReady", async () => {
      // Background: never delays boot; `get()` never throws.
      void feature.source.get();
    });
  }

  r.route({
    method: "GET",
    url: "/app-update/manifest",
    schema: {
      querystring: appUpdateManifestQuerySchema,
      response: { 200: appUpdateManifestResponseSchema },
    },
    onRequest: async (_request, reply) => {
      reply.header("cache-control", "no-store");
    },
    handler: async (request) => {
      const { platform, native, current } = request.query;
      const answer = (
        outcome: AppUpdateOutcome,
        body: AppUpdateManifestResponse,
      ): AppUpdateManifestResponse => {
        request.log.info({ outcome, platform }, "app update check");
        return body;
      };
      const none = (reason: NonNullable<AppUpdateManifestResponse["reason"]>) =>
        answer(reason, { update: null, reason });

      if (!feature.on || clientKindHeader(request) !== "native") return none("disabled");
      const manifest = await feature.source.get();
      if (manifest === null) return none("unavailable");
      if (native < manifest.minNativeBuild[platform as AppUpdatePlatform]) {
        return none("native_too_old");
      }
      if (current === manifest.version) return none("up_to_date");
      const envelope = envelopeFor(manifest);
      if (envelope === null) return none("unavailable");
      return answer("update", { update: envelope });
    },
  });
}
