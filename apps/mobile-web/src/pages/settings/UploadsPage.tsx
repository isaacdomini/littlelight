import { useSyncExternalStore } from "react";
import { SubPage } from "../../components/Page";
import { Card, CheckField } from "../../components/ui";
import { t } from "../../i18n";
import {
  cellularForLargeVideos,
  setCellularForLargeVideos,
  subscribeUploadPrefs,
} from "../../lib/upload/prefs";

/**
 * Settings -> Uploads (native): the persisted "Use cellular for large videos" preference that
 * seeds each new large video's per-item switch (docs/plans/step-12.md Q6). Default off.
 */
export function UploadsPage() {
  const cellular = useSyncExternalStore(subscribeUploadPrefs, cellularForLargeVideos);
  return (
    <SubPage title={t("uploads.settings.title")} backHref="/settings">
      <div className="flex flex-col gap-4" data-testid="uploads-settings">
        <p className="text-muted">{t("uploads.settings.intro")}</p>
        <Card className="flex flex-col gap-1">
          <CheckField
            data-testid="uploads-cellular"
            label={t("uploads.settings.cellular")}
            checked={cellular}
            onChange={(e) => setCellularForLargeVideos(e.target.checked)}
          />
          <p className="ll-hint pl-9">{t("uploads.settings.cellularHint")}</p>
        </Card>
      </div>
    </SubPage>
  );
}
