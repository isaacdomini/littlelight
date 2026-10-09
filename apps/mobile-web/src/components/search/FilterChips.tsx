import type { SearchFacetsResponse } from "@littlelight/shared";
import { useState } from "react";
import { t } from "../../i18n";
import type { SearchParams } from "../../lib/queries/search";
import { Button } from "../ui";

type Chip = "date" | "age" | "milestone" | "person" | "place" | "tag";
const CHIPS: Chip[] = ["date", "age", "milestone", "person", "place", "tag"];
const DAYS_PER_MONTH = 30.4375;

const toDays = (months: string) => String(Math.round(Number(months) * DAYS_PER_MONTH));
const toMonths = (days: string) => String(Math.round((Number(days) / DAYS_PER_MONTH) * 10) / 10);

function summary(chip: Chip, p: SearchParams, facets: SearchFacetsResponse | undefined) {
  switch (chip) {
    case "date":
      if (p.dateFrom && p.dateTo) return t("search.dateRange", { from: p.dateFrom, to: p.dateTo });
      if (p.dateFrom) return t("search.dateFrom", { from: p.dateFrom });
      return p.dateTo ? t("search.dateTo", { to: p.dateTo }) : null;
    case "age":
      if (p.ageFrom && p.ageTo)
        return t("search.ageRange", { from: toMonths(p.ageFrom), to: toMonths(p.ageTo) });
      if (p.ageFrom) return t("search.ageFromOnly", { from: toMonths(p.ageFrom) });
      return p.ageTo ? t("search.ageToOnly", { to: toMonths(p.ageTo) }) : null;
    case "milestone":
      return p.milestoneId
        ? (facets?.milestones.find((m) => m.id === p.milestoneId)?.name ?? "…")
        : null;
    case "person":
      return p.person || null;
    case "place":
      return p.place || null;
    case "tag":
      return p.tag || null;
  }
}

function clearChip(chip: Chip, p: SearchParams): SearchParams {
  switch (chip) {
    case "date":
      return { ...p, dateFrom: "", dateTo: "" };
    case "age":
      return { ...p, ageFrom: "", ageTo: "" };
    case "milestone":
      return { ...p, milestoneId: "" };
    case "person":
      return { ...p, person: "" };
    case "place":
      return { ...p, place: "" };
    case "tag":
      return { ...p, tag: "" };
  }
}

function RangeEditor({
  chip,
  params,
  facets,
  onApply,
}: {
  chip: "date" | "age";
  params: SearchParams;
  facets: SearchFacetsResponse | undefined;
  onApply: (next: SearchParams) => void;
}) {
  const date = chip === "date";
  const [from, setFrom] = useState(
    date ? params.dateFrom : params.ageFrom ? toMonths(params.ageFrom) : "",
  );
  const [to, setTo] = useState(date ? params.dateTo : params.ageTo ? toMonths(params.ageTo) : "");
  const field =
    "min-h-11 rounded-lg border border-gray-500/50 bg-transparent px-3 py-2 text-base text-[var(--ion-text-color)]";
  const invalid = from !== "" && to !== "" && (date ? from > to : Number(from) > Number(to));
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        onApply(
          date
            ? { ...params, dateFrom: from, dateTo: to }
            : {
                ...params,
                ageFrom: from === "" ? "" : toDays(from),
                ageTo: to === "" ? "" : toDays(to),
              },
        );
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        {date ? t("search.from") : t("search.ageFrom")}
        <input
          className={field}
          data-testid={`${date ? "date" : "age"}-from`}
          type={date ? "date" : "number"}
          min={date ? facets?.dateRange?.from : 0}
          max={date ? facets?.dateRange?.to : undefined}
          step={date ? undefined : "any"}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {date ? t("search.to") : t("search.ageTo")}
        <input
          className={field}
          data-testid={`${date ? "date" : "age"}-to`}
          type={date ? "date" : "number"}
          min={date ? facets?.dateRange?.from : 0}
          max={date ? facets?.dateRange?.to : undefined}
          step={date ? undefined : "any"}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </label>
      <Button
        type="submit"
        data-testid={`${chip}-apply`}
        disabled={invalid || (from === "" && to === "")}
      >
        {t("search.apply")}
      </Button>
    </form>
  );
}

