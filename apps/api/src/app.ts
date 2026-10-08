import Fastify, { type FastifyServerOptions } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import pkg from "../package.json" with { type: "json" };
import type { ApiConfig } from "./config";
import { createPool, type DbClient, registerDb } from "./plugins/db";
import { createS3Client, registerStorage, type StorageClient } from "./plugins/storage";
import { healthzRoutes } from "./routes/healthz";

export const SERVICE_NAME = "api";
export const SERVICE_VERSION: string = pkg.version;

export interface BuildAppOptions {
  config: ApiConfig;
  /** Override the pg pool (tests pass a stub). */
  db?: DbClient;
  /** Override the S3 client (tests pass a stub). */
  s3?: StorageClient;
  /** Override logger options (tests usually pass `false`). */
  logger?: FastifyServerOptions["logger"];
}

/** Pino options. Never log auth headers or cookies; request logs carry no bodies. */
export function loggerOptions(config: Pick<ApiConfig, "LOG_LEVEL" | "NODE_ENV">) {
  return {
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ],
      censor: "[redacted]",
    },
    ...(config.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } } }
      : {}),
  } satisfies FastifyServerOptions["logger"];
}

/** Build the Fastify app without listening (used by `server.ts` and by tests via `inject`). */
export async function buildApp(opts: BuildAppOptions) {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(config),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerDb(app, opts.db ?? createPool(config, app.log));
  registerStorage(app, opts.s3 ?? createS3Client(config));

  healthzRoutes(app, { bucket: config.S3_BUCKET, service: SERVICE_NAME, version: SERVICE_VERSION });

  await app.ready();
  return app;
}
