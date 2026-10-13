import { registerPlugin } from "@capacitor/core";
import type { PublicKeyCredentialJsonInput } from "@tinyglow/shared";
import { PasskeyError, type PasskeyFailure, type PasskeyPlatform } from "../passkeys";

// Native passkeys over the in-house `TinyglowPasskeys` plugin (docs/plans/step-13.md 2.6;
// ios/App/App/TinyglowPasskeys.swift, android/.../passkeys/TinyglowPasskeysPlugin.java). Options
// and credentials are the W3C JSON forms the API speaks, passed through verbatim. The plugin
// rejects with `cancelled | not_available | not_configured | failed` as both message and code and
// never forwards an OS message; nothing here is logged.

interface TinyglowPasskeysPlugin {
  available(): Promise<{ available: boolean }>;
  create(o: { options: Record<string, unknown> }): Promise<{ credential: unknown }>;
  get(o: {
    options: Record<string, unknown>;
    preferImmediatelyAvailable?: boolean;
  }): Promise<{ credential: unknown }>;
}

let plugin: TinyglowPasskeysPlugin | null = null;
function load(): TinyglowPasskeysPlugin {
  plugin ??= registerPlugin<TinyglowPasskeysPlugin>("TinyglowPasskeys");
  return plugin;
}

const CODES: ReadonlySet<string> = new Set<PasskeyFailure>([
  "cancelled",
  "not_available",
  "not_configured",
  "failed",
]);

/** A plugin rejection -> `PasskeyError`; an unknown shape (plugin missing) is `not_available`. */
function mapNativeError(e: unknown): PasskeyError {
  const err = e as { code?: unknown; message?: unknown } | null;
  for (const v of [err?.code, err?.message]) {
    if (typeof v === "string" && CODES.has(v)) return new PasskeyError(v as PasskeyFailure);
  }
  if (typeof err?.message === "string" && /not implemented|UNIMPLEMENTED/i.test(err.message)) {
    return new PasskeyError("not_available");
  }
  return new PasskeyError("failed");
}

export const nativePasskeys: PasskeyPlatform = {
  async supported() {
    try {
      return (await load().available()).available === true;
    } catch {
      return false;
    }
  },
  conditionalUiSupported: () => Promise.resolve(false),
  async create(options) {
    try {
      const { credential } = await load().create({ options });
      return credential as PublicKeyCredentialJsonInput;
    } catch (e) {
      throw mapNativeError(e);
    }
  },
  async get(options) {
    try {
      // The explicit button: skip the OS "no passkey here" sheet and report `cancelled`.
      const { credential } = await load().get({ options, preferImmediatelyAvailable: true });
      return credential as PublicKeyCredentialJsonInput;
    } catch (e) {
      throw mapNativeError(e);
    }
  },
};
