import { beforeEach, describe, expect, it, vi } from "vitest";
import { downloadAndShare, shareLink } from "./share";

// Native share sheet and download-to-share (docs/plans/step-9.md 2.7, 2.15): the temp file takes
// an extension from the content type when the name has none, lives in Caches/ll-share, and is
// deleted afterwards whatever happens.

const FS = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
}));
const SHARE = vi.hoisted(() => ({ canShare: vi.fn(), share: vi.fn() }));
vi.mock("@capacitor/filesystem", () => ({ Filesystem: FS, Directory: { Cache: "CACHE" } }));
vi.mock("@capacitor/share", () => ({ Share: SHARE }));

const SIGNED = "https://storage.example.test/bucket/key?X-Amz-Signature=secret";

function stubDownload(type: string, ok = true) {
  // jsdom's Blob (what FileReader accepts), wrapped in the slice of Response the code uses.
  const fetchMock = vi.fn(async () =>
    ok
      ? ({
          ok: true,
          status: 200,
          blob: async () => new window.Blob([new Uint8Array([1, 2, 3])], { type }),
        } as unknown as Response)
      : ({ ok: false, status: 403 } as unknown as Response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  FS.mkdir.mockReset().mockResolvedValue(undefined);
  FS.writeFile
    .mockReset()
    .mockImplementation(async (o: { path: string }) => ({ uri: `file:///cache/${o.path}` }));
  FS.deleteFile.mockReset().mockResolvedValue(undefined);
  SHARE.canShare.mockReset().mockResolvedValue({ value: true });
  SHARE.share.mockReset().mockResolvedValue(undefined);
  vi.unstubAllGlobals();
});

describe("downloadAndShare: file name and extension", () => {
  it.each([
    ["image/jpeg", ".jpg"],
    ["image/heic", ".heic"],
    ["image/heif", ".heic"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["application/octet-stream", ".jpg"],
    ["", ".jpg"],
  ])("a name without an extension takes one from %s", async (type, ext) => {
    stubDownload(type);
    expect(await downloadAndShare(SIGNED, "Mia-2026-06-14")).toBe(true);
    const path = FS.writeFile.mock.calls[0]?.[0].path as string;
    expect(path.endsWith(ext)).toBe(true);
    expect(path.startsWith("ll-share/")).toBe(true);
  });

  it("a name that already has an extension keeps it", async () => {
    stubDownload("image/heic");
    await downloadAndShare(SIGNED, "Mia-2026-06-14.jpg");
    const path = FS.writeFile.mock.calls[0]?.[0].path as string;
    expect(path.endsWith("Mia-2026-06-14.jpg")).toBe(true);
    expect(path.endsWith(".jpg.heic")).toBe(false);
  });

  it("sanitises the name: no path separators, traversal or spaces end up in the path", async () => {
    stubDownload("image/jpeg");
    await downloadAndShare(SIGNED, "../../etc/passwd photo?.jpg");
    const path = FS.writeFile.mock.calls[0]?.[0].path as string;
    // one directory level only: no separator, no ".." segment, nothing but safe characters
    expect(path.split("/")).toHaveLength(2);
    expect(path.split("/")).not.toContain("..");
    expect(path.slice("ll-share/".length)).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("an empty or unusable name falls back to photo.jpg", async () => {
    stubDownload("image/jpeg");
    await downloadAndShare(SIGNED, "");
    expect(String(FS.writeFile.mock.calls[0]?.[0]?.path).endsWith("photo.jpg")).toBe(true);
  });

  it("writes into the cache directory as base64 and opens the share sheet with the file", async () => {
    stubDownload("image/jpeg");
    await downloadAndShare(SIGNED, "a.jpg");
    const arg = FS.writeFile.mock.calls[0]?.[0];
    expect(arg.directory).toBe("CACHE");
    expect(arg.data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(FS.mkdir).toHaveBeenCalledWith(
      expect.objectContaining({ path: "ll-share", directory: "CACHE", recursive: true }),
    );
    expect(SHARE.share).toHaveBeenCalledWith({ files: [`file:///cache/${arg.path}`] });
  });

  it("downloads without credentials", async () => {
    const f = stubDownload("image/jpeg");
    await downloadAndShare(SIGNED, "a.jpg");
    expect(f).toHaveBeenCalledWith(SIGNED, { credentials: "omit" });
  });
});

describe("downloadAndShare: cleanup and failures", () => {
  it("deletes the temp file after sharing", async () => {
    stubDownload("image/jpeg");
    await downloadAndShare(SIGNED, "a.jpg");
    const written = FS.writeFile.mock.calls[0]?.[0].path;
    expect(FS.deleteFile).toHaveBeenCalledWith({ path: written, directory: "CACHE" });
  });

  it("a dismissed share sheet is still a success and the file is deleted", async () => {
    stubDownload("image/jpeg");
    SHARE.share.mockRejectedValue(new Error("Share canceled"));
    expect(await downloadAndShare(SIGNED, "a.jpg")).toBe(true);
    expect(FS.deleteFile).toHaveBeenCalledTimes(1);
  });

  it("a rejected download (expired URL) returns false, shares nothing, writes nothing", async () => {
    stubDownload("image/jpeg", false);
    expect(await downloadAndShare(SIGNED, "a.jpg")).toBe(false);
    expect(FS.writeFile).not.toHaveBeenCalled();
    expect(SHARE.share).not.toHaveBeenCalled();
  });

  it("a network error returns false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    expect(await downloadAndShare(SIGNED, "a.jpg")).toBe(false);
  });

  it("a write failure returns false and still attempts the cleanup", async () => {
    stubDownload("image/jpeg");
    FS.writeFile.mockRejectedValue(new Error("disk full"));
    expect(await downloadAndShare(SIGNED, "a.jpg")).toBe(false);
    expect(FS.deleteFile).toHaveBeenCalled();
  });

  it("a failing cleanup never fails the share", async () => {
    stubDownload("image/jpeg");
    FS.deleteFile.mockRejectedValue(new Error("gone"));
    expect(await downloadAndShare(SIGNED, "a.jpg")).toBe(true);
  });

  it("never logs the signed URL", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => undefined),
    );
    stubDownload("image/jpeg", false);
    await downloadAndShare(SIGNED, "a.jpg");
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain("X-Amz");
  });
});

describe("shareLink", () => {
  it("shares the url and resolves true", async () => {
    expect(await shareLink({ url: "https://x.test/s/abc", title: "Album" })).toBe(true);
    expect(SHARE.share).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://x.test/s/abc", title: "Album" }),
    );
  });

  it("is false when sharing is unavailable", async () => {
    SHARE.canShare.mockResolvedValue({ value: false });
    expect(await shareLink({ url: "https://x.test/s/abc" })).toBe(false);
    expect(SHARE.share).not.toHaveBeenCalled();
  });

  it("is false when the user dismisses the sheet", async () => {
    SHARE.share.mockRejectedValue(new Error("canceled"));
    expect(await shareLink({ url: "https://x.test/s/abc" })).toBe(false);
  });
});
