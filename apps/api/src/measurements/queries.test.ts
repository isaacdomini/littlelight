import { describe, expect, it } from "vitest";
import { type MeasurementRow, toMeasurement } from "./queries";

describe("toMeasurement", () => {
  it("converts numeric text to numbers and dates to ISO strings", () => {
    const row: MeasurementRow = {
      id: "11111111-1111-4111-8111-111111111111",
      baby_id: "22222222-2222-4222-8222-222222222222",
      photo_id: null,
      kind: "weight",
      value_metric: "3401.943",
      value_entered: "7.500",
      unit_entered: "lb",
      measured_at: new Date("2026-05-01T10:00:00Z"),
      note: null,
      created_at: new Date("2026-05-01T10:00:01Z"),
      updated_at: new Date("2026-05-01T10:00:02Z"),
    };
    expect(toMeasurement(row)).toEqual({
      id: row.id,
      babyId: row.baby_id,
      photoId: null,
      kind: "weight",
      valueMetric: 3401.943,
      valueEntered: 7.5,
      unitEntered: "lb",
      measuredAt: "2026-05-01T10:00:00.000Z",
      note: null,
      createdAt: "2026-05-01T10:00:01.000Z",
      updatedAt: "2026-05-01T10:00:02.000Z",
    });
  });
});
