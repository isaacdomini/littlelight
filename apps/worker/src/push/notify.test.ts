import { describe, expect, it, vi } from "vitest";
import { recordingLog, type ScriptedPool, scriptedPool } from "../testing/stubs";
import {
  buildPushMessage,
  decideTarget,
  handlePushNotifyJob,
  type NotifyDeps,
  PushDeliveryFailedError,
  rescheduleSeconds,
} from "./notify";

// push.notify handler logic with a scripted pipeline pool (docs/plans/step-9.md 2.8, 2.15). The
// real database rules are in notify.integration.test.ts.

const BABY = "11111111-1111-4111-8111-111111111111";
const LINK = "22222222-2222-4222-8222-222222222222";
const DEV1 = "d1000000-0000-4000-8000-000000000001";
const DEV2 = "d2000000-0000-4000-8000-000000000002";
const USER1 = "e1000000-0000-4000-8000-000000000001";
const USER2 = "e2000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-09T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const MIN = 60_000;

describe("decideTarget", () => {
  const base = {
    kind: "photos_analyzed" as const,
    lastSentAt: null,
    count: 3,
    now: NOW,
    gapMs: 60 * MIN,
  };

  it("sends when nothing was ever sent", () => {
    expect(decideTarget(base)).toEqual({ action: "send" });
    expect(decideTarget({ ...base, kind: "share_viewed", count: null })).toEqual({
      action: "send",
    });
  });

  it("photos_analyzed with a count of 0 (or null) is skipped as nothing new, before the gap rule", () => {
    expect(decideTarget({ ...base, count: 0 })).toEqual({ action: "skip", why: "nothing_new" });
    expect(decideTarget({ ...base, count: null })).toEqual({ action: "skip", why: "nothing_new" });
    expect(decideTarget({ ...base, count: 0, lastSentAt: minutesAgo(1) })).toEqual({
      action: "skip",
      why: "nothing_new",
    });
  });

  it("defers inside the min gap with the exact remaining time", () => {
    expect(decideTarget({ ...base, lastSentAt: minutesAgo(10) })).toEqual({
      action: "defer",
      remainingMs: 50 * MIN,
    });
    expect(decideTarget({ ...base, lastSentAt: minutesAgo(59.5) })).toMatchObject({
      action: "defer",
      remainingMs: 30_000,
    });
  });

  it("sends once the gap has passed (boundary inclusive)", () => {
    expect(decideTarget({ ...base, lastSentAt: minutesAgo(60) })).toEqual({ action: "send" });
    expect(decideTarget({ ...base, lastSentAt: minutesAgo(61) })).toEqual({ action: "send" });
  });

  it("a gap of 0 never defers", () => {
    expect(decideTarget({ ...base, gapMs: 0, lastSentAt: minutesAgo(0.01) })).toEqual({
      action: "send",
    });
  });

  it("a last_sent_at in the future (clock skew) defers by at most the gap", () => {
    const d = decideTarget({ ...base, lastSentAt: new Date(NOW.getTime() + 5 * MIN) });
    expect(d).toEqual({ action: "defer", remainingMs: 60 * MIN });
  });

  it("share_viewed is covered when a push reached the user after the job was created", () => {
    const share = { ...base, kind: "share_viewed" as const, count: null };
    expect(decideTarget({ ...share, lastSentAt: minutesAgo(1), eventAt: minutesAgo(5) })).toEqual({
      action: "skip",
      why: "covered",
    });
    expect(decideTarget({ ...share, lastSentAt: minutesAgo(5), eventAt: minutesAgo(5) })).toEqual({
      action: "skip",
      why: "covered",
    });
    // sent before the event: the gap rule decides
    expect(
      decideTarget({ ...share, lastSentAt: minutesAgo(10), eventAt: minutesAgo(5) }),
    ).toMatchObject({ action: "defer" });
    expect(decideTarget({ ...share, lastSentAt: minutesAgo(90), eventAt: minutesAgo(5) })).toEqual({
      action: "send",
    });
  });

  it("without an event time (run-job) the covered rule is off", () => {
    expect(
      decideTarget({
        ...base,
        kind: "share_viewed",
        count: null,
        lastSentAt: minutesAgo(1),
        gapMs: 0,
      }),
    ).toEqual({ action: "send" });
  });

  it("photos_analyzed ignores the covered rule", () => {
    expect(
      decideTarget({ ...base, lastSentAt: minutesAgo(1), eventAt: minutesAgo(5), gapMs: 0 }),
    ).toEqual({ action: "send" });
  });
});

