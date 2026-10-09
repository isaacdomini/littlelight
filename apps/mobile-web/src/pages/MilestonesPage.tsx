import { IonContent, IonPage } from "@ionic/react";
import { flagOutline } from "ionicons/icons";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../auth/AuthProvider";
import { AppHeader } from "../components/AppHeader";
import { GrowthChart } from "../components/growth/GrowthChart";
import { AddMilestone } from "../components/milestones/AddMilestone";
import { MilestoneAdminControls } from "../components/milestones/MilestoneAdminControls";
import { MilestoneCard } from "../components/milestones/MilestoneCard";
import { Button, EmptyState, Message, Segmented, Skeleton, SkeletonRegion } from "../components/ui";
import { t } from "../i18n";
import { useMilestones } from "../lib/queries/milestones";

type Segment = "milestones" | "growth";

function MilestonesView({ babyId, isAdmin }: { babyId: string; isAdmin: boolean }) {
  const query = useMilestones(babyId);
  const navigate = useNavigate();
  if (query.isError)
    return <Message data-testid="milestones-error">{t("milestones.loadError")}</Message>;
  if (query.isLoading) {
    return (
      <SkeletonRegion className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <Skeleton key={i} className="aspect-[4/5] !rounded-xl" />
        ))}
      </SkeletonRegion>
    );
  }
  const all = query.data ?? [];
  const recorded = all.filter((m) => m.photoCount > 0);
  const upcoming = all.filter((m) => m.photoCount === 0);
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">{t("milestones.recorded")}</h2>
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
          <EmptyState
            icon={flagOutline}
            data-testid="milestones-recorded-empty"
            className="ll-card"
            action={
              <Button variant="secondary" onClick={() => navigate("/timeline")}>
                {t("tabs.timeline")}
              </Button>
            }
          >
            {t("milestones.recordedEmpty")}
          </EmptyState>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold">{t("milestones.upcoming")}</h2>
          <p className="text-sm text-muted">{t("milestones.upcomingHint")}</p>
        </div>
        <ul data-testid="milestones-upcoming" className="ll-list">
          {upcoming.map((m) => (
            <li
              key={m.id}
              data-testid={`milestone-upcoming-${m.id}`}
              className="flex flex-col justify-center gap-2"
            >
              <span className="font-semibold">{m.name}</span>
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
          className="mx-auto flex w-full max-w-4xl flex-col gap-6"
          data-testid="milestones-page"
        >
          <Segmented label={t("milestones.title")}>
            {(["milestones", "growth"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={segment === s}
                data-testid={`milestones-segment-${s}`}
                onClick={() => setSegment(s)}
              >
                {s === "milestones"
                  ? t("milestones.segmentMilestones")
                  : t("milestones.segmentGrowth")}
              </button>
            ))}
          </Segmented>
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
