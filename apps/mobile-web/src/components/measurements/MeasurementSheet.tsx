import { IonModal } from "@ionic/react";
import {
  MEASUREMENT_UNITS_FOR_KIND,
  type Measurement,
  type MeasurementKind,
  type MeasurementUnit,
  measurementValueIssue,
  OZ_PER_LB,
  roundTo,
} from "@tinyglow/shared";
import { type FormEvent, useState } from "react";
import { t } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { useCreateMeasurement, useUpdateMeasurement } from "../../lib/queries/measurements";
import { defaultUnit, useProfileUnits } from "../../lib/units";
import { Button, Message, SelectField, TextField } from "../ui";

const KINDS: MeasurementKind[] = ["weight", "height", "head"];

export interface MeasurementSheetProps {
  babyId: string;
  /** Link the new measurement to this photo (viewer shortcut). */
  photoId?: string | null;
  /** ISO instant used to prefill the date (a photo's `takenAt`); defaults to today. */
  defaultMeasuredAt?: string | null;
  open: boolean;
  onClose: () => void;
  /** Edit this measurement instead of adding one. */
  measurement?: Measurement | null;
  /** Kind preselected when adding. */
  defaultKind?: MeasurementKind;
}

function dateInputValue(iso: string | null | undefined, timeZone?: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function parseNum(s: string): number {
  const n = Number(s.trim().replace(",", "."));
  return s.trim() === "" ? Number.NaN : n;
}

function Form({
  babyId,
  photoId,
  defaultMeasuredAt,
  measurement,
  defaultKind,
  onClose,
}: Omit<MeasurementSheetProps, "open">) {
  const units = useProfileUnits();
  const create = useCreateMeasurement(babyId);
  const update = useUpdateMeasurement(babyId);
  const editing = !!measurement;

  const initKind: MeasurementKind = measurement?.kind ?? defaultKind ?? "weight";
  const initUnit: MeasurementUnit = measurement?.unitEntered ?? defaultUnit(initKind, units);
  const [kind, setKind] = useState<MeasurementKind>(initKind);
  const [unit, setUnit] = useState<MeasurementUnit>(initUnit);
  const initial = (() => {
    if (!measurement) return { value: "", oz: "" };
    if (measurement.kind === "weight" && measurement.unitEntered === "lb") {
      const lb = Math.floor(measurement.valueEntered);
      const oz = roundTo((measurement.valueEntered - lb) * OZ_PER_LB, 1);
      return { value: String(lb), oz: oz ? String(oz) : "" };
    }
    return { value: String(measurement.valueEntered), oz: "" };
  })();
  const [value, setValue] = useState(initial.value);
  const [oz, setOz] = useState(initial.oz);
  const [date, setDate] = useState(
    measurement
      ? dateInputValue(measurement.measuredAt, "UTC")
      : dateInputValue(defaultMeasuredAt, Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  const [note, setNote] = useState(measurement?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;
  const showOz = kind === "weight" && unit === "lb";

  function changeKind(k: MeasurementKind) {
    setKind(k);
    if (!(MEASUREMENT_UNITS_FOR_KIND[k] as readonly string[]).includes(unit)) {
      setUnit(defaultUnit(k, units));
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let v = parseNum(value);
    if (showOz) {
      const o = oz.trim() === "" ? 0 : parseNum(oz);
      const lb = value.trim() === "" ? 0 : v;
      if (!Number.isFinite(o) || !Number.isFinite(lb) || o < 0 || lb < 0) {
        setError(t("measurements.valueInvalid"));
        return;
      }
      v = roundTo(lb + o / OZ_PER_LB, 6);
    }
    if (!Number.isFinite(v) || v <= 0 || measurementValueIssue(kind, v, unit)) {
      setError(t("measurements.valueInvalid"));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError(t("measurements.saveError"));
      return;
    }
    const measuredAt = `${date}T12:00:00.000Z`;
    const noteValue = note.trim() === "" ? null : note.trim();
    try {
      if (measurement) {
        await update.mutateAsync({
          id: measurement.id,
          kind,
          value: v,
          unit,
          measuredAt,
          note: noteValue,
        });
      } else {
        await create.mutateAsync({
          kind,
          value: v,
          unit,
          measuredAt,
          note: noteValue,
          ...(photoId ? { photoId } : {}),
        });
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err) || t("measurements.saveError"));
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      data-testid="measurement-form"
      noValidate
    >
      <h2 className="text-xl font-semibold">
        {editing ? t("measurements.edit") : t("measurements.add")}
      </h2>
      <SelectField
        id="measurement-kind"
        label={t("measurements.kind")}
        data-testid="measurement-kind"
        value={kind}
        onChange={(e) => changeKind(e.target.value as MeasurementKind)}
      >
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {t(`growth.kind.${k}`)}
          </option>
        ))}
      </SelectField>
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <TextField
            label={t("measurements.value")}
            data-testid="measurement-value"
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        {showOz ? (
          <div className="min-w-0 flex-1">
            <TextField
              label={t("measurements.valueOz")}
              data-testid="measurement-value-oz"
              inputMode="decimal"
              autoComplete="off"
              value={oz}
              onChange={(e) => setOz(e.target.value)}
            />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <SelectField
            id="measurement-unit"
            label={t("measurements.unit")}
            data-testid="measurement-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value as MeasurementUnit)}
          >
            {MEASUREMENT_UNITS_FOR_KIND[kind].map((u) => (
              <option key={u} value={u}>
                {t(`measurements.unit.${u}`)}
              </option>
            ))}
          </SelectField>
        </div>
      </div>
      <TextField
        label={t("measurements.date")}
        data-testid="measurement-date"
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <TextField
        label={`${t("measurements.note")} (${t("common.optional")})`}
        data-testid="measurement-note"
        maxLength={2000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {error ? <Message data-testid="measurement-error">{error}</Message> : null}
      <div className="flex gap-3">
        <Button type="submit" className="flex-1" data-testid="measurement-save" disabled={pending}>
          {t("measurements.save")}
        </Button>
        <Button
          variant="secondary"
          data-testid="measurement-cancel"
          disabled={pending}
          onClick={onClose}
        >
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Add or edit a measurement (admin only; callers hide the entry points for contributors).
 * Pounds + ounces are sent as `value = lb + oz / 16` with unit `lb`; the server normalizes.
 */
export function MeasurementSheet({ open, onClose, ...rest }: MeasurementSheetProps) {
  return (
    <IonModal
      isOpen={open}
      onDidDismiss={onClose}
      data-testid="measurement-sheet"
      className="ll-sheet"
    >
      {open ? <Form {...rest} onClose={onClose} /> : null}
    </IonModal>
  );
}
