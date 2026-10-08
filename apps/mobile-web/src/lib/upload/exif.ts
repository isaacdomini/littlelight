export interface CaptureHint {
  takenAt?: string;
  tzOffsetMinutes?: number;
}

function parseOffset(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(v.trim());
  if (!m) return undefined;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  const signed = m[1] === "-" ? -minutes : minutes;
  return signed >= -840 && signed <= 840 ? signed : undefined;
}

/**
 * Best-effort capture time from EXIF. Reads only DateTimeOriginal and OffsetTimeOriginal
 * (GPS is never read or sent); the server re-reads EXIF and is the source of truth.
 * exifr revives the naive EXIF wall time as a Date in the browser's zone.
 */
export async function readCaptureHint(file: Blob): Promise<CaptureHint> {
  try {
    const exifr = (await import("exifr")).default;
    const tags = (await exifr.parse(file, {
      pick: ["DateTimeOriginal", "OffsetTimeOriginal"],
    })) as { DateTimeOriginal?: unknown; OffsetTimeOriginal?: unknown } | undefined;
    const d = tags?.DateTimeOriginal;
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return {};
    const offset = parseOffset(tags?.OffsetTimeOriginal);
    if (offset === undefined) return { takenAt: d.toISOString() };
    const wallAsUtc = Date.UTC(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
    );
    return {
      takenAt: new Date(wallAsUtc - offset * 60_000).toISOString(),
      tzOffsetMinutes: offset,
    };
  } catch {
    return {};
  }
}
