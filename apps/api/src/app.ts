import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import pkg from "../package.json" with { type: "json" };
import { createGoTrueClient, type GoTrueClient, registerAuth } from "./auth";
import type { ApiConfig } from "./config";
import { createSmtpMailer, type Mailer } from "./email/mailer";
import { registerErrorHandling } from "./lib/errors";
import { measurementsRoutes } from "./measurements/routes";
import { milestonesRoutes } from "./milestones/routes";
import { aiRoutes } from "./photos/ai-routes";
import { photosRoutes } from "./photos/routes";
import { createPool, type DbClient, registerDb } from "./plugins/db";
import { createJobQueue, type JobQueue, registerJobs, sendOnlyBoss } from "./plugins/jobs";
import { createS3Client, registerStorage, type StorageClient } from "./plugins/storage";
import { babiesRoutes } from "./routes/babies";
import { healthzRoutes } from "./routes/healthz";
import { meRoutes } from "./routes/me";
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
  /** Override logger options (tests usually pass `false`). */
  logger?: FastifyServerOptions["logger"];
}

// A path segment that looks like a bearer token (invite tokens are 43-char base64url); UUIDs are
// identifiers, not secrets, and stay readable.
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * URL as logged: query strings dropped (they can carry codes), the segment after `/invites/` and
 * any token-shaped segment replaced. Exported for tests.
 */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  const segments = path.split("/").map((seg, i, all) => {
    if (i > 0 && all[i - 1] === "invites" && seg !== "") return "[redacted]";
    if (TOKEN_SEGMENT.test(seg) && !UUID_SEGMENT.test(seg)) return "[redacted]";
    return seg;
  });
  return segments.join("/") + (q === -1 ? "" : "?[redacted]");
}

/**
 * Pino options. Never log auth headers, cookies, tokens, codes, emails or client IPs; request
 * logs carry method + redacted URL only, no bodies.
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
  babiesRoutes(app);
  // Step 4: uploads, photos (docs/plans/step-4.md 2.4).
  uploadsRoutes(app);
  photosRoutes(app);
  // Step 5: milestones, measurements (docs/plans/step-5.md 2.4).
  milestonesRoutes(app);
  measurementsRoutes(app);
  // Step 6: AI overrides, retry, usage (docs/plans/step-6.md 2.8).
  aiRoutes(app);
}

/** Build the Fastify app without listening (used by `server.ts` and by tests via `inject`). */
export async function buildApp(opts: BuildAppOptions) {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(config),
    // nginx (prod) / Vite (dev) are the only hops in front of us; port 3000 is never public.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  // Parses `Cookie` into `request.cookies`; enables `reply.setCookie`/`clearCookie`. No secret:
  // auth cookies hold GoTrue-signed JWTs / opaque refresh tokens, nothing we sign ourselves.
  await app.register(cookie);

  app.decorate("config", config);
  registerDb(app, opts.db ?? createPool(config, app.log));
  registerStorage(app, opts.s3 ?? createS3Client(config));
  app.decorate("signer", opts.signer ?? createUrlSigner(config));
  registerJobs(
    app,
    opts.jobs ?? createJobQueue({ log: app.log, createBoss: () => sendOnlyBoss(config) }),
  );
  app.decorate("mailer", opts.mailer ?? createSmtpMailer(config, app.log));

  registerAuth(app, {
    gotrue: opts.gotrue ?? createGoTrueClient(config),
    mailer: app.mailer,
    config,
  });

  registerRoutes(app, config);

  await app.ready();
  return app;
}
