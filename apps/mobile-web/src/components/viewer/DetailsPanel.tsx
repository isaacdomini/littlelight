import { IonIcon } from "@ionic/react";
import type { AiDescriptionV1, Milestone, Photo } from "@littlelight/shared";
import { eyeOffOutline } from "ionicons/icons";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { t } from "../../i18n";
import { ageText } from "../../lib/age";
import { FEATURES } from "../../lib/features";
import { measurementText, useProfileTimeZone, useProfileUnits } from "../../lib/units";
import { Button, Tag } from "../ui";

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <dt className="text-xs text-muted">{label}</dt>
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

function summaryLine(d: AiDescriptionV1): string {
  const parts = [
    ...d.activities,
    ...d.mood,
    d.setting.place_type,
    d.setting.indoor_outdoor === "unknown" ? null : d.setting.indoor_outdoor,
    d.setting.time_of_day,
  ].filter((x): x is string => !!x);
  return [...new Set(parts)].join(" · ");
}

function EditedMark({ show }: { show: boolean }) {
  return show ? (
    <span
      data-testid="details-ai-edited"
      className="ml-2 rounded-md bg-fill px-1.5 py-0.5 align-middle text-xs font-semibold text-muted"
    >
      {t("ai.edited")}
    </span>
  ) : null;
}

/** Finds the preset milestone a suggestion's name refers to (case-insensitive), else null. */
function presetFor(name: string, milestones: readonly Milestone[]): Milestone | null {
  const n = name.trim().toLowerCase();
  return milestones.find((m) => m.isPreset && m.name.trim().toLowerCase() === n) ?? null;
}

