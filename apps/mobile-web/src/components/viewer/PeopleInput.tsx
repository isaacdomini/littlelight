import { PHOTO_DETAILS_LIMITS } from "@littlelight/shared";
import { useState } from "react";
import { t } from "../../i18n";

/** Normalizes a typed name (trim, max length). */
export function cleanPerson(raw: string): string {
  return raw.trim().slice(0, PHOTO_DETAILS_LIMITS.personName);
}

/** Returns `list` plus the typed names (case-insensitive de-dupe, capped). */
export function addPeople(list: readonly string[], raw: string): string[] {
  const out = [...list];
  for (const part of raw.split(",")) {
    const name = cleanPerson(part);
    if (!name) continue;
    if (out.length >= PHOTO_DETAILS_LIMITS.people) break;
    if (out.some((x) => x.toLowerCase() === name.toLowerCase())) continue;
    out.push(name);
  }
  return out;
}

/** Chip input: Enter or comma adds, blur adds, each chip has a remove button. */
export function PeopleInput({
  value,
  onChange,
  inputTestId,
  chipTestIdPrefix,
  label,
  draftRef,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  inputTestId: string;
  chipTestIdPrefix: string;
  label: string;
  /** Lets the parent flush text typed but not yet committed when saving. */
  draftRef?: { current: string };
}) {
  const [draft, setDraft] = useState("");
  const full = value.length >= PHOTO_DETAILS_LIMITS.people;
  const set = (v: string) => {
    setDraft(v);
    if (draftRef) draftRef.current = v;
  };
  const commit = (raw: string) => {
    if (!raw.trim()) return;
    onChange(addPeople(value, raw));
    set("");
  };
  return (
    <div className="flex flex-col gap-2">
      <label className="ll-label" htmlFor={inputTestId}>
        {label}
      </label>
      {value.length > 0 ? (
        <ul className="ll-chips">
          {value.map((name) => (
            <li key={name} data-testid={`${chipTestIdPrefix}-${name}`} className="ll-chip !pr-1">
              <span>{name}</span>
              <button
                type="button"
                data-testid={`${chipTestIdPrefix}-remove-${name}`}
                aria-label={t("details.removePerson", { name })}
                className="-my-[6px] flex h-11 w-9 items-center justify-center rounded-full text-lg text-muted"
                onClick={() => onChange(value.filter((x) => x !== name))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        id={inputTestId}
        data-testid={inputTestId}
        value={draft}
        disabled={full}
        maxLength={PHOTO_DETAILS_LIMITS.personName}
        placeholder={t("details.peoplePlaceholder")}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(",")) commit(v);
          else set(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          }
        }}
        onBlur={() => commit(draft)}
      />
      {full ? (
        <p className="text-sm text-muted">
          {t("details.peopleLimit", { max: PHOTO_DETAILS_LIMITS.people })}
        </p>
      ) : null}
    </div>
  );
}
