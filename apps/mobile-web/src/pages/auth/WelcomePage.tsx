import { useQueryClient } from "@tanstack/react-query";
import {
  emailSchema,
  PASSKEY_FAILED_MESSAGE,
  type PublicKeyCredentialJsonInput,
} from "@tinyglow/shared";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ME_KEY } from "../../auth/AuthProvider";
import { FlowPage } from "../../components/Page";
import { Turnstile } from "../../components/Turnstile";
import { Button, Message, TextField } from "../../components/ui";
import { t } from "../../i18n";
import { isApiError } from "../../lib/api";
import { requestCode } from "../../lib/authApi";
import {
  passkeySignIn,
  passkeySignInOptions,
  passkeySignInVerify,
  usePasskeySupport,
} from "../../lib/passkeys";
import { useAuthConfig } from "../../lib/queries";
import { createPkceChallenge, pendingEmail, pendingInvite } from "../../lib/session";
import { signInError } from "../../lib/signInErrors";
import { isPasskeyError, passkeyPlatform } from "../../platform/passkeys";
import { isNative } from "../../platform/platform";

const OAUTH_REDIRECT = `${window.location.origin}/signin/callback`;

async function startOAuth(provider: "apple" | "google"): Promise<void> {
  const challenge = await createPkceChallenge();
  const params = new URLSearchParams({
    provider,
    redirect_to: OAUTH_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "s256",
  });
  // Top-level navigation: /auth/authorize is one of the three GoTrue paths exposed to browsers.
  window.location.assign(`/auth/authorize?${params.toString()}`);
}

/** A failed passkey ceremony -> one safe line; the email code stays on screen in every case. */
function passkeyErrorText(e: unknown): string | null {
  if (isPasskeyError(e, "cancelled")) return t("passkey.cancelled");
  if (isPasskeyError(e, "not_available") || isPasskeyError(e, "unsupported")) {
    return t("passkey.unavailable");
  }
  if (isPasskeyError(e)) return PASSKEY_FAILED_MESSAGE;
  if (isApiError(e, "passkey_failed") || isApiError(e, "passkey_disabled")) {
    return PASSKEY_FAILED_MESSAGE;
  }
  return signInError(e).message;
}

