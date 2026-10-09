import {
  type PushData,
  type PushKind,
  type PushNotifyJob,
  type PushProvider,
  pushDataSchema,
  pushMessage,
  pushNotifyJobSchema,
} from "@littlelight/shared";
import type { JobWithMetadata } from "pg-boss";
import { errorCategory } from "../clients";
import { type PipelinePool, runAsPipeline } from "../db";
import type { WorkerLog } from "../log-types";
import type { PushMessage, PushSender, PushSendStatus } from "./types";

// `push.notify` handler (docs/plans/step-9.md 2.8, D10, D14). The payload is `{kind, id}`; every
// recipient is resolved at run time as `pipeline` through the migration-16 functions (the worker
// has no grant on the push tables):
//
// 1. Baby: `photos_analyzed` ⇒ the payload's baby, skipped unless `baby_ai_enabled` (free-tier
//    babies never get it); `share_viewed` ⇒ `push_link_baby(shareLinkId)` (NULL ⇒ nothing to do).
// 2. Targets: `push_targets(baby, kind)` (admins, pref on, live GoTrue session, device enabled;
//    it also prunes devices of dead sessions) with `last_sent_at` = the user's latest sent/fake
//    delivery for (baby, kind), and for `photos_analyzed` the number of photos analysed since
//    `max(last_sent_at, now − 24 h)` (`push_photos_analyzed_count`).
// 3. Per target, in this order:
//    - `photos_analyzed` with nothing new (n = 0) ⇒ skip;
//    - `share_viewed` already covered: a push for this (baby, kind) reached the user after the
//      job was created (`last_sent_at >= job.createdOn`), e.g. by another link's job or by the
//      run this job was re-sent from ⇒ skip;
//    - within `PUSH_MIN_GAP_MIN` of `last_sent_at` ⇒ defer;
//    - otherwise send.
// 4. Deferred targets ⇒ the job is re-sent ONCE, before any send, with `startAfter` = the longest
//    remaining gap (+1 s), so every deferred target is due when it runs. Re-sending first makes
//    the new job's `createdOn` precede this run's deliveries, so the re-run treats the users
//    notified now as covered (`share_viewed`) or finds n = 0 for them (`photos_analyzed`). The
//    `short` queue keeps one queued job per key: a re-send while one is queued is a no-op.
// 5. Send (generic text from `pushMessage`, opaque ids), then record every outcome with
//    `push_record_delivery` (`invalid_token` disables the device there).
// 6. If any send `failed`, the job throws after recording so pg-boss retries it (`retryLimit 2`);
//    users already notified are covered / at n = 0 on the retry, so nobody is notified twice.
//
// Network calls never run inside a database transaction. Logs carry ids, kinds and counts only:
// never a device token, the notification text's inputs, or a provider response.

/** A `push.notify` job as the handler sees it (`createdOn` from pg-boss metadata). */
export type PushNotifyJobLike = Pick<JobWithMetadata<unknown>, "id" | "data"> & {
  createdOn?: Date | undefined;
};

export interface NotifyDeps {
  pool: PipelinePool;
  sender: Pick<PushSender, "send">;
  log: WorkerLog;
  /** `PUSH_MIN_GAP_MIN`: at most one push per user per (baby, kind) within this many minutes. */
  minGapMin: number;
  /** Re-send this job with `startAfter` seconds (the gap rule); null when one is already queued. */
  resend: (job: PushNotifyJob, startAfterSec: number) => Promise<string | null>;
}

export interface PushNotifyResult {
  kind: PushKind;
  babyId: string | null;
  /** Why nothing was attempted, when nothing was. */
  skippedReason?: "no_baby" | "ai_disabled";
  targets: number;
  /** Outcomes of the sends that were made, by status. */
  delivered: Partial<Record<PushSendStatus, number>>;
  skipped: { nothingNew: number; covered: number };
  deferred: number;
  /** Set when deferred targets made the job re-send itself. */
  rescheduled: { jobId: string | null; startAfterSec: number } | null;
}

