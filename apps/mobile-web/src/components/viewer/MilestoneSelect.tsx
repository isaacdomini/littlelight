import type { Milestone } from "@tinyglow/shared";

/** Native milestone `<select>` (None, built-in, custom). `extra` adds an option at the end. */
export function MilestoneSelect({
  id,
  testId,
  value,
  milestones,
  onChange,
  noneLabel,
  extra,
  first,
  className,
}: {
  id: string;
  testId: string;
  value: string;
  milestones: readonly Milestone[];
  onChange: (v: string) => void;
  noneLabel: string;
  extra?: { value: string; label: string };
  /** An option before "None" (batch: leave unchanged). */
  first?: { value: string; label: string };
  className?: string;
}) {
  const presets = milestones.filter((m) => m.isPreset);
  const custom = milestones.filter((m) => !m.isPreset);
  return (
    <select
      id={id}
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    >
      {first ? <option value={first.value}>{first.label}</option> : null}
      <option value="">{noneLabel}</option>
      {presets.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
      {custom.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
      {extra ? <option value={extra.value}>{extra.label}</option> : null}
    </select>
  );
}
