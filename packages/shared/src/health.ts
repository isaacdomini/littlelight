import { z } from "zod";

// `GET /healthz` contract (docs/plans/step-1.md 2.8, 2.10). `error` is a short, sanitized
// category (e.g. an errno or SDK error name), never a raw message, URL or credential.

export const healthzCheckSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});
export type HealthzCheck = z.infer<typeof healthzCheckSchema>;

export const healthzResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  version: z.string(),
  uptimeSec: z.number(),
  checks: z.object({
    db: healthzCheckSchema,
    storage: healthzCheckSchema,
  }),
});
export type HealthzResponse = z.infer<typeof healthzResponseSchema>;
