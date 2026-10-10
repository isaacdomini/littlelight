import { CHAT_MESSAGES } from "@tinyglow/shared";
import type { Tx } from "../auth";
import { ApiError, forbidden, notFound } from "../lib/errors";

// The chat/search gate (docs/plans/step-7.md 2.8; PRD FR-7.7 "admins only, paid tier",
// FR-5.8). Runs inside the caller's claims transaction before anything else, so no embedding or
// chat call ever happens for a stranger, a contributor or a free/expired baby. RLS is the
// backstop: `photo_search`, `chat_*` and `ai_spend` all require admin + `baby_ai_enabled`.

export interface ChatAccess {
  babyId: string;
  /** `babies.name` (chat system prompt only; never logged). */
  name: string;
  nickname: string | null;
  /** `YYYY-MM-DD`. */
  birthDate: string;
  /** The caller's `profiles.timezone` (IANA) and `profiles.units`. */
  timezone: string;
  units: "metric" | "imperial";
}

export const planRequired = () => new ApiError(403, "plan_required", CHAT_MESSAGES.planRequired);
export const parentsOnly = () => forbidden(CHAT_MESSAGES.parentsOnly);
const babyNotFound = () => notFound("That album doesn't exist or you don't have access to it");

/**
 * 404 for strangers (RLS hides the membership), 403 `forbidden` for contributors, 403
 * `plan_required` when the baby has no AI entitlement (`baby_ai_enabled`: Plus, live, not
 * trashed). Returns what search and chat need about the baby and the caller.
 */
export async function requireChatAccess(
  client: Tx,
  uid: string,
  babyId: string,
): Promise<ChatAccess> {
  const { rows } = await client.query<{
    role: string;
    name: string;
    nickname: string | null;
    birth_date: string;
    ai_enabled: boolean;
    timezone: string | null;
    units: string | null;
  }>(
    `SELECT m.role, b.name, b.nickname, to_char(b.birth_date, 'YYYY-MM-DD') AS birth_date,
            public.baby_ai_enabled(b.id) AS ai_enabled, pr.timezone, pr.units
       FROM public.babies b
       JOIN public.baby_members m ON m.baby_id = b.id AND m.user_id = $1
       LEFT JOIN public.profiles pr ON pr.user_id = $1
      WHERE b.id = $2`,
    [uid, babyId],
  );
  const r = rows[0];
  if (!r) throw babyNotFound();
  if (r.role !== "admin") throw parentsOnly();
  if (!r.ai_enabled) throw planRequired();
  return {
    babyId,
    name: r.name,
    nickname: r.nickname,
    birthDate: r.birth_date,
    timezone: safeTimeZone(r.timezone),
    units: r.units === "imperial" ? "imperial" : "metric",
  };
}

/** An IANA zone the runtime knows (profiles are validated on write; this is a fallback). */
export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Today's date (`YYYY-MM-DD`) in `tz`. */
export function todayIn(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
