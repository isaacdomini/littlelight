import type { Tx } from "../auth";
import type { TurnResult } from "./agent";

// Chat persistence (docs/plans/step-7.md 2.3.8, 2.8). Every statement runs under the caller's
// claims: `chat_threads` / `chat_messages` policies are admin + own + `baby_ai_enabled` (FR-7.7),
// `ai_spend` admits the caller's own chat rows for a paid baby they administer. Message text is
// user content: never logged.

export interface ThreadRow {
  id: string;
}

export interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  cited_photo_ids: string[];
  cited_measurement_ids: string[];
  status: "complete" | "error";
  created_at: Date;
}

const MESSAGE_COLUMNS =
  "m.id, m.role, m.content, m.cited_photo_ids, m.cited_measurement_ids, m.status, m.created_at";

/** The caller's newest thread for the baby (one per user per baby, D4), or null. */
export async function currentThread(
  client: Tx,
  babyId: string,
  uid: string,
): Promise<ThreadRow | null> {
  const { rows } = await client.query<ThreadRow>(
    `SELECT t.id FROM public.chat_threads t
      WHERE t.baby_id = $1 AND t.user_id = $2
      ORDER BY t.updated_at DESC, t.id DESC LIMIT 1`,
    [babyId, uid],
  );
  return rows[0] ?? null;
}

/**
 * Finds or creates the caller's thread and locks it for this transaction
 * (`FOR UPDATE SKIP LOCKED`). `null` = another request holds the lock right now.
 */
export async function lockThread(client: Tx, babyId: string, uid: string): Promise<string | null> {
  const existing = await currentThread(client, babyId, uid);
  if (!existing) {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO public.chat_threads (baby_id, user_id) VALUES ($1, $2) RETURNING id",
      [babyId, uid],
    );
    return rows[0]?.id ?? null;
  }
  const { rows } = await client.query<{ id: string }>(
    "SELECT t.id FROM public.chat_threads t WHERE t.id = $1 FOR UPDATE SKIP LOCKED",
    [existing.id],
  );
  return rows[0]?.id ?? null;
}

/**
 * True when the thread's newest message is a user message younger than `windowMs`: a reply is
 * still being written (the lock above only covers the short first transaction; the model runs
 * outside any transaction). A crashed turn stops counting as busy after the window.
 */
export async function replyInProgress(
  client: Tx,
  threadId: string,
  windowMs: number,
): Promise<boolean> {
  const { rows } = await client.query<{ busy: boolean }>(
    `SELECT (m.role = 'user' AND m.created_at > now() - make_interval(secs => $2::float8 / 1000)) AS busy
       FROM public.chat_messages m WHERE m.thread_id = $1
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    [threadId, windowMs],
  );
  return rows[0]?.busy === true;
}

/** The last `limit` messages of the thread, oldest first. */
export async function threadMessages(
  client: Tx,
  threadId: string,
  limit: number,
): Promise<MessageRow[]> {
  if (limit <= 0) return [];
  const { rows } = await client.query<MessageRow>(
    `SELECT * FROM (
        SELECT ${MESSAGE_COLUMNS} FROM public.chat_messages m
         WHERE m.thread_id = $1 AND m.role IN ('user', 'assistant')
         ORDER BY m.created_at DESC, m.id DESC LIMIT $2) x
      ORDER BY x.created_at, x.id`,
    [threadId, limit],
  );
  return rows;
}

/** `chat_reserve_turn(limit)`: advisory-locks the user and counts their turns in the last 24 h. */
export async function reserveTurn(
  client: Tx,
  limit: number,
): Promise<{ turns: number; oldestAt: Date | null; allowed: boolean }> {
  const { rows } = await client.query<{ turns: number; oldest_at: Date | null; allowed: boolean }>(
    "SELECT turns, oldest_at, allowed FROM public.chat_reserve_turn($1)",
    [limit],
  );
  const r = rows[0];
  return { turns: r?.turns ?? 0, oldestAt: r?.oldest_at ?? null, allowed: r?.allowed === true };
}

/** `chat_user_turns_24h()`. */
export async function turnsLast24h(client: Tx): Promise<number> {
  const { rows } = await client.query<{ n: number }>("SELECT public.chat_user_turns_24h() AS n");
  return rows[0]?.n ?? 0;
}

/** `ai_baby_month_cost_usd(baby, current UTC month)` (vision batches + embeddings + chat). */
export async function monthCostUsd(client: Tx, babyId: string, now: Date): Promise<number> {
  const { rows } = await client.query<{ c: string | null }>(
    "SELECT public.ai_baby_month_cost_usd($1, $2::date) AS c",
    [babyId, now.toISOString().slice(0, 10)],
  );
  return Number(rows[0]?.c ?? 0);
}

/** Whether this user already has an `ai.budget_exceeded` row for the baby, month and kind chat. */
export async function budgetAuditExists(
  client: Tx,
  babyId: string,
  month: string,
): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.audit_log a
                     WHERE a.baby_id = $1 AND a.event = 'ai.budget_exceeded'
                       AND a.metadata ->> 'month' = $2 AND a.metadata ->> 'kind' = 'chat') AS ok`,
    [babyId, month],
  );
  return rows[0]?.ok === true;
}

