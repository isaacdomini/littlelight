import { MILESTONE_NAME_MAX, type Milestone } from "@littlelight/shared";
import { useState } from "react";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { t } from "../../i18n";
import { ApiError, errorMessage } from "../../lib/api";
import { useDeleteMilestone, useUpdateMilestone } from "../../lib/queries/milestones";
import { Button, Message, TextField } from "../ui";

export function milestoneErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) return t("milestones.nameTaken");
    if (e.status === 403) return t("milestones.limitReached");
  }
  return errorMessage(e);
}

/** Rename and delete (with confirmation) for one custom milestone. Admin only. */
export function MilestoneAdminControls({ milestone }: { milestone: Milestone }) {
  const { baby } = useCurrentBaby();
  const babyId = baby?.id ?? "none";
  const update = useUpdateMilestone(babyId);
  const del = useDeleteMilestone(babyId);
  const [mode, setMode] = useState<"idle" | "rename" | "delete">("idle");
  const [name, setName] = useState(milestone.name);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    if (trimmed === milestone.name) {
      setMode("idle");
      return;
    }
    try {
      await update.mutateAsync({ id: milestone.id, name: trimmed });
      setMode("idle");
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 403 && milestone.isPreset
          ? t("milestones.presetLocked")
          : e instanceof ApiError && e.status === 409
            ? t("milestones.nameTaken")
            : errorMessage(e),
      );
    }
  }

  async function remove() {
    setError(null);
    try {
      await del.mutateAsync(milestone.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (mode === "rename") {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label={t("milestones.renameLabel", { name: milestone.name })}
          data-testid={`milestone-rename-input-${milestone.id}`}
          maxLength={MILESTONE_NAME_MAX}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {error ? <Message>{error}</Message> : null}
        <div className="flex gap-2">
          <Button
            type="submit"
            data-testid={`milestone-rename-save-${milestone.id}`}
            disabled={update.isPending || !name.trim()}
          >
            {t("common.save")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setMode("idle");
              setName(milestone.name);
              setError(null);
            }}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    );
  }

  if (mode === "delete") {
    return (
      <div
        className="flex flex-col gap-2"
        role="alertdialog"
        aria-label={t("milestones.deleteConfirmTitle")}
      >
        <p className="font-semibold">{t("milestones.deleteConfirmTitle")}</p>
        <p className="text-sm text-muted">{t("milestones.deleteConfirmBody")}</p>
        {error ? <Message>{error}</Message> : null}
        <div className="flex gap-2">
          <Button
            variant="danger"
            data-testid={`milestone-delete-confirm-${milestone.id}`}
            disabled={del.isPending}
            onClick={() => void remove()}
          >
            {t("milestones.delete")}
          </Button>
          <Button
            variant="secondary"
            data-testid={`milestone-delete-cancel-${milestone.id}`}
            onClick={() => setMode("idle")}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <Button
        variant="secondary"
        size="sm"
        data-testid={`milestone-rename-${milestone.id}`}
        aria-label={t("milestones.renameLabel", { name: milestone.name })}
        onClick={() => setMode("rename")}
      >
        {t("milestones.rename")}
      </Button>
      <Button
        variant="danger"
        size="sm"
        data-testid={`milestone-delete-${milestone.id}`}
        aria-label={t("milestones.deleteLabel", { name: milestone.name })}
        onClick={() => setMode("delete")}
      >
        {t("milestones.delete")}
      </Button>
    </div>
  );
}
