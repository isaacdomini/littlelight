import { describe, expect, it } from "vitest";
import { handleReindexJob } from "./reindex";
import { recordingLog } from "./testing/stubs";

const PHOTO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BABY = "11111111-1111-4111-8111-111111111111";
const valid = { photoId: PHOTO, babyId: BABY, reason: "details" };

describe("handleReindexJob (no-op until step 7)", () => {
  it("drops a malformed payload with a warning that carries only the job id", async () => {
    for (const data of [
      null,
      {},
      "x",
      { ...valid, reason: "nope" },
      { ...valid, photoId: "p1" },
      { ...valid, note: "first steps" },
      { photoId: PHOTO, babyId: BABY },
    ]) {
      const log = recordingLog();
      const out = await handleReindexJob({ log }, { id: "job-1", data });
      expect(out).toEqual({ outcome: "invalid" });
      const warns = log.lines.filter((l) => l.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.obj).toEqual({ jobId: "job-1" });
      expect(JSON.stringify(log.lines)).not.toContain("first steps");
    }
  });

  it("a valid payload is a no-op that logs ids and the reason only", async () => {
    const log = recordingLog();
    const out = await handleReindexJob({ log }, { id: "job-2", data: valid });
    expect(out).toEqual({ outcome: "noop", job: valid });
    expect(log.lines.filter((l) => l.level === "warn" || l.level === "error")).toEqual([]);
    const line = log.lines.find((l) => l.level === "debug");
    expect(Object.keys(line?.obj ?? {}).sort()).toEqual(["babyId", "jobId", "photoId", "reason"]);
  });

  it("takes logger-only dependencies: no pool, storage or client can be reached", async () => {
    // The deps type is { log }; passing extra properties is a type error, and at run time the
    // handler must work with exactly that and nothing else.
    const log = recordingLog();
    await expect(handleReindexJob({ log }, { id: "j", data: valid })).resolves.toBeDefined();
  });

  it("never throws, whatever the payload", async () => {
    const log = recordingLog();
    for (const data of [undefined, 1, [], () => 1, Symbol.iterator as unknown]) {
      await expect(handleReindexJob({ log }, { id: "j", data })).resolves.toEqual({
        outcome: "invalid",
      });
    }
  });
});
