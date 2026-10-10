import { createHash } from "node:crypto";
import path from "node:path";
import {
  GOOGLE_PICKER_SCOPE,
  googleTokenResponseSchema,
  pickerMediaItemsPageSchema,
  pickerSessionSchema,
} from "@tinyglow/shared";
import exifr from "exifr";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FAKE_OVERSIZE_CLAIMED_BYTES } from "./fake-catalogue";
import { type FakeGoogleServer, startFakeGoogleServer } from "./fake-server";

// Fake Google Picker server (docs/plans/step-10.md 2.9): shapes validate with the shared schemas,
// no GPS anywhere, the OAuth/picker/media flows, failure injection, production refusal.

const FIXTURES = path.resolve(__dirname, "../../../../../e2e/fixtures/heic");
const REDIRECT = "http://localhost:8080/api/import/google/callback";

describe("fake Google server", () => {
  let fake: FakeGoogleServer;
  const get = (p: string, init?: RequestInit) =>
    fetch(`${fake.url}${p}`, { redirect: "manual", ...init });
  const post = (p: string, body: unknown, form = false) =>
    fetch(`${fake.url}${p}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
    });

  beforeAll(async () => {
    fake = await startFakeGoogleServer({ port: 0, fixturesDir: FIXTURES, nodeEnv: "test" });
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(async () => {
    await post("/__fake/reset", {});
    await post("/__fake/consent", { decision: "allow" });
  });

  async function connect(account?: string) {
    const url = new URL(`${fake.url}/o/oauth2/v2/auth`);
    url.searchParams.set("client_id", "cid");
    url.searchParams.set("redirect_uri", REDIRECT);
    url.searchParams.set("scope", GOOGLE_PICKER_SCOPE);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", "st-1");
    if (account) url.searchParams.set("account", account);
    const auth = await fetch(url, { redirect: "manual" });
    const loc = new URL(auth.headers.get("location") ?? "");
    const code = loc.searchParams.get("code") ?? "";
    const tok = await post(
      "/token",
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: "cid",
        client_secret: "x",
      },
      true,
    );
    return { auth, loc, tokens: googleTokenResponseSchema.parse(await tok.json()) };
  }

  it("health, and production is refused", async () => {
    expect(await (await get("/healthz")).json()).toEqual({ status: "ok" });
    await expect(startFakeGoogleServer({ port: 0, nodeEnv: "production" })).rejects.toThrow(
      /production/,
    );
  });

  describe("catalogue", () => {
    it("lists G-1..G-8, P-1, W-1, V-1, X-1 and the HEIC fixture; shapes are as documented", async () => {
      const items = (await (await get("/__fake/items")).json()) as {
        id: string;
        type: string;
        mimeType: string;
        bytes: number;
      }[];
      const ids = items.map((i) => i.id);
      for (const id of [
        "G-1",
        "G-2",
        "G-3",
        "G-4",
        "G-5",
        "G-6",
        "G-7",
        "G-8",
        "P-1",
        "W-1",
        "V-1",
        "X-1",
        "H-1",
      ])
        expect(ids).toContain(id);
      expect(items.find((i) => i.id === "V-1")?.type).toBe("VIDEO");
      expect(items.find((i) => i.id === "P-1")?.mimeType).toBe("image/png");
      expect(items.find((i) => i.id === "W-1")?.mimeType).toBe("image/webp");
    });

    it("omits H-1 without the fixtures directory", async () => {
      const bare = await startFakeGoogleServer({ port: 0, nodeEnv: "test" });
      try {
        const items = (await (await fetch(`${bare.url}/__fake/items`)).json()) as { id: string }[];
        expect(items.map((i) => i.id)).not.toContain("H-1");
      } finally {
        await bare.close();
      }
    });

    it("no catalogue photo carries a GPS tag, and each has the capture date and camera", async () => {
      for (const item of fake.catalogue.filter(
        (i) => i.type === "PHOTO" && i.id !== "H-1" && i.id !== "X-1",
      )) {
        const gps = await exifr.gps(item.bytes).catch(() => undefined);
        expect(gps, item.id).toBeUndefined();
        const exif = await exifr
          .parse(item.bytes, { gps: true, tiff: true, exif: true })
          .catch(() => undefined);
        expect(exif?.latitude, item.id).toBeUndefined();
        if (item.mimeType === "image/jpeg") {
          expect(exif?.DateTimeOriginal, item.id).toBeTruthy();
          expect(exif?.Make).toBe("Fake");
        }
        // the byte stream never holds a GPS IFD tag name's payload
        expect(item.bytes.includes(Buffer.from("GPS\0")), item.id).toBe(false);
      }
    });

    it("serves the bytes whose SHA-256 the catalogue states", async () => {
      const res = await get("/__fake/items/G-3");
      const buf = Buffer.from(await res.arrayBuffer());
      const item = fake.catalogue.find((i) => i.id === "G-3");
      expect(createHash("sha256").update(buf).digest("hex")).toBe(item?.sha256);
    });
  });

  describe("OAuth", () => {
    it("Allow: redirects to redirect_uri with code, scope and the same state", async () => {
      const { auth, loc, tokens } = await connect("mom");
      expect(auth.status).toBe(302);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get("state")).toBe("st-1");
      expect(loc.searchParams.get("code")).toMatch(/^fake-code-/);
      expect(tokens.access_token).toMatch(/^fake-access-/);
      expect(tokens.refresh_token).toMatch(/^fake-refresh-/);
      expect(tokens.scope).toBe(GOOGLE_PICKER_SCOPE);
    });

    it("a code works once", async () => {
      const { loc } = await connect();
      const again = await post(
        "/token",
        {
          grant_type: "authorization_code",
          code: loc.searchParams.get("code") ?? "",
          redirect_uri: REDIRECT,
        },
        true,
      );
      expect(again.status).toBe(400);
      expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
    });

    it("Deny: error=access_denied and no code", async () => {
      await post("/__fake/consent", { decision: "deny" });
      const { loc } = await (async () => {
        const r = await get(
          `/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(GOOGLE_PICKER_SCOPE)}&state=s`,
        );
        return { loc: new URL(r.headers.get("location") ?? "") };
      })();
      expect(loc.searchParams.get("error")).toBe("access_denied");
      expect(loc.searchParams.has("code")).toBe(false);
    });

    it("consent defaults to ask: an HTML page with Allow and Deny", async () => {
      await post("/__fake/consent", { decision: "ask" });
      const r = await get(
        `/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(GOOGLE_PICKER_SCOPE)}&state=s`,
      );
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain("Allow");
      expect(html).toContain("Deny");
    });

    it("scope_missing grants without the picker scope", async () => {
      await post("/__fake/consent", { decision: "allow", scopeMissing: true });
      const { tokens } = await connect();
      expect(tokens.scope ?? "").not.toContain("photospicker");
    });

    it("rejects a non-http redirect_uri", async () => {
      const r = await get(
        `/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent("javascript:alert(1)")}&scope=x`,
      );
      expect(r.status).toBe(400);
    });

    it("refresh gives a new access token; revoke-all makes refresh invalid_grant and Bearer 401", async () => {
      const { tokens } = await connect();
      const r = await post(
        "/token",
        { grant_type: "refresh_token", refresh_token: tokens.refresh_token ?? "" },
        true,
      );
      expect(r.status).toBe(200);
      const refreshed = googleTokenResponseSchema.parse(await r.json());
      expect(refreshed.access_token).not.toBe(tokens.access_token);
      await post("/__fake/revoke-all", {});
      const dead = await post(
        "/token",
        { grant_type: "refresh_token", refresh_token: tokens.refresh_token ?? "" },
        true,
      );
      expect(dead.status).toBe(400);
      expect(((await dead.json()) as { error: string }).error).toBe("invalid_grant");
      const s = await post("/v1/sessions", {});
      expect(s.status).toBe(401);
    });

    it("revoke records the token", async () => {
      const { tokens } = await connect();
      await post("/revoke", { token: tokens.refresh_token ?? "" }, true);
      const revs = (await (await get("/__fake/revocations")).json()) as { token: string }[];
      expect(revs.map((r) => r.token)).toContain(tokens.refresh_token);
    });
  });

  describe("Picker", () => {
    async function session(account?: string) {
      const { tokens } = await connect(account);
      const auth = { authorization: `Bearer ${tokens.access_token}` };
      const created = await fetch(`${fake.url}/v1/sessions`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: "{}",
      });
      expect(created.status).toBe(200);
      const s = pickerSessionOf(await created.json());
      return { auth, s, tokens };
    }
    const pickerSessionOf = (j: unknown) => pickerSessionSchema.parse(j);

    it("requires a Bearer token", async () => {
      expect((await post("/v1/sessions", {})).status).toBe(401);
    });

    it("session shape validates; autopick completes it and mediaItems paginates", async () => {
      const { auth, s } = await session();
      expect(s.mediaItemsSet).toBe(false);
      expect(s.pickerUri).toContain(`/picker/${s.id}`);
      expect((await get(`/picker/${s.id}?autopick=G-1,G-2,G-3,V-1`)).status).toBe(200);
      const polled = pickerSessionSchema.parse(
        await (await fetch(`${fake.url}/v1/sessions/${s.id}`, { headers: auth })).json(),
      );
      expect(polled.mediaItemsSet).toBe(true);
      const p1 = pickerMediaItemsPageSchema.parse(
        await (
          await fetch(`${fake.url}/v1/mediaItems?sessionId=${s.id}&pageSize=2`, { headers: auth })
        ).json(),
      );
      expect(p1.mediaItems.map((i) => i.id)).toEqual(["G-1", "G-2"]);
      expect(p1.nextPageToken).toBeTruthy();
      const p2 = pickerMediaItemsPageSchema.parse(
        await (
          await fetch(
            `${fake.url}/v1/mediaItems?sessionId=${s.id}&pageSize=2&pageToken=${p1.nextPageToken}`,
            { headers: auth },
          )
        ).json(),
      );
      expect(p2.mediaItems.map((i) => i.id)).toEqual(["G-3", "V-1"]);
      expect(p2.nextPageToken).toBeUndefined();
      expect(p2.mediaItems[1]?.type).toBe("VIDEO");
    });

    it("mediaItems before picking is a 400 FAILED_PRECONDITION", async () => {
      const { auth, s } = await session();
      expect(
        (await fetch(`${fake.url}/v1/mediaItems?sessionId=${s.id}`, { headers: auth })).status,
      ).toBe(400);
    });

    it("one account cannot see another's session", async () => {
      const mom = await session("mom");
      const nanny = await session("nanny");
      const r = await fetch(`${fake.url}/v1/sessions/${mom.s.id}`, { headers: nanny.auth });
      expect(r.status).toBe(404);
    });

    it("delete makes the session 404; the delete is recorded", async () => {
      const { auth, s } = await session();
      expect(
        (await fetch(`${fake.url}/v1/sessions/${s.id}`, { method: "DELETE", headers: auth }))
          .status,
      ).toBe(200);
      expect((await fetch(`${fake.url}/v1/sessions/${s.id}`, { headers: auth })).status).toBe(404);
      const reqs = (await (await get("/__fake/requests")).json()) as {
        method: string;
        path: string;
      }[];
      expect(
        reqs.filter((r) => r.method === "DELETE" && r.path.startsWith("/v1/sessions/")),
      ).toHaveLength(1);
    });

    it("an expired session answers 404 to the api", async () => {
      const { auth, s } = await session();
      await post(`/__fake/sessions/${s.id}/expire`, {});
      expect((await fetch(`${fake.url}/v1/sessions/${s.id}`, { headers: auth })).status).toBe(404);
    });

    it("the request recorder keeps methods and paths only: no query, no headers, no tokens", async () => {
      const { auth, s } = await session();
      await get(`/picker/${s.id}?autopick=G-1`);
      await fetch(`${fake.url}/v1/mediaItems?sessionId=${s.id}`, { headers: auth });
      const body = JSON.stringify(await (await get("/__fake/requests")).json());
      expect(body).not.toContain("fake-access");
      expect(body).not.toContain("autopick");
      expect(body).not.toContain("sessionId=");
    });
  });

  describe("media", () => {
    async function token() {
      const { tokens } = await connect();
      return { authorization: `Bearer ${tokens.access_token}` };
    }

    it("serves =d with Content-Length and needs Bearer", async () => {
      const auth = await token();
      expect((await get("/media/G-1=d")).status).toBe(401);
      const r = await fetch(`${fake.url}/media/G-1=d`, { headers: auth });
      expect(r.status).toBe(200);
      const buf = Buffer.from(await r.arrayBuffer());
      expect(Number(r.headers.get("content-length"))).toBe(buf.length);
      expect(r.headers.get("content-type")).toBe("image/jpeg");
    });

    it("only the =d form is served", async () => {
      const auth = await token();
      expect((await fetch(`${fake.url}/media/G-1`, { headers: auth })).status).toBe(400);
      expect((await fetch(`${fake.url}/media/G-1=w100`, { headers: auth })).status).toBe(400);
    });

    it("X-1 announces 200 MiB and drops the connection", async () => {
      const auth = await token();
      const r = await fetch(`${fake.url}/media/X-1=d`, { headers: auth });
      expect(Number(r.headers.get("content-length"))).toBe(FAKE_OVERSIZE_CLAIMED_BYTES);
      await expect(r.arrayBuffer()).rejects.toThrow();
    });
  });

  describe("fault injection", () => {
    it("a 429 with Retry-After is consumed once", async () => {
      const { tokens } = await connect();
      await post("/__fake/faults", { route: "sessions.create", status: 429, retryAfter: 1 });
      const h = { authorization: `Bearer ${tokens.access_token}` };
      const a = await fetch(`${fake.url}/v1/sessions`, { method: "POST", headers: h });
      expect(a.status).toBe(429);
      expect(a.headers.get("retry-after")).toBe("1");
      const b = await fetch(`${fake.url}/v1/sessions`, { method: "POST", headers: h });
      expect(b.status).toBe(200);
    });

    it("cross-host redirects for media", async () => {
      const { tokens } = await connect();
      await post("/__fake/faults", { route: "media", itemId: "G-1", redirect: "cross-host" });
      const r = await fetch(`${fake.url}/media/G-1=d`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        redirect: "manual",
      });
      expect(r.status).toBe(302);
      expect(new URL(r.headers.get("location") ?? "").hostname).not.toBe(
        new URL(fake.url).hostname,
      );
    });

    it("rejects invalid faults (no effect, body fault on a non-media route)", async () => {
      expect((await post("/__fake/faults", { route: "token" })).status).toBe(400);
      expect((await post("/__fake/faults", { route: "token", truncateAfterBytes: 5 })).status).toBe(
        400,
      );
    });

    it("an invalid_grant fault on refresh", async () => {
      const { tokens } = await connect();
      await post("/__fake/faults", {
        route: "token",
        grantType: "refresh_token",
        error: "invalid_grant",
      });
      const r = await post(
        "/token",
        { grant_type: "refresh_token", refresh_token: tokens.refresh_token ?? "" },
        true,
      );
      expect(((await r.json()) as { error: string }).error).toBe("invalid_grant");
    });
  });
});
