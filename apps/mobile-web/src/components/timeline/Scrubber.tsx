import type { PhotoGroup } from "@littlelight/shared";
import { t } from "../../i18n";
import { ageGroupText } from "../../lib/age";
import { shortGroupLabel } from "./groups";

/**
 * Vertical rail of age groups from the timeline summary. Tapping one starts a new timeline
 * stream at the group's cursor (the newest group simply resets to the top).
 */
export function Scrubber({
  groups,
  activeKey,
  onJump,
}: {
  groups: readonly PhotoGroup[];
  activeKey: string | null;
  onJump: (group: PhotoGroup, index: number) => void;
}) {
  if (groups.length < 2) return null;
  return (
    <nav
      aria-label={t("timeline.scrubber")}
      data-testid="timeline-scrubber"
      className="flex h-full w-11 shrink-0 flex-col overflow-y-auto overscroll-contain border-l border-gray-500/20"
    >
      {groups.map((g, i) => (
        <button
          key={g.key}
          type="button"
          data-testid={`timeline-jump-${g.key}`}
          aria-label={t("timeline.jumpTo", { label: ageGroupText(g.key) })}
          aria-current={activeKey === g.key ? "true" : undefined}
          onClick={() => onJump(g, i)}
          className={`min-h-11 min-w-11 shrink-0 text-xs font-semibold ${
            activeKey === g.key
              ? "bg-[var(--ion-color-primary)] text-[var(--ion-color-primary-contrast)]"
              : "opacity-80"
          }`}
        >
          {shortGroupLabel(g.key)}
        </button>
      ))}
    </nav>
  );
}
