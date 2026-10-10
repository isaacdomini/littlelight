import { emailSchema, inviteSchema } from "@tinyglow/shared";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { FlowPage } from "../../components/Page";
import { Button, Message, TextField } from "../../components/ui";
import { t } from "../../i18n";
import { apiFetch, errorMessage } from "../../lib/api";

export function InviteCoParentPage() {
  const navigate = useNavigate();
  const { baby } = useCurrentBaby();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setError(t("invite.invalidEmail"));
      return;
    }
    if (!baby) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/babies/${baby.id}/invites`, {
        method: "POST",
        body: { email: parsed.data, role: "admin" },
        schema: inviteSchema,
      });
      setSentTo(parsed.data);
      setEmail("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FlowPage
      title={t("invite.coParentTitle")}
      subtitle={t("invite.coParentBody")}
      testId="onboarding-invite"
    >
      {sentTo ? (
        <>
          <Message kind="info" data-testid="invite-sent">
            {t("invite.sent", { email: sentTo })}
          </Message>
          <Button
            data-testid="invite-next"
            onClick={() => navigate("/onboarding/plan", { replace: true })}
          >
            {t("common.continue")}
          </Button>
        </>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
          <TextField
            data-testid="invite-email"
            label={t("invite.emailLabel")}
            type="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {error ? <Message data-testid="invite-error">{error}</Message> : null}
          <Button
            type="submit"
            data-testid="invite-send"
            disabled={busy || email.trim() === "" || !baby}
          >
            {t("invite.send")}
          </Button>
          <Button
            variant="link"
            data-testid="invite-skip"
            onClick={() => navigate("/onboarding/plan", { replace: true })}
          >
            {t("common.skip")}
          </Button>
        </form>
      )}
    </FlowPage>
  );
}
