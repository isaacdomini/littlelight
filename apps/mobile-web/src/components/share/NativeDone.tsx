import { t } from "../../i18n";
import { clearViewerSession } from "../../lib/shareApi";
import { isNative } from "../../platform/platform";
import { Button } from "../ui";

/**
 * Leaves the family album and returns to the parent app. The viewer has no router (the page is
 * picked from the URL at load), so this is a full navigation to `/`. Native only; on the web the
 * browser's own back/close does the job.
 */
export function NativeDone({ variant = "link" }: { variant?: "link" | "secondary" | "primary" }) {
  if (!isNative()) return null;
  return (
    <Button
      variant={variant}
      data-testid="share-done"
      onClick={() => {
        clearViewerSession();
        window.location.assign("/");
      }}
    >
      {t("native.share.done")}
    </Button>
  );
}
