import { VIEWER_COOKIE } from "@littlelight/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobQueue } from "../plugins/jobs";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedPhoto } from "../testing/photos";

// "Someone opened your shared album" (docs/plans/step-9.md 2.8, 2.15): the viewer token exchange
// enqueues exactly one push.notify per NEW viewer session, never for a reused session or a
// refused exchange, never blocks the response, and the job carries only the link id.

const WEB = { "x-littlelight-client": "web" };
const NATIVE = { "x-littlelight-client": "native" };
const PASSCODE = "739104";

describe.skipIf(!databaseUrl)("share_viewed push enqueue (api + db)", () => {
  let h: Harness;
  let mom: TestUser;
  let baby: string;
  const enqueuePush = vi.fn<NonNullable<JobQueue["enqueuePush"]>>(async () => true);
  let ipCounter = 0;
  const newIp = () => {
    ipCounter = (ipCounter % 200) + 1;
    return `198.51.100.${ipCounter}`;
  };

  async function createLink(body: Record<string, unknown> = {}) {
    const res = await h.inject(mom, "POST", `/babies/${baby}/share-links`, {
      name: "Grandparents",
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json();
    return {
      id: created.link.id as string,
      token: (created.url as string).split("/s/")[1] as string,
    };
  }
  const exchange = (
    token: string,
    o: { passcode?: string; cookie?: string; headers?: Record<string, string> } = {},
  ) =>
    h.app.inject({
      method: "POST",
      url: "/share/session",
      headers: {
        ...(o.headers ?? WEB),
        "cf-connecting-ip": newIp(),
        ...(o.cookie ? { cookie: `${VIEWER_COOKIE}=${o.cookie}` } : {}),
      },
      payload: { token, ...(o.passcode !== undefined ? { passcode: o.passcode } : {}) },
    });
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
    res.cookies.find((c) => c.name === VIEWER_COOKIE)?.value;
  const flush = () => new Promise((r) => setTimeout(r, 25));

  beforeAll(async () => {
    h = await createHarness({
      jobs: {
        enqueueIngest: async () => true,
        enqueueReindex: async () => true,
        enqueueShareApply: async () => true,
        enqueuePush,
        close: async () => undefined,
      },
    });
    mom = await h.user();
    baby = await h.baby(mom, "Mia");
    await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [baby]);
    await seedPhoto(h.admin, baby, { uploadedBy: mom.id, withThumb: true });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("a new viewer session enqueues exactly one share_viewed job carrying only the link id", async () => {
    const link = await createLink();
    enqueuePush.mockClear();
    const res = await exchange(link.token);
    expect(res.statusCode, res.body).toBe(200);
    await flush();
    expect(enqueuePush).toHaveBeenCalledTimes(1);
    expect(enqueuePush).toHaveBeenCalledWith({ kind: "share_viewed", shareLinkId: link.id });
    expect(Object.keys(enqueuePush.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      "kind",
      "shareLinkId",
    ]);
    expect(JSON.stringify(enqueuePush.mock.calls)).not.toContain(link.token);
  });

  it("reusing the browser's live session enqueues nothing more", async () => {
    const link = await createLink();
    enqueuePush.mockClear();
    const first = await exchange(link.token);
    const cookie = cookieOf(first) as string;
    expect(cookie).toBeTruthy();
    await flush();
    expect(enqueuePush).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      const again = await exchange(link.token, { cookie });
      expect(again.statusCode, again.body).toBe(200);
    }
    await flush();
    expect(enqueuePush).toHaveBeenCalledTimes(1);
  });

  it("a second, different visitor is a new session and enqueues again", async () => {
    const link = await createLink();
    enqueuePush.mockClear();
    await exchange(link.token);
    await exchange(link.token);
    await flush();
    expect(enqueuePush).toHaveBeenCalledTimes(2);
    expect(enqueuePush.mock.calls.every(([j]) => j.kind === "share_viewed")).toBe(true);
  });

  it("a native client's exchange (viewerToken in the body) enqueues once", async () => {
    const link = await createLink();
    enqueuePush.mockClear();
    const res = await exchange(link.token, { headers: NATIVE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().viewerToken).toBeTruthy();
    await flush();
    expect(enqueuePush).toHaveBeenCalledTimes(1);
  });

  it("a wrong passcode, a missing passcode, an unknown token, an expired and a revoked link enqueue nothing", async () => {
    const locked = await createLink({ passcode: PASSCODE });
    enqueuePush.mockClear();
    expect((await exchange(locked.token)).statusCode).toBe(401);
    expect((await exchange(locked.token, { passcode: "000000" })).statusCode).toBe(401);
    expect((await exchange("A".repeat(22))).statusCode).toBe(410);
    const expired = await createLink();
    await h.admin.query(
      "UPDATE public.share_links SET expires_at = now() - interval '1 hour' WHERE id = $1",
      [expired.id],
    );
    expect((await exchange(expired.token)).statusCode).toBe(410);
    const revoked = await createLink();
    await h.admin.query("UPDATE public.share_links SET revoked_at = now() WHERE id = $1", [
      revoked.id,
    ]);
    expect((await exchange(revoked.token)).statusCode).toBe(410);
    await flush();
    expect(enqueuePush).not.toHaveBeenCalled();
  });

  it("the correct passcode opens a session and enqueues once", async () => {
    const locked = await createLink({ passcode: PASSCODE });
    enqueuePush.mockClear();
    const res = await exchange(locked.token, { passcode: PASSCODE });
    expect(res.statusCode, res.body).toBe(200);
    await flush();
    expect(enqueuePush).toHaveBeenCalledTimes(1);
  });

  it("a failed enqueue (false, a rejection, or one that never resolves) never changes the response", async () => {
    const link = await createLink();
    for (const impl of [
      async () => false,
      async () => {
        throw new Error("boom with tok-secret");
      },
      () => new Promise<boolean>(() => undefined),
    ]) {
      enqueuePush.mockReset();
      enqueuePush.mockImplementation(impl);
      const res = await exchange(link.token);
      expect(res.statusCode, res.body).toBe(200);
    }
    enqueuePush.mockReset();
    enqueuePush.mockImplementation(async () => true);
  });

  it("the enqueue happens after the commit: the session row exists when it is called", async () => {
    const link = await createLink();
    let existed = false;
    enqueuePush.mockReset();
    enqueuePush.mockImplementation(async (job) => {
      const r = await h.admin.query(
        "SELECT count(*)::int n FROM public.viewer_sessions WHERE share_link_id = $1",
        [(job as { shareLinkId: string }).shareLinkId],
      );
      existed = (r.rows[0]?.n ?? 0) > 0;
      return true;
    });
    await exchange(link.token);
    await flush();
    expect(existed).toBe(true);
    enqueuePush.mockReset();
    enqueuePush.mockImplementation(async () => true);
  });
});
