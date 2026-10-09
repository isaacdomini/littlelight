import type { Milestone } from "@littlelight/shared";
import { useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { t, tn } from "../../i18n";
import { ageText } from "../../lib/age";
import { useProfileTimeZone } from "../../lib/units";
import { ageDaysIn } from "../growth/growthData";
import { PhotoImage } from "../PhotoImage";
import { MilestoneAdminControls } from "./MilestoneAdminControls";

function formatDate(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(iso));
  }
}

/** One recorded milestone: cover photo, name, first date and age, photo count; opens the timeline. */
export function MilestoneCard({ milestone, isAdmin }: { milestone: Milestone; isAdmin: boolean }) {
  const navigate = useNavigate();
  const { baby } = useCurrentBaby();
  const tz = useProfileTimeZone();
  const cover = milestone.coverPhoto;
  const when =
    milestone.firstTakenAt && baby
      ? t("milestones.firstOn", {
          date: formatDate(milestone.firstTakenAt, tz),
          age: ageText(ageDaysIn(baby.birthDate, new Date(milestone.firstTakenAt), tz)),
        })
      : null;
  return (
    <li
      data-testid={`milestone-card-${milestone.id}`}
      className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface"
    >
      <button
        type="button"
        data-testid={`milestone-open-${milestone.id}`}
        aria-label={t("milestones.openInTimeline", { name: milestone.name })}
        onClick={() => navigate(`/timeline?milestone=${milestone.id}`)}
        className="flex min-h-11 w-full flex-col text-left"
      >
        <div className="aspect-square w-full bg-fill">
          {cover ? (
            <PhotoImage photo={cover} baby={baby} milestoneName={milestone.name} timeZone={tz} />
          ) : null}
        </div>
        <div className="flex flex-col gap-0.5 p-3">
          <span className="font-semibold">{milestone.name}</span>
          {when ? <span className="text-sm text-muted">{when}</span> : null}
          <span className="text-sm text-muted">
            {tn("milestones.photoCount", milestone.photoCount)}
          </span>
        </div>
      </button>
      {isAdmin && !milestone.isPreset ? (
        <div className="border-t border-line p-2">
          <MilestoneAdminControls milestone={milestone} />
        </div>
      ) : null}
    </li>
  );
}
