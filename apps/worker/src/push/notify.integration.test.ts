import { randomUUID } from "node:crypto";
import type { PushNotifyJob } from "@tinyglow/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, integrationEnv } from "../testing/harness";
import { recordingLog } from "../testing/stubs";
import { handlePushNotifyJob, type NotifyDeps, PushDeliveryFailedError } from "./notify";
import { createPushSender } from "./sender";
import type { PushSender } from "./types";

// push.notify against the real database (docs/plans/step-9.md 2.8, 2.15): who is a target, the
// generic text, the ledger, the gap rule and the retry behaviour, with the fake sender (nothing
// leaves the host).

describe.skipIf(!integrationEnv)("push.notify (real database)", () => {
  let h: Harness;
  const extraUsers: string[] = [];
  const sessions: string[] = [];

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    if (h) {
      await h.admin.query("DELETE FROM auth.sessions WHERE id = ANY($1::uuid[])", [sessions]);
      await h.admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [extraUsers]);
      await h.close();
    }
  });

  async function user(
    babyId: string,
    role: "admin" | "contributor",
    opts: { live?: boolean; device?: boolean } = {},
  ) {
    const id = randomUUID();
    await h.admin.query(
      `INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
       VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())`,
      [id, `pn-${id}@worker.test`],
    );
    await h.admin.query("INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'PN')", [
      id,
    ]);
    extraUsers.push(id);
    await h.admin.query(
      "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, $3)",
      [babyId, id, role],
    );
    const sessionId = randomUUID();
    sessions.push(sessionId);
    if (opts.live !== false) {
      await h.admin.query(
        "INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
        [sessionId, id],
      );
    }
    let deviceId: string | null = null;
    const token = `tok-${randomUUID().replaceAll("-", "")}`;
    if (opts.device !== false) {
      const r = await h.admin.query<{ id: string }>(
        `INSERT INTO public.push_devices (user_id, session_id, platform, provider, token, app_version)
         VALUES ($1, $2, 'ios', 'apns', $3, '1.0.0') RETURNING id`,
        [id, sessionId, token],
      );
      deviceId = r.rows[0]?.id ?? null;
    }
    return { id, sessionId, deviceId, token };
  }

  /** A live session and an enabled device for the baby's owner (the first admin). */
  async function ownerDevice(owner: { id: string; ownerId: string }) {
    const sessionId = randomUUID();
    sessions.push(sessionId);
    await h.admin.query(
      "INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
      [sessionId, owner.ownerId],
    );
    const token = `tok-${randomUUID().replaceAll("-", "")}`;
    const r = await h.admin.query<{ id: string }>(
      `INSERT INTO public.push_devices (user_id, session_id, platform, provider, token, app_version)
       VALUES ($1, $2, 'ios', 'apns', $3, '1.0.0') RETURNING id`,
      [owner.ownerId, sessionId, token],
    );
    return { id: owner.ownerId, sessionId, deviceId: r.rows[0]?.id as string, token };
  }

  /** `n` approved, live photos with a fake photo_ai row (created `agoMin` minutes ago). */
  async function analysed(babyId: string, ownerId: string, n: number, agoMin = 0) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await h.admin.query(
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, bytes, approval, status, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, 1000, 'approved', 'ingested', $3, now())`,
        [id, babyId, ownerId, `babies/${babyId}/originals/${id}.jpg`],
      );
      await h.admin.query(
        `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description, created_at)
         VALUES ($1, 'fake', 'v1', 'v1', '{"caption":"x"}'::jsonb, now() - $2::interval)`,
        [id, `${agoMin} minutes`],
      );
      ids.push(id);
    }
    return ids;
  }

  async function link(babyId: string, ownerId: string) {
    const id = randomUUID();
    await h.admin.query(
      `INSERT INTO public.share_links (id, baby_id, name, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'L', decode(md5($4::text) || md5($4::text || 'x'), 'hex'), now() + interval '1 day', $3)`,
      [id, babyId, ownerId, id],
    );
    return id;
  }

  const ledger = (babyId: string) =>
    h.admin
      .query(
        `SELECT user_id, device_id, share_link_id, kind, status, item_count
           FROM public.push_deliveries WHERE baby_id = $1 ORDER BY id`,
        [babyId],
      )
      .then((r) => r.rows);

  function deps(
    over: Partial<NotifyDeps> = {},
    sender?: PushSender,
  ): NotifyDeps & { sender: PushSender; resend: ReturnType<typeof vi.fn> } {
    const log = recordingLog();
    const real =
      sender ??
      createPushSender(
        {
          PUSH_PROVIDER: "fake",
          APNS_BUNDLE_ID: "x.y",
          APNS_ENVIRONMENT: "sandbox",
          NODE_ENV: "test",
        },
        log,
      );
    const resend = vi.fn(async () => "job-2");
    return { pool: h.workerPool, sender: real, log, minGapMin: 0, resend, ...over } as never;
  }
  const photosJob = (babyId: string): { id: string; data: PushNotifyJob } => ({
    id: randomUUID(),
    data: { kind: "photos_analyzed", babyId },
  });

  let baby: { id: string; ownerId: string };
  beforeEach(async () => {
    baby = await h.baby({ plan: "plus" });
  });

  it("a paid baby with analysed photos: one fake delivery per admin device carrying the photo count", async () => {
    const a1 = await ownerDevice(baby);
    const a2 = await user(baby.id, "admin");
    await analysed(baby.id, baby.ownerId, 3);
    const send = vi.fn<PushSender["send"]>(async () => "fake");
    const d = deps({}, { mode: "fake", send, close: async () => undefined });
    const r = await handlePushNotifyJob(d, photosJob(baby.id));
    expect(r?.delivered).toEqual({ fake: 2 });
    const rows = await ledger(baby.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.device_id).sort()).toEqual([a1.deviceId, a2.deviceId].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        kind: "photos_analyzed",
        status: "fake",
        item_count: 3,
        share_link_id: null,
      });
    }
    // exactly the generic text, ids only
    const [target, message] = send.mock.calls[0] ?? [];
    expect(target?.provider).toBe("apns");
    expect(message?.body).toBe("3 new photos are ready to search.");
    expect(message?.data).toEqual({ kind: "photos_analyzed", babyId: baby.id });
    expect(JSON.stringify(message)).not.toMatch(/Mia|W\b/);
  });

  it("a contributor with a registered device gets nothing", async () => {
    const admin = await ownerDevice(baby);
    const contrib = await user(baby.id, "contributor");
    await analysed(baby.id, baby.ownerId, 2);
    const send = vi.fn<PushSender["send"]>(async () => "fake");
    await handlePushNotifyJob(
      deps({}, { mode: "fake", send, close: async () => undefined }),
      photosJob(baby.id),
    );
    const rows = await ledger(baby.id);
    expect(rows.map((r) => r.user_id)).toEqual([admin.id]);
    expect(JSON.stringify(send.mock.calls)).not.toContain(contrib.token);
  });

  it("a signed-out session gets nothing and its device is pruned", async () => {
    const live = await ownerDevice(baby);
    const out = await user(baby.id, "admin", { live: false });
    await analysed(baby.id, baby.ownerId, 2);
    const send = vi.fn<PushSender["send"]>(async () => "fake");
    await handlePushNotifyJob(
      deps({}, { mode: "fake", send, close: async () => undefined }),
      photosJob(baby.id),
    );
    expect((await ledger(baby.id)).map((r) => r.user_id)).toEqual([live.id]);
    expect(JSON.stringify(send.mock.calls)).not.toContain(out.token);
    const gone = await h.admin.query("SELECT 1 FROM public.push_devices WHERE id = $1", [
      out.deviceId,
    ]);
    expect(gone.rowCount).toBe(0);
  });

  it("an admin who turned the kind off gets nothing; the other admin still does", async () => {
    const off = await ownerDevice(baby);
    const on = await user(baby.id, "admin");
    await h.admin.query(
      "UPDATE public.profiles SET notify_photos_analyzed = false WHERE user_id = $1",
      [off.id],
    );
    await analysed(baby.id, baby.ownerId, 1);
    await handlePushNotifyJob(deps(), photosJob(baby.id));
    expect((await ledger(baby.id)).map((r) => r.user_id)).toEqual([on.id]);
    // the other kind is independent
    const linkId = await link(baby.id, baby.ownerId);
    await handlePushNotifyJob(deps(), {
      id: "j",
      data: { kind: "share_viewed", shareLinkId: linkId },
    });
    expect(
      (await ledger(baby.id))
        .filter((r) => r.kind === "share_viewed")
        .map((r) => r.user_id)
        .sort(),
    ).toEqual([off.id, on.id].sort());
  });

  it("a deleted profile gets nothing", async () => {
    const live = await ownerDevice(baby);
    const deleted = await user(baby.id, "admin");
    await h.admin.query("UPDATE public.profiles SET deleted_at = now() WHERE user_id = $1", [
      deleted.id,
    ]);
    await analysed(baby.id, baby.ownerId, 1);
    await handlePushNotifyJob(deps(), photosJob(baby.id));
    expect((await ledger(baby.id)).map((r) => r.user_id)).toEqual([live.id]);
  });

  it("a FREE baby never gets a photos_analyzed push and the sender is never called", async () => {
    const free = await h.baby({ plan: "free" });
    await ownerDevice(free);
    const send = vi.fn<PushSender["send"]>(async () => "fake");
    const r = await handlePushNotifyJob(
      deps({}, { mode: "fake", send, close: async () => undefined }),
      photosJob(free.id),
    );
    expect(r).toMatchObject({ skippedReason: "ai_disabled", targets: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await ledger(free.id)).toEqual([]);
  });

  it("a free baby still gets share_viewed (it is not an AI feature)", async () => {
    const free = await h.baby({ plan: "free" });
    const admin = await ownerDevice(free);
    const linkId = await link(free.id, free.ownerId);
    const r = await handlePushNotifyJob(deps(), {
      id: "j",
      data: { kind: "share_viewed", shareLinkId: linkId },
    });
    expect(r?.delivered).toEqual({ fake: 1 });
    const rows = await ledger(free.id);
    expect(rows).toEqual([
      {
        user_id: admin.id,
        device_id: admin.deviceId,
        share_link_id: linkId,
        kind: "share_viewed",
        status: "fake",
        item_count: null,
      },
    ]);
  });

  it("share_viewed for an unknown link or a trashed baby does nothing", async () => {
    await ownerDevice(baby);
    const send = vi.fn<PushSender["send"]>(async () => "fake");
    const d = deps({}, { mode: "fake", send, close: async () => undefined });
    const r = await handlePushNotifyJob(d, {
      id: "j",
      data: { kind: "share_viewed", shareLinkId: randomUUID() },
    });
    expect(r).toMatchObject({ skippedReason: "no_baby" });
    const linkId = await link(baby.id, baby.ownerId);
    await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [baby.id]);
    expect(
      await handlePushNotifyJob(d, {
        id: "j",
        data: { kind: "share_viewed", shareLinkId: linkId },
      }),
    ).toMatchObject({
      skippedReason: "no_baby",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("a second run inside the gap is rescheduled, not sent; the deferred job re-sends with the remaining gap", async () => {
    await ownerDevice(baby);
    await analysed(baby.id, baby.ownerId, 2);
    const d = deps({ minGapMin: 60 });
    expect((await handlePushNotifyJob(d, photosJob(baby.id)))?.delivered).toEqual({ fake: 1 });
    await analysed(baby.id, baby.ownerId, 4);
    const second = await handlePushNotifyJob(d, photosJob(baby.id));
    expect(second?.deferred).toBe(1);
    expect(second?.delivered).toEqual({});
    expect(d.resend).toHaveBeenCalledTimes(1);
    const startAfter = d.resend.mock.calls[0]?.[1] as number;
    expect(startAfter).toBeGreaterThan(59 * 60);
    expect(startAfter).toBeLessThanOrEqual(60 * 60 + 1);
    expect(await ledger(baby.id)).toHaveLength(1);
  });

  it("once the gap has passed the deferred run sends only what is new since the last push", async () => {
    const admin = await ownerDevice(baby);
    await analysed(baby.id, baby.ownerId, 2, 200);
    const d = deps({ minGapMin: 60 });
    await handlePushNotifyJob(d, photosJob(baby.id));
    // pretend the first push was 2 hours ago, and 4 photos were analysed since
    await h.admin.query(
      "UPDATE public.push_deliveries SET created_at = now() - interval '2 hours' WHERE baby_id = $1",
      [baby.id],
    );
    await analysed(baby.id, baby.ownerId, 4, 30);
    const r = await handlePushNotifyJob(d, photosJob(baby.id));
    expect(r?.delivered).toEqual({ fake: 1 });
    const rows = await ledger(baby.id);
    expect(rows.at(-1)).toMatchObject({ user_id: admin.id, item_count: 4 });
  });

  it("with nothing new since the last push the run sends nothing (count 0)", async () => {
    await ownerDevice(baby);
    await analysed(baby.id, baby.ownerId, 2);
    const d = deps({ minGapMin: 0 });
    await handlePushNotifyJob(d, photosJob(baby.id));
    const r = await handlePushNotifyJob(d, photosJob(baby.id));
    expect(r?.skipped.nothingNew).toBe(1);
    expect(await ledger(baby.id)).toHaveLength(1);
  });

  it("signing out and back in does not reset the gap (the ledger follows the user, not the device)", async () => {
    const admin = await ownerDevice(baby);
    await analysed(baby.id, baby.ownerId, 1);
    const d = deps({ minGapMin: 60 });
    await handlePushNotifyJob(d, photosJob(baby.id));
    await h.admin.query("DELETE FROM public.push_devices WHERE user_id = $1", [admin.id]);
    const sid = randomUUID();
    sessions.push(sid);
    await h.admin.query(
      "INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
      [sid, admin.id],
    );
    await h.admin.query(
      `INSERT INTO public.push_devices (user_id, session_id, platform, provider, token, app_version)
       VALUES ($1, $2, 'ios', 'apns', $3, '1.0.0')`,
      [admin.id, sid, `tok-${randomUUID().replaceAll("-", "")}`],
    );
    await analysed(baby.id, baby.ownerId, 5);
    const r = await handlePushNotifyJob(d, photosJob(baby.id));
    expect(r?.deferred).toBe(1);
    expect(await ledger(baby.id)).toHaveLength(1);
  });

  it("share_viewed already covered by a push sent after the job was created is skipped", async () => {
    await ownerDevice(baby);
    const linkId = await link(baby.id, baby.ownerId);
    const d = deps({ minGapMin: 60 });
    const created = new Date(Date.now() - 5 * 60_000);
    const first = await handlePushNotifyJob(d, {
      id: "j1",
      data: { kind: "share_viewed", shareLinkId: linkId },
      createdOn: new Date(Date.now() - 10 * 60_000),
    });
    expect(first?.delivered).toEqual({ fake: 1 });
    const second = await handlePushNotifyJob(d, {
      id: "j2",
      data: { kind: "share_viewed", shareLinkId: linkId },
      createdOn: created,
    });
    expect(second?.skipped.covered).toBe(1);
    expect(d.resend).not.toHaveBeenCalled();
    expect(await ledger(baby.id)).toHaveLength(1);
  });

  it("invalid_token is recorded and disables the device; the next run has no target", async () => {
    const admin = await ownerDevice(baby);
    await analysed(baby.id, baby.ownerId, 1);
    const send = vi.fn<PushSender["send"]>(async () => "invalid_token");
    const d = deps({}, { mode: "live", send, close: async () => undefined });
    const r = await handlePushNotifyJob(d, photosJob(baby.id));
    expect(r?.delivered).toEqual({ invalid_token: 1 });
    const dev = await h.admin.query(
      "SELECT disabled_at, disabled_reason FROM public.push_devices WHERE id = $1",
      [admin.deviceId],
    );
    expect(dev.rows[0]?.disabled_reason).toBe("invalid_token");
    const again = await handlePushNotifyJob(d, photosJob(baby.id));
    expect(again?.targets).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a failed send is recorded, keeps the device, throws for pg-boss to retry and does not start the gap", async () => {
    const admin = await ownerDevice(baby);
    await analysed(baby.id, baby.ownerId, 1);
    let ok = false;
    const send = vi.fn<PushSender["send"]>(async () => (ok ? "sent" : "failed"));
    const d = deps({ minGapMin: 60 }, { mode: "live", send, close: async () => undefined });
    await expect(handlePushNotifyJob(d, photosJob(baby.id))).rejects.toBeInstanceOf(
      PushDeliveryFailedError,
    );
    expect((await ledger(baby.id)).map((r) => r.status)).toEqual(["failed"]);
    const dev = await h.admin.query("SELECT disabled_at FROM public.push_devices WHERE id = $1", [
      admin.deviceId,
    ]);
    expect(dev.rows[0]?.disabled_at).toBeNull();
    ok = true;
    const retry = await handlePushNotifyJob(d, photosJob(baby.id));
    expect(retry?.delivered).toEqual({ sent: 1 });
    expect(retry?.deferred).toBe(0);
  });

  it("an unconfigured provider (PUSH_PROVIDER=none) records unconfigured and never throws", async () => {
    await ownerDevice(baby);
    await analysed(baby.id, baby.ownerId, 1);
    const none = createPushSender(
      {
        PUSH_PROVIDER: "none",
        APNS_BUNDLE_ID: "x.y",
        APNS_ENVIRONMENT: "sandbox",
        NODE_ENV: "test",
      },
      recordingLog(),
    );
    const r = await handlePushNotifyJob(deps({}, none), photosJob(baby.id));
    expect(r?.delivered).toEqual({ unconfigured: 1 });
    expect((await ledger(baby.id)).map((x) => x.status)).toEqual(["unconfigured"]);
  });

  it("the ledger and the logs never contain a device token", async () => {
    const admin = await ownerDevice(baby);
    await analysed(baby.id, baby.ownerId, 2);
    const d = deps();
    await handlePushNotifyJob(d, photosJob(baby.id));
    const dump = await h.admin.query(
      "SELECT row_to_json(x)::text AS j FROM public.push_deliveries x WHERE baby_id = $1",
      [baby.id],
    );
    expect(JSON.stringify(dump.rows)).not.toContain(admin.token);
    expect(JSON.stringify((d.log as ReturnType<typeof recordingLog>).lines)).not.toContain(
      admin.token,
    );
  });

  it("the worker role cannot read the push tables directly (only the functions)", async () => {
    const c = await h.workerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE pipeline");
      await expect(c.query("SELECT token FROM public.push_devices")).rejects.toThrow(
        /permission denied/,
      );
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});
