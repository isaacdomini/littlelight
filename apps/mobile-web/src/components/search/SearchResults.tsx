import { IonSpinner } from "@ionic/react";
import type { BabySummary, PhotoSummary, SearchResponse } from "@littlelight/shared";
import { t, tn } from "../../i18n";
import { Thumb } from "../timeline/Thumb";
import { Message } from "../ui";

const noop = () => {};

/** Results grid for an active search or filter; thumbs open the viewer. Not virtualized (<= 50). */
export function SearchResults({
  data,
  loading,
  error,
  baby,
  timeZone,
  onOpen,
}: {
  data: SearchResponse | undefined;
  loading: boolean;
  error: boolean;
  baby: Pick<BabySummary, "name" | "nickname"> | null;
  timeZone: string;
  onOpen: (photo: PhotoSummary) => void;
}) {
  const photos = data?.photos ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" data-testid="search-results">
      {error ? <Message>{t("search.error")}</Message> : null}
      {loading && !data ? (
        <div className="flex justify-center p-6" role="status">
          <IonSpinner aria-label={t("common.loading")} />
        </div>
      ) : null}
      {data ? (
        <>
          <p className="py-1 text-sm opacity-80" data-testid="search-count" aria-live="polite">
            {tn("search.results", photos.length)}
          </p>
          {data.degraded ? (
            <p className="pb-2 text-sm opacity-80" data-testid="search-degraded">
              {t("search.degraded")}
            </p>
          ) : null}
          {photos.length === 0 ? (
            <p className="opacity-70" data-testid="search-empty">
              {t("search.none")}
            </p>
          ) : (
            <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4 lg:grid-cols-5">
              {photos.map((p) => (
                <li key={p.id} className="min-w-0">
                  <Thumb
                    photo={p}
                    baby={baby}
                    milestoneName={null}
                    timeZone={timeZone}
                    selectMode={false}
                    selected={false}
                    pendingActions={false}
                    busy={false}
                    onOpen={onOpen}
                    onToggle={noop}
                    onApprove={noop}
                    onReject={noop}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
