import { t } from "../../i18n";
import { FlowPage } from "../Page";
import { NativeDone } from "./NativeDone";

/**
 * Friendly end of the line for an unknown, expired, revoked or regenerated link (410). Says
 * nothing about the baby or the album, and offers no retry: the parents have to send a new link.
 */
export function ShareExpired() {
  return (
    <FlowPage
      title={t("shareViewer.expiredTitle")}
      subtitle={t("shareViewer.expiredBody")}
      testId="share-expired"
      brand
    >
      <NativeDone variant="secondary" />
    </FlowPage>
  );
}
