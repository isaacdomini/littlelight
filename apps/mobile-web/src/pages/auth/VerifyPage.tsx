import { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { ActiveNavigate } from "../../auth/guards";
import { nextOnboardingRoute } from "../../auth/onboarding";
import { CodeEntry } from "../../components/CodeEntry";
import { FlowPage } from "../../components/Page";
import { Button, Message } from "../../components/ui";
import { t } from "../../i18n";
import { offerPasskeyPrompt } from "../../lib/passkeyPrompt";
import { pendingEmail, pendingInvite } from "../../lib/session";

/**
 * Code entry. `?reauth=1&next=/path` re-verifies the signed-in user (fresh sign-in for
 * destructive actions); otherwise it continues the sign-in started on /welcome.
 */
export function VerifyPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { me, refetchMe } = useAuth();
  const reauth = params.get("reauth") === "1";
  const rawNext = params.get("next");
  // Only same-app absolute paths; never an open redirect.
  const next = rawNext?.startsWith("/") && !rawNext.startsWith("//") ? rawNext : null;
  const email = reauth ? (me?.user.email ?? null) : pendingEmail.get();

  const onVerified = useCallback(async () => {
    const fresh = await refetchMe();
    pendingEmail.clear();
    // A sign-in by email code (not a re-verification) may show the one-time "Add a passkey" card.
    if (!reauth) offerPasskeyPrompt();
    navigate(next ?? nextOnboardingRoute(fresh, pendingInvite.get()), { replace: true });
  }, [refetchMe, navigate, next, reauth]);

  if (!email) return <ActiveNavigate path="/verify" to={reauth ? "/settings" : "/welcome"} />;

  return (
    <FlowPage
      title={reauth ? t("verify.reauthTitle") : t("verify.title")}
      subtitle={reauth ? t("verify.reauthBody", { email }) : undefined}
      testId="verify"
    >
      {reauth ? null : <Message kind="info">{t("verify.sent", { email })}</Message>}
      <CodeEntry email={email} sendOnMount={reauth} onVerified={onVerified} />
      <Button
        variant="link"
        onClick={() => {
          pendingEmail.clear();
          navigate(reauth && next ? next : "/welcome", { replace: true });
        }}
      >
        {reauth ? t("common.cancel") : t("verify.wrongEmail")}
      </Button>
    </FlowPage>
  );
}
