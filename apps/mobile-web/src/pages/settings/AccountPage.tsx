import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ME_KEY, useAuth } from "../../auth/AuthProvider";
import { useFreshSignIn } from "../../auth/FreshSignInGate";
import { SubPage } from "../../components/Page";
import { Button, Card, CheckField, Message } from "../../components/ui";
import { t } from "../../i18n";
import { apiFetch, errorMessage, isApiError } from "../../lib/api";
import { DELETION_PREVIEW_KEY, useDeletionPreview } from "../../lib/queries";

export function AccountPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { clearSession } = useAuth();
  const withFresh = useFreshSignIn();
  const preview = useDeletionPreview();
  const [step, setStep] = useState<"preview" | "consequences">("preview");
  const [ack, setAck] = useState(false);
  const [confirmAlbum, setConfirmAlbum] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = preview.data;
  const blocked = (data?.blockingBabies.length ?? 0) > 0;

  async function deleteAlbum(id: string) {
    setBusy(true);
    setError(null);
    try {
      await withFresh(() => apiFetch(`/babies/${id}`, { method: "DELETE" }));
      setConfirmAlbum(null);
      await qc.invalidateQueries({ queryKey: ME_KEY });
      await qc.invalidateQueries({ queryKey: DELETION_PREVIEW_KEY });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    setBusy(true);
    setError(null);
    try {
      await withFresh(() => apiFetch("/me", { method: "DELETE", body: { acknowledge: true } }));
      clearSession();
      navigate("/welcome", { replace: true });
    } catch (e) {
      if (isApiError(e, "sole_admin")) {
        setStep("preview");
        await qc.invalidateQueries({ queryKey: DELETION_PREVIEW_KEY });
      }
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function onContinue() {
    if (data && !data.freshSignIn) {
      navigate(`/verify?reauth=1&next=${encodeURIComponent("/settings/account")}`);
    } else {
      setStep("consequences");
    }
  }

  return (
    <SubPage title={t("account.title")} backHref="/settings">
      <div data-testid="account" className="flex flex-col gap-4">
        {preview.isError ? <Message>{errorMessage(preview.error)}</Message> : null}
        {error ? <Message data-testid="account-error">{error}</Message> : null}

        {step === "preview" && data ? (
          <>
            <p>{t("account.deleteIntro")}</p>
            {data.blockingBabies.map((b) => (
              <Card key={b.id}>
                <p className="mb-2" data-testid="account-blocking">
                  {t("account.blocking", { baby: b.name })}
                </p>
                {confirmAlbum === b.id ? (
                  <div className="flex flex-col gap-2">
                    <p>{t("account.deleteAlbumConfirm", { baby: b.name })}</p>
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        data-testid="blocking-delete-confirm"
                        disabled={busy}
                        onClick={() => void deleteAlbum(b.id)}
                      >
                        {t("account.deleteAlbumYes")}
                      </Button>
                      <Button variant="secondary" onClick={() => setConfirmAlbum(null)}>
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      data-testid="blocking-delete-album"
                      onClick={() => setConfirmAlbum(b.id)}
                    >
                      {t("account.deleteAlbum")}
                    </Button>
                    <Button variant="secondary" onClick={() => navigate("/family")}>
                      {t("account.promote")}
                    </Button>
                  </div>
                )}
              </Card>
            ))}
            {data.babiesKept.map((b) => (
              <p key={b.id} className="opacity-80">
                {t("account.kept", { baby: b.name, other: b.otherAdminName })}
              </p>
            ))}
            <Button data-testid="account-continue" disabled={blocked || busy} onClick={onContinue}>
              {data.freshSignIn ? t("account.continue") : t("account.verify")}
            </Button>
          </>
        ) : null}

        {step === "consequences" ? (
          <>
            <h2 className="text-lg font-semibold">{t("account.consequencesTitle")}</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("account.consequence1")}</li>
              <li>{t("account.consequence2")}</li>
              <li>{t("account.consequence3")}</li>
              <li>{t("account.consequence4")}</li>
            </ul>
            <CheckField
              data-testid="account-ack"
              label={t("account.ack")}
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <Button
              variant="danger"
              data-testid="account-delete"
              disabled={!ack || busy}
              onClick={() => void deleteAccount()}
            >
              {t("account.confirmDelete")}
            </Button>
          </>
        ) : null}
      </div>
    </SubPage>
  );
}
