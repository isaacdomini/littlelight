import type { Measurement, MeasurementKind } from "@littlelight/shared";
import { fromMetric } from "@littlelight/shared";
import { useMemo, useState } from "react";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { t } from "../../i18n";
import { ageText } from "../../lib/age";
import { errorMessage } from "../../lib/api";
import { useDeleteMeasurement, useMeasurements } from "../../lib/queries/measurements";
import { measurementText, useProfileUnits } from "../../lib/units";
import { MeasurementSheet } from "../measurements/MeasurementSheet";
import { Button, Message } from "../ui";
import { ageMonths, measurementAgeDays, measurementDate } from "./growthData";

const KINDS: MeasurementKind[] = ["weight", "height", "head"];

const W = 600;
const H = 300;
const PAD = { l: 52, r: 16, t: 16, b: 44 };

function niceTicks(min: number, max: number, count: number): number[] {
  if (max <= min) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

interface Point {
  m: Measurement;
  x: number;
  y: number;
  label: string;
}

function Chart({
  kind,
  measurements,
  birthDate,
}: {
  kind: MeasurementKind;
  measurements: Measurement[];
  birthDate: string;
}) {
  const units = useProfileUnits();
  const pts = useMemo(() => {
    const raw = measurements.map((m) => {
      const days = measurementAgeDays(birthDate, m);
      return {
        m,
        xv: ageMonths(days),
        yv: fromMetric(kind, m.valueMetric, units).value,
        label: t("growth.pointLabel", {
          value: measurementText(kind, m.valueMetric, units),
          age: ageText(days),
        }),
      };
    });
    if (!raw.length) return null;
    let xMin = Math.min(...raw.map((p) => p.xv));
    let xMax = Math.max(...raw.map((p) => p.xv));
    let yMin = Math.min(...raw.map((p) => p.yv));
    let yMax = Math.max(...raw.map((p) => p.yv));
    if (xMax - xMin < 1) {
      xMin -= 0.5;
      xMax += 0.5;
    }
    const ySpan = Math.max(yMax - yMin, yMax * 0.1, 0.1);
    yMin -= ySpan * 0.15;
    yMax += ySpan * 0.15;
    const sx = (v: number) => PAD.l + ((v - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
    const sy = (v: number) => H - PAD.b - ((v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
    const points: Point[] = raw.map((p) => ({
      m: p.m,
      x: sx(p.xv),
      y: sy(p.yv),
      label: p.label,
    }));
    return {
      points,
      xTicks: niceTicks(xMin, xMax, 5).map((v) => ({ v, p: sx(v) })),
      yTicks: niceTicks(yMin, yMax, 4).map((v) => ({ v, p: sy(v) })),
    };
  }, [measurements, birthDate, kind, units]);

  if (!pts) return null;
  const line = pts.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const kindLabel = t(`growth.kind.${kind}`);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      aria-label={t("growth.chartLabel", { kind: kindLabel })}
      data-testid="growth-svg"
      className="h-auto w-full max-w-full text-[var(--ion-text-color)]"
    >
      <title>{t("growth.chartLabel", { kind: kindLabel })}</title>
      {pts.yTicks.map((tk) => (
        <g key={`y${tk.v}`}>
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={tk.p}
            y2={tk.p}
            stroke="currentColor"
            opacity={0.15}
          />
          <text x={PAD.l - 6} y={tk.p + 4} textAnchor="end" fontSize={12} fill="currentColor">
            {Number(tk.v.toFixed(2))}
          </text>
        </g>
      ))}
      {pts.xTicks.map((tk) => (
        <text
          key={`x${tk.v}`}
          x={tk.p}
          y={H - PAD.b + 18}
          textAnchor="middle"
          fontSize={12}
          fill="currentColor"
        >
          {Number(tk.v.toFixed(1))}
        </text>
      ))}
      <text
        x={(PAD.l + W - PAD.r) / 2}
        y={H - 6}
        textAnchor="middle"
        fontSize={12}
        fill="currentColor"
      >
        {t("growth.axisAge")}
      </text>
      <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={H - PAD.b} stroke="currentColor" opacity={0.4} />
      <line
        x1={PAD.l}
        x2={W - PAD.r}
        y1={H - PAD.b}
        y2={H - PAD.b}
        stroke="currentColor"
        opacity={0.4}
      />
      {pts.points.length > 1 ? (
        <polyline
          points={line}
          fill="none"
          stroke="var(--ion-color-primary)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      ) : null}
      {pts.points.map((p) => (
        <circle
          key={p.m.id}
          cx={p.x}
          cy={p.y}
          r={5}
          aria-label={p.label}
          data-testid={`growth-point-${p.m.id}`}
          fill="var(--ion-color-primary)"
        >
          <title>{p.label}</title>
        </circle>
      ))}
    </svg>
  );
}

export function GrowthChart() {
  const { baby } = useCurrentBaby();
  const babyId = baby?.id;
  const isAdmin = baby?.role === "admin";
  const units = useProfileUnits();
  const [kind, setKind] = useState<MeasurementKind>("weight");
  const query = useMeasurements(babyId, kind);
  const del = useDeleteMeasurement(babyId ?? "none");
  const [sheet, setSheet] = useState<{ open: boolean; edit: Measurement | null }>({
    open: false,
    edit: null,
  });
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!baby || !babyId) return null;
  const rows = query.data ?? [];
  const kindLabel = t(`growth.kind.${kind}`);

  async function remove(id: string) {
    setError(null);
    try {
      await del.mutateAsync(id);
      setConfirmId(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <section data-testid="growth-chart" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{t("growth.title")}</h2>
          <p className="text-sm opacity-70">{t("growth.subtitle")}</p>
        </div>
        {isAdmin ? (
          <Button
            data-testid="measurement-add"
            onClick={() => setSheet({ open: true, edit: null })}
          >
            {t("measurements.add")}
          </Button>
        ) : null}
      </div>

      <div role="tablist" aria-label={t("growth.title")} className="flex gap-2">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            data-testid={`growth-kind-${k}`}
            onClick={() => {
              setKind(k);
              setConfirmId(null);
            }}
            className={`min-h-11 flex-1 rounded-lg border px-3 text-base ${
              kind === k
                ? "border-transparent bg-[var(--ion-color-primary)] font-semibold text-[var(--ion-color-primary-contrast)]"
                : "border-gray-500/50"
            }`}
          >
            {t(`growth.kind.${k}`)}
          </button>
        ))}
      </div>

      {query.isError ? (
        <Message data-testid="growth-error">{t("growth.loadError")}</Message>
      ) : query.isLoading ? (
        <p role="status" className="opacity-70">
          {t("common.loading")}
        </p>
      ) : rows.length === 0 ? (
        <p data-testid="growth-empty" className="opacity-80">
          {t("growth.empty", { kind: kindLabel.toLowerCase() })}
        </p>
      ) : (
        <>
          <Chart kind={kind} measurements={rows} birthDate={baby.birthDate} />
          <div className="overflow-x-auto">
            <table data-testid="growth-table" className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">{t("growth.tableCaption", { kind: kindLabel })}</caption>
              <thead>
                <tr className="border-b border-gray-500/40">
                  <th scope="col" className="py-2 pr-3">
                    {t("growth.columnDate")}
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    {t("growth.columnAge")}
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    {t("growth.columnValue")}
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    {t("growth.columnNote")}
                  </th>
                  {isAdmin ? (
                    <td className="py-2">
                      <span className="sr-only">{t("measurements.edit")}</span>
                    </td>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const date = measurementDate(m);
                  return (
                    <tr
                      key={m.id}
                      data-testid={`measurement-row-${m.id}`}
                      className="border-b border-gray-500/20 align-top"
                    >
                      <td className="py-2 pr-3">{date}</td>
                      <td className="py-2 pr-3">
                        {ageText(measurementAgeDays(baby.birthDate, m))}
                      </td>
                      <td className="py-2 pr-3 font-medium">
                        {measurementText(m.kind, m.valueMetric, units)}
                      </td>
                      <td className="py-2 pr-3 break-words">{m.note ?? ""}</td>
                      {isAdmin ? (
                        <td className="py-1">
                          {confirmId === m.id ? (
                            <div
                              className="flex flex-col gap-2"
                              role="alertdialog"
                              aria-label={t("measurements.deleteConfirmTitle")}
                            >
                              <p className="font-medium">{t("measurements.deleteConfirmTitle")}</p>
                              <p className="opacity-80">{t("measurements.deleteConfirmBody")}</p>
                              <div className="flex gap-2">
                                <Button
                                  variant="danger"
                                  data-testid={`measurement-delete-confirm-${m.id}`}
                                  disabled={del.isPending}
                                  onClick={() => void remove(m.id)}
                                >
                                  {t("measurements.delete")}
                                </Button>
                                <Button
                                  variant="secondary"
                                  data-testid={`measurement-delete-cancel-${m.id}`}
                                  onClick={() => setConfirmId(null)}
                                >
                                  {t("common.cancel")}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-2">
                              <Button
                                variant="secondary"
                                data-testid={`measurement-edit-${m.id}`}
                                aria-label={t("measurements.editLabel", { kind: kindLabel, date })}
                                onClick={() => setSheet({ open: true, edit: m })}
                              >
                                {t("measurements.edit")}
                              </Button>
                              <Button
                                variant="secondary"
                                data-testid={`measurement-delete-${m.id}`}
                                aria-label={t("measurements.deleteLabel", {
                                  kind: kindLabel,
                                  date,
                                })}
                                onClick={() => setConfirmId(m.id)}
                              >
                                {t("milestones.delete")}
                              </Button>
                            </div>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {error ? <Message>{error}</Message> : null}

      {isAdmin ? (
        <MeasurementSheet
          babyId={babyId}
          open={sheet.open}
          measurement={sheet.edit}
          defaultKind={kind}
          onClose={() => setSheet({ open: false, edit: null })}
        />
      ) : null}
    </section>
  );
}
