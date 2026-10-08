import type { Milestone, Photo } from "@littlelight/shared";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { t } from "../../i18n";
import { ageText } from "../../lib/age";
import { measurementText, useProfileTimeZone, useProfileUnits } from "../../lib/units";

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <dt className="text-xs font-medium uppercase tracking-wide opacity-60">{label}</dt>
      <dd className="text-base">{children}</dd>
    </div>
  );
}

function formatTaken(iso: string | null, timeZone: string, estimated: boolean): string {
  if (!iso) return t("details.empty");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t("details.empty");
  let text: string;
  try {
    text = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(d);
  } catch {
    text = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(d);
  }
  return estimated ? `${text} (${t("details.dateEstimated").toLowerCase()})` : text;
}

/** Read-only details: caption slot, age, date, place, camera and the parent's details. */
export function DetailsPanel({
  photo,
  milestones,
  isAdmin,
  paid,
}: {
  photo: Photo;
  milestones: readonly Milestone[];
  isAdmin: boolean;
  paid: boolean;
}) {
  const units = useProfileUnits();
  const timeZone = useProfileTimeZone();
  const d = photo.details;
  const milestone = d?.milestoneId ? milestones.find((m) => m.id === d.milestoneId) : null;
  const camera = [photo.exif?.cameraMake, photo.exif?.cameraModel].filter(Boolean).join(" ");
  const place = isAdmin ? photo.exif?.placeLabel : null;

  return (
    <dl data-testid="viewer-details" className="flex flex-col gap-3">
      <Row label={t("details.caption")} testId="details-caption">
        {photo.caption ? (
          <span>{photo.caption}</span>
        ) : paid ? (
          <span className="opacity-70">{t("details.captionPending")}</span>
        ) : (
          <Link to="/settings" className="underline">
            {t("details.captionUpgrade")}
          </Link>
        )}
      </Row>
      <Row label={t("details.age")} testId="details-age">
        {ageText(photo.ageDays)}
      </Row>
      <Row label={t("details.date")} testId="details-date">
        {formatTaken(photo.takenAt, timeZone, photo.takenAtEstimated)}
      </Row>
      {place ? <Row label={t("details.place")}>{place}</Row> : null}
      {camera ? <Row label={t("details.camera")}>{camera}</Row> : null}
      <Row label={t("details.milestone")} testId="details-milestone-value">
        {milestone ? milestone.name : <span className="opacity-60">{t("details.empty")}</span>}
      </Row>
      <Row label={t("details.people")} testId="details-people-value">
        {d && d.people.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {d.people.map((name) => (
              <li key={name} className="rounded-full border border-gray-500/50 px-3 py-0.5 text-sm">
                {name}
              </li>
            ))}
          </ul>
        ) : (
          <span className="opacity-60">{t("details.empty")}</span>
        )}
      </Row>
      <Row label={t("details.location")} testId="details-location-value">
        {d?.locationLabel || <span className="opacity-60">{t("details.empty")}</span>}
      </Row>
      <Row label={t("details.note")} testId="details-note-value">
        {d?.note ? (
          <span className="whitespace-pre-wrap break-words">{d.note}</span>
        ) : (
          <span className="opacity-60">{t("details.empty")}</span>
        )}
      </Row>
      {photo.measurements.length > 0 ? (
        <Row label={t("details.measurements")} testId="details-measurements-value">
          <ul className="flex flex-col gap-1">
            {photo.measurements.map((m) => (
              <li key={m.id} data-testid={`details-measurement-${m.id}`}>
                {t(`growth.kind.${m.kind}`)}: {measurementText(m.kind, m.valueMetric, units)}
              </li>
            ))}
          </ul>
        </Row>
      ) : null}
    </dl>
  );
}
