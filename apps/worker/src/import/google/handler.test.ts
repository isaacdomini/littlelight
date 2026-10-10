import { randomUUID } from "node:crypto";
import type { PickerMediaItem } from "@tinyglow/shared";
import { describe, expect, it, vi } from "vitest";
import { recordingLog, scriptedPool } from "../../testing/stubs";
import {
  classifyItem,
  createTokenSource,
  handleImportGoogleJob,
  ImportRetryError,
  ingestPayload,
  stateError,
} from "./handler";

const item = (
  over: Partial<PickerMediaItem["mediaFile"]> = {},
  type: PickerMediaItem["type"] = "PHOTO",
): PickerMediaItem => ({
  id: "G-1",
  createTime: "2026-03-01T09:00:00Z",
  type,
  mediaFile: { baseUrl: "https://lh3.googleusercontent.com/a", mimeType: "image/jpeg", ...over },
});

describe("stateError (requester state -> batch error)", () => {
  it.each([
    ["ok", null],
    ["not_active", "skip"],
    ["baby_trashed", "baby_trashed"],
    ["not_connected", "google_reconnect"],
    ["reconnect", "google_reconnect"],
    ["not_member", "requester_not_member"],
    ["", "requester_not_member"],
    ["something new", "requester_not_member"],
  ])("%j -> %j", (state, out) => {
    expect(stateError(state)).toBe(out);
  });
});

describe("classifyItem", () => {
  it.each([
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/heif",
    "image/webp",
    "IMAGE/JPEG",
    "image/jpeg; charset=x",
  ])("accepts %s", (mime) => {
    expect(classifyItem(item({ mimeType: mime }))).toMatchObject({
      status: "pending",
      error: null,
    });
  });

  it.each(["image/gif", "image/tiff", "video/mp4", "application/pdf", "image/svg+xml", ""])(
    "skips %j as unsupported",
    (mime) => {
      expect(classifyItem(item({ mimeType: mime }))).toMatchObject({
        status: "skipped",
        error: "unsupported_media_type",
        mime: null,
      });
    },
  );

  it("skips VIDEO and unspecified types even with an image mime", () => {
    expect(classifyItem(item({}, "VIDEO")).status).toBe("skipped");
    expect(classifyItem(item({}, "TYPE_UNSPECIFIED")).status).toBe("skipped");
  });

  it("keeps only sane dimensions", () => {
    expect(classifyItem(item({ mediaFileMetadata: { width: 640, height: 480 } }))).toMatchObject({
      width: 640,
      height: 480,
    });
    expect(classifyItem(item({ mediaFileMetadata: { width: 0, height: -1 } }))).toMatchObject({
      width: null,
      height: null,
    });
    expect(classifyItem(item({ mediaFileMetadata: { width: 3e12, height: 1 } }))).toMatchObject({
      width: null,
      height: 1,
    });
  });
});

describe("ingestPayload", () => {
  const P = randomUUID();
  const B = randomUUID();
  it("carries the batch time zone when valid", () => {
    expect(ingestPayload(P, B, "Europe/Paris")).toEqual({
      photoId: P,
      babyId: B,
      tzHint: "Europe/Paris",
    });
  });
  it("drops an invalid or missing time zone", () => {
    expect(ingestPayload(P, B, "Mars/Olympus")).toEqual({ photoId: P, babyId: B });
    expect(ingestPayload(P, B, null)).toEqual({ photoId: P, babyId: B });
  });
});

describe("createTokenSource", () => {
  it("returns the first token and refreshes single-flight on a stale one", async () => {
    let n = 0;
    const mint = vi.fn(async () => `tok-${++n}`);
    const src = createTokenSource(mint, "tok-0");
    expect(await src.get()).toBe("tok-0");
    const [a, b] = await Promise.all([src.refresh("tok-0"), src.refresh("tok-0")]);
    expect(a).toBe("tok-1");
    expect(b).toBe("tok-1");
    expect(mint).toHaveBeenCalledTimes(1);
    expect(await src.get()).toBe("tok-1");
  });

  it("a caller holding an already-replaced token gets the current one without a mint", async () => {
    const mint = vi.fn(async () => "new");
    const src = createTokenSource(mint, "cur");
    expect(await src.refresh("older")).toBe("cur");
    expect(mint).not.toHaveBeenCalled();
  });

  it("a failed mint can be retried", async () => {
    const mint = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("ok");
    const src = createTokenSource(mint, "t");
    await expect(src.refresh("t")).rejects.toThrow();
    expect(await src.refresh("t")).toBe("ok");
  });
});

describe("handleImportGoogleJob", () => {
  const deps = () => ({
    pool: scriptedPool(),
    storage: { putObjectStream: vi.fn(), deleteAllVersions: vi.fn() },
    dataKey: "k",
    google: null,
    download: { allowList: { hostSuffixes: [], exactOrigins: [] }, maxBytes: 1 },
    concurrency: 1,
    sendIngest: vi.fn(),
    log: recordingLog(),
  });
  const job = (data: unknown) => ({ id: "j", data, retryCount: 0, retryLimit: 2 });

  it("drops a malformed or over-full payload without touching the database", async () => {
    const d = deps();
    for (const data of [
      {},
      { batchId: "x", babyId: "y" },
      { batchId: randomUUID(), babyId: randomUUID(), token: "ya29.x" },
    ]) {
      expect(await handleImportGoogleJob(d as never, job(data) as never)).toBeNull();
    }
    expect(d.pool.log).toEqual([]);
    expect(d.log.lines.filter((l) => l.level === "warn")).toHaveLength(3);
    expect(JSON.stringify(d.log.lines)).not.toContain("ya29");
  });

  it("a batch that does not exist is dropped as skipped", async () => {
    const d = deps();
    const r = await handleImportGoogleJob(
      d as never,
      job({ batchId: randomUUID(), babyId: randomUUID() }) as never,
    );
    expect(r?.outcome).toBe("skipped");
  });

  it("ImportRetryError carries a category only", () => {
    const e = new ImportRetryError("storage_error");
    expect(e.message).toBe("import retry: storage_error");
    expect(e.category).toBe("storage_error");
  });
});
