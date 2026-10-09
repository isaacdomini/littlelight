import { IonIcon } from "@ionic/react";
import type { SearchFacetsResponse } from "@littlelight/shared";
import { chevronDown } from "ionicons/icons";
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
  const invalid = from !== "" && to !== "" && (date ? from > to : Number(from) > Number(to));
  return (
    <form
      className="ll-card flex flex-wrap items-end gap-3 !p-3"
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
      <label className="ll-label flex min-w-0 flex-1 flex-col gap-1.5">
        {date ? t("search.from") : t("search.ageFrom")}
        <input
          data-testid={`${date ? "date" : "age"}-from`}
          type={date ? "date" : "number"}
          min={date ? facets?.dateRange?.from : 0}
          max={date ? facets?.dateRange?.to : undefined}
          step={date ? undefined : "any"}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <label className="ll-label flex min-w-0 flex-1 flex-col gap-1.5">
        {date ? t("search.to") : t("search.ageTo")}
        <input
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
      <ul className="ll-chips ll-chips-scroll">
        {CHIPS.map((chip) => {
          const value = summary(chip, params, facets);
          const kind = t(`search.chip.${chip}`);
          return (
            <li key={chip} className="flex">
              <span className={value !== null ? "ll-chip-split" : "contents"}>
                <button
                  type="button"
                  data-testid={`chip-${chip}`}
                  aria-expanded={openChip === chip}
                  aria-pressed={value !== null}
                  onClick={() => setOpenChip(openChip === chip ? null : chip)}
                  className="ll-chip"
                >
                  {value !== null ? t("search.chip.value", { kind, value }) : kind}
                  {value === null ? (
                    <IonIcon aria-hidden icon={chevronDown} className="h-3.5 w-3.5 text-muted" />
                  ) : null}
                </button>
                {value !== null ? (
                  <button
                    type="button"
                    data-testid={`chip-remove-${chip}`}
                    aria-label={t("search.chip.remove", { kind })}
                    aria-pressed="true"
                    onClick={() => onChange(clearChip(chip, params))}
                    className="ll-chip"
                  >
                    <span aria-hidden className="text-lg leading-none">
                      ×
                    </span>
                  </button>
                ) : null}
              </span>
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
        <ul className="ll-chips max-h-44 overflow-y-auto" data-testid="chip-options">
          {options(openChip).length === 0 ? (
            <li className="text-sm text-muted">{t("search.noOptions")}</li>
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
                  className="ll-chip"
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
