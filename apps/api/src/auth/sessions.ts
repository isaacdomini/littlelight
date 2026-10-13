import {
  idParamsSchema,
  type SignInMethod,
  sessionsListResponseSchema,
  signInMethodSchema,
  userAgentLabel,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { notFound } from "../lib/errors";
import { audit, type Tx, withClaims } from "./context";
import { requireAuth } from "./plugin";
import type { AuthRuntime } from "./runtime";
import { clearSessionCookies } from "./session";

// Devices screen (PRD "Sessions and tokens"; docs/plans/step-3.md 2.4, 2.5): the user's live
// GoTrue sessions via the step-3 SECURITY DEFINER functions, which filter by `auth_uid()`. No
// IPs leave the database; the User-Agent is reduced to a coarse label. Step 13 (docs/plans/
// step-13.md 2.4): `signInMethod` comes from the session's latest `auth.sign_in` audit row
// (`metadata.session_id`, written by `issueSession` on every sign-in path; the user reads their
// own actor rows under RLS). Sessions created before step 13 have no such row: `signInMethod`
// is omitted for them.

interface SessionRow {
  id: string;
  created_at: Date;
  refreshed_at: Date | null;
  user_agent: string | null;
}

/** `session id → method` from the newest `auth.sign_in` row per session, for the given sessions. */
async function signInMethods(
  client: Tx,
  uid: string,
  sessionIds: string[],
): Promise<Map<string, SignInMethod>> {
  const out = new Map<string, SignInMethod>();
  if (sessionIds.length === 0) return out;
  const { rows } = await client.query<{ session_id: string; method: string | null }>(
    `SELECT DISTINCT ON (metadata->>'session_id')
            metadata->>'session_id' AS session_id,
            metadata->>'method'     AS method
       FROM public.audit_log
      WHERE event = 'auth.sign_in'
        AND actor_user_id = $1
        AND metadata->>'session_id' = ANY($2::text[])
      ORDER BY metadata->>'session_id', created_at DESC, id DESC`,
    [uid, sessionIds],
  );
  for (const row of rows) {
    const parsed = signInMethodSchema.safeParse(row.method);
    if (parsed.success) out.set(row.session_id, parsed.data);
  }
  return out;
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
        const methods = await signInMethods(
          client,
          ctx.uid,
          rows.map((s) => s.id),
        );
        return {
          sessions: rows.map((s) => {
            const signInMethod = methods.get(s.id);
            return {
              id: s.id,
              createdAt: s.created_at.toISOString(),
              lastActiveAt: (s.refreshed_at ?? s.created_at).toISOString(),
              deviceLabel: userAgentLabel(s.user_agent),
              current: s.id === ctx.sessionId,
              ...(signInMethod ? { signInMethod } : {}),
            };
          }),
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
