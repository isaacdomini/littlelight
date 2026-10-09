/**
 * OpenAI Files API (docs/plans/step-6.md 2.2): upload a batch input JSONL (`purpose=batch`),
 * stream a file's content line by line, delete a file (404 = already gone).
 */

import { AiProviderError, safeCode } from "../errors";
import type { HttpClient } from "../http";

export interface UploadedFile {
  id: string;
  bytes: number;
}

/**
 * Uploads a JSONL built from byte parts (never one giant string). The file name is random and
 * carries nothing about the family. Retries on 429 only (a duplicate upload would be an
 * orphaned copy of photos at the provider).
 */
export async function uploadBatchFile(
  http: HttpClient,
  parts: readonly Uint8Array[],
  filename: string,
): Promise<UploadedFile> {
  const blob = new Blob(parts as Uint8Array<ArrayBuffer>[], { type: "application/jsonl" });
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", blob, filename);
  const res = await http.request({
    op: "files.upload",
    method: "POST",
    path: "/v1/files",
    form,
    retry: "rate_limit_only",
    timeoutMs: 10 * 60_000,
  });
  const body = res.body as { id?: unknown; bytes?: unknown } | undefined;
  if (typeof body?.id !== "string") {
    throw new AiProviderError(http.provider, "files.upload", res.status, "no_file_id", false);
  }
  return { id: body.id, bytes: typeof body.bytes === "number" ? body.bytes : blob.size };
}

/** `GET /v1/files/{id}/content`, streamed as lines. */
export function streamFileLines(http: HttpClient, fileId: string): AsyncGenerator<string> {
  return http.lines({
    op: "files.content",
    method: "GET",
    path: `/v1/files/${encodeURIComponent(fileId)}/content`,
    retry: "idempotent",
    timeoutMs: 10 * 60_000,
  });
}

/** `DELETE /v1/files/{id}`; true when deleted or already gone (404). */
export async function deleteFile(http: HttpClient, fileId: string): Promise<boolean> {
  const res = await http.request({
    op: "files.delete",
    method: "DELETE",
    path: `/v1/files/${encodeURIComponent(fileId)}`,
    retry: "idempotent",
    allowStatuses: [404],
  });
  if (res.status === 404) return true;
  const body = res.body as { deleted?: unknown } | undefined;
  if (body?.deleted !== true) {
    throw new AiProviderError(
      http.provider,
      "files.delete",
      res.status,
      safeCode("not_deleted"),
      false,
    );
  }
  return true;
}
