import { emailSchema } from "@tinyglow/shared";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FlowPage } from "../../components/Page";
import { Turnstile } from "../../components/Turnstile";
import { Button, Message, TextField } from "../../components/ui";
import { t } from "../../i18n";
import { errorMessage, isApiError } from "../../lib/api";
import { requestCode } from "../../lib/authApi";
import { useAuthConfig } from "../../lib/queries";
import { createPkceChallenge, pendingEmail, pendingInvite } from "../../lib/session";
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

export function WelcomePage() {
  const navigate = useNavigate();
  const config = useAuthConfig();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();

  // Native is email-code only until Apple/Google sign-in lands in the app (9b).
  const providers = isNative() ? undefined : config.data?.providers;
  const siteKey = config.data?.turnstileSiteKey ?? null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setError(t("welcome.invalidEmail"));
      return;
    }
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
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <FlowPage title={t("welcome.title")} subtitle={t("welcome.subtitle")} testId="welcome" brand>
      {pendingInvite.get() ? <Message kind="info">{t("welcome.invitePending")}</Message> : null}
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
        <TextField
          data-testid="welcome-email"
          label={t("welcome.emailLabel")}
          type="email"
          inputMode="email"
          autoComplete="email"
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
          disabled={busy || email.trim() === "" || (needCaptcha && !captchaToken)}
        >
          {t("welcome.continue")}
        </Button>
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
