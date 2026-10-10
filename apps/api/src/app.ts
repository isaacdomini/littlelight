import cookie from "@fastify/cookie";
import type { AiEnvInput } from "@littlelight/ai";
import { AI_PIPELINE_DEFAULTS, redactUrl } from "@littlelight/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import pkg from "../package.json" with { type: "json" };
import { createGoTrueClient, type GoTrueClient, registerAuth } from "./auth";
import { chatRoutes } from "./chat";
import { type ApiConfig, chatSettings, nativeSettings, searchSettings } from "./config";
import { createSmtpMailer, type Mailer } from "./email/mailer";
import { exportsRoutes } from "./exports/routes";
import { registerErrorHandling } from "./lib/errors";
import { trustProxyHop } from "./lib/request";
import { measurementsRoutes } from "./measurements/routes";
import { milestonesRoutes } from "./milestones/routes";
import { aiRoutes } from "./photos/ai-routes";
import { photosRoutes } from "./photos/routes";
import { type AiServices, createAiServices, registerAi } from "./plugins/ai";
import { registerNativeCors } from "./plugins/cors";
import { createPool, type DbClient, registerDb } from "./plugins/db";
import { createJobQueue, type JobQueue, registerJobs, sendOnlyBoss } from "./plugins/jobs";
import { createS3Client, registerStorage, type StorageClient } from "./plugins/storage";
import { registerTelemetry } from "./plugins/telemetry";
import { babiesRoutes } from "./routes/babies";
import { healthzRoutes } from "./routes/healthz";
import { meRoutes } from "./routes/me";
import { pushRoutes } from "./routes/push";
import { type SearchChatDeps, searchRoutes } from "./search";
import { registerSharing, registerViewerAuth } from "./sharing";
import { createUrlSigner, type UrlSigner } from "./storage/sign";
import { uploadsRoutes } from "./uploads/routes";

export const SERVICE_NAME = "api";
export const SERVICE_VERSION: string = pkg.version;

declare module "fastify" {
  interface FastifyInstance {
    /** Parsed env (secrets included): never log or serialize it. */
    config: ApiConfig;
    mailer: Mailer;
  }
}

export interface BuildAppOptions {
  config: ApiConfig;
  /** Override the pg pool (tests pass a stub). */
  db?: DbClient;
  /** Override the S3 client (tests pass a stub). */
  s3?: StorageClient;
  /** Override the URL signer (default: a signer on `S3_PUBLIC_ENDPOINT`; it never sends requests). */
  signer?: UrlSigner;
  /** Override the job queue (tests pass a stub; the default starts pg-boss lazily on first send). */
  jobs?: JobQueue;
  /** Override the mailer (tests pass `captureMailer()`). */
  mailer?: Mailer;
  /** Override the GoTrue client (tests pass a stub). */
  gotrue?: GoTrueClient;
  /**
   * Override the chat model / embedder (tests pass fakes). Default: built once from `aiEnv` by
   * `@littlelight/ai`'s factories (docs/plans/step-7.md 2.9).
   */
  ai?: AiServices;
  /** Env for the AI factories when `ai` is not given (default `process.env`). */
  aiEnv?: AiEnvInput;
  /** Override logger options (tests usually pass `false`). */
  logger?: FastifyServerOptions["logger"];
}

/**
 * URL as logged (query string dropped; invite/share tokens and token-shaped segments replaced).
 * Moved to `@littlelight/shared` (`telemetry.ts`) so the request logger and the Sentry scrubber
 * apply one set of rules; re-exported here for existing imports and tests.
 */
export { redactUrl };

/**
 * Pino options. Never log auth headers, cookies (`ll_access`, `ll_refresh`, the viewer's
 * `ll_viewer`), tokens, share tokens, passcodes, codes, emails or client IPs; request logs carry
 * method + redacted URL only, no bodies.
 */
export function loggerOptions(config: Pick<ApiConfig, "LOG_LEVEL" | "NODE_ENV">) {
  return {
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-api-key"]',
        'req.headers["cf-connecting-ip"]',
        'req.headers["x-forwarded-for"]',
        'res.headers["set-cookie"]',
        "req.body.email",
        "req.body.code",
        "req.body.tokenHash",
        "req.body.refreshToken",
        "req.body.accessToken",
        "req.body.idToken",
        "req.body.nonce",
        "req.body.codeVerifier",
        "req.body.captchaToken",
        // Upload registrations: 100 entries of hashes and hints are noise, not request context.
        "req.body.files",
        // Step 6: AI field overrides are parent content (PATCH /photos/:id/ai).
        "req.body.caption",
        "req.body.detailed_description",
        "req.body.search_tags",
        // Step 7: chat messages and search queries (docs/plans/step-7.md 2.8, 2.9). The request
        // serializer below already drops bodies and query strings; these keep it that way if a
        // handler ever logs `req` with its body or parsed query.
        "req.body.text",
        "req.body.content",
        "req.body.question",
        "req.query.q",
        // Step 8 (docs/plans/step-8.md 2.6, 2.9): the share token exchange
        // (`POST /share/session {token, passcode}`), the viewer manifest's `?t=<token>`, the
        // viewer JWT (cookie or native bearer; the header paths above cover the raw headers).
        "req.body.token",
        "req.body.passcode",
        "req.query.t",
        "req.cookies",
        // Step 9 (docs/plans/step-9.md 2.8): `POST /me/push-devices {token}` is covered by
        // `req.body.token` above; the app version is not secret but not request context either.
        "req.body.appVersion",
      ],
      censor: "[redacted]",
    },
    serializers: {
      req(req: { method?: string; url?: string; routeOptions?: { url?: string } }) {
        return {
          method: req.method,
          url: req.url === undefined ? undefined : redactUrl(req.url),
          route: req.routeOptions?.url,
        };
      },
    },
    ...(config.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } } }
      : {}),
  } satisfies FastifyServerOptions["logger"];
}

