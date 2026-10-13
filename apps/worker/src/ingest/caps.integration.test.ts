import { originalKey, photoPrefixes } from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAP_MESSAGES, refusingPool } from "../testing/cap-refusal";
import { createHarness, type Harness, integrationEnv } from "../testing/harness";
import { sceneJpeg } from "../testing/images";
import { FINISH_PHOTO_SQL } from "./common";
import { ingestPhoto } from "./index";

// Review fix S1 (docs/plans/step-12.md 2.3; migration 22): when a cap trigger refuses the
// `failed → ingested` finish (23514 with one of three fixed messages: the family photo pool, the
// free-tier video count or the uploader's pending queue filled up between the register and this
// re-run), the ingest ends `failed` with `free_tier_limit` / `pending_limit`, the original and the
// derivatives are deleted and the error does not propagate (no retry: the limit is a fact). The
// trigger is simulated by a pool whose client throws the exact Postgres error on FINISH_PHOTO_SQL,
// so the test covers the worker's handling independently of the trigger's own tests (packages/db).
// The video path (FINISH_VIDEO_SQL) is covered next to the other ffmpeg cases in
// ../video/video.integration.test.ts.

describe.skipIf(!integrationEnv)("ingest: cap trigger refusals at finish (S1)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it.each([
    ["free tier photo limit…", CAP_MESSAGES.photo, "free_tier_limit"],
    ["free tier video limit…", CAP_MESSAGES.video, "free_tier_limit"],
    ["pending photo limit…", CAP_MESSAGES.pending, "pending_limit"],
  ])(
    "image path: FINISH_PHOTO_SQL refused with '%s' → failed/%s, original and derivatives deleted, no throw",
    async (_n, message, error) => {
      const baby = await h.baby();
      const s = await h.seedUpload({ baby, bytes: await sceneJpeg(640, 480, 7) });
      const hits: string[] = [];
      const deps = h.deps({
        pool: refusingPool(h.workerPool, { [FINISH_PHOTO_SQL]: message }, hits),
      });
      const r = await ingestPhoto(deps, { photoId: s.id, babyId: baby.id });
      expect(r).toMatchObject({ outcome: "failed", error });
      expect(hits).toEqual([FINISH_PHOTO_SQL]);
      expect(
        await h.one("SELECT status, media_kind FROM photos WHERE id = $1", [s.id]),
      ).toMatchObject({ status: "failed", media_kind: "photo" });
      expect(await h.one("SELECT state, error FROM upload_files WHERE id = $1", [s.id])).toEqual({
        state: "failed",
        error,
      });
      expect(await h.versionCount(originalKey(baby.id, s.id))).toBe(0);
      for (const prefix of photoPrefixes(baby.id, s.id)) {
        expect(await h.versionCount(prefix), prefix).toBe(0);
      }
    },
  );

  it("a 23514 with any other message is not a cap: it propagates (pg-boss retries) and nothing is deleted", async () => {
    const baby = await h.baby();
    const s = await h.seedUpload({ baby, bytes: await sceneJpeg(640, 480, 7) });
    const deps = h.deps({
      pool: refusingPool(h.workerPool, {
        [FINISH_PHOTO_SQL]:
          'new row for relation "photos" violates check constraint "photos_shape"',
      }),
    });
    await expect(ingestPhoto(deps, { photoId: s.id, babyId: baby.id })).rejects.toMatchObject({
      code: "23514",
    });
    expect(await h.one("SELECT status FROM photos WHERE id = $1", [s.id])).not.toEqual({
      status: "failed",
    });
    expect(await h.versionCount(originalKey(baby.id, s.id))).toBe(1);
  });
});
