import { HeadBucketCommand } from "@aws-sdk/client-s3";
import {
  type HealthzCheck,
  type HealthzResponse,
  healthzResponseSchema,
} from "@littlelight/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

/** Per-check budget; the compose healthcheck must not hang on an unreachable dependency. */
export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

class CheckTimeoutError extends Error {
  constructor() {
    super("check timed out");
    this.name = "TimeoutError";
  }
}

const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Reduce an error to a short, safe category for the public response: an errno (`ECONNREFUSED`),
 * SQLSTATE (`28P01`) or SDK error name (`NotFound`). Raw messages are never returned because
 * they can contain endpoints, hostnames or connection strings.
 */
export function errorCategory(err: unknown): string {
  if (err instanceof CheckTimeoutError) return "timeout";
  if (typeof err !== "object" || err === null) return "error";
  const { code, name } = err as { code?: unknown; name?: unknown };
  for (const candidate of [code, name]) {
    if (typeof candidate === "string" && SAFE_CODE.test(candidate) && candidate !== "Error") {
      return candidate;
    }
  }
  return "error";
}

async function runCheck(
  fn: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number,
): Promise<HealthzCheck & { cause?: unknown }> {
  const started = performance.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CheckTimeoutError());
    }, timeoutMs);
  });
  try {
    await Promise.race([fn(controller.signal), timeout]);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: errorCategory(err),
      cause: err,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthzRouteOptions {
  bucket: string;
  service: string;
  version: string;
  timeoutMs?: number;
}

/** `GET /healthz`: 200 when db and storage are reachable, 503 (`degraded`) otherwise. */
export function healthzRoutes(app: FastifyInstance, opts: HealthzRouteOptions): void {
  const timeoutMs = opts.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;

  app.withTypeProvider<ZodTypeProvider>().route({
    method: "GET",
    url: "/healthz",
    // Polled by the compose healthcheck every few seconds; only log problems.
    logLevel: "warn",
    schema: {
      response: { 200: healthzResponseSchema, 503: healthzResponseSchema },
    },
    handler: async (request, reply) => {
      const [db, storage] = await Promise.all([
        runCheck(() => app.db.query("SELECT 1"), timeoutMs),
        runCheck(
          (abortSignal) =>
            app.s3.send(new HeadBucketCommand({ Bucket: opts.bucket }), { abortSignal }),
          timeoutMs,
        ),
      ]);

      for (const [check, result] of [
        ["db", db],
        ["storage", storage],
      ] as const) {
        // Log only the sanitized category; raw errors may embed endpoints or hostnames.
        if (!result.ok) request.log.warn({ check, error: result.error }, "healthz check failed");
      }

      const strip = ({ cause: _cause, ...check }: HealthzCheck & { cause?: unknown }) => check;
      const ok = db.ok && storage.ok;
      const body: HealthzResponse = {
        status: ok ? "ok" : "degraded",
        service: opts.service,
        version: opts.version,
        uptimeSec: Math.round(process.uptime()),
        checks: { db: strip(db), storage: strip(storage) },
      };
      return reply.code(ok ? 200 : 503).send(body);
    },
  });
}
