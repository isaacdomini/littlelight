import { IonModal } from "@ionic/react";
import type { PhotosBatchDetailsRequest } from "@littlelight/shared";
import { PHOTO_DETAILS_LIMITS } from "@littlelight/shared";
import { useRef, useState } from "react";
import { t } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { useMilestones } from "../../lib/queries/milestones";
import { Button, Message, TextAreaField, TextField } from "../ui";
import { MilestoneSelect } from "../viewer/MilestoneSelect";
import { addPeople, PeopleInput } from "../viewer/PeopleInput";

const KEEP = "__keep__";

/**
 * Batch details for the selection (FR-3.1): milestone (leave / none / one), people to add,
 * location and note (blank leaves them unchanged).
 */
export function BatchDetailsSheet({
  open,
  count,
  babyId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  babyId: string;
  onClose: () => void;
  onSubmit: (changes: Omit<PhotosBatchDetailsRequest, "photoIds">) => Promise<void>;
}) {
  return (
    <IonModal
      isOpen={open}
      onDidDismiss={onClose}
      data-testid="batch-details-sheet"
      aria-label={t("details.batchTitle", { n: count })}
      className="ll-sheet"
    >
      <BatchForm count={count} babyId={babyId} onClose={onClose} onSubmit={onSubmit} />
    </IonModal>
  );
}

function BatchForm({
  count,
  babyId,
  onClose,
  onSubmit,
}: {
  count: number;
  babyId: string;
  onClose: () => void;
  onSubmit: (changes: Omit<PhotosBatchDetailsRequest, "photoIds">) => Promise<void>;
}) {
  const milestones = useMilestones(babyId);
  const [milestone, setMilestone] = useState(KEEP);
  const [people, setPeople] = useState<string[]>([]);
  const draft = useRef("");
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const add = addPeople(people, draft.current);
    const changes: Omit<PhotosBatchDetailsRequest, "photoIds"> = {};
    if (milestone !== KEEP) changes.milestoneId = milestone || null;
    if (add.length > 0) changes.addPeople = add;
    if (location.trim()) changes.locationLabel = location.trim();
    if (note.trim()) changes.note = note.trim();
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(changes);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <form
      className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="text-xl font-semibold">{t("details.batchTitle", { n: count })}</h2>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="batch-milestone" className="ll-label">
          {t("details.milestone")}
        </label>
        <MilestoneSelect
          id="batch-milestone"
          testId="batch-milestone"
          value={milestone}
          first={{ value: KEEP, label: t("details.batchKeep") }}
          milestones={milestones.data ?? []}
          onChange={setMilestone}
          noneLabel={t("details.none")}
        />
      </div>
      <PeopleInput
        value={people}
        onChange={setPeople}
        draftRef={draft}
        inputTestId="batch-people-input"
        chipTestIdPrefix="batch-person-chip"
        label={t("details.batchAddPeople")}
      />
      <TextField
        label={t("details.locationLabel")}
        data-testid="batch-location"
        value={location}
        maxLength={PHOTO_DETAILS_LIMITS.locationLabel}
        placeholder={t("details.batchKeep")}
        onChange={(e) => setLocation(e.target.value)}
      />
      <TextAreaField
        id="batch-note"
        label={t("details.noteLabel")}
        data-testid="batch-note"
        rows={3}
        maxLength={PHOTO_DETAILS_LIMITS.note}
        value={note}
        placeholder={t("details.batchKeep")}
        onChange={(e) => setNote(e.target.value)}
      />
      {error ? <Message>{error}</Message> : null}
      <div className="flex gap-2">
        <Button type="submit" className="flex-1" data-testid="batch-save" disabled={busy}>
          {t("details.save")}
        </Button>
        <Button variant="secondary" data-testid="batch-cancel" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
