import { lazy, Suspense } from "react";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { GoogleCard } from "../../components/import/GoogleCard";
import { SubPage } from "../../components/Page";
import { Message, Skeleton, SkeletonRegion } from "../../components/ui";
import { t } from "../../i18n";
import { useGoogleConnection } from "../../lib/googleImport";
import { useAppleSyncAvailable } from "../../lib/queries/imports";
import { nativePlatform } from "../../platform/platform";

// Native code stays out of the web bundle: the card is its own lazy chunk.
const SyncCard = lazy(() =>
  import("../../components/import/SyncCard").then((m) => ({ default: m.SyncCard })),
);

/**
 * Settings -> Photo import: Google Photos import (everywhere the server offers it) and Apple Photos
 * album sync (iPhone, admins only). The Google section goes first except on the iPhone.
 */
export function ImportPage() {
  const { baby } = useCurrentBaby();
  const apple = useAppleSyncAvailable();
  const google = useGoogleConnection();
  const googleSection =
    google.data?.available === false ? null : (
      <section className="flex flex-col gap-3" data-testid="import-google">
        <GoogleCard returnTo="/settings/import" />
      </section>
    );
  const iphone = nativePlatform() === "ios";
  return (
    <SubPage title={t("import.title")} backHref="/settings">
      {iphone ? null : googleSection}
      <section className="flex flex-col gap-3" data-testid="import-apple">
        <h2 className="text-lg font-semibold">{t("import.apple.heading")}</h2>
        <p className="text-muted">{t("import.apple.intro")}</p>
        {apple ? (
          <Suspense
            fallback={
              <SkeletonRegion className="flex flex-col gap-3">
                <Skeleton className="h-32 w-full" />
              </SkeletonRegion>
            }
          >
            <SyncCard />
          </Suspense>
        ) : nativePlatform() !== "ios" ? (
          <Message kind="info">{t("import.apple.onlyIphone")}</Message>
        ) : baby ? (
          <Message kind="info">{t("import.apple.onlyAdmins")}</Message>
        ) : null}
      </section>
      {iphone ? googleSection : null}
    </SubPage>
  );
}
