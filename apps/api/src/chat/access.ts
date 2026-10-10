import type { Tx } from "../auth";
import { notFound } from "../lib/errors";
import { parentsOnly } from "../search/access";

// The chat *history* gate (docs/plans/review-fixes.md 2.7, D15). Reading and clearing one's own
// chat history is a data right that survives a downgrade, so `GET` and `DELETE
// /babies/:id/chat/thread` check admin membership only: no plan check, no model or embedding
// client. Sending a message keeps `requireChatAccess` (plan gate before any model call). RLS
// agrees: `chat_threads`/`chat_messages` SELECT and DELETE need `is_baby_admin` and own rows only;
// INSERT additionally needs `baby_ai_enabled`.

const babyNotFound = () => notFound("That album doesn't exist or you don't have access to it");

/**
 * 404 for strangers (RLS hides the baby and the membership), 403 `forbidden` for contributors.
 * Runs inside the caller's claims transaction.
 */
export async function requireChatHistoryAccess(
  client: Tx,
  uid: string,
  babyId: string,
): Promise<void> {
  const { rows } = await client.query<{ role: string }>(
    `SELECT m.role
       FROM public.babies b
       JOIN public.baby_members m ON m.baby_id = b.id AND m.user_id = $1
      WHERE b.id = $2`,
    [uid, babyId],
  );
  const r = rows[0];
  if (!r) throw babyNotFound();
  if (r.role !== "admin") throw parentsOnly();
}
