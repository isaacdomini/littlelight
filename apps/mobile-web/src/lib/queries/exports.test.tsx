import type { DataExport } from "@littlelight/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../../testing/native";
import {
  deleteExport,
  exportsKey,
  isActiveExport,
  mintExportUrl,
  requestExport,
  useExports,
} from "./exports";

const BABY = "11111111-1111-4111-8111-111111111111";
const EXP = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const row = (over: Partial<DataExport> = {}): DataExport => ({
  id: EXP,
  babyId: BABY,
  status: "queued",
  includeLocation: true,
  requestedBy: USER,
  requestedByName: "Mom",
  isMine: true,
  photoCount: null,
  photosDone: 0,
  bytes: null,
  error: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  expiresAt: "2026-10-17T10:00:00.000Z",
  canDownload: false,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  setNativePlatform(null);
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function intervalOf(client: QueryClient): number | false | undefined {
  const q = client.getQueryCache().find({ queryKey: exportsKey(BABY) });
  const opt = q?.observers[0]?.options.refetchInterval;
  return typeof opt === "function" ? (opt as (query: unknown) => number | false)(q) : opt;
}

describe("isActiveExport", () => {
  it("is true for queued and running only", () => {
    for (const [status, expected] of [
      ["queued", true],
      ["running", true],
      ["ready", false],
      ["failed", false],
      ["expired", false],
    ] as const) {
      expect(isActiveExport(row({ status })), status).toBe(expected);
    }
  });
});

describe("useExports", () => {
  it("polls every 3 s while an export is active and stops when none is", async () => {
    let list = [row({ status: "running" })];
    stubFetch(() => jsonResponse({ exports: list }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useExports(BABY), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data?.exports).toHaveLength(1));
    expect(intervalOf(client)).toBe(3000);
    list = [row({ status: "ready", canDownload: true })];
    await client.refetchQueries({ queryKey: exportsKey(BABY) });
    await waitFor(() => expect(result.current.data?.exports[0]?.status).toBe("ready"));
    expect(intervalOf(client)).toBe(false);
  });

  it("does nothing without a baby", () => {
    const { fn } = stubFetch(() => jsonResponse({ exports: [] }));
    const client = new QueryClient();
    renderHook(() => useExports(undefined), { wrapper: wrapper(client) });
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects a list that carries an unexpected field (strict schema)", async () => {
    stubFetch(() =>
      jsonResponse({ exports: [{ ...row(), storage_key: "babies/x/exports/y.zip" }] }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useExports(BABY), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("export requests", () => {
  it("POST, download-url and DELETE hit the documented routes", async () => {
    const { calls } = stubFetch((c) => {
      if (c.method === "POST" && c.url.endsWith("/exports"))
        return jsonResponse({ export: row() }, 202);
      if (c.url.endsWith("/download-url"))
        return jsonResponse({
          url: `http://h.test/b/babies/${BABY}/exports/${EXP}.zip?X-Amz-Signature=abc`,
          expiresAt: "2026-10-10T10:10:00.000Z",
        });
      return jsonResponse(null, 204);
    });
    await requestExport(BABY, { includeLocation: false });
    const dl = await mintExportUrl(BABY, EXP);
    expect(dl.url).toContain(".zip");
    await deleteExport(BABY, EXP);
    expect(
      calls.map((c) => `${c.method} ${new URL(c.url, "http://x").pathname.replace(/^\/api/, "")}`),
    ).toEqual([
      `POST /babies/${BABY}/exports`,
      `POST /babies/${BABY}/exports/${EXP}/download-url`,
      `DELETE /babies/${BABY}/exports/${EXP}`,
    ]);
    expect(calls[0]?.body).toEqual({ includeLocation: false });
  });

  it("a download URL for anything but an export ZIP is refused by the response schema", async () => {
    stubFetch(() =>
      jsonResponse({
        url: `http://h.test/b/babies/${BABY}/originals/${EXP}`,
        expiresAt: "2026-10-10T10:10:00.000Z",
      }),
    );
    await expect(mintExportUrl(BABY, EXP)).rejects.toBeDefined();
  });
});
