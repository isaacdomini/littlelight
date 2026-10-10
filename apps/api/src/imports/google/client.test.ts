import { GOOGLE_PICKER_SCOPE } from "@littlelight/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createGoogleClient,
  type FetchLike,
  GOOGLE_CALL_TIMEOUT_MS,
  GOOGLE_REVOKE_TIMEOUT_MS,
  GoogleError,
  isGoogleError,
} from "./client";

const fakeSettings = {
  GOOGLE_IMPORT_PROVIDER: "fake" as const,
  GOOGLE_IMPORT_CLIENT_ID: undefined,
  GOOGLE_IMPORT_CLIENT_SECRET: undefined,
  GOOGLE_IMPORT_FAKE_URL: "http://google-fake:8099",
  GOOGLE_IMPORT_FAKE_PUBLIC_URL: "http://localhost:18099",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const session = {
  id: "sess-1",
  pickerUri: "http://localhost:18099/picker/sess-1",
  pollingConfig: { pollInterval: "3s", timeoutIn: "1800s" },
  expireTime: "2026-10-10T12:00:00Z",
  mediaItemsSet: false,
};

function client(
  fetchImpl: FetchLike,
  settings: Parameters<typeof createGoogleClient>[0] = fakeSettings,
) {
  const c = createGoogleClient(settings, fetchImpl);
  if (!c) throw new Error("no client");
  return c;
}

describe("createGoogleClient", () => {
  it("is null when the provider is none", () => {
    expect(createGoogleClient({ ...fakeSettings, GOOGLE_IMPORT_PROVIDER: "none" })).toBeNull();
  });

  it("builds the consent URL: offline access, forced consent, picker scope only, no granted-scope merge", () => {
    const c = client(vi.fn());
    const url = new URL(
      c.authUrl({ state: "st", redirectUri: "http://localhost:8080/api/import/google/callback" }),
    );
    expect(url.origin + url.pathname).toBe("http://localhost:18099/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      scope: GOOGLE_PICKER_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state: "st",
      redirect_uri: "http://localhost:8080/api/import/google/callback",
    });
  });

  it("live mode uses Google's endpoints", () => {
    const c = client(vi.fn(), {
      ...fakeSettings,
      GOOGLE_IMPORT_PROVIDER: "live",
      GOOGLE_IMPORT_CLIENT_ID: "cid",
      GOOGLE_IMPORT_CLIENT_SECRET: "sec",
    });
    expect(c.authUrl({ state: "s", redirectUri: "https://x.test/cb" })).toMatch(
      /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/,
    );
  });

  it("exchanges a code with a form body (client secret included), never in the URL", async () => {
    const f = vi.fn<FetchLike>(async () =>
      json(200, {
        access_token: "fake-access-1",
        expires_in: 3600,
        refresh_token: "fake-refresh-1",
        scope: GOOGLE_PICKER_SCOPE,
        token_type: "Bearer",
      }),
    );
    const c = client(f, {
      ...fakeSettings,
      GOOGLE_IMPORT_CLIENT_ID: "cid",
      GOOGLE_IMPORT_CLIENT_SECRET: "sec",
    });
    const t = await c.exchangeCode("fake-code-1", "http://localhost:8080/cb");
    expect(t.refresh_token).toBe("fake-refresh-1");
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe("http://google-fake:8099/token");
    expect(String(url)).not.toContain("fake-code");
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "authorization_code",
      code: "fake-code-1",
      client_id: "cid",
      client_secret: "sec",
    });
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("refresh: invalid_grant is google_reconnect; an invalid_grant on a code exchange is google_denied", async () => {
    const f = vi.fn<FetchLike>(async () =>
      json(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked fake-refresh-1",
      }),
    );
    const c = client(f);
    const err = await c.refreshAccessToken("fake-refresh-1").catch((e) => e);
    expect(isGoogleError(err)).toBe(true);
    expect(err).toMatchObject({ category: "google_reconnect", status: 400 });
    expect(String(err.message)).not.toContain("fake-refresh");
    await expect(c.exchangeCode("c", "r")).rejects.toMatchObject({ category: "google_denied" });
  });

  it("returns only the access token on refresh", async () => {
    const c = client(async () =>
      json(200, { access_token: "fake-access-9", expires_in: 3600, token_type: "Bearer" }),
    );
    expect(await c.refreshAccessToken("r")).toBe("fake-access-9");
  });

  it.each([
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "network"],
    [503, "network"],
    [401, "google_denied"],
    [403, "google_denied"],
  ])("maps picker status %i to %s", async (status, category) => {
    const c = client(async () => json(status, { error: { message: "secret detail ya29.zzz" } }));
    const err = await c.getSession("tok", "sess-1").catch((e) => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect(err.category).toBe(category);
    expect(JSON.stringify([err.message, err.category])).not.toContain("ya29");
  });

  it("a malformed body is an internal error; a transport failure is network, with no cause leaked", async () => {
    const c = client(async () => json(200, { id: "x" }));
    await expect(c.createSession("t")).rejects.toMatchObject({ category: "internal" });
    const boom = client(async () => {
      throw new Error("connect ECONNREFUSED http://google-fake:8099/v1/sessions?token=ya29.secret");
    });
    const err = await boom.createSession("t").catch((e) => e);
    expect(err.category).toBe("network");
    expect(err.message).not.toContain("ya29");
    expect(err.cause).toBeUndefined();
  });

  it("sends the bearer on the header only, encodes the session id in the path", async () => {
    const f = vi.fn<FetchLike>(async () => json(200, session));
    const c = client(f);
    await c.getSession("fake-access-1", "a/b c");
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe("http://google-fake:8099/v1/sessions/a%2Fb%20c");
    expect(String(url)).not.toContain("fake-access");
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer fake-access-1",
    );
  });

  it("delete is best effort: 404 counts as gone, errors resolve false", async () => {
    expect(
      await client(async () => new Response(null, { status: 404 })).deleteSession("t", "s"),
    ).toBe(true);
    expect(
      await client(async () => new Response(null, { status: 204 })).deleteSession("t", "s"),
    ).toBe(true);
    expect(
      await client(async () => new Response(null, { status: 500 })).deleteSession("t", "s"),
    ).toBe(false);
    expect(
      await client(async () => {
        throw new Error("x");
      }).deleteSession("t", "s"),
    ).toBe(false);
  });

  it("revoke is best effort and never throws", async () => {
    expect(await client(async () => new Response(null, { status: 200 })).revoke("t")).toBe(true);
    expect(await client(async () => new Response(null, { status: 400 })).revoke("t")).toBe(false);
    expect(
      await client(async () => {
        throw new Error("x");
      }).revoke("t"),
    ).toBe(false);
  });

  it("timeouts: 15 s for calls, 5 s for revoke", () => {
    expect(GOOGLE_CALL_TIMEOUT_MS).toBe(15_000);
    expect(GOOGLE_REVOKE_TIMEOUT_MS).toBe(5_000);
  });
});