export async function insertUserMessage(
  client: Tx,
  threadId: string,
  babyId: string,
  uid: string,
  text: string,
): Promise<{ id: string; created_at: Date }> {
  const { rows } = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO public.chat_messages (thread_id, baby_id, user_id, role, content)
     VALUES ($1, $2, $3, 'user', $4) RETURNING id, created_at`,
    [threadId, babyId, uid, text],
  );
  return rows[0] as { id: string; created_at: Date };
}

/**
 * The assistant message, its `ai_spend` row (kind chat; skipped when nothing was billed) and the
 * thread's `updated_at`, in one transaction. `cited_photo_ids` stores the grid (cited photos, or
 * the last search's results when the model cited none).
 */
export async function insertAssistantTurn(
  client: Tx,
  o: { threadId: string; babyId: string; uid: string; result: TurnResult },
): Promise<{ id: string; created_at: Date }> {
  const r = o.result;
  const { rows } = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO public.chat_messages
       (thread_id, baby_id, user_id, role, content, cited_photo_ids, cited_measurement_ids,
        tokens_in, tokens_out, model, cost_usd, tools_used, status)
     VALUES ($1, $2, $3, 'assistant', $4, $5::uuid[], $6::uuid[], $7, $8, $9, $10, $11::text[], $12)
     RETURNING id, created_at`,
    [
      o.threadId,
      o.babyId,
      o.uid,
      r.text,
      r.photoIds.slice(0, 50),
      r.citations.measurementIds.slice(0, 50),
      r.usage.inputTokens,
      r.usage.outputTokens,
      r.model,
      r.usage.costUsd,
      r.toolsUsed,
      r.status,
    ],
  );
  const msg = rows[0] as { id: string; created_at: Date };
  if (r.usage.costUsd > 0) {
    await client.query(
      `INSERT INTO public.ai_spend (baby_id, user_id, kind, ref_id, model, input_tokens,
                                    cached_input_tokens, output_tokens, reasoning_tokens,
                                    item_count, cost_usd)
       VALUES ($1, $2, 'chat', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        o.babyId,
        o.uid,
        msg.id,
        r.model,
        r.usage.inputTokens,
        r.usage.cachedInputTokens,
        r.usage.outputTokens,
        r.usage.reasoningTokens,
        r.usage.calls,
        r.usage.costUsd,
      ],
    );
  }
  await client.query("UPDATE public.chat_threads SET updated_at = now() WHERE id = $1", [
    o.threadId,
  ]);
  return msg;
}

/** Deletes the caller's threads for the baby (messages cascade); returns how many. */
export async function deleteThreads(client: Tx, babyId: string, uid: string): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    "DELETE FROM public.chat_threads t WHERE t.baby_id = $1 AND t.user_id = $2 RETURNING t.id",
    [babyId, uid],
  );
  return rows.length;
}
