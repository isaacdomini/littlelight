import { idParamsSchema, sessionsListResponseSchema, userAgentLabel } from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { notFound } from "../lib/errors";
import { audit, withClaims } from "./context";
import { requireAuth } from "./plugin";
import type { AuthRuntime } from "./runtime";
import { clearSessionCookies } from "./session";

// Devices screen (PRD "Sessions and tokens"; docs/plans/step-3.md 2.4, 2.5): the user's live
// GoTrue sessions via the step-3 SECURITY DEFINER functions, which filter by `auth_uid()`. No
// IPs leave the database; the User-Agent is reduced to a coarse label.

interface SessionRow {
  id: string;
  created_at: Date;
  refreshed_at: Date | null;
  user_agent: string | null;
}

export function sessionRoutes(app: FastifyInstance, runtime: AuthRuntime): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "GET",
    url: "/auth/sessions",
    schema: { response: { 200: sessionsListResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) =>
      withClaims(request, async (client, ctx) => {
        const { rows } = await client.query<SessionRow>(
          "SELECT id, created_at, refreshed_at, user_agent FROM public.list_user_sessions()",
        );
        return {
          sessions: rows.map((s) => ({
            id: s.id,
            createdAt: s.created_at.toISOString(),
            lastActiveAt: (s.refreshed_at ?? s.created_at).toISOString(),
            deviceLabel: userAgentLabel(s.user_agent),
            current: s.id === ctx.sessionId,
          })),
        };
      }),
  });

  r.route({
    method: "DELETE",
    url: "/auth/sessions/:id",
    schema: { params: idParamsSchema },
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { id } = request.params;
      const current = await withClaims(request, async (client, ctx) => {
        // Audit inside the same transaction: a miss rolls it back with the delete.
        await audit(client, "auth.sign_out", {
          actorUserId: ctx.uid,
          metadata: { scope: "device", client: request.auth?.clientKind ?? "web" },
        });
        const { rows } = await client.query<{ ok: boolean }>(
          "SELECT public.delete_user_session($1) AS ok",
          [id],
        );
        // Missing and someone else's are indistinguishable on purpose (the function returns false).
        if (!rows[0]?.ok) throw notFound("No such device");
        return id === ctx.sessionId;
      });
      if (current && request.auth?.transport === "cookie") {
        clearSessionCookies(reply, runtime.config);
      }
      return reply.code(204).send();
    },
  });
}
