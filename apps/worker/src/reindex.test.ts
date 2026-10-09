import { describe, expect, it, vi } from "vitest";
import { batchReason, handleReindexJobs } from "./reindex";
import { recordingLog } from "./testing/stubs";

const PHOTO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHOTO2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BABY = "11111111-1111-4111-8111-111111111111";
const valid = { photoId: PHOTO, babyId: BABY, reason: "details" };

function setup() {
  const log = recordingLog();
  const reindex = vi.fn(
    async (ids: string[], _reason?: string) => ({ indexed: ids.length }) as never,
  );
  return { log, reindex, deps: { indexer: { reindex }, log } };
}

describe("handleReindexJobs (batch handler, step 7)", () => {
  it("drops malformed payloads with a warning that carries only the job id, no indexer call", async () => {
    for (const data of [
      null,
      {},
      "x",
      { ...valid, reason: "nope" },
      { ...valid, photoId: "p1" },
      { ...valid, note: "first steps" },
      { photoId: PHOTO, babyId: BABY },
    ]) {
      const { deps, log, reindex } = setup();
      const out = await handleReindexJobs(deps, [{ id: "job-1", data }]);
      expect(out).toEqual({ photoIds: [], invalid: 1, result: null });
      expect(reindex).not.toHaveBeenCalled();
      const warns = log.lines.filter((l) => l.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.obj).toEqual({ jobId: "job-1" });
      expect(JSON.stringify(log.lines)).not.toContain("first steps");
    }
  });

  it("calls the indexer once per batch with de-duplicated photo ids in first-seen order", async () => {
    const { deps, reindex } = setup();
    const out = await handleReindexJobs(deps, [
      { id: "1", data: valid },
      { id: "2", data: { ...valid, photoId: PHOTO2, reason: "ai" } },
      { id: "3", data: { ...valid, reason: "milestone" } },
    ]);
    expect(reindex).toHaveBeenCalledTimes(1);
    expect(reindex.mock.calls[0]?.[0]).toEqual([PHOTO, PHOTO2]);
    expect(out.photoIds).toEqual([PHOTO, PHOTO2]);
    expect(out.invalid).toBe(0);
    expect(out.result).toEqual({ indexed: 2 });
  });

  it("invalid payloads are dropped while the valid ones in the same batch are still indexed", async () => {
    const { deps, reindex, log } = setup();
    const out = await handleReindexJobs(deps, [
      { id: "1", data: { bad: true } },
      { id: "2", data: valid },
    ]);
    expect(reindex).toHaveBeenCalledWith([PHOTO], "details");
    expect(out.invalid).toBe(1);
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("the reason handed over is the most frequent one in the batch (ties: first seen)", async () => {
    const { deps, reindex } = setup();
    await handleReindexJobs(deps, [
      { id: "1", data: { ...valid, reason: "ai" } },
      { id: "2", data: { ...valid, photoId: PHOTO2, reason: "details" } },
      { id: "3", data: { ...valid, photoId: PHOTO2, reason: "details" } },
    ]);
    expect(reindex.mock.calls[0]?.[1]).toBe("details");
    expect(batchReason([{ reason: "ai" }, { reason: "details" }])).toBe("ai");
    expect(batchReason([])).toBe("backfill");
  });

  it("logs counts and reasons only, never ids of babies or any payload content", async () => {
    const { deps, log } = setup();
    await handleReindexJobs(deps, [{ id: "1", data: valid }]);
    const debug = log.lines.find((l) => l.level === "debug");
    expect(Object.keys(debug?.obj ?? {}).sort()).toEqual(["invalid", "ms", "photos", "reasons"]);
    expect(JSON.stringify(log.lines)).not.toContain(BABY);
  });

  it("indexer errors propagate so pg-boss retries the batch", async () => {
    const { deps, reindex } = setup();
    reindex.mockRejectedValueOnce(new Error("db down"));
    await expect(handleReindexJobs(deps, [{ id: "1", data: valid }])).rejects.toThrow("db down");
  });

  it("an empty batch is a no-op", async () => {
    const { deps, reindex } = setup();
    expect(await handleReindexJobs(deps, [])).toEqual({ photoIds: [], invalid: 0, result: null });
    expect(reindex).not.toHaveBeenCalled();
  });

  it("never throws on odd payload shapes (it only returns invalid)", async () => {
    const { deps, reindex } = setup();
    for (const data of [undefined, 1, [], () => 1, Symbol.iterator as unknown]) {
      await expect(handleReindexJobs(deps, [{ id: "j", data }])).resolves.toMatchObject({
        invalid: 1,
        result: null,
      });
    }
    expect(reindex).not.toHaveBeenCalled();
  });
});
