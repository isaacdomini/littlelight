import { MILESTONE_NAME_MAX, type MilestoneCategory } from "@littlelight/shared";
import { type FormEvent, useState } from "react";
import { t } from "../../i18n";
import { useCreateMilestone } from "../../lib/queries/milestones";
import { Button, Message, TextField } from "../ui";
import { milestoneErrorMessage } from "./MilestoneAdminControls";

const CATEGORIES: MilestoneCategory[] = [
  "custom",
  "social",
  "motor",
  "feeding",
  "growth",
  "speech",
  "event",
];

/** Create a custom milestone (name + category). Admin only. */
export function AddMilestone({ babyId }: { babyId: string }) {
  const create = useCreateMilestone(babyId);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<MilestoneCategory>("custom");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await create.mutateAsync({ name: trimmed, category });
      setName("");
      setCategory("custom");
      setOpen(false);
    } catch (err) {
      setError(milestoneErrorMessage(err));
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" data-testid="milestone-add" onClick={() => setOpen(true)}>
        {t("milestones.add")}
      </Button>
    );
  }
  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="flex flex-col gap-3 rounded-xl border border-gray-500/30 p-4"
      data-testid="milestone-add-form"
    >
      <TextField
        label={t("milestones.nameLabel")}
        data-testid="milestone-name"
        maxLength={MILESTONE_NAME_MAX}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="milestone-category" className="text-sm font-medium">
          {t("milestones.categoryLabel")}
        </label>
        <select
          id="milestone-category"
          data-testid="milestone-category"
          className="min-h-11 w-full rounded-lg border border-gray-500/50 bg-transparent px-3 py-2 text-base text-[var(--ion-text-color)]"
          value={category}
          onChange={(e) => setCategory(e.target.value as MilestoneCategory)}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`milestones.category.${c}`)}
            </option>
          ))}
        </select>
      </div>
      {error ? <Message data-testid="milestone-error">{error}</Message> : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          data-testid="milestone-create"
          disabled={create.isPending || !name.trim()}
        >
          {t("milestones.create")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
