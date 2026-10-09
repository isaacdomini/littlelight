import { IonModal } from "@ionic/react";
import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { hapticSuccess } from "../../lib/haptics";
import { isNative } from "../../platform/platform";
import { Button } from "../ui";
import { copyText } from "./format";

/**
 * The share URL, shown once (D1). The URL lives in component state only: not in storage, not in
 * query data, not in logs. Closing the sheet drops it.
 */
export function ShareUrlBody({ url, onDone }: { url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const native = isNative();
  const canShare =
    native || (typeof navigator !== "undefined" && typeof navigator.share === "function");

  // A link was just created: a light confirmation tap in the app.
  useEffect(() => {
    if (native) hapticSuccess();
  }, [native]);

  async function copy() {
    setCopied(await copyText(url));
  }
  async function share() {
    if (native) {
      // The iOS/Android share sheet; the URL is handed to the OS and never logged or stored.
      const { shareLink } = await import("../../platform/native/share");
      await shareLink({ url, title: t("share.url.shareTitle") }); // dismissing is not an error
      return;
    }
    try {
      await navigator.share({ title: t("share.url.shareTitle"), url });
    } catch (e) {
      // Cancelling the native sheet is not an error; anything else falls back to copying.
      if (!(e instanceof DOMException && e.name === "AbortError")) await copy();
    }
  }

  return (
    <div
      className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      data-testid="share-url"
    >
      <h2 className="text-xl font-semibold">{t("share.url.title")}</h2>
      <input
        readOnly
        aria-label={t("share.url.title")}
        data-testid="share-url-value"
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="text-sm"
      />
      <div className="flex flex-wrap gap-3">
        <Button className="flex-1" data-testid="share-copy" onClick={() => void copy()}>
          {copied ? t("share.url.copied") : t("share.url.copy")}
        </Button>
        {canShare ? (
          <Button
            variant="secondary"
            className="flex-1"
            data-testid="share-native"
            onClick={() => void share()}
          >
            {t("share.url.share")}
          </Button>
        ) : null}
      </div>
      <p aria-live="polite" className="sr-only">
        {copied ? t("share.url.copied") : ""}
      </p>
      <p className="ll-callout" data-testid="share-url-once">
        {t("share.url.once")}
      </p>
      <Button variant="link" data-testid="share-url-done" onClick={onDone}>
        {t("share.url.done")}
      </Button>
    </div>
  );
}

export function ShareUrlSheet({
  url,
  onClose,
}: {
  /** `null` = closed. */
  url: string | null;
  onClose: () => void;
}) {
  return (
    <IonModal isOpen={url !== null} onDidDismiss={onClose} className="ll-sheet">
      {url ? <ShareUrlBody url={url} onDone={onClose} /> : null}
    </IonModal>
  );
}
