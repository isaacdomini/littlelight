import { IonIcon } from "@ionic/react";
import { closeOutline, shareOutline } from "ionicons/icons";
import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { Button } from "../ui";

const DISMISSED = "ll_share_install_dismissed";

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
}

const standalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const isIosSafari = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === "1";
  } catch {
    return false;
  }
}

/**
 * "Add this album to your home screen" (D11). Chrome/Android: the real install prompt. iOS Safari:
 * a short instruction. Dismissal is remembered as a boolean flag only (never the link).
 */
export function InstallPrompt() {
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [ios] = useState(isIosSafari);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setEvent(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", on);
    return () => window.removeEventListener("beforeinstallprompt", on);
  }, []);

  if (dismissed || standalone() || (!event && !ios)) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {
      /* private mode: just hide for this visit */
    }
    setDismissed(true);
  };

  return (
    <div className="ll-callout flex flex-col gap-2" data-testid="share-install">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1">{t("shareViewer.install")}</p>
        {event ? (
          <Button
            size="sm"
            data-testid="share-install-button"
            onClick={() => void event.prompt().finally(() => setEvent(null))}
          >
            {t("shareViewer.installAction")}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            data-testid="share-install-how"
            aria-expanded={help}
            onClick={() => setHelp((v) => !v)}
          >
            {t("shareViewer.installHow")}
          </Button>
        )}
        <button
          type="button"
          aria-label={t("shareViewer.installDismiss")}
          data-testid="share-install-dismiss"
          onClick={dismiss}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted"
        >
          <IonIcon icon={closeOutline} aria-hidden className="h-5 w-5" />
        </button>
      </div>
      {help ? (
        <p className="text-sm text-muted" data-testid="share-install-steps">
          {t("shareViewer.installStepsA")}{" "}
          <IonIcon icon={shareOutline} aria-hidden className="inline h-4 w-4 align-text-bottom" />{" "}
          {t("shareViewer.installStepsB")}
        </p>
      ) : null}
    </div>
  );
}
