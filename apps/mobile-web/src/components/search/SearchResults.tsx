import type { BabySummary, PhotoSummary, SearchResponse } from "@tinyglow/shared";
import { searchOutline } from "ionicons/icons";
import { t, tn } from "../../i18n";
import { Thumb } from "../timeline/Thumb";
import { EmptyState, GridSkeleton, Message } from "../ui";

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
    <div className="min-h-0 flex-1 overflow-y-auto pb-3" data-testid="search-results">
      {error ? (
        <div className="px-4">
          <Message>{t("search.error")}</Message>
        </div>
      ) : null}
      {loading && !data ? <GridSkeleton count={9} /> : null}
      {data ? (
        <>
          <p className="px-4 py-2 text-sm text-muted" data-testid="search-count" aria-live="polite">
            {tn("search.results", photos.length)}
          </p>
          {data.degraded ? (
            <p className="px-4 pb-2 text-sm text-muted" data-testid="search-degraded">
              {t("search.degraded")}
            </p>
          ) : null}
          {photos.length === 0 ? (
            <EmptyState icon={searchOutline} data-testid="search-empty">
              {t("search.none")}
            </EmptyState>
          ) : (
            <ul className="grid grid-cols-3 gap-0.5 sm:grid-cols-4 lg:grid-cols-5">
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
