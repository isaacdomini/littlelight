import { IonContent, IonPage } from "@ionic/react";
import { useState } from "react";
import { useCurrentBaby } from "../auth/AuthProvider";
import { AppHeader } from "../components/AppHeader";
import { GrowthChart } from "../components/growth/GrowthChart";
import { AddMilestone } from "../components/milestones/AddMilestone";
import { MilestoneAdminControls } from "../components/milestones/MilestoneAdminControls";
import { MilestoneCard } from "../components/milestones/MilestoneCard";
import { Message } from "../components/ui";
import { t } from "../i18n";
import { useMilestones } from "../lib/queries/milestones";

type Segment = "milestones" | "growth";

function MilestonesView({ babyId, isAdmin }: { babyId: string; isAdmin: boolean }) {
  const query = useMilestones(babyId);
  if (query.isError)
    return <Message data-testid="milestones-error">{t("milestones.loadError")}</Message>;
  if (query.isLoading) {
    return (
      <p role="status" className="opacity-70">
        {t("common.loading")}
      </p>
    );
  }
  const all = query.data ?? [];
  const recorded = all.filter((m) => m.photoCount > 0);
  const upcoming = all.filter((m) => m.photoCount === 0);
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">{t("milestones.recorded")}</h2>
        {recorded.length ? (
          <ul
            data-testid="milestones-recorded"
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
          >
            {recorded.map((m) => (
              <MilestoneCard key={m.id} milestone={m} isAdmin={isAdmin} />
            ))}
          </ul>
        ) : (
          <p data-testid="milestones-recorded-empty" className="opacity-80">
            {t("milestones.recordedEmpty")}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">{t("milestones.upcoming")}</h2>
        <ul data-testid="milestones-upcoming" className="flex flex-col divide-y divide-gray-500/20">
          {upcoming.map((m) => (
            <li
              key={m.id}
              data-testid={`milestone-upcoming-${m.id}`}
              className="flex flex-col gap-2 py-3"
            >
              <span className="font-medium">{m.name}</span>
              <span className="text-sm opacity-70">{t("milestones.upcomingHint")}</span>
              {isAdmin && !m.isPreset ? <MilestoneAdminControls milestone={m} /> : null}
            </li>
          ))}
        </ul>
      </section>

      {isAdmin ? <AddMilestone babyId={babyId} /> : null}
    </div>
  );
}

export function MilestonesPage() {
  const { baby } = useCurrentBaby();
  const [segment, setSegment] = useState<Segment>("milestones");
  const isAdmin = baby?.role === "admin";

  return (
    <IonPage>
      <AppHeader title={t("milestones.title")} />
      <IonContent className="ion-padding">
        <main
          className="mx-auto flex w-full max-w-4xl flex-col gap-5"
          data-testid="milestones-page"
        >
          <div role="tablist" aria-label={t("milestones.title")} className="flex gap-2">
            {(["milestones", "growth"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={segment === s}
                data-testid={`milestones-segment-${s}`}
                onClick={() => setSegment(s)}
                className={`min-h-11 flex-1 rounded-lg border px-3 text-base ${
                  segment === s
                    ? "border-transparent bg-[var(--ion-color-primary)] font-semibold text-[var(--ion-color-primary-contrast)]"
                    : "border-gray-500/50"
                }`}
              >
                {s === "milestones"
                  ? t("milestones.segmentMilestones")
                  : t("milestones.segmentGrowth")}
              </button>
            ))}
          </div>
          {baby ? (
            segment === "milestones" ? (
              <MilestonesView babyId={baby.id} isAdmin={isAdmin} />
            ) : (
              <GrowthChart />
            )
          ) : null}
        </main>
      </IonContent>
    </IonPage>
  );
}
