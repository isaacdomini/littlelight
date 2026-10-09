import { AI_DESCRIPTION_LIMITS, type Photo, type PhotoAiOverridePatch } from "@littlelight/shared";
import { useState } from "react";
import { t } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { Button, Message, TextAreaField } from "../ui";

type Field = "caption" | "detailed_description" | "search_tags";

function cleanTag(raw: string): string {
  return raw.trim().toLowerCase().slice(0, AI_DESCRIPTION_LIMITS.searchTag);
}

function addTags(list: readonly string[], raw: string): string[] {
  const out = [...list];
  for (const part of raw.split(",")) {
    const tag = cleanTag(part);
    if (!tag || out.includes(tag) || out.length >= AI_DESCRIPTION_LIMITS.searchTags) continue;
    out.push(tag);
  }
  return out;
}

/**
 * Admin override form (FR-5.6): caption, detailed description and search tags. Each field has
 * "Reset to AI" which sends `null` (clears the override). Only changed fields are sent. The
 * text is user content: it only travels in the PATCH body.
 */
export function AiEditForm({
  photo,
  onSubmit,
  onCancel,
}: {
  photo: Photo;
  onSubmit: (patch: PhotoAiOverridePatch) => Promise<void>;
  onCancel: () => void;
}) {
  const current = photo.ai.description;
  const raw = photo.ai.raw ?? current;
  const overrides = photo.ai.overrides;
  const [caption, setCaption] = useState(current?.caption ?? "");
  const [description, setDescription] = useState(current?.detailed_description ?? "");
  const [tags, setTags] = useState<string[]>(current?.search_tags ?? []);
  const [draft, setDraft] = useState("");
  const [reset, setReset] = useState<Partial<Record<Field, true>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isOverridden = (f: Field) => overrides[f] !== undefined && !reset[f];
  const resetField = (f: Field) => {
    setReset((r) => ({ ...r, [f]: true }));
    if (!raw) return;
    if (f === "caption") setCaption(raw.caption);
    else if (f === "detailed_description") setDescription(raw.detailed_description);
    else setTags(raw.search_tags);
  };
  const unreset = (f: Field) => {
    if (reset[f]) setReset((r) => ({ ...r, [f]: undefined }));
  };

  async function save() {
    const finalTags = addTags(tags, draft);
    const patch: PhotoAiOverridePatch = {};
    if (reset.caption) patch.caption = null;
    else if (caption.trim() !== (current?.caption ?? "")) {
      if (!caption.trim()) return setError(t("ai.emptyField"));
      patch.caption = caption.trim();
    }
    if (reset.detailed_description) patch.detailed_description = null;
    else if (description.trim() !== (current?.detailed_description ?? "")) {
      if (!description.trim()) return setError(t("ai.emptyField"));
      patch.detailed_description = description.trim();
    }
    if (reset.search_tags) patch.search_tags = null;
    else if (finalTags.join("\n") !== (current?.search_tags ?? []).join("\n")) {
      if (finalTags.length === 0) return setError(t("ai.tagsRequired"));
      patch.search_tags = finalTags;
    }
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(patch);
    } catch (e) {
      setError(errorMessage(e) || t("ai.saveError"));
      setBusy(false);
    }
  }

  const resetButton = (f: Field, label: string) =>
    isOverridden(f) ? (
      <Button
        variant="link"
        size="sm"
        className="self-start !px-0"
        data-testid={`ai-edit-reset-${f}`}
        aria-label={t("ai.resetFieldLabel", { field: label })}
        onClick={() => resetField(f)}
      >
        {t("ai.resetField")}
      </Button>
    ) : null;

  return (
    <form
      data-testid="ai-edit-form"
      aria-label={t("ai.editTitle")}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-1">
        <TextAreaField
          id="ai-edit-caption"
          label={t("ai.editCaption")}
          data-testid="ai-edit-caption"
          rows={2}
          maxLength={AI_DESCRIPTION_LIMITS.caption}
          value={caption}
          onChange={(e) => {
            unreset("caption");
            setCaption(e.target.value);
          }}
          counter={t("ai.counter", { n: caption.length, max: AI_DESCRIPTION_LIMITS.caption })}
        />
        {resetButton("caption", t("ai.editCaption"))}
      </div>

      <div className="flex flex-col gap-1">
        <TextAreaField
          id="ai-edit-description"
          label={t("ai.editDescription")}
          data-testid="ai-edit-description"
          rows={5}
          maxLength={AI_DESCRIPTION_LIMITS.detailedDescription}
          value={description}
          onChange={(e) => {
            unreset("detailed_description");
            setDescription(e.target.value);
          }}
          counter={t("ai.counter", {
            n: description.length,
            max: AI_DESCRIPTION_LIMITS.detailedDescription,
          })}
        />
        {resetButton("detailed_description", t("ai.editDescription"))}
      </div>

      <div className="flex flex-col gap-2" data-testid="ai-edit-tags">
        <label htmlFor="ai-edit-tag-input" className="ll-label">
          {t("ai.editTags")}
        </label>
        {tags.length > 0 ? (
          <ul className="ll-chips">
            {tags.map((tag) => (
              <li key={tag} data-testid={`ai-edit-tag-${tag}`} className="ll-chip !pr-1">
                <span>{tag}</span>
                <button
                  type="button"
                  data-testid={`ai-edit-tag-remove-${tag}`}
                  aria-label={t("ai.removeTag", { name: tag })}
                  className="-my-[6px] flex h-11 w-9 items-center justify-center rounded-full text-lg text-muted"
                  onClick={() => {
                    unreset("search_tags");
                    setTags(tags.filter((x) => x !== tag));
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          id="ai-edit-tag-input"
          data-testid="ai-edit-tag-input"
          value={draft}
          disabled={tags.length >= AI_DESCRIPTION_LIMITS.searchTags}
          maxLength={AI_DESCRIPTION_LIMITS.searchTag}
          placeholder={t("ai.editTagsPlaceholder")}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(",")) {
              unreset("search_tags");
              setTags(addTags(tags, v));
              setDraft("");
            } else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (draft.trim()) {
                unreset("search_tags");
                setTags(addTags(tags, draft));
                setDraft("");
              }
            }
          }}
        />
        {tags.length >= AI_DESCRIPTION_LIMITS.searchTags ? (
          <p className="text-sm text-muted">
            {t("ai.editTagsMax", { max: AI_DESCRIPTION_LIMITS.searchTags })}
          </p>
        ) : null}
        {resetButton("search_tags", t("ai.editTags"))}
      </div>

      {error ? <Message data-testid="ai-edit-error">{error}</Message> : null}

      <div className="flex gap-2">
        <Button type="submit" className="flex-1" data-testid="ai-edit-save" disabled={busy}>
          {t("ai.save")}
        </Button>
        <Button variant="secondary" data-testid="ai-edit-cancel" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