function AiSection({
  photo,
  milestones,
  paid,
  onEditAi,
  onRetry,
  retrying,
  retryError,
  onSuggestMilestone,
}: {
  photo: Photo;
  milestones: readonly Milestone[];
  paid: boolean;
  onEditAi?: () => void;
  onRetry?: () => void;
  retrying?: boolean;
  retryError?: boolean;
  onSuggestMilestone?: (milestoneId: string) => void;
}) {
  const ai = photo.ai;
  const d = ai.description;
  const edited = (f: "caption" | "detailed_description" | "search_tags") =>
    ai.overrides[f] !== undefined;
  let content: ReactNode;
  if (ai.status === "not_available") {
    content = paid ? (
      <span className="text-muted" data-testid="details-ai-unavailable">
        {t("details.captionPending")}
      </span>
    ) : (
      <span data-testid="details-ai-upgrade">
        <Link to="/settings" className="ll-link">
          {t("ai.upgrade")}
        </Link>
        <span className="mt-1 block text-sm text-muted">{t("ai.upgradeBody")}</span>
      </span>
    );
  } else if (ai.status === "pending") {
    content = (
      <span className="text-muted" data-testid="details-ai-pending">
        {t("ai.pending")}
      </span>
    );
  } else if (ai.status === "queued" || ai.status === "analyzing") {
    content = (
      <span className="flex items-center gap-2" role="status" data-testid="details-ai-analyzing">
        <span
          aria-hidden
          className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
        {t("ai.analyzing")}
      </span>
    );
  } else if (ai.status === "failed") {
    content = (
      <span className="flex flex-col items-start gap-2" data-testid="details-ai-failed">
        <span>{t("ai.failed")}</span>
        {ai.canRetry && onRetry ? (
          <Button
            variant="secondary"
            data-testid="details-ai-retry"
            disabled={retrying}
            onClick={onRetry}
          >
            {t("ai.retry")}
          </Button>
        ) : null}
        {retryError ? (
          <span role="alert" className="ll-msg-error">
            {t("ai.retryError")}
          </span>
        ) : null}
      </span>
    );
  } else if (!d) {
    content = (
      <span className="text-muted" data-testid="details-ai-reanalysing">
        {t("ai.reanalysing")}
      </span>
    );
  } else {
    const line = summaryLine(d);
    content = (
      <div className="flex flex-col gap-3">
        <p>
          <span data-testid="details-ai-caption-text">{d.caption}</span>
          <EditedMark show={edited("caption")} />
        </p>
        <p className="whitespace-pre-wrap break-words text-sm" data-testid="details-ai-description">
          {d.detailed_description}
          <EditedMark show={edited("detailed_description")} />
        </p>
        {line ? (
          <p className="text-sm text-muted" data-testid="details-ai-summary">
            {line}
          </p>
        ) : null}
        <div>
          <p className="sr-only">{t("ai.tagsList")}</p>
          <ul className="flex flex-wrap gap-2" data-testid="details-ai-tags">
            {d.search_tags.map((tag) => (
              <li key={tag}>
                <Tag>{tag}</Tag>
              </li>
            ))}
          </ul>
          <EditedMark show={edited("search_tags")} />
        </div>
        {d.possible_milestones.length > 0 ? (
          <ul className="flex flex-col gap-1" data-testid="details-ai-milestones">
            {d.possible_milestones.map((m, n) => {
              const preset = presetFor(m.name, milestones);
              const pct = Math.round(m.confidence * 100);
              return (
                <li key={m.name} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{t("ai.lookLike", { name: m.name, pct })}</span>
                  {photo.canEdit && preset && onSuggestMilestone ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      data-testid={`details-ai-milestone-suggest-${n}`}
                      aria-label={t("ai.tagItLabel", { name: preset.name })}
                      onClick={() => onSuggestMilestone(preset.id)}
                    >
                      {t("ai.tagIt")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {FEATURES.aiEdits && photo.canEdit && onEditAi ? (
          <Button
            variant="secondary"
            className="self-start"
            data-testid="details-ai-edit"
            onClick={onEditAi}
          >
            {t("ai.edit")}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="ll-card flex flex-col gap-2 !p-3" data-testid="details-ai">
      {photo.isSensitive ? (
        <span
          data-testid="details-sensitive-badge"
          className="inline-flex items-center gap-1.5 self-start rounded-full bg-fill px-3 py-1 text-sm text-fg"
        >
          <IonIcon icon={eyeOffOutline} aria-hidden className="h-4 w-4" />
          {t("ai.sensitiveBadge")}
        </span>
      ) : null}
      <span data-testid="details-caption">{content}</span>
    </div>
  );
}

/** Read-only details: caption slot, age, date, place, camera and the parent's details. */
export function DetailsPanel({
  photo,
  milestones,
  isAdmin,
  paid,
  onEditAi,
  onRetry,
  retrying,
  retryError,
  onSuggestMilestone,
}: {
  photo: Photo;
  milestones: readonly Milestone[];
  isAdmin: boolean;
  paid: boolean;
  onEditAi?: () => void;
  onRetry?: () => void;
  retrying?: boolean;
  retryError?: boolean;
  /** Opens the details form with this preset milestone preselected; nothing is saved yet. */
  onSuggestMilestone?: (milestoneId: string) => void;
}) {
  const units = useProfileUnits();
  const timeZone = useProfileTimeZone();
  const d = photo.details;
  const milestone = d?.milestoneId ? milestones.find((m) => m.id === d.milestoneId) : null;
  const camera = [photo.exif?.cameraMake, photo.exif?.cameraModel].filter(Boolean).join(" ");
  const place = isAdmin ? photo.exif?.placeLabel : null;

  return (
    <dl data-testid="viewer-details" className="flex flex-col gap-4">
      <Row label={t("ai.sectionTitle")}>
        <AiSection
          photo={photo}
          milestones={milestones}
          paid={paid}
          onEditAi={onEditAi}
          onRetry={onRetry}
          retrying={retrying}
          retryError={retryError}
          onSuggestMilestone={onSuggestMilestone}
        />
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
        {milestone ? milestone.name : <span className="text-muted">{t("details.empty")}</span>}
      </Row>
      <Row label={t("details.people")} testId="details-people-value">
        {d && d.people.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {d.people.map((name) => (
              <li key={name}>
                <Tag>{name}</Tag>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-muted">{t("details.empty")}</span>
        )}
      </Row>
      <Row label={t("details.location")} testId="details-location-value">
        {d?.locationLabel || <span className="text-muted">{t("details.empty")}</span>}
      </Row>
      <Row label={t("details.note")} testId="details-note-value">
        {d?.note ? (
          <span className="whitespace-pre-wrap break-words">{d.note}</span>
        ) : (
          <span className="text-muted">{t("details.empty")}</span>
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
