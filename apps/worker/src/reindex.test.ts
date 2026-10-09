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
      expect(out).toEqual({ photoIds: [], invalid: 1, result: null, autoShare: null });
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
    expect(await handleReindexJobs(deps, [])).toEqual({
      photoIds: [],
      invalid: 0,
      result: null,
      autoShare: null,
    });
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

describe("handleReindexJobs auto-share hook (step 8, docs/plans/step-8.md 2.8)", () => {
  const shareResult = { links: 1, photos: 2, added: 1, removed: 0, skipped: 0 };

  it("runs auto-share before indexing, with the same de-duplicated ids, and reports its result", async () => {
    const order: string[] = [];
    const evaluatePhotos = vi.fn(async (_ids: string[]) => {
      order.push("autoshare");
      return shareResult;
    });
    const { log, reindex } = setup();
    reindex.mockImplementation(async (ids: string[]) => {
      order.push("index");
      return { indexed: ids.length } as never;
    });
    const out = await handleReindexJobs(
      { indexer: { reindex }, autoSharer: { evaluatePhotos }, log },
      [
        { id: "1", data: valid },
        { id: "2", data: { ...valid, photoId: PHOTO2, reason: "ai" } },
        { id: "3", data: valid },
      ],
    );
    expect(order).toEqual(["autoshare", "index"]);
    expect(evaluatePhotos).toHaveBeenCalledTimes(1);
    expect(evaluatePhotos).toHaveBeenCalledWith([PHOTO, PHOTO2]);
    expect(reindex.mock.calls[0]?.[0]).toEqual([PHOTO, PHOTO2]);
    expect(out.autoShare).toEqual(shareResult);
  });

  it("an auto-share failure is logged (category only) and never blocks indexing", async () => {
    const evaluatePhotos = vi.fn(async () => {
      throw Object.assign(new Error("boom: secret note text"), { code: "57P01" });
    });
    const { log, reindex } = setup();
    const out = await handleReindexJobs(
      { indexer: { reindex }, autoSharer: { evaluatePhotos }, log },
      [{ id: "1", data: valid }],
    );
    expect(reindex).toHaveBeenCalledTimes(1);
    expect(out.result).not.toBeNull();
    expect(out.autoShare).toBeNull();
    const warns = log.lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).not.toContain("secret note text");
  });

  it("an indexer failure still propagates after auto-share ran", async () => {
    const evaluatePhotos = vi.fn(async () => shareResult);
    const { log, reindex } = setup();
    reindex.mockRejectedValueOnce(new Error("db down"));
    await expect(
      handleReindexJobs({ indexer: { reindex }, autoSharer: { evaluatePhotos }, log }, [
        { id: "1", data: valid },
      ]),
    ).rejects.toThrow("db down");
    expect(evaluatePhotos).toHaveBeenCalledTimes(1);
  });

  it("auto-share is not called when the whole batch is invalid", async () => {
    const evaluatePhotos = vi.fn(async () => shareResult);
    const { log, reindex } = setup();
    const out = await handleReindexJobs(
      { indexer: { reindex }, autoSharer: { evaluatePhotos }, log },
      [{ id: "1", data: { nope: true } }],
    );
    expect(evaluatePhotos).not.toHaveBeenCalled();
    expect(out.autoShare).toBeNull();
  });
});
