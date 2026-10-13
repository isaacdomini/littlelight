import { PASSKEY_PROMPT_KEY, PASSKEY_PROMPT_SNOOZE_DAYS } from "@tinyglow/shared";
import { isNative } from "../platform/platform";

// The one-time "Add a passkey" card (docs/plans/step-13.md Q2, 2.3, 2.5): offered after an
// email-code sign-in, snoozed 30 days on "Not now", re-offered at most once. The stored record is
// `{ snoozedUntil }` under `PASSKEY_PROMPT_KEY`: localStorage on the web, the secure store in the
// app. Never a credential, challenge or name. Every storage access is best effort.

const OFFER_KEY = "ll_passkey_offer";
/** The second "Not now" is final: a snooze this far out never expires in practice. */
const FOREVER_MS = 100 * 365 * 86_400_000;
const DAY_MS = 86_400_000;

interface PromptRecord {
  snoozedUntil: string;
}

// ---- the per-session offer marker (set by an email-code sign-in, read by the card) --------------

function ss(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Marks that an email-code sign-in just happened, so the card may show once this session. */
export function offerPasskeyPrompt(): void {
  try {
    ss()?.setItem(OFFER_KEY, "1");
  } catch {
    // storage unavailable: no card this session
  }
}

export function passkeyPromptOffered(): boolean {
  try {
    return ss()?.getItem(OFFER_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearPasskeyPromptOffer(): void {
  try {
    ss()?.removeItem(OFFER_KEY);
  } catch {
    // nothing to clear
  }
}

// ---- the persisted snooze ---------------------------------------------------------------------

async function readRaw(): Promise<string | null> {
  try {
    if (isNative()) {
      const { secureKv } = await import("../platform/native/secureKv");
      return await secureKv.get(PASSKEY_PROMPT_KEY);
    }
    return window.localStorage.getItem(PASSKEY_PROMPT_KEY);
  } catch {
    return null;
  }
}

async function writeRaw(value: string): Promise<void> {
  try {
    if (isNative()) {
      const { secureKv } = await import("../platform/native/secureKv");
      await secureKv.set(PASSKEY_PROMPT_KEY, value);
      return;
    }
    window.localStorage.setItem(PASSKEY_PROMPT_KEY, value);
  } catch {
    // storage unavailable: the card may show again next time
  }
}

async function readRecord(): Promise<PromptRecord | null> {
  const raw = await readRaw();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as PromptRecord).snoozedUntil === "string" &&
      !Number.isNaN(Date.parse((parsed as PromptRecord).snoozedUntil))
    ) {
      return parsed as PromptRecord;
    }
  } catch {
    // corrupt: treated as never snoozed
  }
  return null;
}

/** True while a snooze is in force. */
export async function passkeyPromptSnoozed(now = Date.now()): Promise<boolean> {
  const rec = await readRecord();
  return rec !== null && Date.parse(rec.snoozedUntil) > now;
}

/**
 * "Not now": snooze `PASSKEY_PROMPT_SNOOZE_DAYS`; a second dismissal (an expired snooze already
 * recorded) is final.
 */
export async function snoozePasskeyPrompt(now = Date.now()): Promise<void> {
  const previous = await readRecord();
  const ms = previous ? FOREVER_MS : PASSKEY_PROMPT_SNOOZE_DAYS * DAY_MS;
  await writeRaw(JSON.stringify({ snoozedUntil: new Date(now + ms).toISOString() }));
}

/** After a passkey was added (from the card or Settings): never offer the card again. */
export async function dismissPasskeyPromptForever(now = Date.now()): Promise<void> {
  await writeRaw(JSON.stringify({ snoozedUntil: new Date(now + FOREVER_MS).toISOString() }));
}
