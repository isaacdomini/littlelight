import type { PublicKeyCredentialJsonInput } from "@tinyglow/shared";
import { isNative } from "./platform";

// Passkey ceremonies behind one seam (docs/plans/step-13.md 2.5, 2.6). Web: the browser's WebAuthn
// API in its JSON form (`PublicKeyCredential.parseCreationOptionsFromJSON` /
// `parseRequestOptionsFromJSON` / `toJSON()`, present in current Safari, Chrome and Firefox; when
// absent the feature is hidden, no polyfill). Native: the in-house `TinyglowPasskeys` plugin, so
// the relying party is the production host rather than the WebView origin. Options, challenges,
// credentials and user handles pass through opaquely and are never logged.

/**
 * Why a ceremony did not produce a credential. `cancelled`: the user dismissed the sheet (or no
 * passkey was available for an explicit request); `not_available` / `unsupported`: this
 * device/browser cannot do passkeys; `not_configured`: the native app is not associated with the
 * relying party yet; `failed`: anything else. Never carries an OS or browser message.
 */
export type PasskeyFailure =
  | "cancelled"
  | "not_available"
  | "not_configured"
  | "unsupported"
  | "failed";

export class PasskeyError extends Error {
  readonly code: PasskeyFailure;
  constructor(code: PasskeyFailure) {
    super(`passkey ${code}`);
    this.name = "PasskeyError";
    this.code = code;
  }
}

export function isPasskeyError(e: unknown, code?: PasskeyFailure): e is PasskeyError {
  return e instanceof PasskeyError && (code === undefined || e.code === code);
}

/** The W3C JSON options the API passes through from GoTrue (opaque to the client). */
export type PasskeyOptionsJson = Record<string, unknown>;

export interface GetOptions {
  /**
   * Web: `mediation: "conditional"` (autofill on the email field; resolves only when the user
   * picks a passkey from the suggestions). Native: ignored.
   */
  conditional?: boolean;
  /** Cancels a pending (conditional) request. */
  signal?: AbortSignal;
}

export interface PasskeyPlatform {
  /** A user-verifying platform authenticator and the JSON WebAuthn API are available. */
  supported(): Promise<boolean>;
  /** Autofill ("conditional UI") for `get({ conditional: true })` is available (web only). */
  conditionalUiSupported(): Promise<boolean>;
  create(options: PasskeyOptionsJson): Promise<PublicKeyCredentialJsonInput>;
  get(options: PasskeyOptionsJson, opts?: GetOptions): Promise<PublicKeyCredentialJsonInput>;
}

// ---- web --------------------------------------------------------------------------------------

/** The JSON-form WebAuthn surface this code needs (typed locally: lib.dom lags the spec). */
interface PublicKeyCredentialStatics {
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
  isConditionalMediationAvailable?: () => Promise<boolean>;
  parseCreationOptionsFromJSON?: (json: unknown) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (json: unknown) => PublicKeyCredentialRequestOptions;
}
interface CredentialWithJson {
  toJSON?: () => unknown;
}

function statics(): PublicKeyCredentialStatics | null {
  const w = globalThis as { PublicKeyCredential?: PublicKeyCredentialStatics };
  return typeof w.PublicKeyCredential === "function" || typeof w.PublicKeyCredential === "object"
    ? (w.PublicKeyCredential ?? null)
    : null;
}

function hasJsonApi(
  s: PublicKeyCredentialStatics | null,
): s is Required<
  Pick<PublicKeyCredentialStatics, "parseCreationOptionsFromJSON" | "parseRequestOptionsFromJSON">
> &
  PublicKeyCredentialStatics {
  return (
    !!s &&
    typeof s.parseCreationOptionsFromJSON === "function" &&
    typeof s.parseRequestOptionsFromJSON === "function" &&
    typeof navigator !== "undefined" &&
    !!navigator.credentials
  );
}

function toJson(credential: Credential | null): PublicKeyCredentialJsonInput {
  const c = credential as (Credential & CredentialWithJson) | null;
  if (!c || typeof c.toJSON !== "function") throw new PasskeyError("failed");
  return c.toJSON() as PublicKeyCredentialJsonInput;
}

/** Browser errors -> one of ours; the browser's message is dropped. */
function mapWebError(e: unknown): PasskeyError {
  if (e instanceof PasskeyError) return e;
  if (e instanceof DOMException) {
    if (e.name === "AbortError" || e.name === "NotAllowedError") {
      return new PasskeyError("cancelled");
    }
    if (e.name === "NotSupportedError") return new PasskeyError("not_available");
  }
  return new PasskeyError("failed");
}

export const webPasskeys: PasskeyPlatform = {
  async supported() {
    const s = statics();
    if (!hasJsonApi(s)) return false;
    try {
      // Only a user-verifying platform authenticator counts: the API requires UV on every
      // assertion (decision g), and the enrol card must not offer what cannot be completed.
      return (await s.isUserVerifyingPlatformAuthenticatorAvailable?.()) === true;
    } catch {
      return false;
    }
  },
  async conditionalUiSupported() {
    const s = statics();
    if (!hasJsonApi(s) || typeof s.isConditionalMediationAvailable !== "function") return false;
    try {
      return (await s.isConditionalMediationAvailable()) === true;
    } catch {
      return false;
    }
  },
  async create(options) {
    const s = statics();
    if (!hasJsonApi(s)) throw new PasskeyError("unsupported");
    try {
      const publicKey = s.parseCreationOptionsFromJSON(options);
      return toJson(await navigator.credentials.create({ publicKey }));
    } catch (e) {
      throw mapWebError(e);
    }
  },
  async get(options, opts = {}) {
    const s = statics();
    if (!hasJsonApi(s)) throw new PasskeyError("unsupported");
    try {
      const publicKey = s.parseRequestOptionsFromJSON(options);
      const request: CredentialRequestOptions & { mediation?: string } = {
        publicKey,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.conditional ? { mediation: "conditional" } : {}),
      };
      return toJson(await navigator.credentials.get(request));
    } catch (e) {
      throw mapWebError(e);
    }
  },
};

// ---- native -----------------------------------------------------------------------------------

/** Capacitor code loads lazily so the web bundle never carries it. */
const nativePasskeys: PasskeyPlatform = {
  supported: () => import("./native/passkeys").then((m) => m.nativePasskeys.supported()),
  conditionalUiSupported: () => Promise.resolve(false),
  create: (options) => import("./native/passkeys").then((m) => m.nativePasskeys.create(options)),
  get: (options, opts) =>
    import("./native/passkeys").then((m) => m.nativePasskeys.get(options, opts)),
};

let override: PasskeyPlatform | null = null;

/** Test seam: replace the platform implementation (pass `null` to restore). */
export function setPasskeyPlatform(p: PasskeyPlatform | null): void {
  override = p;
}

/** The passkey implementation for this runtime: the plugin in the app, WebAuthn on the web. */
export function passkeyPlatform(): PasskeyPlatform {
  return override ?? (isNative() ? nativePasskeys : webPasskeys);
}
