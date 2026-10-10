import {
  formatMeasurement,
  fromMetric,
  type MeasurementKind,
  type MeasurementUnit,
  splitLbOz,
  type Units,
} from "@tinyglow/shared";
import { useAuth } from "../auth/AuthProvider";

/** Display units of the signed-in profile (metric until the profile exists). */
export function useProfileUnits(): Units {
  return useAuth().me?.profile?.units ?? "metric";
}

/** IANA zone of the signed-in profile; the browser's zone until the profile exists. */
export function useProfileTimeZone(): string {
  return useAuth().me?.profile?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "3.40 kg" / "7 lb 8.0 oz" / "66.0 cm" / "26.0 in" for a stored metric value. */
export function measurementText(kind: MeasurementKind, metric: number, units: Units): string {
  return formatMeasurement(kind, metric, units);
}

/** Default entry unit of a kind for a profile (lb for imperial weight, in for imperial lengths). */
export function defaultUnit(kind: MeasurementKind, units: Units): MeasurementUnit {
  return fromMetric(kind, 1000, units).unit;
}

export { fromMetric, splitLbOz };