export function WelcomePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const config = useAuthConfig();
  const passkeys = usePasskeySupport();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  /** Native `not_configured`: the app is not associated with the relying party in this build. */
  const [notConfigured, setNotConfigured] = useState(false);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  /** The pending autofill ("conditional UI") request; aborted when the user acts otherwise. */
  const conditional = useRef<AbortController | null>(null);
  const signedIn = useRef(false);

  // Native is email-code only until Apple/Google sign-in lands in the app (9b).
  const providers = isNative() ? undefined : config.data?.providers;
  const siteKey = config.data?.turnstileSiteKey ?? null;
  const showPasskey = passkeys.enabled === true && !notConfigured;

  const stopConditional = useCallback(() => {
    conditional.current?.abort();
    conditional.current = null;
  }, []);

  /** A passkey session exists: `/me` reloads and the route guard moves the user on. */
  const onPasskeySignedIn = useCallback(async () => {
    signedIn.current = true;
    stopConditional();
    pendingEmail.clear();
    await qc.refetchQueries({ queryKey: ME_KEY });
  }, [qc, stopConditional]);

  // Autofill: one silent request that resolves only when the user picks a passkey from the
  // email field's suggestions. Cancelled when they submit the email or press the button. It is
  // silent on every failure before the browser prompt (options 401/429/captcha, no autofill):
  // the user did nothing, so no message. Only a ceremony the user completed and the server then
  // refused shows the generic line.
  useEffect(() => {
    if (!showPasskey || !passkeys.conditionalUi || signedIn.current) return;
    const ctrl = new AbortController();
    conditional.current = ctrl;
    void (async () => {
      let challengeId: string;
      let options: Record<string, unknown>;
      try {
        ({ challengeId, options } = await passkeySignInOptions());
      } catch {
        return;
      }
      if (ctrl.signal.aborted) return;
      let credential: PublicKeyCredentialJsonInput;
      try {
        credential = await passkeyPlatform().get(options, {
          conditional: true,
          signal: ctrl.signal,
        });
      } catch {
        return;
      }
      if (ctrl.signal.aborted) return;
      try {
        await passkeySignInVerify(challengeId, credential);
        await onPasskeySignedIn();
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (isApiError(e, "passkey_failed")) setError(PASSKEY_FAILED_MESSAGE);
        else setError(signInError(e).message);
      }
    })();
    return () => ctrl.abort();
  }, [showPasskey, passkeys.conditionalUi, onPasskeySignedIn]);

  async function onPasskey() {
    stopConditional();
    setPasskeyBusy(true);
    setError(null);
    try {
      await passkeySignIn(captchaToken ? { captchaToken } : {});
      await onPasskeySignedIn();
    } catch (err) {
      if (isApiError(err, "captcha_required") || isApiError(err, "captcha_failed")) {
        setNeedCaptcha(true);
        setCaptchaToken(undefined);
        setError(t("welcome.captcha"));
      } else if (isPasskeyError(err, "not_configured")) {
        // Not in this build (NATIVE.md "Passkeys"): hide the button, no message; email code stays.
        setNotConfigured(true);
      } else {
        setError(passkeyErrorText(err));
      }
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setError(t("welcome.invalidEmail"));
      return;
    }
    stopConditional();
    setBusy(true);
    setError(null);
    try {
      await requestCode(parsed.data, captchaToken);
      pendingEmail.set(parsed.data);
      navigate("/verify", { replace: true });
    } catch (err) {
      if (isApiError(err, "captcha_required") || isApiError(err, "captcha_failed")) {
        setNeedCaptcha(true);
        setCaptchaToken(undefined);
        setError(t("welcome.captcha"));
      } else {
        setError(signInError(err).message);
      }
    } finally {
      setBusy(false);
    }
  }

  const anyBusy = busy || passkeyBusy;

  return (
    <FlowPage title={t("welcome.title")} subtitle={t("welcome.subtitle")} testId="welcome" brand>
      {pendingInvite.get() ? <Message kind="info">{t("welcome.invitePending")}</Message> : null}
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
        <TextField
          data-testid="welcome-email"
          label={t("welcome.emailLabel")}
          type="email"
          inputMode="email"
          // `webauthn` lets the browser list passkeys in the field's autofill suggestions.
          autoComplete={showPasskey ? "username webauthn" : "email"}
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {needCaptcha && siteKey ? <Turnstile siteKey={siteKey} onToken={setCaptchaToken} /> : null}
        {error ? <Message data-testid="welcome-error">{error}</Message> : null}
        <Button
          type="submit"
          data-testid="welcome-continue"
          disabled={anyBusy || email.trim() === "" || (needCaptcha && !captchaToken)}
        >
          {t("welcome.continue")}
        </Button>
        {showPasskey ? (
          <Button
            variant="secondary"
            data-testid="welcome-passkey"
            disabled={anyBusy || (needCaptcha && !captchaToken)}
            aria-busy={passkeyBusy || undefined}
            onClick={() => void onPasskey()}
          >
            {passkeyBusy ? t("passkey.signingIn") : t("passkey.signIn")}
          </Button>
        ) : null}
      </form>
      {providers?.apple || providers?.google ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 text-muted" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            <span className="text-sm">{t("welcome.or")}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
          {providers.apple ? (
            <Button
              variant="secondary"
              data-testid="welcome-apple"
              onClick={() =>
                void startOAuth("apple").catch(() => setError(t("welcome.oauthFailed")))
              }
            >
              {t("welcome.apple")}
            </Button>
          ) : null}
          {providers.google ? (
            <Button
              variant="secondary"
              data-testid="welcome-google"
              onClick={() =>
                void startOAuth("google").catch(() => setError(t("welcome.oauthFailed")))
              }
            >
              {t("welcome.google")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </FlowPage>
  );
}
