import { PHOTO_DETAILS_LIMITS, type Photo, type PhotoDetailsPatch } from "@littlelight/shared";
import { useRef, useState } from "react";
import { t } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { hapticSuccess } from "../../lib/haptics";
import { useCreateMilestone, useMilestones } from "../../lib/queries/milestones";
import { Button, Message, TextAreaField, TextField } from "../ui";
import { MilestoneSelect } from "./MilestoneSelect";
import { addPeople, PeopleInput } from "./PeopleInput";

const NEW = "__new__";

/**
 * Edit milestone (presets + custom, admins can add one inline), people chips, location and note.
 * `onSubmit` performs the (optimistic) save; the form closes when it resolves.
 */
export function DetailsForm({
  photo,
  babyId,
  isAdmin,
  onSubmit,
  onCancel,
  onAddMeasurement,
  initialMilestoneId,
}: {
  photo: Photo;
  babyId: string;
  isAdmin: boolean;
  onSubmit: (patch: PhotoDetailsPatch) => Promise<void>;
  onCancel: () => void;
  onAddMeasurement?: () => void;
  /** Preselected milestone (an AI suggestion the parent chose to tag); unsaved until Save. */
  initialMilestoneId?: string | null;
}) {
  const milestones = useMilestones(babyId);
  const createMilestone = useCreateMilestone(babyId);
  const [milestoneId, setMilestoneId] = useState(
    initialMilestoneId ?? photo.details?.milestoneId ?? "",
  );
  const [custom, setCustom] = useState("");
  const [people, setPeople] = useState<string[]>(photo.details?.people ?? []);
  const draft = useRef("");
  const [location, setLocation] = useState(photo.details?.locationLabel ?? "");
  const [note, setNote] = useState(photo.details?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addingNew = milestoneId === NEW;

  async function addCustomMilestone() {
    const name = custom.trim();
    if (!name) return;
    setError(null);
    try {
      const m = await createMilestone.mutateAsync({ name, category: "custom" });
      setMilestoneId(m.id);
      setCustom("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function save() {
    if (addingNew) {
      setError(t("details.newMilestonePlaceholder"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        milestoneId: milestoneId || null,
        people: addPeople(people, draft.current),
        locationLabel: location.trim() || null,
        note: note.trim() || null,
      });
      if (milestoneId) hapticSuccess(); // a milestone was saved on this photo (app only)
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <form
      data-testid="details-form"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="details-milestone" className="ll-label">
          {t("details.milestone")}
        </label>
        <MilestoneSelect
          id="details-milestone"
          testId="details-milestone"
          value={milestoneId}
          milestones={milestones.data ?? []}
          onChange={setMilestoneId}
          noneLabel={t("details.none")}
          extra={isAdmin ? { value: NEW, label: t("details.newMilestone") } : undefined}
        />
        {addingNew ? (
          <div className="mt-1 flex items-end gap-2">
            <TextField
              label={t("details.newMilestonePlaceholder")}
              data-testid="details-milestone-custom"
              value={custom}
              maxLength={80}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addCustomMilestone();
                }
              }}
            />
            <Button
              variant="secondary"
              data-testid="details-milestone-add"
              disabled={!custom.trim() || createMilestone.isPending}
              onClick={() => void addCustomMilestone()}
            >
              {t("details.newMilestoneAdd")}
            </Button>
          </div>
        ) : null}
      </div>

      <PeopleInput
        value={people}
        onChange={setPeople}
        draftRef={draft}
        inputTestId="details-people-input"
        chipTestIdPrefix="details-person-chip"
        label={t("details.peopleLabel")}
      />

      <TextField
        label={t("details.locationLabel")}
        data-testid="details-location"
        value={location}
        maxLength={PHOTO_DETAILS_LIMITS.locationLabel}
        onChange={(e) => setLocation(e.target.value)}
      />

      <TextAreaField
        id="details-note"
        label={t("details.noteLabel")}
        data-testid="details-note"
        rows={4}
        maxLength={PHOTO_DETAILS_LIMITS.note}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        counter={t("details.noteCounter", { n: note.length, max: PHOTO_DETAILS_LIMITS.note })}
      />

      {isAdmin && onAddMeasurement ? (
        <Button
          variant="secondary"
          data-testid="details-add-measurement"
          onClick={onAddMeasurement}
        >
          {t("details.addMeasurement")}
        </Button>
      ) : null}

      {error ? <Message>{error || t("details.saveError")}</Message> : null}

      <div className="flex gap-2">
        <Button type="submit" className="flex-1" data-testid="details-save" disabled={busy}>
          {t("details.save")}
        </Button>
        <Button variant="secondary" data-testid="details-cancel" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