describe("rescheduleSeconds", () => {
  it("is the longest remaining gap rounded up, plus one second", () => {
    expect(rescheduleSeconds([30_000])).toBe(31);
    expect(rescheduleSeconds([30_001, 5000])).toBe(32);
    expect(rescheduleSeconds([50 * MIN, 10 * MIN])).toBe(3001);
    expect(rescheduleSeconds([])).toBe(1);
  });
});

describe("buildPushMessage", () => {
  it("photos_analyzed: the count in the text, ids only in the data, collapse id kind:baby", () => {
    const m = buildPushMessage({ kind: "photos_analyzed", babyId: BABY }, BABY, 23);
    expect(m).toEqual({
      title: "Littlelight",
      body: "23 new photos are ready to search.",
      data: { kind: "photos_analyzed", babyId: BABY },
      collapseId: `photos_analyzed:${BABY}`,
    });
  });

  it("share_viewed: fixed text, link id in the data", () => {
    const m = buildPushMessage({ kind: "share_viewed", shareLinkId: LINK }, BABY, null);
    expect(m.body).toBe("Someone opened your shared album.");
    expect(m.data).toEqual({ kind: "share_viewed", babyId: BABY, shareLinkId: LINK });
    expect(m.collapseId).toBe(`share_viewed:${BABY}`);
  });

  it("a missing count falls back to singular text", () => {
    expect(buildPushMessage({ kind: "photos_analyzed", babyId: BABY }, BABY, null).body).toBe(
      "1 new photo is ready to search.",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// handler with a scripted pool

interface Row {
  device_id: string;
  user_id: string;
  provider: "apns" | "fcm";
  token: string;
  last_sent_at: Date | null;
  db_now: Date;
  n: number | null;
}
const row = (over: Partial<Row> = {}): Row => ({
  device_id: DEV1,
  user_id: USER1,
  provider: "apns",
  token: "tok-device-one-0000000000000000",
  last_sent_at: null,
  db_now: NOW,
  n: 3,
  ...over,
});

function setup(opts: {
  rows?: Row[];
  aiEnabled?: boolean;
  linkBaby?: string | null;
  send?: (t: { provider: string; token: string }, m: unknown) => Promise<string>;
  minGapMin?: number;
  resendFails?: boolean;
}) {
  const pool: ScriptedPool = scriptedPool({});
  const records: unknown[][] = [];
  const statements: string[] = [];
  // The handler's statements are not exported consts: answer by SQL fragment through a wrapper.
  const original = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await original();
    const baseQuery = client.query.bind(client);
    client.query = (async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes("push_record_delivery")) {
        records.push(params ?? []);
        return { rows: [] };
      }
      if (sql.includes("baby_ai_enabled")) return { rows: [{ enabled: opts.aiEnabled ?? true }] };
      if (sql.includes("push_link_baby"))
        return { rows: [{ baby_id: opts.linkBaby === undefined ? BABY : opts.linkBaby }] };
      if (sql.includes("push_targets")) return { rows: opts.rows ?? [] };
      return baseQuery(sql, params);
    }) as never;
    return client;
  };
  const send = vi.fn(opts.send ?? (async () => "sent"));
  const resend = vi.fn(async () => {
    if (opts.resendFails) throw new Error("queue down");
    return "job-2";
  });
  const log = recordingLog();
  const deps: NotifyDeps = {
    pool: pool as never,
    sender: { send: send as never },
    log,
    minGapMin: opts.minGapMin ?? 60,
    resend: resend as never,
  };
  return { deps, send, resend, log, pool, records, statements };
}

describe("handlePushNotifyJob", () => {
  it("drops an invalid payload without touching the database", async () => {
    const s = setup({});
    for (const data of [
      null,
      {},
      { kind: "chat", babyId: BABY },
      { kind: "photos_analyzed", babyId: BABY, count: 3 },
      { kind: "share_viewed", babyId: BABY },
    ]) {
      expect(await handlePushNotifyJob(s.deps, { id: "j1", data })).toBeNull();
    }
    expect(s.statements).toHaveLength(0);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.log.lines.every((l) => l.level === "warn" && l.obj.jobId === "j1")).toBe(true);
  });

  it("photos_analyzed for a free baby (ai disabled) sends nothing and never asks for targets", async () => {
    const s = setup({ aiEnabled: false, rows: [row()] });
    const r = await handlePushNotifyJob(s.deps, {
      id: "j",
      data: { kind: "photos_analyzed", babyId: BABY },
    });
    expect(r).toMatchObject({ skippedReason: "ai_disabled", targets: 0 });
    expect(s.send).not.toHaveBeenCalled();
    expect(s.statements.some((sql) => sql.includes("push_targets"))).toBe(false);
    expect(s.records).toHaveLength(0);
  });

  it("share_viewed for an unknown link or trashed baby sends nothing", async () => {
    const s = setup({ linkBaby: null, rows: [row()] });
    const r = await handlePushNotifyJob(s.deps, {
      id: "j",
      data: { kind: "share_viewed", shareLinkId: LINK },
    });
    expect(r).toMatchObject({ skippedReason: "no_baby", babyId: null });
    expect(s.send).not.toHaveBeenCalled();
  });

  it("no targets: nothing to do, no sends, no records", async () => {
    const s = setup({ rows: [] });
    const r = await handlePushNotifyJob(s.deps, {
      id: "j",
      data: { kind: "photos_analyzed", babyId: BABY },
    });
    expect(r).toMatchObject({ targets: 0 });
    expect(s.send).not.toHaveBeenCalled();
    expect(s.records).toHaveLength(0);
  });

  it("sends the generic message to each due target and records every outcome with the count", async () => {
    const s = setup({
      rows: [
        row(),
        row({
          device_id: DEV2,
          user_id: USER2,
          provider: "fcm",
          token: "tok-device-two-0000000000000000",
          n: 5,
        }),
      ],
    });
    const r = await handlePushNotifyJob(s.deps, {
      id: "j",
      data: { kind: "photos_analyzed", babyId: BABY },
    });
    expect(r?.delivered).toEqual({ sent: 2 });
    expect(s.send).toHaveBeenCalledTimes(2);
    const [target1, message1] = s.send.mock.calls[0] as [unknown, { body: string; data: unknown }];
    expect(target1).toEqual({ provider: "apns", token: "tok-device-one-0000000000000000" });
    expect(message1.body).toBe("3 new photos are ready to search.");
    expect(message1.data).toEqual({ kind: "photos_analyzed", babyId: BABY });
    const m2 = s.send.mock.calls[1]?.[1] as { body: string };
    expect(m2.body).toBe("5 new photos are ready to search.");
    expect(s.records).toEqual([
      [DEV1, BABY, null, "photos_analyzed", "sent", 3],
      [DEV2, BABY, null, "photos_analyzed", "sent", 5],
    ]);
    expect(s.resend).not.toHaveBeenCalled();
  });

  it("share_viewed records the link id and no count", async () => {
    const s = setup({ rows: [row({ n: null })] });
    await handlePushNotifyJob(s.deps, {
      id: "j",
      data: { kind: "share_viewed", shareLinkId: LINK },
    });
    expect(s.records).toEqual([[DEV1, BABY, LINK, "share_viewed", "sent", null]]);
    const m = s.send.mock.calls[0]?.[1] as { body: string; data: unknown };
    expect(m.body).toBe("Someone opened your shared album.");
    expect(m.data).toEqual({ kind: "share_viewed", babyId: BABY, shareLinkId: LINK });
  });

  it("count 0 targets are skipped (nothing new) and not recorded", async () => {
    const s = setup({ rows: [row({ n: 0 })] });
    const r = await handlePushNotifyJob(s.deps, {
      id: "j",
      data: { kind: "photos_analyzed", babyId: BABY },
    });
    expect(r?.skipped).toEqual({ nothingNew: 1, covered: 0 });
    expect(s.send).not.toHaveBeenCalled();
    expect(s.records).toHaveLength(0);
  });

  it("a target inside the gap is deferred: the job re-sends itself once, before any send", async () => {
    const order: string[] = [];
    const s = setup({
      minGapMin: 60,
      rows: [
        row({ last_sent_at: minutesAgo(10) }),
        row({
          device_id: DEV2,
          user_id: USER2,
          token: "tok-device-two-0000000000000000",
          last_sent_at: minutesAgo(40),
        }),
        row({
          device_id: "d3000000-0000-4000-8000-000000000003",
          user_id: "e3000000-0000-4000-8000-000000000003",
          token: "tok-device-three-00000000000000",
          last_sent_at: null,
        }),
      ],
      send: async () => {
        order.push("send");
        return "sent";
      },
    });
    s.deps.resend = vi.fn(async () => {
      order.push("resend");
      return "job-2";
    }) as never;
    const r = await handlePushNotifyJob(s.deps, {
      id: "j",
      data: { kind: "photos_analyzed", babyId: BABY },
    });
    expect(r?.deferred).toBe(2);
    expect(s.deps.resend).toHaveBeenCalledTimes(1);
    expect(s.deps.resend).toHaveBeenCalledWith(
      { kind: "photos_analyzed", babyId: BABY },
      50 * 60 + 1,
    );
    expect(r?.rescheduled).toEqual({ jobId: "job-2", startAfterSec: 3001 });
    expect(order).toEqual(["resend", "send"]);
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("a coalesced re-send (queue already holds one) still counts as handled", async () => {
    const s = setup({ rows: [row({ last_sent_at: minutesAgo(5) })] });
    s.deps.resend = vi.fn(async () => null) as never;
    const r = await handlePushNotifyJob(s.deps, {
      id: "j",
      data: { kind: "photos_analyzed", babyId: BABY },
    });
    expect(r?.rescheduled).toEqual({ jobId: null, startAfterSec: 55 * 60 + 1 });
  });

  it("if the re-send itself fails the job throws before anything is sent (the retry will not double-send)", async () => {
    const s = setup({
      resendFails: true,
      rows: [
        row({ last_sent_at: minutesAgo(5) }),
        row({ device_id: DEV2, user_id: USER2, token: "tok-device-two-0000000000000000" }),
      ],
    });
    await expect(
      handlePushNotifyJob(s.deps, { id: "j", data: { kind: "photos_analyzed", babyId: BABY } }),
    ).rejects.toThrow("queue down");
    expect(s.send).not.toHaveBeenCalled();
    expect(s.records).toHaveLength(0);
  });

  it("share_viewed covered by an earlier push is skipped, not deferred", async () => {
    const created = minutesAgo(5);
    const s = setup({ rows: [row({ n: null, last_sent_at: minutesAgo(1) })] });
    const r = await handlePushNotifyJob(s.deps, {
      id: "j",
      data: { kind: "share_viewed", shareLinkId: LINK },
      createdOn: created,
    });
    expect(r?.skipped.covered).toBe(1);
    expect(r?.deferred).toBe(0);
    expect(s.resend).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });

  it("records invalid_token and unconfigured outcomes; only failed makes the job throw (after recording)", async () => {
    const s = setup({
      rows: [
        row(),
        row({ device_id: DEV2, user_id: USER2, token: "tok-device-two-0000000000000000" }),
      ],
      send: async (t) => (t.token.includes("one") ? "invalid_token" : "unconfigured"),
    });
    const r = await handlePushNotifyJob(s.deps, {
      id: "j",
      data: { kind: "photos_analyzed", babyId: BABY },
    });
    expect(r?.delivered).toEqual({ invalid_token: 1, unconfigured: 1 });
    expect(s.records.map((d) => d[4])).toEqual(["invalid_token", "unconfigured"]);
  });

  it("a failed send is recorded and then the job throws so pg-boss retries", async () => {
    const s = setup({
      rows: [
        row(),
        row({ device_id: DEV2, user_id: USER2, token: "tok-device-two-0000000000000000" }),
      ],
      send: async (t) => (t.token.includes("one") ? "failed" : "sent"),
    });
    const err = await handlePushNotifyJob(s.deps, {
      id: "j",
      data: { kind: "photos_analyzed", babyId: BABY },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PushDeliveryFailedError);
    expect(err.failed).toBe(1);
    expect(s.records.map((d) => d[4])).toEqual(["failed", "sent"]);
  });

  it("a sender that throws is treated as failed (and the batch still records the others)", async () => {
    const s = setup({
      rows: [
        row(),
        row({ device_id: DEV2, user_id: USER2, token: "tok-device-two-0000000000000000" }),
      ],
      send: async (t) => {
        if (t.token.includes("one")) throw new Error("socket hang up");
        return "sent";
      },
    });
    await expect(
      handlePushNotifyJob(s.deps, { id: "j", data: { kind: "photos_analyzed", babyId: BABY } }),
    ).rejects.toBeInstanceOf(PushDeliveryFailedError);
    expect(s.records.map((d) => d[4])).toEqual(["failed", "sent"]);
  });

  it("never logs a device token, a count-bearing text or a link id's owner", async () => {
    const s = setup({ rows: [row()] });
    await handlePushNotifyJob(s.deps, { id: "j", data: { kind: "photos_analyzed", babyId: BABY } });
    const text = JSON.stringify(s.log.lines);
    expect(text).not.toContain("tok-device-one");
    expect(text).not.toContain("ready to search");
    expect(s.log.lines.some((l) => l.msg === "push.notify: done")).toBe(true);
  });
});
