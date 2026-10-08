import { describe, expect, it } from "vitest";
import { createS3Stub, s3Error } from "../testing/s3-stub";
import { isInvalidParts, isMissingObject, isNoSuchUpload, MultipartStorage } from "./multipart";

describe("S3 error classifiers", () => {
  it("isNoSuchUpload by name or Code, false for anything else", () => {
    expect(isNoSuchUpload(s3Error("NoSuchUpload", 404))).toBe(true);
    expect(isNoSuchUpload({ Code: "NoSuchUpload" })).toBe(true);
    expect(isNoSuchUpload(s3Error("AccessDenied", 403))).toBe(false);
    expect(isNoSuchUpload(null)).toBe(false);
    expect(isNoSuchUpload("NoSuchUpload")).toBe(false);
  });

  it("isMissingObject is true for 404 / NotFound / NoSuchKey, false for 403", () => {
    expect(isMissingObject(s3Error("NotFound", 404))).toBe(true);
    expect(isMissingObject(s3Error("NoSuchKey"))).toBe(true);
    expect(isMissingObject(s3Error("Whatever", 404))).toBe(true);
    expect(isMissingObject(s3Error("Forbidden", 403))).toBe(false);
    expect(isMissingObject(undefined)).toBe(false);
  });

  it("isInvalidParts covers the part-level Complete failures", () => {
    for (const n of ["InvalidPart", "InvalidPartOrder", "EntityTooSmall"]) {
      expect(isInvalidParts(s3Error(n, 400))).toBe(true);
    }
    expect(isInvalidParts(s3Error("InternalError", 500))).toBe(false);
  });
});

describe("MultipartStorage (stubbed S3)", () => {
  const make = () => {
    const s3 = createS3Stub();
    return { s3, mp: new MultipartStorage(s3, "bkt") };
  };

  it("create returns the upload id and passes the bucket and key", async () => {
    const { s3, mp } = make();
    const id = await mp.create("k1");
    expect(id).toMatch(/^upload-/);
    expect(s3.calls[0]).toMatchObject({
      name: "CreateMultipartUpload",
      input: { Bucket: "bkt", Key: "k1" },
    });
  });

  it("create throws when S3 answers without an UploadId", async () => {
    const mp = new MultipartStorage(
      { send: (async () => ({})) as never, destroy: () => undefined },
      "b",
    );
    await expect(mp.create("k")).rejects.toThrow(/UploadId/);
  });

  it("listParts is sorted and complete() sends ascending part numbers with etags", async () => {
    const { s3, mp } = make();
    const id = await mp.create("k");
    s3.putPart("k", 2, 5);
    s3.putPart("k", 1, 16);
    const parts = await mp.listParts("k", id);
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
    await mp.complete("k", id, parts);
    expect(s3.objects.get("k")).toBe(21);
    const sent = s3.calls.find((c) => c.name === "CompleteMultipartUpload");
    if (!sent) throw new Error("CompleteMultipartUpload was not sent");
    const sentParts = (sent.input.MultipartUpload as { Parts: { PartNumber: number }[] }).Parts;
    expect(sentParts.map((p) => p.PartNumber)).toEqual([1, 2]);
  });

  it("listParts paginates through NextPartNumberMarker", async () => {
    const pages = [
      {
        IsTruncated: true,
        NextPartNumberMarker: "2",
        Parts: [
          { PartNumber: 2, ETag: "e2", Size: 1 },
          { PartNumber: 1, ETag: "e1", Size: 1 },
        ],
      },
      { IsTruncated: false, Parts: [{ PartNumber: 3, ETag: "e3", Size: 1 }] },
    ];
    const markers: unknown[] = [];
    const mp = new MultipartStorage(
      {
        send: (async (c: { input: { PartNumberMarker?: string } }) => {
          markers.push(c.input.PartNumberMarker);
          return pages.shift();
        }) as never,
        destroy: () => undefined,
      },
      "b",
    );
    expect((await mp.listParts("k", "u")).map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(markers).toEqual([undefined, "2"]);
  });

  it("listParts ignores malformed part entries", async () => {
    const mp = new MultipartStorage(
      {
        send: (async () => ({
          Parts: [{ PartNumber: 1 }, { ETag: "x" }, { PartNumber: 2, ETag: "e" }],
        })) as never,
        destroy: () => undefined,
      },
      "b",
    );
    expect(await mp.listParts("k", "u")).toEqual([{ partNumber: 2, size: 0, etag: "e" }]);
  });

  it("abort swallows NoSuchUpload but rethrows anything else", async () => {
    const { s3, mp } = make();
    await expect(mp.abort("k", "gone")).resolves.toBeUndefined();
    s3.failNext("AbortMultipartUpload", s3Error("AccessDenied", 403));
    await expect(mp.abort("k", "gone")).rejects.toMatchObject({ name: "AccessDenied" });
  });

  it("objectSize: size, null when missing, throws on 403", async () => {
    const { s3, mp } = make();
    s3.putObject("here", 42);
    expect(await mp.objectSize("here")).toBe(42);
    expect(await mp.objectSize("nope")).toBeNull();
    s3.failNext("HeadObject", s3Error("Forbidden", 403));
    await expect(mp.objectSize("here")).rejects.toMatchObject({ name: "Forbidden" });
  });
});
