import { IonIcon, IonModal } from "@ionic/react";
import { keyOutline } from "ionicons/icons";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { onboardingGate } from "../auth/onboarding";
import { t } from "../i18n";
import {
  clearPasskeyPromptOffer,
  dismissPasskeyPromptForever,
  passkeyPromptOffered,
  passkeyPromptSnoozed,
  snoozePasskeyPrompt,
} from "../lib/passkeyPrompt";
import {
  registerPasskey,
  useInvalidatePasskeys,
  usePasskeySupport,
  usePasskeys,
} from "../lib/passkeys";
import { pendingInvite } from "../lib/session";
import { isPasskeyError } from "../platform/passkeys";
import { passkeyAddError } from "./passkeyErrors";
import { Button, Message } from "./ui";

const APP_ROUTES = ["/chat", "/timeline", "/upload", "/milestones", "/family", "/settings"];

/**
 * The one-time "Sign in faster next time" card (docs/plans/step-13.md Q2, 2.5), shown as a sheet
 * once the user lands in the app after an email-code sign-in, when passkeys are on and supported,
 * the account has none, and the card is not snoozed. "Not now" snoozes 30 days (re-offered at
 * most once); a successful add never shows it again. Renders nothing when the feature is off.
 */
export function PasskeyPrompt() {
  const { me } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const support = usePasskeySupport();
  const inApp = APP_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  const onboarded = !!me && onboardingGate(me, pendingInvite.get()) === null;
  const offered = passkeyPromptOffered();
  const eligible = support.enabled === true && onboarded && inApp && offered;
  const list = usePasskeys(eligible);
  const invalidate = useInvalidatePasskeys();
  const [snoozed, setSnoozed] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    void passkeyPromptSnoozed().then((s) => {
      if (!cancelled) setSnoozed(s);
    });
    return () => {
      cancelled = true;
    };
  }, [eligible]);

  useEffect(() => {
    if (eligible && snoozed === false && list.data && list.data.passkeys.length === 0) {
      setOpen(true);
    } else if (eligible && (snoozed === true || (list.data && list.data.passkeys.length > 0))) {
      // Nothing to offer this session.
      clearPasskeyPromptOffer();
    }
  }, [eligible, snoozed, list.data]);

  if (support.enabled !== true) return null;

  const close = () => {
    setOpen(false);
    clearPasskeyPromptOffer();
  };

  async function notNow() {
    close();
    await snoozePasskeyPrompt();
  }

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await registerPasskey();
      await dismissPasskeyPromptForever();
      await invalidate();
      setAdded(true);
    } catch (e) {
      if (isPasskeyError(e, "not_configured")) {
        // Not in this build: no message, the card simply goes away for this session.
        close();
        return;
      }
      setError(passkeyAddError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <IonModal
      isOpen={open}
      onDidDismiss={() => {
        if (open) void notNow();
      }}
      data-testid="passkey-prompt"
      className="ll-sheet"
    >
      <div className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <span
          aria-hidden
          className="flex h-12 w-12 items-center justify-center rounded-full bg-fill text-accent"
        >
          <IonIcon icon={keyOutline} className="h-6 w-6" />
        </span>
        {added ? (
          <>
            <h2 className="text-xl font-semibold">{t("passkey.prompt.title")}</h2>
            <Message kind="info" data-testid="passkey-prompt-added">
              {t("passkey.prompt.added")}
            </Message>
            <Button data-testid="passkey-prompt-done" onClick={close}>
              {t("common.continue")}
            </Button>
            <Button
              variant="link"
              onClick={() => {
                close();
                navigate("/settings/passkeys");
              }}
            >
              {t("passkey.settings.title")}
            </Button>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold">{t("passkey.prompt.title")}</h2>
            <p className="text-muted">{t("passkey.prompt.body")}</p>
            {error ? <Message data-testid="passkey-prompt-error">{error}</Message> : null}
            <Button data-testid="passkey-prompt-add" disabled={busy} onClick={() => void add()}>
              {t("passkey.prompt.add")}
            </Button>
            <Button
              variant="secondary"
              data-testid="passkey-prompt-later"
              disabled={busy}
              onClick={() => void notNow()}
            >
              {t("passkey.prompt.later")}
            </Button>
          </>
        )}
      </div>
    </IonModal>
  );
}
