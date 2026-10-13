import {
  type GoTruePasskey,
  PASSKEY_MAX_PER_USER,
  type Passkey,
  type PasskeysListResponse,
  passkeyFromGoTrue,
  passkeyOptionsFromGoTrue,
  passkeyParamsSchema,
  passkeyRegisterRequestSchema,
  passkeyRegistrationOptionsResponseSchema,
  passkeyRenameRequestSchema,
  passkeySchema,
  passkeysListResponseSchema,
} from "@tinyglow/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { passkeysEnabled } from "../config";
import { passkeyChangedEmail } from "../email/templates";
import { ApiError } from "../lib/errors";
import { clientCountry, clientDeviceLabel, upstreamClientHeaders } from "../lib/request";
import { audit, requireConsent, requireFreshSignIn, type TxContext, withClaims } from "./context";
import { type GoTruePasskeys, hasPasskeys } from "./gotrue";
import { requireAuth } from "./plugin";
import { isReviewEmail } from "./review";
import type { AuthRuntime } from "./runtime";
import {
  assertPasskeyNameShape,
  attestationHasUserVerification,
  mapPasskeyError,
  passkeyDisabled,
  passkeyFailed,
  passkeyLimit,
  passkeyUnavailableForAccount,
  passkeyUpstreamUnavailable,
} from "./webauthn";

// Passkey management for the signed-in user (docs/plans/step-13.md 2.4 `passkeys.ts`; PRD
// "Sign-in methods", "Auth security requirements"; decisions Q3–Q7). The API fronts GoTrue's
// registration and management routes with the caller's own access token (cookie or bearer:
// `request.auth.token`); GoTrue owns the credentials, the API stores nothing. Rules:
// - every route is 404 `passkey_disabled` unless `AUTH_PASSKEYS_ENABLED` (before validation);
// - `requireAuth` + liveness + `requireConsent` on every route;
// - the store-review account cannot register (Q6: 403 `passkey_unavailable_for_account`);
// - registration requires user verification on the attestation's authenticator data, checked
//   by the API before GoTrue sees it (decision g);
// - removing a passkey needs a fresh sign-in (Q4); adding does not; removing the last one is
//   allowed (the email code remains, D4);
// - audit `auth.passkey_added/removed/renamed { passkey_id }` under the user's claims, and an
//   email on add/remove (Q7, no links);
// - logs carry `{ outcome }` only (the GoTrue error mapper logs status + code on its own line):
//   never a name, a credential, a challenge id or any WebAuthn material.

const SORT_NEWEST_FIRST = (a: Passkey, b: Passkey) => (a.createdAt < b.createdAt ? 1 : -1);

function toList(items: GoTruePasskey[]): PasskeysListResponse {
  return {
    passkeys: items.map(passkeyFromGoTrue).sort(SORT_NEWEST_FIRST).slice(0, 10),
    max: PASSKEY_MAX_PER_USER,
  };
}

