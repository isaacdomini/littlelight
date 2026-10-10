import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  apiErrorSchema,
  deletionPreviewResponseSchema,
  GOOGLE_PICKER_SCOPE,
  googleConnectionSchema,
  googleConnectResponseSchema,
  importBatchCreateResponseSchema,
  importBatchesListResponseSchema,
  importBatchResponseSchema,
  importSourceResponseSchema,
  importSourcesListResponseSchema,
} from "@littlelight/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type FakeGoogleServer,
  startFakeGoogleServer,
} from "../../../worker/src/import/google/fake-server";
import { loggerOptions } from "../app";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { testConfig } from "../testing/support";

// Photo import API against a real database and the in-process fake Google server
// (docs/plans/step-10.md 2.6, 10.13; PRD "Roles and permissions", FR-2.7, "Privacy and child
// safety"): Google connect/disconnect, Picker batches, Apple sync status rows, account deletion.

describe.skipIf(!databaseUrl)("photo import API", () => {
  let h: Harness;
  let fake: FakeGoogleServer;
  const sent: { batchId: string; babyId: string }[] = [];
  let enqueueOk = true;
  const logLines: string[] = [];
  let mom: TestUser; // admin
  let dad: TestUser; // co-admin
  let nanny: TestUser; // contributor
  let stranger: TestUser;
  let baby: string;

  const json = (method: "GET" | "POST" | "DELETE", p: string, body?: unknown) =>
    fetch(`${fake.url}${p}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const setConsent = (b: Record<string, unknown>) => json("POST", "/__fake/consent", b);
  const fakeRequests = async () =>
    (await (await json("GET", "/__fake/requests")).json()) as { method: string; path: string }[];

  beforeAll(async () => {
    fake = await startFakeGoogleServer({ port: 0, nodeEnv: "test" });
    const config = {
      GOOGLE_IMPORT_PROVIDER: "fake" as const,
      GOOGLE_IMPORT_FAKE_URL: fake.url,
      GOOGLE_IMPORT_FAKE_PUBLIC_URL: fake.url,
    };
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logLines.push(String(chunk));
        cb();
      },
    });
    h = await createHarness({
      config,
      logger: {
        ...loggerOptions(testConfig()),
        level: "info",
        stream,
        transport: undefined,
      } as never,
      jobs: {
        enqueueIngest: async () => true,
        enqueueReindex: async () => true,
        enqueueShareApply: async () => true,
        enqueuePush: async () => true,
        enqueueDataExport: async () => true,
        enqueueImportGoogle: async (job: { batchId: string; babyId: string }) => {
          sent.push(job);
          return enqueueOk;
        },
        close: async () => undefined,
      } as never,
    });
  });
  afterAll(async () => {
    await h?.close();
    await fake?.close();
  });
  // Fresh people and a fresh album per test: the per-user throttles (10 an hour) are in memory
  // and would otherwise run out across the file.
  beforeEach(async () => {
    sent.length = 0;
    enqueueOk = true;
    await json("POST", "/__fake/reset", {});
    mom = await h.user({ displayName: "Mom" });
    dad = await h.user({ displayName: "Dad" });
    nanny = await h.user({ displayName: "Nanny" });
    stranger = await h.user();
    baby = await h.baby(mom, "Maya");
    await h.member(baby, dad, "admin");
    await h.member(baby, nanny, "contributor");
  });

  // --- helpers ---------------------------------------------------------------------------------

  /** `google_accounts` rows of this test's people. */
  const accounts = async () =>
    (
      await h.admin.query<{ user_id: string }>(
        "SELECT user_id FROM public.google_accounts WHERE user_id = ANY($1::uuid[])",
        [[mom.id, dad.id, nanny.id, stranger.id]],
      )
    ).rows.map((r) => r.user_id);

  const connection = async (u: TestUser | null) => {
    const res = await h.inject(u, "GET", "/me/import/google/connection");
    return res;
  };

  /** Full connect: POST connect, the fake consent (auto-allow), then the callback. */
  async function connect(
    u: TestUser,
    o: {
      client?: "web" | "native";
      returnTo?: "/upload" | "/settings/import";
      account?: string;
      decision?: "allow" | "deny";
      scopeMissing?: boolean;
    } = {},
  ) {
    await setConsent({
      decision: o.decision ?? "allow",
      account: o.account ?? `acct-${u.id.slice(0, 8)}`,
      ...(o.scopeMissing ? { scopeMissing: true } : {}),
    });
    const res = await h.inject(u, "POST", "/me/import/google/connect", {
      client: o.client ?? "web",
      ...(o.returnTo ? { returnTo: o.returnTo } : {}),
    });
    expect(res.statusCode, res.body).toBe(200);
    const { url } = googleConnectResponseSchema.parse(res.json());
    const auth = await fetch(url, { redirect: "manual" });
    const loc = new URL(auth.headers.get("location") ?? "");
    const cb = await h.inject(null, "GET", `${loc.pathname.replace(/^\/api/, "")}${loc.search}`);
    return { url, loc, cb };
  }
  const connectedStatus = (location: string | undefined) =>
    new URL(location ?? "http://x").searchParams;

  const createBatch = (u: TestUser | null, b = baby) =>
    h.inject(u, "POST", `/babies/${b}/imports/google`, {});
  const getBatch = (u: TestUser | null, id: string) => h.inject(u, "GET", `/imports/${id}`);
  const cancel = (u: TestUser | null, id: string) => h.inject(u, "POST", `/imports/${id}/cancel`);
  const startBatch = async (u: TestUser, b = baby) => {
    await connect(u);
    const res = await createBatch(u, b);
    expect(res.statusCode, res.body).toBe(201);
    return importBatchCreateResponseSchema.parse(res.json());
  };
  const sessionIdOf = async (batchId: string) =>
    (
      await h.admin.query<{ provider_session_id: string }>(
        "SELECT provider_session_id FROM public.import_batches WHERE id = $1",
        [batchId],
      )
    ).rows[0]?.provider_session_id ?? "";
  const dueNow = (batchId: string) =>
    h.admin.query(
      "UPDATE public.import_batches SET last_polled_at = now() - interval '1 minute' WHERE id = $1",
      [batchId],
    );

  // --- connection ------------------------------------------------------------------------------

  describe("GET /me/import/google/connection", () => {
    it("not connected: available, no connection", async () => {
      const res = await connection(mom);
      expect(res.statusCode).toBe(200);
      expect(googleConnectionSchema.parse(res.json())).toEqual({
        available: true,
        connected: false,
        connectedAt: null,
        needsReconnect: false,
      });
    });

    it("needs a session", async () => {
      expect((await connection(null)).statusCode).toBe(401);
    });
  });

  describe("connect flow", () => {
    it("POST /connect returns Google's consent URL: picker scope only, offline, forced consent, our callback, a state", async () => {
      await setConsent({ decision: "allow" });
      const res = await h.inject(mom, "POST", "/me/import/google/connect", { client: "web" });
      expect(res.statusCode).toBe(200);
      const url = new URL(googleConnectResponseSchema.parse(res.json()).url);
      expect(url.origin + url.pathname).toBe(`${fake.url}/o/oauth2/v2/auth`);
      expect(url.searchParams.get("scope")).toBe(GOOGLE_PICKER_SCOPE);
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
      expect(url.searchParams.get("include_granted_scopes")).toBe("false");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("redirect_uri")).toBe(
        "http://localhost:8080/api/import/google/callback",
      );
      expect((url.searchParams.get("state") ?? "").split(".")).toHaveLength(3);
    });

    it("validates the body (client required, returnTo allow-listed, no extras) and needs a session", async () => {
      for (const body of [
        {},
        { client: "tv" },
        { client: "web", returnTo: "https://evil.test" },
        { client: "web", x: 1 },
      ]) {
        const res = await h.inject(mom, "POST", "/me/import/google/connect", body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect(
        (await h.inject(null, "POST", "/me/import/google/connect", { client: "web" })).statusCode,
      ).toBe(401);
    });

    it("Allow: redirects to the connected page (ok), stores the refresh token encrypted, audits without a token", async () => {
      const { cb } = await connect(mom, { returnTo: "/settings/import" });
      expect(cb.statusCode).toBe(302);
      const q = connectedStatus(cb.headers.location as string);
      expect(new URL(cb.headers.location as string).pathname).toBe("/import/google/connected");
      expect(Object.fromEntries(q)).toEqual({
        status: "ok",
        client: "web",
        returnTo: "/settings/import",
      });
      expect(cb.headers["cache-control"]).toBe("no-store");

      const conn = googleConnectionSchema.parse((await connection(mom)).json());
      expect(conn).toMatchObject({ available: true, connected: true, needsReconnect: false });
      expect(conn.connectedAt).not.toBeNull();

      const row = (
        await h.admin.query<{ blob: Buffer; scope: string }>(
          "SELECT refresh_token_enc AS blob, scope FROM public.google_accounts WHERE user_id = $1",
          [mom.id],
        )
      ).rows[0];
      expect(row?.scope).toContain("photospicker.mediaitems.readonly");
      expect(row?.blob.byteLength).toBeGreaterThan(20);
      expect(row?.blob.toString("latin1")).not.toContain("fake-refresh");
      const dec = await h.admin.query("BEGIN").then(async () => {
        await h.admin.query("SELECT set_config('app.data_key', $1, true)", [
          h.config.DATA_ENCRYPTION_KEY,
        ]);
        const r = await h.admin.query<{ t: string }>(
          "SELECT decrypt_secret(refresh_token_enc) AS t FROM public.google_accounts WHERE user_id = $1",
          [mom.id],
        );
        await h.admin.query("ROLLBACK");
        return r.rows[0]?.t;
      });
      expect(dec).toMatch(/^fake-refresh-/);
      const audits = await h.audit({ event: "import.google_connected", actor: mom.id });
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0])).not.toMatch(/fake-|token|1\/\//);
    });

    it("a native client is told so on the connected page", async () => {
      const { cb } = await connect(mom, { client: "native" });
      expect(Object.fromEntries(connectedStatus(cb.headers.location as string))).toMatchObject({
        status: "ok",
        client: "native",
      });
    });

    it("Deny: redirects with status=denied and stores nothing", async () => {
      const { cb } = await connect(mom, { decision: "deny" });
      expect(connectedStatus(cb.headers.location as string).get("status")).toBe("denied");
      expect(
        (await h.admin.query("SELECT 1 FROM public.google_accounts WHERE user_id = $1", [mom.id]))
          .rowCount,
      ).toBe(0);
      expect(googleConnectionSchema.parse((await connection(mom)).json()).connected).toBe(false);
    });

    it("a consent without the Picker scope: status=scope_missing, nothing stored, the grant is revoked at Google", async () => {
      const { cb } = await connect(mom, { scopeMissing: true });
      expect(connectedStatus(cb.headers.location as string).get("status")).toBe("scope_missing");
      expect(
        (await h.admin.query("SELECT 1 FROM public.google_accounts WHERE user_id = $1", [mom.id]))
          .rowCount,
      ).toBe(0);
      expect(
        ((await (await json("GET", "/__fake/revocations")).json()) as unknown[]).length,
      ).toBeGreaterThanOrEqual(1);
    });

    it.each([
      ["no state", ""],
      ["a garbage state", "?code=fake-code-x&state=not-a-jwt"],
      ["a tampered state", "tamper"],
    ])("the callback with %s: status=expired, nothing stored", async (name, qs) => {
      let query = qs;
      if (name === "a tampered state") {
        const { url } = googleConnectResponseSchema.parse(
          (await h.inject(mom, "POST", "/me/import/google/connect", { client: "web" })).json(),
        );
        const state = new URL(url).searchParams.get("state") ?? "";
        query = `?code=fake-code-x&state=${state.slice(0, -3)}abc`;
      }
      const res = await h.inject(null, "GET", `/import/google/callback${query}`);
      expect(res.statusCode).toBe(302);
      expect(connectedStatus(res.headers.location as string).get("status")).toBe("expired");
      expect((await accounts()).length).toBe(0);
    });

    it("an expired state is rejected (10 minute lifetime)", async () => {
      const { mintGoogleState } = await import("./google/state");
      const state = await mintGoogleState(h.config, {
        uid: mom.id,
        sessionId: mom.sessionId,
        client: "web",
        returnTo: "/upload",
        now: new Date(Date.now() - 20 * 60_000),
      });
      const res = await h.inject(
        null,
        "GET",
        `/import/google/callback?code=fake-code-x&state=${state}`,
      );
      expect(connectedStatus(res.headers.location as string).get("status")).toBe("expired");
    });

    it("the state binds to a live sign-in session: after sign-out the callback stores nothing", async () => {
      await setConsent({ decision: "allow", account: "acct-out" });
      const { url } = googleConnectResponseSchema.parse(
        (await h.inject(mom, "POST", "/me/import/google/connect", { client: "web" })).json(),
      );
      const second = await h.session(mom);
      const { mintGoogleState } = await import("./google/state");
      const state = await mintGoogleState(h.config, {
        uid: mom.id,
        sessionId: second.id,
        client: "web",
        returnTo: "/upload",
      });
      const authUrl = new URL(url);
      authUrl.searchParams.set("state", state);
      const loc = new URL(
        (await fetch(authUrl, { redirect: "manual" })).headers.get("location") ?? "",
      );
      await h.admin.query("DELETE FROM auth.sessions WHERE id = $1", [second.id]);
      const res = await h.inject(null, "GET", `${loc.pathname.replace(/^\/api/, "")}${loc.search}`);
      expect(connectedStatus(res.headers.location as string).get("status")).toBe("expired");
      expect((await accounts()).length).toBe(0);
    });

    it("a state cannot be replayed to connect for a different user (the state names its user)", async () => {
      const { url } = googleConnectResponseSchema.parse(
        (await h.inject(mom, "POST", "/me/import/google/connect", { client: "web" })).json(),
      );
      await setConsent({ decision: "allow", account: "acct-replay" });
      const loc = new URL((await fetch(url, { redirect: "manual" })).headers.get("location") ?? "");
      // Delivered by anyone: the connection lands on mom (the state's user), never on the deliverer.
      const res = await h.inject(
        nanny,
        "GET",
        `${loc.pathname.replace(/^\/api/, "")}${loc.search}`,
      );
      expect(connectedStatus(res.headers.location as string).get("status")).toBe("ok");
      expect(await accounts()).toEqual([mom.id]);
    });

    it("an authorization code works once: the replay is status=error and keeps the first connection", async () => {
      await setConsent({ decision: "allow", account: "acct-once" });
      const { url } = googleConnectResponseSchema.parse(
        (await h.inject(mom, "POST", "/me/import/google/connect", { client: "web" })).json(),
      );
      const loc = new URL((await fetch(url, { redirect: "manual" })).headers.get("location") ?? "");
      const path = `${loc.pathname.replace(/^\/api/, "")}${loc.search}`;
      expect(
        connectedStatus((await h.inject(null, "GET", path)).headers.location as string).get(
          "status",
        ),
      ).toBe("ok");
      expect(
        connectedStatus((await h.inject(null, "GET", path)).headers.location as string).get(
          "status",
        ),
      ).toBe("error");
      expect(googleConnectionSchema.parse((await connection(mom)).json()).connected).toBe(true);
    });

    it("throttles connect starts to 10 per user per hour (429 with Retry-After)", async () => {
      await setConsent({ decision: "allow" });
      const u = await h.user();
      let last = 200;
      for (let i = 0; i < 11; i++)
        last = (await h.inject(u, "POST", "/me/import/google/connect", { client: "web" }))
          .statusCode;
      expect(last).toBe(429);
    });

    it("reconnect after Google revoked: needsReconnect shows, a new connect clears it", async () => {
      await connect(mom);
      await json("POST", "/__fake/revoke-all", {});
      const batchTry = await createBatch(mom);
      expect(batchTry.statusCode).toBe(409);
      expect(apiErrorSchema.parse(batchTry.json()).error).toBe("google_reconnect");
      expect(googleConnectionSchema.parse((await connection(mom)).json())).toMatchObject({
        connected: true,
        needsReconnect: true,
      });
      await connect(mom);
      expect(googleConnectionSchema.parse((await connection(mom)).json())).toMatchObject({
        connected: true,
        needsReconnect: false,
      });
    });

    it("one user's connection is invisible to others", async () => {
      await connect(mom);
      expect(googleConnectionSchema.parse((await connection(dad)).json()).connected).toBe(false);
      expect(googleConnectionSchema.parse((await connection(stranger)).json()).connected).toBe(
        false,
      );
    });
  });

  describe("DELETE /me/import/google/connection", () => {
    it("revokes at Google, deletes the row, audits, and cancels the user's picking batches", async () => {
      const { batch } = await startBatch(mom);
      const before = await json("GET", "/__fake/sessions");
      expect(((await before.json()) as { deleted: boolean }[]).some((s) => !s.deleted)).toBe(true);
      const res = await h.inject(mom, "DELETE", "/me/import/google/connection");
      expect(res.statusCode).toBe(204);
      const revs = (await (await json("GET", "/__fake/revocations")).json()) as { token: string }[];
      expect(revs).toHaveLength(1);
      expect(revs[0]?.token).toMatch(/^fake-refresh-/);
      expect(
        (await h.admin.query("SELECT 1 FROM public.google_accounts WHERE user_id = $1", [mom.id]))
          .rowCount,
      ).toBe(0);
      expect(googleConnectionSchema.parse((await connection(mom)).json()).connected).toBe(false);
      expect(
        (
          await h.admin.query<{ status: string }>(
            "SELECT status FROM public.import_batches WHERE id = $1",
            [batch.id],
          )
        ).rows[0]?.status,
      ).toBe("cancelled");
      expect(await h.audit({ event: "import.google_disconnected", actor: mom.id })).toHaveLength(1);
    });

    it("is a quiet 204 when nothing is connected, and calls Google not at all", async () => {
      const res = await h.inject(stranger, "DELETE", "/me/import/google/connection");
      expect(res.statusCode).toBe(204);
      expect((await fakeRequests()).filter((r) => r.path === "/revoke")).toEqual([]);
    });

    it("still deletes the row when Google's revoke fails", async () => {
      await connect(mom);
      await json("POST", "/__fake/faults", { route: "revoke", status: 500 });
      expect((await h.inject(mom, "DELETE", "/me/import/google/connection")).statusCode).toBe(204);
      expect(
        (await h.admin.query("SELECT 1 FROM public.google_accounts WHERE user_id = $1", [mom.id]))
          .rowCount,
      ).toBe(0);
    });

    it("needs a session", async () => {
      expect((await h.inject(null, "DELETE", "/me/import/google/connection")).statusCode).toBe(401);
    });
  });

  // --- batches ---------------------------------------------------------------------------------

  describe("POST /babies/:id/imports/google", () => {
    it("needs a connection first", async () => {
      const res = await createBatch(mom);
      expect(res.statusCode).toBe(409);
      expect(apiErrorSchema.parse(res.json()).error).toBe("google_not_connected");
    });

    it("201: a picking batch, the pickerUri once, the session id stored but never returned, audited by id", async () => {
      const { batch, pickerUri } = await startBatch(mom);
      expect(batch).toMatchObject({
        babyId: baby,
        kind: "google_picker",
        status: "picking",
        error: null,
        requestedBy: mom.id,
        requestedByName: "Mom",
        isMine: true,
        itemsTotal: null,
        itemsImported: 0,
        startedAt: null,
        finishedAt: null,
      });
      expect(batch.pollIntervalSec).toBeGreaterThanOrEqual(3);
      expect(batch.pickerExpiresAt).not.toBeNull();
      const exp = Date.parse(batch.pickerExpiresAt ?? "");
      expect(exp - Date.now()).toBeLessThanOrEqual(30 * 60_000 + 5_000);
      const sid = await sessionIdOf(batch.id);
      expect(sid).toMatch(/^fake-session-/);
      expect(pickerUri).toBe(`${fake.url}/picker/${sid}`);
      const audits = await h.audit({ event: "import.batch_created", baby });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actor_user_id).toBe(mom.id);
      expect(audits[0]?.metadata).toEqual({ batch_id: batch.id, kind: "google_picker" });

      // pickerUri and the session id are in the create response and nowhere else.
      const later = await getBatch(mom, batch.id);
      expect(later.body).not.toContain(sid);
      expect(later.body).not.toContain("pickerUri");
      const list = await h.inject(mom, "GET", `/babies/${baby}/imports`);
      expect(list.body).not.toContain(sid);
      expect(list.body).not.toContain("pickerUri");
    });

    it("only one active batch per album: the second is 409 import_in_progress, and no extra Google session stays open", async () => {
      await startBatch(mom);
      await connect(dad);
      const res = await createBatch(dad);
      expect(res.statusCode).toBe(409);
      expect(apiErrorSchema.parse(res.json()).error).toBe("import_in_progress");
      const again = await createBatch(mom);
      expect(again.statusCode).toBe(409);
      const open = (
        (await (await json("GET", "/__fake/sessions")).json()) as { deleted: boolean }[]
      ).filter((s) => !s.deleted);
      expect(open).toHaveLength(1);
    });

    it("a contributor may import, into their own batch (their photos will wait for approval)", async () => {
      const b2 = await h.baby(mom, "Second");
      await h.member(b2, nanny, "contributor");
      const { batch } = await startBatch(nanny, b2);
      expect(batch.isMine).toBe(true);
      expect(batch.requestedBy).toBe(nanny.id);
    });

    it("a stranger gets 404 not_found; so does someone from another album; nobody learns the album exists", async () => {
      await connect(stranger);
      const res = await createBatch(stranger);
      expect(res.statusCode).toBe(404);
      expect(apiErrorSchema.parse(res.json()).error).toBe("not_found");
      const missing = await createBatch(stranger, randomUUID());
      expect(missing.statusCode).toBe(404);
      expect(missing.json().message).toBe(res.json().message);
    });

    it("a trashed album is 409 baby_trashed", async () => {
      const trashed = await h.baby(mom, "Gone");
      await connect(mom);
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [trashed]);
      const res = await createBatch(mom, trashed);
      expect(res.statusCode).toBe(409);
      expect(apiErrorSchema.parse(res.json()).error).toBe("baby_trashed");
    });

    it("needs a session and a body that is an empty object", async () => {
      expect((await createBatch(null)).statusCode).toBe(401);
      await connect(mom);
      expect(
        (await h.inject(mom, "POST", `/babies/${baby}/imports/google`, { items: ["x"] }))
          .statusCode,
      ).toBe(400);
    });

    it("throttles batch starts to 10 per user per hour", async () => {
      const u = await h.user();
      const b = await h.baby(u, "Throttle");
      await connect(u);
      let last = 0;
      for (let i = 0; i < 11; i++) {
        const res = await createBatch(u, b);
        last = res.statusCode;
        if (res.statusCode === 201) await cancel(u, res.json().batch.id);
      }
      expect(last).toBe(429);
    });

    it("an album past 20 batches in 24 hours is 429 rate_limited", async () => {
      const b = await h.baby(mom, "Busy");
      await connect(mom);
      for (let i = 0; i < 20; i++) {
        const id = randomUUID();
        await h.admin.query(
          "INSERT INTO public.import_batches (id, baby_id, requested_by, kind, status, finished_at) VALUES ($1, $2, $3, 'google_picker', 'picking', NULL)",
          [id, b, mom.id],
        );
        await h.admin.query(
          "UPDATE public.import_batches SET status = 'done', finished_at = now() WHERE id = $1",
          [id],
        );
      }
      const res = await createBatch(mom, b);
      expect(res.statusCode).toBe(429);
      expect(apiErrorSchema.parse(res.json()).error).toBe("rate_limited");
    });
  });

  describe("GET /imports/:batchId (poll)", () => {
    it("asks Google at most once per interval", async () => {
      const { batch } = await startBatch(mom);
      await dueNow(batch.id);
      const sid = await sessionIdOf(batch.id);
      await json("DELETE", "/__fake/requests");
      for (let i = 0; i < 6; i++) {
        const res = await getBatch(mom, batch.id);
        expect(importBatchResponseSchema.parse(res.json()).batch.status).toBe("picking");
      }
      const polls = (await fakeRequests()).filter(
        (r) => r.method === "GET" && r.path === `/v1/sessions/${sid}`,
      );
      expect(polls.length).toBe(1);
      expect(sent).toEqual([]);
    });

    it("picked => queued and import.google is sent once, with ids only", async () => {
      const { batch, pickerUri } = await startBatch(mom);
      await fetch(`${pickerUri}?autopick=G-1,G-2`);
      await dueNow(batch.id);
      const res = await getBatch(mom, batch.id);
      expect(importBatchResponseSchema.parse(res.json()).batch.status).toBe("queued");
      expect(sent).toEqual([{ batchId: batch.id, babyId: baby }]);
      await dueNow(batch.id);
      await getBatch(mom, batch.id);
      expect(sent).toHaveLength(1);
    });

    it("a failed enqueue leaves the batch queued (the sweep re-sends it)", async () => {
      enqueueOk = false;
      const { batch, pickerUri } = await startBatch(mom);
      await fetch(`${pickerUri}?autopick=G-1`);
      await dueNow(batch.id);
      const res = await getBatch(mom, batch.id);
      expect(importBatchResponseSchema.parse(res.json()).batch.status).toBe("queued");
      expect(sent).toHaveLength(1);
    });

    it("a transient Google failure on poll answers with the stored state, not an error", async () => {
      const { batch } = await startBatch(mom);
      await dueNow(batch.id);
      await json("POST", "/__fake/faults", { route: "sessions.get", status: 503 });
      const res = await getBatch(mom, batch.id);
      expect(res.statusCode).toBe(200);
      expect(importBatchResponseSchema.parse(res.json()).batch.status).toBe("picking");
    });

    it("a session gone at Google (404) expires the batch", async () => {
      const { batch } = await startBatch(mom);
      await json("POST", `/__fake/sessions/${await sessionIdOf(batch.id)}/expire`, {});
      await dueNow(batch.id);
      const res = await getBatch(mom, batch.id);
      expect(importBatchResponseSchema.parse(res.json()).batch.status).toBe("expired");
    });

    it("a picking batch past its expiry reads as expired and frees the album", async () => {
      const { batch } = await startBatch(mom);
      await h.admin.query(
        "UPDATE public.import_batches SET picker_expires_at = now() - interval '1 minute' WHERE id = $1",
        [batch.id],
      );
      expect(
        importBatchResponseSchema.parse((await getBatch(mom, batch.id)).json()).batch.status,
      ).toBe("expired");
      const next = await createBatch(mom);
      expect(next.statusCode).toBe(201);
    });

    it("visibility: the requester and the album's admins see it; a contributor sees only their own; strangers get 404", async () => {
      const { batch } = await startBatch(mom);
      expect((await getBatch(mom, batch.id)).statusCode).toBe(200);
      const asDad = importBatchResponseSchema.parse((await getBatch(dad, batch.id)).json()).batch;
      expect(asDad.isMine).toBe(false);
      expect(asDad.requestedByName).toBe("Mom");
      expect((await getBatch(nanny, batch.id)).statusCode).toBe(404);
      expect((await getBatch(stranger, batch.id)).statusCode).toBe(404);
      expect((await getBatch(null, batch.id)).statusCode).toBe(401);
      expect((await getBatch(mom, randomUUID())).statusCode).toBe(404);
      expect((await getBatch(mom, "not-a-uuid")).statusCode).toBe(400);
    });

    it("a co-admin's poll does not drive the requester's batch (it is not their token)", async () => {
      const { batch, pickerUri } = await startBatch(mom);
      await fetch(`${pickerUri}?autopick=G-1`);
      await dueNow(batch.id);
      await connect(dad);
      const res = await getBatch(dad, batch.id);
      expect(importBatchResponseSchema.parse(res.json()).batch.status).toBe("picking");
      expect(sent).toEqual([]);
    });
  });

  describe("POST /imports/:batchId/cancel", () => {
    it("a picking batch: cancelled, the Google session deleted, audited", async () => {
      const { batch } = await startBatch(mom);
      const sid = await sessionIdOf(batch.id);
      await json("DELETE", "/__fake/requests");
      const res = await cancel(mom, batch.id);
      expect(res.statusCode).toBe(200);
      expect(importBatchResponseSchema.parse(res.json()).batch.status).toBe("cancelled");
      const dels = (await fakeRequests()).filter(
        (r) => r.method === "DELETE" && r.path.startsWith("/v1/sessions/"),
      );
      expect(dels).toHaveLength(1);
      expect(dels[0]?.path).toBe(`/v1/sessions/${sid}`);
      expect(await h.audit({ event: "import.batch_cancelled", actor: mom.id })).toHaveLength(1);
      // the album is free again
      expect((await createBatch(mom)).statusCode).toBe(201);
    });

    it("a queued/running batch: cancel_requested_at is set for the worker, the status is not changed", async () => {
      const { batch, pickerUri } = await startBatch(mom);
      await fetch(`${pickerUri}?autopick=G-1`);
      await dueNow(batch.id);
      await getBatch(mom, batch.id);
      const res = await cancel(mom, batch.id);
      expect(importBatchResponseSchema.parse(res.json()).batch.status).toBe("queued");
      const row = (
        await h.admin.query<{ cancel_requested_at: Date | null }>(
          "SELECT cancel_requested_at FROM public.import_batches WHERE id = $1",
          [batch.id],
        )
      ).rows[0];
      expect(row?.cancel_requested_at).not.toBeNull();
    });

    it("only the requester can cancel (a co-admin gets 403 not_requester, a stranger 404)", async () => {
      const { batch } = await startBatch(mom);
      const r1 = await cancel(dad, batch.id);
      expect(r1.statusCode).toBe(403);
      expect(apiErrorSchema.parse(r1.json()).error).toBe("not_requester");
      expect((await cancel(stranger, batch.id)).statusCode).toBe(404);
      expect((await cancel(null, batch.id)).statusCode).toBe(401);
      expect(
        importBatchResponseSchema.parse((await getBatch(mom, batch.id)).json()).batch.status,
      ).toBe("picking");
    });

    it("cancelling a finished batch changes nothing", async () => {
      const { batch } = await startBatch(mom);
      await h.admin.query(
        "UPDATE public.import_batches SET status = 'done', finished_at = now() WHERE id = $1",
        [batch.id],
      );
      const res = await cancel(mom, batch.id);
      expect(importBatchResponseSchema.parse(res.json()).batch.status).toBe("done");
      expect(await h.audit({ event: "import.batch_cancelled", baby })).toHaveLength(0);
    });
  });

  describe("GET /babies/:id/imports", () => {
    it("admins see every batch, a contributor only their own, a stranger 404", async () => {
      const { batch } = await startBatch(mom);
      await cancel(mom, batch.id);
      const { batch: theirs } = await startBatch(nanny);
      const adminList = importBatchesListResponseSchema.parse(
        (await h.inject(dad, "GET", `/babies/${baby}/imports`)).json(),
      ).batches;
      expect(adminList.map((b) => b.id)).toEqual([theirs.id, batch.id]);
      const nannyList = importBatchesListResponseSchema.parse(
        (await h.inject(nanny, "GET", `/babies/${baby}/imports`)).json(),
      ).batches;
      expect(nannyList.map((b) => b.id)).toEqual([theirs.id]);
      expect((await h.inject(stranger, "GET", `/babies/${baby}/imports`)).statusCode).toBe(404);
      expect((await h.inject(mom, "GET", `/babies/${baby}/imports?limit=21`)).statusCode).toBe(400);
      expect(
        importBatchesListResponseSchema.parse(
          (await h.inject(mom, "GET", `/babies/${baby}/imports?limit=1`)).json(),
        ).batches,
      ).toHaveLength(1);
    });
  });

  // --- Apple sync status -----------------------------------------------------------------------

  describe("import sources (Apple album sync status)", () => {
    const device = randomUUID();
    const body = (over: Record<string, unknown> = {}) => ({
      kind: "apple_photos",
      deviceId: device,
      deviceLabel: "Mom's iPhone",
      albumTitle: "Maya",
      wifiOnly: true,
      ...over,
    });
    const upsert = (u: TestUser | null, b: unknown = body(), babyId = baby) =>
      h.inject(u, "POST", `/babies/${babyId}/import-sources`, b);
    const list = (u: TestUser | null, deviceId?: string, babyId = baby) =>
      h.inject(
        u,
        "GET",
        `/me/import-sources?babyId=${babyId}${deviceId ? `&deviceId=${deviceId}` : ""}`,
      );

    it("an admin creates (201) then re-enables (200), un-pausing and clearing the error; audit once, no label or title in it", async () => {
      const res = await upsert(mom);
      expect(res.statusCode).toBe(201);
      const s = importSourceResponseSchema.parse(res.json()).source;
      expect(s).toMatchObject({
        babyId: baby,
        userId: mom.id,
        userName: "Mom",
        kind: "apple_photos",
        deviceId: device,
        deviceLabel: "Mom's iPhone",
        albumTitle: "Maya",
        wifiOnly: true,
        paused: false,
        isMine: true,
        importedCount: 0,
        lastError: null,
      });
      await h.inject(mom, "PATCH", `/import-sources/${s.id}`, {
        paused: true,
        lastError: "network",
      });
      const again = await upsert(mom, body({ albumTitle: "Maya 2", wifiOnly: false }));
      expect(again.statusCode).toBe(200);
      expect(importSourceResponseSchema.parse(again.json()).source).toMatchObject({
        id: s.id,
        albumTitle: "Maya 2",
        wifiOnly: false,
        paused: false,
        lastError: null,
      });
      const audits = await h.audit({ event: "import.source_created", baby });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadata).toEqual({ source_id: s.id, kind: "apple_photos" });
      expect(JSON.stringify(audits)).not.toMatch(/Maya|iPhone|deviceId/i);
    });

    it("a contributor is refused (403 forbidden); so is a stranger (404); nothing is created", async () => {
      const r1 = await upsert(nanny);
      expect(r1.statusCode).toBe(403);
      expect(apiErrorSchema.parse(r1.json()).error).toBe("forbidden");
      expect((await upsert(stranger)).statusCode).toBe(404);
      expect((await upsert(null)).statusCode).toBe(401);
      expect(
        (await h.admin.query("SELECT 1 FROM public.import_sources WHERE baby_id = $1", [baby]))
          .rowCount,
      ).toBe(0);
    });

    it("validates the body: no asset ids, no extra keys, bounded labels, uuid device", async () => {
      for (const b of [
        body({ assetIds: ["A/L0/001"] }),
        body({ kind: "google_picker" }),
        body({ deviceId: "iphone" }),
        body({ deviceLabel: "" }),
        body({ albumTitle: "x".repeat(121) }),
        body({ albumTitle: "bad\u0007" }),
      ])
        expect((await upsert(mom, b)).statusCode, JSON.stringify(b)).toBe(400);
    });

    it("another user's row for the same device is 409 import_source_exists", async () => {
      await upsert(mom);
      const res = await upsert(dad);
      expect(res.statusCode).toBe(409);
      expect(apiErrorSchema.parse(res.json()).error).toBe("import_source_exists");
    });

    it("at most 10 devices per album (409 import_source_limit)", async () => {
      for (let i = 0; i < 10; i++)
        expect((await upsert(mom, body({ deviceId: randomUUID() }))).statusCode).toBe(201);
      const res = await upsert(mom, body({ deviceId: randomUUID() }));
      expect(res.statusCode).toBe(409);
      expect(apiErrorSchema.parse(res.json()).error).toBe("import_source_limit");
    });

    it("a trashed album is 409 baby_trashed", async () => {
      const trashed = await h.baby(mom, "Trash");
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [trashed]);
      const res = await upsert(mom, body(), trashed);
      expect(res.statusCode).toBe(409);
      expect(apiErrorSchema.parse(res.json()).error).toBe("baby_trashed");
    });

    it("GET lists with isThisDevice from the deviceId query; the co-admin sees it, a contributor does not, a stranger 404", async () => {
      await upsert(mom);
      const asMom = importSourcesListResponseSchema.parse((await list(mom, device)).json()).sources;
      expect(asMom).toHaveLength(1);
      expect(asMom[0]).toMatchObject({ isMine: true, isThisDevice: true });
      expect(
        importSourcesListResponseSchema.parse((await list(mom, randomUUID())).json()).sources[0]
          ?.isThisDevice,
      ).toBe(false);
      expect(
        importSourcesListResponseSchema.parse((await list(mom)).json()).sources[0]?.isThisDevice,
      ).toBe(false);
      const asDad = importSourcesListResponseSchema.parse((await list(dad, device)).json()).sources;
      expect(asDad[0]).toMatchObject({ isMine: false, isThisDevice: true, userName: "Mom" });
      expect(importSourcesListResponseSchema.parse((await list(nanny)).json()).sources).toEqual([]);
      expect((await list(stranger)).statusCode).toBe(404);
      expect((await list(null)).statusCode).toBe(401);
    });

    it("PATCH applies counter deltas additively (no lost updates), sets flags, clears the error", async () => {
      const s = importSourceResponseSchema.parse((await upsert(mom)).json()).source;
      const patch = (b: unknown, u: TestUser | null = mom) =>
        h.inject(u, "PATCH", `/import-sources/${s.id}`, b);
      await Promise.all([
        patch({ importedDelta: 3, duplicateDelta: 1 }),
        patch({ importedDelta: 4, failedDelta: 2 }),
        patch({ skippedDelta: 5 }),
      ]);
      const res = await patch({
        lastSyncAt: "2026-10-10T10:00:00.000Z",
        lastTrigger: "manual",
        lastError: "free_tier_limit",
        paused: true,
      });
      const after = importSourceResponseSchema.parse(res.json()).source;
      expect(after).toMatchObject({
        importedCount: 7,
        duplicateCount: 1,
        failedCount: 2,
        skippedCount: 5,
        lastTrigger: "manual",
        lastError: "free_tier_limit",
        paused: true,
        isThisDevice: false,
      });
      expect(after.lastSyncAt).toBe("2026-10-10T10:00:00.000Z");
      const cleared = importSourceResponseSchema.parse(
        (await patch({ lastError: null })).json(),
      ).source;
      expect(cleared.lastError).toBeNull();
    });

    it("PATCH rejects an empty patch, a delta over 500, a negative delta, unknown keys", async () => {
      const s = importSourceResponseSchema.parse((await upsert(mom)).json()).source;
      for (const b of [
        {},
        { importedDelta: 501 },
        { failedDelta: -1 },
        { importedCount: 9 },
        { lastError: "boom" },
      ])
        expect(
          (await h.inject(mom, "PATCH", `/import-sources/${s.id}`, b)).statusCode,
          JSON.stringify(b),
        ).toBe(400);
    });

    it("only the owner patches: the co-admin, a contributor and a stranger get 404; after demotion the owner does too", async () => {
      const s = importSourceResponseSchema.parse((await upsert(mom)).json()).source;
      for (const u of [dad, nanny, stranger])
        expect(
          (await h.inject(u, "PATCH", `/import-sources/${s.id}`, { paused: true })).statusCode,
        ).toBe(404);
      expect(
        (await h.inject(null, "PATCH", `/import-sources/${s.id}`, { paused: true })).statusCode,
      ).toBe(401);
      expect(
        (await h.inject(mom, "PATCH", `/import-sources/${randomUUID()}`, { paused: true }))
          .statusCode,
      ).toBe(404);
      const row = (
        await h.admin.query<{ paused: boolean }>(
          "SELECT paused FROM public.import_sources WHERE id = $1",
          [s.id],
        )
      ).rows[0];
      expect(row?.paused).toBe(false);
    });

    it("DELETE: the owner and a co-admin may (audited by id); a contributor and a stranger get 404; 204", async () => {
      const s = importSourceResponseSchema.parse((await upsert(mom)).json()).source;
      expect((await h.inject(nanny, "DELETE", `/import-sources/${s.id}`)).statusCode).toBe(404);
      expect((await h.inject(stranger, "DELETE", `/import-sources/${s.id}`)).statusCode).toBe(404);
      expect((await h.inject(null, "DELETE", `/import-sources/${s.id}`)).statusCode).toBe(401);
      expect((await h.inject(dad, "DELETE", `/import-sources/${s.id}`)).statusCode).toBe(204);
      expect((await h.inject(dad, "DELETE", `/import-sources/${s.id}`)).statusCode).toBe(404);
      const audits = await h.audit({ event: "import.source_deleted", baby });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadata).toEqual({ source_id: s.id });
      const own = importSourceResponseSchema.parse((await upsert(mom)).json()).source;
      expect((await h.inject(mom, "DELETE", `/import-sources/${own.id}`)).statusCode).toBe(204);
    });

    it("demoting the owner to contributor turns the sync off (the row is gone: PATCH is 404)", async () => {
      const s = importSourceResponseSchema.parse((await upsert(dad)).json()).source;
      await h.admin.query(
        "UPDATE public.baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
        [baby, dad.id],
      );
      try {
        expect(
          (await h.inject(dad, "PATCH", `/import-sources/${s.id}`, { paused: true })).statusCode,
        ).toBe(404);
        expect(
          (await h.admin.query("SELECT 1 FROM public.import_sources WHERE id = $1", [s.id]))
            .rowCount,
        ).toBe(0);
      } finally {
        await h.admin.query(
          "UPDATE public.baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
          [baby, dad.id],
        );
      }
    });
  });

  // --- feature switch ---------------------------------------------------------------------------

  describe("provider none", () => {
    it("reports unavailable and refuses connect and import with 404 feature_unavailable", async () => {
      const off = await createHarness({ config: { GOOGLE_IMPORT_PROVIDER: "none" } });
      try {
        const u = await off.user();
        const b = await off.baby(u, "Off");
        const conn = googleConnectionSchema.parse(
          (await off.inject(u, "GET", "/me/import/google/connection")).json(),
        );
        expect(conn).toEqual({
          available: false,
          connected: false,
          connectedAt: null,
          needsReconnect: false,
        });
        for (const [m, p, body] of [
          ["POST", "/me/import/google/connect", { client: "web" }],
          ["POST", `/babies/${b}/imports/google`, {}],
        ] as const) {
          const res = await off.inject(u, m, p, body);
          expect(res.statusCode, p).toBe(404);
          expect(apiErrorSchema.parse(res.json()).error).toBe("feature_unavailable");
        }
        // Apple sync status does not depend on Google.
        const ok = await off.inject(u, "POST", `/babies/${b}/import-sources`, {
          kind: "apple_photos",
          deviceId: randomUUID(),
          deviceLabel: "x",
          albumTitle: "y",
          wifiOnly: true,
        });
        expect(ok.statusCode).toBe(201);
        // The callback is harmless without a provider.
        const cb = await off.inject(null, "GET", "/import/google/callback?code=x&state=y");
        expect(cb.statusCode).toBe(302);
      } finally {
        await off.close();
      }
    });
  });

  // --- account deletion -------------------------------------------------------------------------

  describe("account deletion and the Google connection (task 10.10)", () => {
    const del = (u: TestUser) => h.inject(u, "DELETE", "/me", { acknowledge: true });
    const preview = async (u: TestUser) =>
      deletionPreviewResponseSchema.parse(
        (await h.inject(u, "GET", "/me/deletion-preview")).json(),
      );

    it("preview: googlePhotosConnected is true only for the caller's own connection", async () => {
      const u = await h.user();
      const other = await h.user();
      expect((await preview(u)).googlePhotosConnected).toBe(false);
      await connect(other);
      expect((await preview(u)).googlePhotosConnected).toBe(false);
      expect((await preview(other)).googlePhotosConnected).toBe(true);
      await connect(u);
      expect((await preview(u)).googlePhotosConnected).toBe(true);
    });

    it("a connected user's deletion revokes their refresh token at Google, then removes the row with the account", async () => {
      const u = await h.user();
      await connect(u);
      const token = await (async () => {
        await h.admin.query("BEGIN");
        await h.admin.query("SELECT set_config('app.data_key', $1, true)", [
          h.config.DATA_ENCRYPTION_KEY,
        ]);
        const r = await h.admin.query<{ t: string }>(
          "SELECT decrypt_secret(refresh_token_enc) AS t FROM public.google_accounts WHERE user_id = $1",
          [u.id],
        );
        await h.admin.query("ROLLBACK");
        return r.rows[0]?.t ?? "";
      })();
      expect((await del(u)).statusCode).toBe(204);
      const revs = (await (await json("GET", "/__fake/revocations")).json()) as { token: string }[];
      expect(revs.map((r) => r.token)).toContain(token);
      expect(
        (await h.admin.query("SELECT 1 FROM public.google_accounts WHERE user_id = $1", [u.id]))
          .rowCount,
      ).toBe(0);
      expect((await h.admin.query("SELECT 1 FROM auth.users WHERE id = $1", [u.id])).rowCount).toBe(
        0,
      );
    });

    it("when Google's revoke fails (500) the deletion still succeeds", async () => {
      const u = await h.user();
      await connect(u);
      await json("POST", "/__fake/faults", { route: "revoke", status: 500 });
      expect((await del(u)).statusCode).toBe(204);
      expect((await h.admin.query("SELECT 1 FROM auth.users WHERE id = $1", [u.id])).rowCount).toBe(
        0,
      );
      expect(
        (await h.admin.query("SELECT 1 FROM public.google_accounts WHERE user_id = $1", [u.id]))
          .rowCount,
      ).toBe(0);
    });

    it("without a connection no revoke call is made", async () => {
      const u = await h.user();
      await json("DELETE", "/__fake/requests");
      expect((await del(u)).statusCode).toBe(204);
      expect((await fakeRequests()).filter((r) => r.path === "/revoke")).toEqual([]);
    });

    it("provider none: deletion works and nothing is called", async () => {
      const off = await createHarness({ config: { GOOGLE_IMPORT_PROVIDER: "none" } });
      try {
        const u = await off.user();
        await json("DELETE", "/__fake/requests");
        expect((await off.inject(u, "DELETE", "/me", { acknowledge: true })).statusCode).toBe(204);
        expect(await fakeRequests()).toEqual([]);
        expect(
          deletionPreviewResponseSchema.safeParse({
            blockingBabies: [],
            babiesKept: [],
            freshSignIn: true,
            googlePhotosConnected: false,
          }).success,
        ).toBe(true);
      } finally {
        await off.close();
      }
    });

    it("no token reaches the audit log", async () => {
      const u = await h.user();
      await connect(u);
      await del(u);
      const rows = await h.admin.query(
        "SELECT metadata FROM public.audit_log WHERE actor_user_id = $1 OR metadata::text LIKE '%' || $1 || '%'",
        [u.id],
      );
      expect(JSON.stringify(rows.rows)).not.toMatch(/fake-(refresh|access|code)|1\/\//);
    });
  });

  // --- logs -------------------------------------------------------------------------------------

  describe("logs", () => {
    it("after the whole run, no api log line carries a token, a code, a state, a picker URL, a media URL or a session id", async () => {
      // exercise every secret-bearing path once more, then scan everything captured so far
      const u = await h.user();
      const b = await h.baby(u, "Log");
      await connect(u);
      const created = await createBatch(u, b);
      const { batch, pickerUri } = importBatchCreateResponseSchema.parse(created.json());
      await fetch(`${pickerUri}?autopick=G-1`);
      await dueNow(batch.id);
      await getBatch(u, batch.id);
      await h.inject(u, "DELETE", "/me/import/google/connection");
      const all = logLines.join("");
      expect(all.length).toBeGreaterThan(100);
      expect(all).not.toMatch(/fake-(access|refresh|code|session)-/);
      expect(all).not.toMatch(/\/picker\/|\/media\/|pickerUri|baseUrl/);
      expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
      expect(all).not.toMatch(/[?&](code|state)=/);
    });
  });
});
