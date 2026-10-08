import { type MeResponse, meResponseSchema } from "@littlelight/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ME_KEY, useAuth } from "../../auth/AuthProvider";
import { nextOnboardingRoute } from "../../auth/onboarding";
import { FlowPage } from "../../components/Page";
import { Button, CheckField, Message } from "../../components/ui";
import { t } from "../../i18n";
import { apiFetch, errorMessage, isApiError } from "../../lib/api";
import { pendingInvite } from "../../lib/session";

export function ConsentPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me, refetchMe } = useAuth();
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!adult || !me) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await apiFetch<MeResponse>("/me/consent", {
        method: "POST",
        // `isAdult: false` is never sent: an unchecked box cannot submit.
        body: {
          termsVersion: me.consent.requiredTermsVersion,
          privacyVersion: me.consent.requiredPrivacyVersion,
          isAdult: true,
        },
        schema: meResponseSchema,
      });
      qc.setQueryData(ME_KEY, updated);
      navigate(nextOnboardingRoute(updated, pendingInvite.get()), { replace: true });
    } catch (err) {
      if (isApiError(err, "under_18")) setError(t("consent.under18"));
      else {
        if (isApiError(err, "consent_version_outdated")) await refetchMe();
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <FlowPage title={t("consent.title")} subtitle={t("consent.body")} testId="consent">
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
        <CheckField
          data-testid="consent-adult"
          checked={adult}
          onChange={(e) => setAdult(e.target.checked)}
          label={
            <>
              {t("consent.checkbox.prefix")}
              <Link to="/legal/terms" className="underline">
                {t("consent.checkbox.terms")}
              </Link>
              {t("consent.checkbox.and")}
              <Link to="/legal/privacy" className="underline">
                {t("consent.checkbox.privacy")}
              </Link>
            </>
          }
        />
        {error ? <Message data-testid="consent-error">{error}</Message> : null}
        <Button type="submit" data-testid="consent-continue" disabled={!adult || busy}>
          {t("consent.continue")}
        </Button>
      </form>
    </FlowPage>
  );
}
