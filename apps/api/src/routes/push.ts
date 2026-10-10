import {
  PUSH_REGISTRATIONS_PER_HOUR,
  type PushDeviceResponse,
  type PushPlatform,
  pushDeviceRegisterRequestSchema,
  pushDeviceResponseSchema,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createThrottle, requireAuth, requireConsent, type Throttle, withClaims } from "../auth";
import { ApiError, internalError, rateLimited } from "../lib/errors";
import { clientKindHeader } from "../lib/request";

// Push device registration (docs/plans/step-9.md 2.8, 2.9). Both routes run under the caller's
// claims (`withClaims`, role `authenticated`): `register_push_device` / `unregister_push_devices_
// for_session` are SECURITY DEFINER functions that bind the row to `auth_uid()` and the claims'
// GoTrue `session_id`, so sign-out (any kind), idle expiry and account deletion stop pushes with
// no code here. The API never writes `push_devices` directly and never selects `token`
// (`authenticated` has no column grant on it).
//
// Privacy: the device token arrives in `req.body.token`, which pino redacts; the request
// serializer logs no bodies; nothing here logs, returns or echoes it (validation errors carry
// field paths only, DB errors map to fixed messages in `lib/errors.ts`).

/** 400 for a registration that does not come from the app (`X-Tinyglow-Client: native`). */
export const pushNativeOnly = () =>
  new ApiError(400, "validation_failed", "Notifications are only available in the app", {
    fields: ["headers.x-tinyglow-client"],
  });

interface DeviceRow {
  id: string;
  platform: PushPlatform;
  created_at: Date;
}

export interface PushRoutesOptions {
  /** Override the per-user registration throttle (tests). Default 20 per hour per user. */
  throttle?: Throttle;
}

export function pushRoutes(app: FastifyInstance, opts: PushRoutesOptions = {}): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const throttle =
    opts.throttle ?? createThrottle({ limit: PUSH_REGISTRATIONS_PER_HOUR, windowMs: 3_600_000 });
  app.addHook("onClose", async () => {
    throttle.close();
  });

  r.route({
    method: "POST",
    url: "/me/push-devices",
    schema: {
      body: pushDeviceRegisterRequestSchema,
      response: { 201: pushDeviceResponseSchema },
    },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      if (clientKindHeader(request) !== "native") throw pushNativeOnly();
      const auth = request.auth;
      if (!auth) throw new ApiError(401, "unauthorized", "Sign in to continue");
      const hit = throttle.hit(auth.uid);
      if (!hit.allowed) throw rateLimited(hit.retryAfterSec);

      const { platform, provider, token, appVersion } = request.body;
      const body = await withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const reg = await client.query<{ id: string }>(
          "SELECT public.register_push_device($1, $2, $3, $4) AS id",
          [platform, provider, token, appVersion],
        );
        const id = reg.rows[0]?.id;
        if (!id) throw internalError();
        // RLS (`user_id = auth_uid()`) and the column grant: never the token.
        const { rows } = await client.query<DeviceRow>(
          "SELECT id, platform, created_at FROM public.push_devices WHERE id = $1",
          [id],
        );
        const row = rows[0];
        if (!row) throw internalError();
        return {
          device: { id: row.id, platform: row.platform, createdAt: row.created_at.toISOString() },
        } satisfies PushDeviceResponse;
      });
      return reply.code(201).send(body);
    },
  });

  // Best effort from the app's sign-out sequence (2.5): no consent or native-header guard, so it
  // also works for a session that never finished onboarding. Idempotent (0 rows ⇒ still 204).
  r.route({
    method: "DELETE",
    url: "/me/push-devices/current",
    preHandler: requireAuth,
    handler: async (request, reply) => {
      await withClaims(request, (client) =>
        client.query("SELECT public.unregister_push_devices_for_session()"),
      );
      return reply.code(204).send();
    },
  });
}
