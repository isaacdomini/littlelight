import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { nextOnboardingRoute } from "../../auth/onboarding";
import { FlowPage } from "../../components/Page";
import { Button, Message } from "../../components/ui";
import { t } from "../../i18n";
import { exchangePkce, verifyTokenHash } from "../../lib/authApi";
import { offerPasskeyPrompt } from "../../lib/passkeyPrompt";
import { pendingInvite, pkceVerifier } from "../../lib/session";

/**
 * `/signin/callback`: magic link (`#token_hash=…&type=email`, web fallback) or OAuth return
 * (`?code=…`, PKCE). The secret is read once, scrubbed from the address bar, and exchanged
 * through the API, which sets the httpOnly session cookies.
 */
export function CallbackPage() {
  const navigate = useNavigate();
  const { refetchMe } = useAuth();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    const tokenHash = hash.get("token_hash");
    const oauthCode = query.get("code");
    // Remove the single-use secret from history immediately.
    window.history.replaceState(null, "", window.location.pathname);

    let exchange: Promise<unknown>;
    if (tokenHash && (hash.get("type") ?? "email") === "email") {
      exchange = verifyTokenHash(tokenHash);
    } else if (oauthCode) {
      const verifier = pkceVerifier.get();
      pkceVerifier.clear();
      exchange = verifier
        ? exchangePkce(oauthCode, verifier)
        : Promise.reject(new Error("no verifier"));
    } else {
      exchange = Promise.reject(new Error("no credentials"));
    }

    exchange
      .then(() => {
        // A magic-link / OAuth sign-in may show the one-time "Add a passkey" card.
        offerPasskeyPrompt();
        return refetchMe();
      })
      .then((me) => navigate(nextOnboardingRoute(me, pendingInvite.get()), { replace: true }))
      .catch(() => setFailed(true));
  }, [navigate, refetchMe]);

  return (
    <FlowPage title={t("app.name")} testId="callback">
      {failed ? (
        <>
          <Message data-testid="callback-error">{t("callback.failed")}</Message>
          <Button onClick={() => navigate("/welcome", { replace: true })}>
            {t("callback.back")}
          </Button>
        </>
      ) : (
        <Message kind="info">{t("callback.working")}</Message>
      )}
    </FlowPage>
  );
}
