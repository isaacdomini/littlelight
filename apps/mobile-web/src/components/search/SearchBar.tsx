import { SEARCH_QUERY_LIMITS } from "@tinyglow/shared";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { isNative } from "../../platform/platform";

const DEBOUNCE_MS = 300;

/**
 * Search box for the timeline header (FR-7.5): reports the trimmed text 300 ms after typing
 * stops (immediately on Enter or clear). Free babies see it disabled with the Plus hint.
 */
export function SearchBar({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (q: string) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(value);

  // External resets (clear all) flow back into the box.
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  function emit(next: string) {
    if (timer.current) clearTimeout(timer.current);
    const q = next.trim();
    last.current = q;
    onChange(q);
  }
  function type(next: string) {
    setText(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => emit(next), DEBOUNCE_MS);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="search"
          data-testid="search-input"
          aria-label={t("search.label")}
          placeholder={t("search.placeholder")}
          value={text}
          disabled={disabled}
          maxLength={SEARCH_QUERY_LIMITS.q}
          enterKeyHint="search"
          autoComplete="off"
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") emit(text);
          }}
        />
        {text !== "" && !disabled ? (
          <button
            type="button"
            data-testid="search-clear"
            aria-label={t("search.clear")}
            onClick={() => {
              setText("");
              emit("");
            }}
            className="ll-btn ll-btn-secondary !px-0 text-xl"
          >
            <span aria-hidden>×</span>
          </button>
        ) : null}
      </div>
      {disabled && !isNative() ? (
        <p className="ll-caption" data-testid="search-upsell">
          {t("search.upsell")}
        </p>
      ) : null}
    </div>
  );
}
