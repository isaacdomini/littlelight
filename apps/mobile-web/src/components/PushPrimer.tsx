import { useEffect, useState } from "react";
import { t } from "../i18n";
import { usePushKinds } from "../pages/settings/NotificationsPage";
import { isNative } from "../platform/platform";
import { Button, Card } from "./ui";

// One-time offer to turn on notifications, shown after the first completed upload in the app
// (docs/plans/step-9.md 2.8). Opt-in only: the OS prompt appears only when the user taps
// "Turn on notifications". The only thing remembered is that the offer was answered.
const ANSWERED_KEY = "ll_push_primer_answered";

function answered(): boolean {
  try {
    return window.localStorage.getItem(ANSWERED_KEY) === "1";
  } catch {
    return true; // storage unavailable: never nag
  }
}
function markAnswered() {
  try {
    window.localStorage.setItem(ANSWERED_KEY, "1");
  } catch {
    // ignore
  }
}

export function PushPrimer({ uploaded }: { uploaded: boolean }) {
  const kinds = usePushKinds();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const eligible = isNative() && uploaded && (kinds.shareViewed || kinds.photosAnalyzed);

  useEffect(() => {
    if (!eligible || answered()) return;
    let off = false;
    void import("../platform/native/push").then(async (m) => {
      const perm = await m.pushPermission();
      if (!off && perm === "prompt") setShow(true);
    });
    return () => {
      off = true;
    };
  }, [eligible]);

  if (!show) return null;
  async function enable() {
    setBusy(true);
    try {
      const { enablePush } = await import("../platform/native/push");
      await enablePush();
    } finally {
      markAnswered();
      setShow(false);
    }
  }
  return (
    <Card className="flex flex-col gap-3" data-testid="push-primer">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold">{t("push.primer.title")}</h2>
        <p className="text-sm text-muted">{t("push.primer.body")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy}
          data-testid="push-primer-enable"
          onClick={() => void enable()}
        >
          {t("push.primer.enable")}
        </Button>
        <Button
          size="sm"
          variant="link"
          data-testid="push-primer-later"
          onClick={() => {
            markAnswered();
            setShow(false);
          }}
        >
          {t("push.primer.later")}
        </Button>
      </div>
    </Card>
  );
}