/**
 * Route modules, registered after auth so its `onRequest` hook (`request.auth`) covers them.
 * Auth-owned modules (`/auth/*`, invites, members, account) are registered by `registerAuth`.
 */
function registerRoutes(app: FastifyInstance, config: ApiConfig): void {
  healthzRoutes(app, {
    bucket: config.S3_BUCKET,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    // Production: full detail only for the loopback container healthcheck (step-1 S4).
    detail: config.NODE_ENV === "production" ? "loopback" : "full",
  });
  meRoutes(app);
  // Step 9: native push device registration (docs/plans/step-9.md 2.8).
  pushRoutes(app);
  babiesRoutes(app);
  // Step 4: uploads, photos (docs/plans/step-4.md 2.4).
  uploadsRoutes(app);
  photosRoutes(app);
  // Step 5: milestones, measurements (docs/plans/step-5.md 2.4).
  milestonesRoutes(app);
  measurementsRoutes(app);
  // Step 6: AI overrides, retry, usage (docs/plans/step-6.md 2.8).
  aiRoutes(app);
  // Step 7: hybrid search + facets, chat (docs/plans/step-7.md 2.8). Both gate on admin + paid
  // tier before any model or embedding call; `app.ai` holds the (possibly null) clients.
  const searchChat: SearchChatDeps = {
    ai: app.ai,
    settings: {
      ...searchSettings(config),
      ...chatSettings(config),
      AI_BABY_MONTHLY_BUDGET_USD:
        config.AI_BABY_MONTHLY_BUDGET_USD ?? AI_PIPELINE_DEFAULTS.AI_BABY_MONTHLY_BUDGET_USD,
    },
  };
  searchRoutes(app, searchChat);
  chatRoutes(app, searchChat);
  // Review fixes (docs/plans/review-fixes.md 2.5; PRD FR-10.1): admin-only album export.
  exportsRoutes(app);
}

/** Build the Fastify app without listening (used by `server.ts` and by tests via `inject`). */
export async function buildApp(opts: BuildAppOptions) {
  const { config } = opts;
  const native = nativeSettings(config);
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(config),
    // Trust exactly one hop: nginx (prod) / Vite (dev) sit directly in front of us on a private
    // network and port 3000 is never public. `request.ip` is the address that hop saw (the
    // right-most X-Forwarded-For entry), so a client-supplied X-Forwarded-For can no longer
    // choose it (docs/plans/review-fixes.md 2.11, D10; `trustProxyHop` explains why not `1`).
    // `clientIp()` still prefers `CF-Connecting-IP`, which nginx sets from `$remote_addr` when
    // Cloudflare did not.
    trustProxy: trustProxyHop,
    // Longer than nginx's upstream keepalive and cloudflared's idle limits, so the proxy (not
    // the API) always closes an idle connection first (docs/plans/step-7.md 2.9, R6). Fastify's
    // `requestTimeout` stays 0: a chat SSE turn is bounded by CHAT_MODEL_TIMEOUT_MS × rounds.
    keepAliveTimeout: 125_000,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  // Review fixes (docs/plans/review-fixes.md 2.6): capture 5xx (route pattern, method, status
  // and the scrubbed exception only) when `initTelemetry` ran with a DSN; otherwise a no-op.
  registerTelemetry(app);
  // Step 9 (docs/plans/step-9.md 2.3): CORS for the native WebView origins only, before every
  // other hook so a preflight never reaches auth. The web SPA stays same-origin.
  registerNativeCors(app, native.NATIVE_APP_ORIGINS);

  // Parses `Cookie` into `request.cookies`; enables `reply.setCookie`/`clearCookie`. No secret:
  // auth cookies hold GoTrue-signed JWTs / opaque refresh tokens, nothing we sign ourselves.
  await app.register(cookie);

  app.decorate("config", config);
  registerDb(app, opts.db ?? createPool(config, app.log));
  registerStorage(app, opts.s3 ?? createS3Client(config));
  app.decorate("signer", opts.signer ?? createUrlSigner(config));
  registerJobs(
    app,
    opts.jobs ??
      createJobQueue({
        log: app.log,
        createBoss: () => sendOnlyBoss(config),
        pushDebounce: {
          photosAnalyzedSec: native.PUSH_PHOTOS_DEBOUNCE_SEC,
          shareViewedSec: native.PUSH_SHARE_DEBOUNCE_SEC,
        },
      }),
  );
  app.decorate("mailer", opts.mailer ?? createSmtpMailer(config, app.log));
  registerAi(app, opts.ai ?? createAiServices(opts.aiEnv ?? process.env, app.log));

  registerAuth(app, {
    gotrue: opts.gotrue ?? createGoTrueClient(config),
    mailer: app.mailer,
    config,
  });

  // Step 8 (docs/plans/step-8.md 2.6, 2.9): the viewer-auth hook for `/share/*` (`ll_viewer`
  // cookie, Path=/api/share; or a native bearer viewer JWT) sits next to the user auth hook and
  // before every route. The two credentials never cross: viewer JWTs use an HKDF-derived key,
  // their own issuer and audience, so `registerAuth` rejects them on every parent route (chat,
  // search, `/babies`), and the viewer hook never reads `ll_access` or a GoTrue bearer.
  registerViewerAuth(app, config);

  registerRoutes(app, config);
  // Admin share-link routes + viewer routes (`apps/api/src/sharing`, tasks 8.6/8.7). They read
  // `app.config` (`shareSettings`), `app.jobs.enqueueShareApply` and `app.signer`.
  await registerSharing(app);

  await app.ready();
  return app;
}
