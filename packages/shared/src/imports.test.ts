import { describe, expect, it } from "vitest";
import {
  GOOGLE_ENDPOINTS,
  GOOGLE_MEDIA_HOST_SUFFIX_DEFAULT,
  GOOGLE_PICKER_SCOPE,
  IMPORT_ALBUM_TITLE_MAX,
  IMPORT_BATCH_MAX_ITEMS,
  IMPORT_BATCHES_PER_BABY_PER_DAY,
  IMPORT_BATCHES_PER_USER_PER_HOUR,
  IMPORT_CONNECTS_PER_USER_PER_HOUR,
  IMPORT_DEVICE_LABEL_MAX,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_PICKER_POLL_MIN_SEC,
  IMPORT_PICKING_TTL_MIN,
  IMPORT_SOURCES_PER_BABY_MAX,
  SYNC_ASSET_MAX_ATTEMPTS,
  SYNC_BACKGROUND_BATCH,
  SYNC_BG_TASK_ID,
  SYNC_FOREGROUND_BATCH,
  SYNC_LANE_CONCURRENCY,
  SYNC_MIN_INTERVAL_SEC,
} from "./imports";
import { UPLOAD_MAX_FILE_BYTES, UPLOAD_MAX_FILES_PER_SESSION } from "./upload";

describe("photo import constants (docs/plans/step-10.md 2.3)", () => {
  it("batch and file limits keep parity with the upload pipeline", () => {
    expect(IMPORT_BATCH_MAX_ITEMS).toBe(UPLOAD_MAX_FILES_PER_SESSION);
    expect(IMPORT_BATCH_MAX_ITEMS).toBe(500);
    expect(IMPORT_MAX_FILE_BYTES).toBe(UPLOAD_MAX_FILE_BYTES);
  });

  it("rate limits and caps", () => {
    expect(IMPORT_BATCHES_PER_BABY_PER_DAY).toBe(20);
    expect(IMPORT_BATCHES_PER_USER_PER_HOUR).toBe(10);
    expect(IMPORT_CONNECTS_PER_USER_PER_HOUR).toBe(10);
    expect(IMPORT_SOURCES_PER_BABY_MAX).toBe(10);
    expect(IMPORT_PICKER_POLL_MIN_SEC).toBe(3);
    expect(IMPORT_PICKING_TTL_MIN).toBe(30);
  });

  it("label limits", () => {
    expect(IMPORT_DEVICE_LABEL_MAX).toBe(60);
    expect(IMPORT_ALBUM_TITLE_MAX).toBe(120);
  });

  it("sync tuning", () => {
    expect(SYNC_FOREGROUND_BATCH).toBe(50);
    expect(SYNC_BACKGROUND_BATCH).toBe(25);
    expect(SYNC_BACKGROUND_BATCH).toBeLessThan(SYNC_FOREGROUND_BATCH);
    expect(SYNC_LANE_CONCURRENCY).toBe(2);
    expect(SYNC_ASSET_MAX_ATTEMPTS).toBe(3);
    expect(SYNC_MIN_INTERVAL_SEC).toBe(60);
    expect(SYNC_BG_TASK_ID).toBe("com.tesarsoft.littlelight.sync");
  });

  it("asks for the Picker scope only, over https endpoints", () => {
    expect(GOOGLE_PICKER_SCOPE).toBe(
      "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
    );
    for (const url of Object.values(GOOGLE_ENDPOINTS))
      expect(url.startsWith("https://")).toBe(true);
    expect(GOOGLE_ENDPOINTS.PICKER).toBe("https://photospicker.googleapis.com");
    expect(GOOGLE_MEDIA_HOST_SUFFIX_DEFAULT).toBe("googleusercontent.com");
  });
});