/** Thrown after recording when at least one send failed, so pg-boss retries the job. */
export class PushDeliveryFailedError extends Error {
  readonly code = "push_delivery_failed";
  constructor(readonly failed: number) {
    super(`${failed} push delivery attempt(s) failed`);
    this.name = "PushDeliveryFailedError";
  }
}

export type TargetDecision =
  | { action: "send" }
  | { action: "defer"; remainingMs: number }
  | { action: "skip"; why: "nothing_new" | "covered" };

/** Step 3 of the contract above for one target (pure; exported for tests). */
export function decideTarget(input: {
  kind: PushKind;
  lastSentAt: Date | null;
  /** `photos_analyzed` only: photos analysed since `max(last_sent_at, now − 24 h)`. */
  count: number | null;
  /** Database `now()` of the targets query. */
  now: Date;
  gapMs: number;
  /** The job's `createdOn` (absent for an in-process run-job). */
  eventAt?: Date | undefined;
}): TargetDecision {
  const { kind, lastSentAt, count, now, gapMs, eventAt } = input;
  if (kind === "photos_analyzed" && (count ?? 0) <= 0) {
    return { action: "skip", why: "nothing_new" };
  }
  if (
    kind === "share_viewed" &&
    eventAt !== undefined &&
    lastSentAt !== null &&
    lastSentAt.getTime() >= eventAt.getTime()
  ) {
    return { action: "skip", why: "covered" };
  }
  if (lastSentAt !== null && gapMs > 0) {
    const elapsed = now.getTime() - lastSentAt.getTime();
    if (elapsed < gapMs) return { action: "defer", remainingMs: gapMs - Math.max(elapsed, 0) };
  }
  return { action: "send" };
}

/** `startAfter` (seconds) of the re-sent job: the longest remaining gap, rounded up, +1 s. */
export function rescheduleSeconds(remainingMs: readonly number[]): number {
  return Math.ceil(Math.max(0, ...remainingMs) / 1000) + 1;
}

/** The notification for one kind (generic text, opaque ids; D10). */
export function buildPushMessage(
  job: PushNotifyJob,
  babyId: string,
  count: number | null,
): PushMessage {
  const data: PushData = pushDataSchema.parse(
    job.kind === "photos_analyzed"
      ? { kind: job.kind, babyId }
      : { kind: job.kind, babyId, shareLinkId: job.shareLinkId },
  );
  const text = pushMessage(job.kind, job.kind === "photos_analyzed" ? (count ?? 1) : 1);
  return { title: text.title, body: text.body, data, collapseId: `${job.kind}:${babyId}` };
}

interface TargetRow {
  device_id: string;
  user_id: string;
  provider: PushProvider;
  token: string;
  last_sent_at: Date | null;
  db_now: Date;
  n: number | null;
}

const TARGETS_SQL = `
  SELECT t.device_id, t.user_id, t.provider, t.token, t.last_sent_at, now() AS db_now,
         CASE WHEN $2::text = 'photos_analyzed'
              THEN public.push_photos_analyzed_count(
                     $1::uuid, GREATEST(t.last_sent_at, now() - interval '24 hours'))
         END AS n
    FROM public.push_targets($1::uuid, $2::text) t`;

