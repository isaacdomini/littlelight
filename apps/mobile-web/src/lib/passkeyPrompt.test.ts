import { PASSKEY_PROMPT_KEY, PASSKEY_PROMPT_SNOOZE_DAYS } from "@tinyglow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../testing/native";

// The enrol card's bookkeeping (docs/plans/step-13.md Q2, 2.3, 2.5): a per-session offer marker
// set by an email-code sign-in, and a persisted `{ snoozedUntil }` record (30 days on "Not now",
// final on the second dismissal or after a passkey was added). Nothing else is ever stored.

const kv = vi.hoisted(() => ({ data: new Map<string, string>() }));
vi.mock("../platform/native/secureKv", () => ({
  secureKv: {
    get: async (k: string) => kv.data.get(k) ?? null,
    set: async (k: string, v: string) => void kv.data.set(k, v),
    remove: async (k: string) => void kv.data.delete(k),
  },
}));

import {
  clearPasskeyPromptOffer,
  dismissPasskeyPromptForever,
  offerPasskeyPrompt,
  passkeyPromptOffered,
  passkeyPromptSnoozed,
  snoozePasskeyPrompt,
} from "./passkeyPrompt";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-11T12:00:00Z");

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  kv.data.clear();
});
afterEach(() => setNativePlatform(null));

const record = () => JSON.parse(window.localStorage.getItem(PASSKEY_PROMPT_KEY) ?? "null");

describe("per-session offer marker", () => {
  it("is set by offerPasskeyPrompt, read by passkeyPromptOffered, cleared by clearPasskeyPromptOffer; lives in sessionStorage only", () => {
    expect(passkeyPromptOffered()).toBe(false);
    offerPasskeyPrompt();
    expect(passkeyPromptOffered()).toBe(true);
    expect(window.localStorage.length).toBe(0);
    clearPasskeyPromptOffer();
    expect(passkeyPromptOffered()).toBe(false);
  });
});

describe("snooze (web: localStorage under PASSKEY_PROMPT_KEY)", () => {
  it("is not snoozed before any dismissal", async () => {
    expect(await passkeyPromptSnoozed(NOW)).toBe(false);
    expect(record()).toBeNull();
  });

  it("'Not now' snoozes exactly PASSKEY_PROMPT_SNOOZE_DAYS (30) days and stores only { snoozedUntil }", async () => {
    await snoozePasskeyPrompt(NOW);
    expect(Object.keys(record())).toEqual(["snoozedUntil"]);
    expect(record().snoozedUntil).toBe(
      new Date(NOW + PASSKEY_PROMPT_SNOOZE_DAYS * DAY).toISOString(),
    );
    expect(PASSKEY_PROMPT_SNOOZE_DAYS).toBe(30);
    expect(await passkeyPromptSnoozed(NOW)).toBe(true);
    expect(await passkeyPromptSnoozed(NOW + 29 * DAY)).toBe(true);
    expect(await passkeyPromptSnoozed(NOW + 30 * DAY + 1)).toBe(false);
  });

  it("the second 'Not now' (after the first snooze lapsed) is final: re-offered at most once", async () => {
    await snoozePasskeyPrompt(NOW);
    const later = NOW + 31 * DAY;
    expect(await passkeyPromptSnoozed(later)).toBe(false);
    await snoozePasskeyPrompt(later);
    expect(await passkeyPromptSnoozed(later + 365 * DAY)).toBe(true);
    expect(await passkeyPromptSnoozed(later + 50 * 365 * DAY)).toBe(true);
  });

  it("adding a passkey dismisses the card for good", async () => {
    await dismissPasskeyPromptForever(NOW);
    expect(await passkeyPromptSnoozed(NOW + 20 * 365 * DAY)).toBe(true);
    expect(Object.keys(record())).toEqual(["snoozedUntil"]);
  });

  it("a corrupt or foreign record counts as never snoozed (and a snooze then starts at 30 days, not forever)", async () => {
    for (const raw of [
      "not json",
      "{}",
      '{"snoozedUntil":"yesterday"}',
      '{"snoozedUntil":5}',
      "[]",
      "null",
    ]) {
      window.localStorage.setItem(PASSKEY_PROMPT_KEY, raw);
      expect(await passkeyPromptSnoozed(NOW), raw).toBe(false);
    }
    await snoozePasskeyPrompt(NOW);
    expect(await passkeyPromptSnoozed(NOW + 31 * DAY)).toBe(false);
  });

  it("never stores a name, credential or challenge: the record has one key", async () => {
    await snoozePasskeyPrompt(NOW);
    const raw = window.localStorage.getItem(PASSKEY_PROMPT_KEY) ?? "";
    expect(raw).not.toMatch(/credential|challenge|name|rawId|signature/i);
    expect(Object.keys(window.localStorage).filter((k) => k.includes("passkey"))).toEqual([
      PASSKEY_PROMPT_KEY,
    ]);
  });
});

describe("snooze (native: secure store under the same key, nothing in localStorage)", () => {
  beforeEach(() => setNativePlatform("ios"));

  it("writes and reads the secure store", async () => {
    await snoozePasskeyPrompt(NOW);
    expect(kv.data.has(PASSKEY_PROMPT_KEY)).toBe(true);
    expect(window.localStorage.getItem(PASSKEY_PROMPT_KEY)).toBeNull();
    expect(await passkeyPromptSnoozed(NOW + DAY)).toBe(true);
    expect(await passkeyPromptSnoozed(NOW + 31 * DAY)).toBe(false);
  });

  it("the second dismissal is final on native too", async () => {
    await snoozePasskeyPrompt(NOW);
    await snoozePasskeyPrompt(NOW + 31 * DAY);
    expect(await passkeyPromptSnoozed(NOW + 10 * 365 * DAY)).toBe(true);
  });
});
