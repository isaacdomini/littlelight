import type { ShareRuleInput, ShareRuleMode } from "@tinyglow/shared";
import { normalizeShareTag, SHARE_RULE_TAG_MAX_CHARS, SHARE_RULE_TAGS_MAX } from "@tinyglow/shared";
import { useId, useState } from "react";
import { t } from "../../i18n";
import { useSearchFacets } from "../../lib/queries/search";
import { isNative } from "../../platform/platform";
import { Message } from "../ui";

export type RuleMode = "manual" | ShareRuleMode;
export interface RuleDraft {
  mode: RuleMode;
  includeTags: string[];
  excludeTags: string[];
}

export const EMPTY_RULE: RuleDraft = { mode: "manual", includeTags: [], excludeTags: [] };

/** The request body for a draft (`null` = no rule), or `undefined` when the draft is incomplete. */
export function ruleInput(d: RuleDraft): ShareRuleInput | null | undefined {
  if (d.mode === "manual") return null;
  if (d.mode === "tags" && d.includeTags.length === 0) return undefined;
  return { mode: d.mode, includeTags: d.includeTags, excludeTags: d.excludeTags };
}

const MODES: RuleMode[] = ["manual", "all", "milestones", "tags"];

function TagInput({
  label,
  value,
  onChange,
  suggestions,
  testId,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  testId: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const tag = normalizeShareTag(raw).slice(0, SHARE_RULE_TAG_MAX_CHARS);
    setDraft("");
    if (!tag || value.includes(tag) || value.length >= SHARE_RULE_TAGS_MAX) return;
    onChange([...value, tag]);
  };
  const shown = suggestions.filter((s) => !value.includes(s)).slice(0, 8);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="ll-label">
        {label}
      </label>
      {value.length > 0 ? (
        <ul className="ll-chips">
          {value.map((tag) => (
            <li key={tag} className="ll-chip !pr-1" data-testid={`${testId}-chip-${tag}`}>
              <span>{tag}</span>
              <button
                type="button"
                aria-label={t("share.rule.removeTag", { name: tag })}
                className="-my-[6px] flex h-11 w-9 items-center justify-center rounded-full text-lg text-muted"
                onClick={() => onChange(value.filter((x) => x !== tag))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        id={id}
        data-testid={testId}
        value={draft}
        placeholder={t("share.rule.tagPlaceholder")}
        maxLength={SHARE_RULE_TAG_MAX_CHARS}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(",")) add(v.replace(",", ""));
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => add(draft)}
      />
      {shown.length > 0 ? (
        <ul className="ll-chips">
          {shown.map((s) => (
            <li key={s}>
              <button type="button" className="ll-chip" onClick={() => add(s)}>
                + {s}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Auto-share rule picker (FR-9.4). Plus only: free babies get the upsell and no rule UI (the
 * server enforces it too, D3). Sensitive photos are never shared by a rule (FR-9.5).
 */
export function RuleEditor({
  babyId,
  plus,
  value,
  onChange,
}: {
  babyId: string;
  plus: boolean;
  value: RuleDraft;
  onChange: (next: RuleDraft) => void;
}) {
  const facets = useSearchFacets(babyId, plus && (value.mode === "tags" || value.mode === "all"));
  const tagSuggestions = (facets.data?.tags ?? []).map((x) => x.tag);

  if (!plus && isNative()) return null;
  if (!plus) {
    return (
      <div className="ll-card flex flex-col gap-1" data-testid="share-rule-upsell">
        <p className="font-semibold">{t("share.rule.upsellTitle")}</p>
        <p className="text-sm text-muted">{t("share.rule.upsellBody")}</p>
      </div>
    );
  }
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="ll-label mb-2">{t("share.rule.title")}</legend>
      <div className="ll-chips">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={value.mode === m}
            data-testid={`share-rule-mode-${m}`}
            className="ll-chip"
            onClick={() => onChange({ ...value, mode: m })}
          >
            {t(`share.rule.mode.${m}`)}
          </button>
        ))}
      </div>
      <p className="text-sm text-muted">{t(`share.rule.modeHint.${value.mode}`)}</p>
      {value.mode === "tags" ? (
        <TagInput
          label={t("share.rule.include")}
          testId="share-rule-include"
          value={value.includeTags}
          suggestions={tagSuggestions}
          onChange={(includeTags) => onChange({ ...value, includeTags })}
        />
      ) : null}
      {value.mode !== "manual" ? (
        <TagInput
          label={t("share.rule.exclude")}
          testId="share-rule-exclude"
          value={value.excludeTags}
          suggestions={[]}
          onChange={(excludeTags) => onChange({ ...value, excludeTags })}
        />
      ) : null}
      {value.mode === "tags" && value.includeTags.length === 0 ? (
        <Message kind="info">{t("share.rule.needTag")}</Message>
      ) : null}
      {value.mode !== "manual" ? <p className="ll-caption">{t("share.rule.note")}</p> : null}
    </fieldset>
  );
}