/** The `push.notify` handler for one job (exported for run-job and tests). */
export async function handlePushNotifyJob(
  deps: NotifyDeps,
  job: PushNotifyJobLike,
): Promise<PushNotifyResult | null> {
  const parsed = pushNotifyJobSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "push.notify: invalid job payload, dropped");
    return null;
  }
  const payload = parsed.data;
  const kind = payload.kind;
  const result: PushNotifyResult = {
    kind,
    babyId: null,
    targets: 0,
    delivered: {},
    skipped: { nothingNew: 0, covered: 0 },
    deferred: 0,
    rescheduled: null,
  };

  // 1–2: baby and targets (one pipeline transaction; push_targets is VOLATILE: it prunes).
  const resolved = await runAsPipeline(deps.pool, {}, async (client) => {
    let babyId: string | null;
    if (payload.kind === "photos_analyzed") {
      const { rows } = await client.query<{ enabled: boolean }>(
        "SELECT public.baby_ai_enabled($1::uuid) AS enabled",
        [payload.babyId],
      );
      if (rows[0]?.enabled !== true) {
        return {
          babyId: payload.babyId,
          rows: [] as TargetRow[],
          skippedReason: "ai_disabled" as const,
        };
      }
      babyId = payload.babyId;
    } else {
      const { rows } = await client.query<{ baby_id: string | null }>(
        "SELECT public.push_link_baby($1::uuid) AS baby_id",
        [payload.shareLinkId],
      );
      babyId = rows[0]?.baby_id ?? null;
      if (babyId === null) {
        return { babyId: null, rows: [] as TargetRow[], skippedReason: "no_baby" as const };
      }
    }
    const { rows } = await client.query<TargetRow>(TARGETS_SQL, [babyId, kind]);
    return { babyId, rows, skippedReason: undefined };
  });
  result.babyId = resolved.babyId;
  result.targets = resolved.rows.length;
  if (resolved.skippedReason) result.skippedReason = resolved.skippedReason;
  const babyId = resolved.babyId;
  if (babyId === null || resolved.rows.length === 0) {
    deps.log.info(
      { jobId: job.id, kind, babyId, targets: 0, skipped: resolved.skippedReason },
      "push.notify: nothing to send",
    );
    return result;
  }

  // 3: decide per target.
  const gapMs = deps.minGapMin * 60_000;
  const toSend: TargetRow[] = [];
  const remaining: number[] = [];
  for (const row of resolved.rows) {
    const decision = decideTarget({
      kind,
      lastSentAt: row.last_sent_at,
      count: row.n,
      now: row.db_now,
      gapMs,
      eventAt: job.createdOn,
    });
    if (decision.action === "send") toSend.push(row);
    else if (decision.action === "defer") remaining.push(decision.remainingMs);
    else if (decision.why === "nothing_new") result.skipped.nothingNew += 1;
    else result.skipped.covered += 1;
  }
  result.deferred = remaining.length;

  // 4: re-send once, before any delivery (errors propagate: nothing was sent yet).
  if (remaining.length > 0) {
    const startAfterSec = rescheduleSeconds(remaining);
    const jobId = await deps.resend(payload, startAfterSec);
    result.rescheduled = { jobId, startAfterSec };
  }

  // 5: send (outside any transaction), then record.
  const outcomes = await Promise.all(
    toSend.map(async (row) => {
      let status: PushSendStatus;
      try {
        status = await deps.sender.send(
          { provider: row.provider, token: row.token },
          buildPushMessage(payload, babyId, row.n),
        );
      } catch {
        status = "failed";
      }
      return { row, status };
    }),
  );
  for (const { status } of outcomes) {
    result.delivered[status] = (result.delivered[status] ?? 0) + 1;
  }
  if (outcomes.length > 0) {
    try {
      await runAsPipeline(deps.pool, {}, async (client) => {
        for (const { row, status } of outcomes) {
          await client.query(
            "SELECT public.push_record_delivery($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::int)",
            [
              row.device_id,
              babyId,
              payload.kind === "share_viewed" ? payload.shareLinkId : null,
              kind,
              status,
              kind === "photos_analyzed" ? row.n : null,
            ],
          );
        }
      });
    } catch (err) {
      // Not rethrown: a retry would notify the users who were just reached a second time.
      deps.log.error(
        { jobId: job.id, kind, babyId, deliveries: outcomes.length, err: errorCategory(err) },
        "push.notify: could not record deliveries",
      );
    }
  }

  deps.log.info(
    {
      jobId: job.id,
      kind,
      babyId,
      targets: result.targets,
      delivered: result.delivered,
      skipped: result.skipped,
      deferred: result.deferred,
      rescheduleSec: result.rescheduled?.startAfterSec,
    },
    "push.notify: done",
  );

  // 6: retry the failed ones.
  const failed = result.delivered.failed ?? 0;
  if (failed > 0) throw new PushDeliveryFailedError(failed);
  return result;
}
