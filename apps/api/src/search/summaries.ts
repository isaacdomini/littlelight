import type { PhotoSummary } from "@tinyglow/shared";
import type { Tx } from "../auth";
import { type PhotoSummaryRow, photoRowsByIds, toPhotoSummary } from "../photos/queries";
import type { UrlSigner } from "../storage/sign";

// Photo summaries for ranked ids (search results, chat grids), reusing the step-4/5 helpers so
// signing stays in one place: thumb only, TTL ≤ 1 h, never `analysis`, never a stored key.
// Rows are read under the caller's claims (RLS) and filtered to the live album; order follows
// `ids`; ids the caller cannot see (or that were trashed meanwhile) are dropped.

export async function liveRowsInOrder(
  client: Tx,
  ids: readonly string[],
): Promise<PhotoSummaryRow[]> {
  if (ids.length === 0) return [];
  const rows = await photoRowsByIds(client, ids);
  const byId = new Map(
    rows
      .filter((r) => r.deleted_at === null && r.approval === "approved" && r.status !== "failed")
      .map((r) => [r.id, r]),
  );
  return ids.map((id) => byId.get(id)).filter((r): r is PhotoSummaryRow => r !== undefined);
}

export function signSummaries(
  signer: UrlSigner,
  rows: readonly PhotoSummaryRow[],
): Promise<PhotoSummary[]> {
  return Promise.all(rows.map((r) => toPhotoSummary(signer, r)));
}