/** Filter chips (FR-7.5): date, age, milestone, person, place, tag; values come from the facets. */
export function FilterChips({
  params,
  facets,
  onChange,
}: {
  params: SearchParams;
  facets: SearchFacetsResponse | undefined;
  onChange: (next: SearchParams) => void;
}) {
  const [openChip, setOpenChip] = useState<Chip | null>(null);

  const options = (chip: Chip): { key: string; label: string; apply: () => SearchParams }[] => {
    switch (chip) {
      case "milestone":
        return (facets?.milestones ?? []).map((m) => ({
          key: m.id,
          label: t("search.optionCount", { name: m.name, n: m.count }),
          apply: () => ({ ...params, milestoneId: m.id }),
        }));
      case "person":
        return (facets?.people ?? []).map((x) => ({
          key: x.name,
          label: t("search.optionCount", { name: x.name, n: x.count }),
          apply: () => ({ ...params, person: x.name }),
        }));
      case "place":
        return (facets?.places ?? []).map((x) => ({
          key: x.place,
          label: t("search.optionCount", { name: x.place, n: x.count }),
          apply: () => ({ ...params, place: x.place }),
        }));
      case "tag":
        return (facets?.tags ?? []).map((x) => ({
          key: x.tag,
          label: t("search.optionCount", { name: x.tag, n: x.count }),
          apply: () => ({ ...params, tag: x.tag }),
        }));
      default:
        return [];
    }
  };

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="sr-only">{t("search.filters")}</legend>
      <ul className="flex flex-wrap gap-2">
        {CHIPS.map((chip) => {
          const value = summary(chip, params, facets);
          const kind = t(`search.chip.${chip}`);
          return (
            <li key={chip} className="flex">
              <button
                type="button"
                data-testid={`chip-${chip}`}
                aria-expanded={openChip === chip}
                aria-pressed={value !== null}
                onClick={() => setOpenChip(openChip === chip ? null : chip)}
                className={`min-h-11 border px-3 text-sm ${value !== null ? "rounded-l-full border-[var(--ion-color-primary)] bg-[var(--ion-color-primary)] text-[var(--ion-color-primary-contrast)]" : "rounded-full border-gray-500/50"}`}
              >
                {value !== null ? t("search.chip.value", { kind, value }) : kind}
              </button>
              {value !== null ? (
                <button
                  type="button"
                  data-testid={`chip-remove-${chip}`}
                  aria-label={t("search.chip.remove", { kind })}
                  onClick={() => onChange(clearChip(chip, params))}
                  className="min-h-11 min-w-11 rounded-r-full border border-[var(--ion-color-primary)] px-2 text-sm"
                >
                  ×
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {openChip === "date" || openChip === "age" ? (
        <RangeEditor
          key={openChip}
          chip={openChip}
          params={params}
          facets={facets}
          onApply={(next) => {
            onChange(next);
            setOpenChip(null);
          }}
        />
      ) : openChip ? (
        <ul className="flex max-h-40 flex-wrap gap-2 overflow-y-auto" data-testid="chip-options">
          {options(openChip).length === 0 ? (
            <li className="text-sm opacity-70">{t("search.noOptions")}</li>
          ) : (
            options(openChip).map((o) => (
              <li key={o.key}>
                <button
                  type="button"
                  data-testid={`chip-option-${openChip}-${o.key}`}
                  onClick={() => {
                    onChange(o.apply());
                    setOpenChip(null);
                  }}
                  className="min-h-11 rounded-full border border-gray-500/50 px-3 text-sm"
                >
                  {o.label}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </fieldset>
  );
}