export function passkeyRoutes(app: FastifyInstance, runtime: AuthRuntime): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { config, review } = runtime;
  const enabled = passkeysEnabled(config);

  /** Before validation: a disabled feature is 404 whatever the body or params. */
  const requirePasskeysEnabled = async (): Promise<void> => {
    if (!enabled) throw passkeyDisabled();
  };

  /** The caller's session facts after liveness + consent; also the token GoTrue needs. */
  async function caller(
    request: FastifyRequest,
  ): Promise<{ ctx: TxContext; token: string; gotrue: GoTruePasskeys }> {
    const auth = request.auth;
    if (!auth) throw new ApiError(401, "unauthorized", "Sign in to continue");
    const ctx = await withClaims(request, async (client, c) => {
      await requireConsent(client, c);
      return c;
    });
    const { gotrue } = runtime;
    if (!hasPasskeys(gotrue)) throw passkeyUpstreamUnavailable();
    return { ctx, token: auth.token, gotrue };
  }

  function refuseReviewAccount(request: FastifyRequest, ctx: TxContext): void {
    if (isReviewEmail(review, ctx.email)) {
      request.log.info({ outcome: "review_account" }, "passkey registration refused");
      throw passkeyUnavailableForAccount();
    }
  }

  /** Q7: "A passkey was added/removed" alert to the account's address; best effort, no links. */
  async function notify(
    request: FastifyRequest,
    ctx: TxContext,
    action: "added" | "removed",
  ): Promise<void> {
    if (!ctx.email) return;
    const content = passkeyChangedEmail({
      action,
      when: new Date(),
      deviceLabel: clientDeviceLabel(request),
      country: clientCountry(request),
      publicUrl: config.PUBLIC_URL,
    });
    try {
      await runtime.mailer.send({ to: ctx.email, ...content });
    } catch {
      // The mailer logged its own safe category; a failed alert never fails the change.
      request.log.info({ outcome: "mail_failed" }, "passkey change alert not sent");
    }
  }

  r.route({
    method: "POST",
    url: "/me/passkeys/options",
    schema: { response: { 200: passkeyRegistrationOptionsResponseSchema } },
    preValidation: requirePasskeysEnabled,
    preHandler: requireAuth,
    handler: async (request) => {
      const { ctx, token, gotrue } = await caller(request);
      refuseReviewAccount(request, ctx);
      // Pre-check the per-account maximum for a clean 409 (GoTrue enforces it too, at verify).
      let existing: GoTruePasskey[];
      try {
        existing = await gotrue.passkeyList(token);
      } catch (err) {
        throw mapPasskeyError(err, request.log, "register");
      }
      if (existing.length >= PASSKEY_MAX_PER_USER) {
        request.log.info({ outcome: "limit" }, "passkey registration refused");
        throw passkeyLimit();
      }
      try {
        const options = await gotrue.passkeyRegOptions(token, upstreamClientHeaders(request));
        request.log.info({ outcome: "issued" }, "passkey registration options");
        return passkeyOptionsFromGoTrue(options);
      } catch (err) {
        throw mapPasskeyError(err, request.log, "register");
      }
    },
  });

  r.route({
    method: "POST",
    url: "/me/passkeys",
    schema: { body: passkeyRegisterRequestSchema, response: { 201: passkeySchema } },
    preValidation: requirePasskeysEnabled,
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { ctx, token, gotrue } = await caller(request);
      refuseReviewAccount(request, ctx);
      const { challengeId, credential, name } = request.body;
      if (name !== undefined) assertPasskeyNameShape(name);
      // Decision g, registration side: the attestation's authenticator data must carry UV, or
      // this passkey could later sign in without biometrics/PIN. Checked before any GoTrue call.
      if (!attestationHasUserVerification(credential)) {
        request.log.info({ outcome: "no_user_verification" }, "passkey registration refused");
        throw passkeyFailed();
      }
      let created: GoTruePasskey;
      try {
        created = await gotrue.passkeyRegVerify(
          token,
          { challengeId, credential },
          upstreamClientHeaders(request),
        );
      } catch (err) {
        throw mapPasskeyError(err, request.log, "register");
      }
      // The passkey exists from here on: a failed rename or alert never undoes it.
      if (name !== undefined) {
        try {
          created = await gotrue.passkeyRename(token, created.id, name);
        } catch (err) {
          mapPasskeyError(err, request.log, "manage");
          request.log.info({ outcome: "rename_failed" }, "passkey added without its name");
        }
      }
      await withClaims(request, async (client, c) => {
        await audit(client, "auth.passkey_added", {
          actorUserId: c.uid,
          metadata: { passkey_id: created.id, client: request.auth?.clientKind ?? "web" },
        });
      });
      await notify(request, ctx, "added");
      request.log.info({ outcome: "added" }, "passkey added");
      return reply.code(201).send(passkeyFromGoTrue(created));
    },
  });

  r.route({
    method: "GET",
    url: "/me/passkeys",
    schema: { response: { 200: passkeysListResponseSchema } },
    preValidation: requirePasskeysEnabled,
    preHandler: requireAuth,
    handler: async (request) => {
      const { token, gotrue } = await caller(request);
      try {
        return toList(await gotrue.passkeyList(token));
      } catch (err) {
        throw mapPasskeyError(err, request.log, "manage");
      }
    },
  });

  r.route({
    method: "PATCH",
    url: "/me/passkeys/:id",
    schema: {
      params: passkeyParamsSchema,
      body: passkeyRenameRequestSchema,
      response: { 200: passkeySchema },
    },
    preValidation: requirePasskeysEnabled,
    preHandler: requireAuth,
    handler: async (request) => {
      const { token, gotrue } = await caller(request);
      const { id } = request.params;
      const { name } = request.body;
      assertPasskeyNameShape(name);
      let renamed: GoTruePasskey;
      try {
        renamed = await gotrue.passkeyRename(token, id, name);
      } catch (err) {
        throw mapPasskeyError(err, request.log, "manage");
      }
      await withClaims(request, async (client, c) => {
        await audit(client, "auth.passkey_renamed", {
          actorUserId: c.uid,
          metadata: { passkey_id: renamed.id },
        });
      });
      request.log.info({ outcome: "renamed" }, "passkey renamed");
      return passkeyFromGoTrue(renamed);
    },
  });

  r.route({
    method: "DELETE",
    url: "/me/passkeys/:id",
    schema: { params: passkeyParamsSchema },
    preValidation: requirePasskeysEnabled,
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { ctx, token, gotrue } = await caller(request);
      // Q4: removing a passkey is destructive (it is a sign-in credential); a passkey sign-in
      // itself counts as fresh (Q5: the session is new and user-verified).
      requireFreshSignIn(ctx);
      const { id } = request.params;
      try {
        await gotrue.passkeyDelete(token, id);
      } catch (err) {
        throw mapPasskeyError(err, request.log, "manage");
      }
      await withClaims(request, async (client, c) => {
        await audit(client, "auth.passkey_removed", {
          actorUserId: c.uid,
          metadata: { passkey_id: id, client: request.auth?.clientKind ?? "web" },
        });
      });
      await notify(request, ctx, "removed");
      request.log.info({ outcome: "removed" }, "passkey removed");
      return reply.code(204).send();
    },
  });
}
