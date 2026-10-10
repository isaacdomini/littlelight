import { HeadBucketCommand } from "@aws-sdk/client-s3";
import {
  type HealthzCheck,
  type HealthzResponse,
  healthzResponseSchema,
} from "@littlelight/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

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
  /**
   * `full` (development/test): every caller gets the full body. `loopback` (production): only a
   * caller on a loopback socket (the container healthcheck, `fetch('http://127.0.0.1:3000/healthz')`)
   * gets version, uptime and check details; everyone else (via nginx/cloudflared) gets
   * `{ status }` only (closes step-1 open issue S4: no version or error codes in public).
   */
  detail?: "full" | "loopback";
}

/** What a non-loopback caller sees in production. */
export const healthzPublicResponseSchema = healthzResponseSchema.pick({ status: true });
export type HealthzPublicResponse = z.infer<typeof healthzPublicResponseSchema>;

const healthzAnyResponseSchema = z.union([healthzResponseSchema, healthzPublicResponseSchema]);

/**
 * True when the TCP peer is this host. Uses the raw socket address, never `request.ip`: behind
 * the proxy (`trustProxyHop`) that is the proxy's X-Forwarded-For entry, and a request that
 * reaches port 3000 directly can set X-Forwarded-For itself.
 */
export function isLoopbackSocket(request: Pick<FastifyRequest, "raw">): boolean {
  const addr = request.raw.socket?.remoteAddress;
  if (!addr) return false;
  const v4 = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  return v4 === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * `GET /healthz`: 200 when db and storage are reachable, 503 (`degraded`) otherwise. Body detail
 * per `HealthzRouteOptions.detail`; the status code is the same for every caller.
 */
export function healthzRoutes(app: FastifyInstance, opts: HealthzRouteOptions): void {
  const timeoutMs = opts.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const detail = opts.detail ?? "loopback";

  app.withTypeProvider<ZodTypeProvider>().route({
    method: "GET",
    url: "/healthz",
    // Polled by the compose healthcheck every few seconds; only log problems.
    logLevel: "warn",
    schema: {
      response: { 200: healthzAnyResponseSchema, 503: healthzAnyResponseSchema },
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
      const status = ok ? 200 : 503;
      if (detail === "loopback" && !isLoopbackSocket(request)) {
        const body: HealthzPublicResponse = { status: ok ? "ok" : "degraded" };
        return reply.code(status).send(body);
      }
      const body: HealthzResponse = {
        status: ok ? "ok" : "degraded",
        service: opts.service,
        version: opts.version,
        uptimeSec: Math.round(process.uptime()),
        checks: { db: strip(db), storage: strip(storage) },
      };
      return reply.code(status).send(body);
    },
  });
}
