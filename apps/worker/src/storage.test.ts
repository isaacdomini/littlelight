import { describe, expect, it } from "vitest";
import { createStorage, StorageError } from "./storage";

type DeleteInput = { Delete: { Objects: unknown[] } };
type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

/** An S3 `send` stub driven by a per-command function; records every command. */
function s3(handler: (name: string, input: Record<string, unknown>) => unknown) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    send: (async (c: Cmd) => {
      const name = c.constructor.name.replace(/Command$/, "");
      calls.push({ name, input: c.input });
      return handler(name, c.input);
    }) as never,
  };
}
const awsError = (name: string) =>
  Object.assign(new Error(`${name} at https://signed.example/secret?X-Amz-Signature=abc`), {
    name,
  });

describe("deleteAllVersions", () => {
  it("deletes versions and delete markers of the prefix, across pages", async () => {
    const pages = [
      {
        IsTruncated: true,
        NextKeyMarker: "p/b",
        NextVersionIdMarker: "v2",
        Versions: [
          { Key: "p/a", VersionId: "v1" },
          { Key: "p/a", VersionId: "v1b" },
          { Key: "p-other/x", VersionId: "vx" }, // not under the prefix: never deleted
        ],
        DeleteMarkers: [{ Key: "p/a", VersionId: "dm1" }],
      },
      { IsTruncated: false, Versions: [{ Key: "p/b", VersionId: "v3" }], DeleteMarkers: [] },
    ];
    const deletes: unknown[] = [];
    const client = s3((name, input) => {
      if (name === "ListObjectVersions") return pages.shift();
      if (name === "DeleteObjects") {
        deletes.push((input as DeleteInput).Delete.Objects);
        return {};
      }
      throw new Error(name);
    });
    const n = await createStorage(client, "bkt").deleteAllVersions("p/");
    expect(n).toBe(4);
    expect(deletes).toEqual([
      [
        { Key: "p/a", VersionId: "v1" },
        { Key: "p/a", VersionId: "v1b" },
        { Key: "p/a", VersionId: "dm1" },
      ],
      [{ Key: "p/b", VersionId: "v3" }],
    ]);
    const lists = client.calls.filter((c) => c.name === "ListObjectVersions");
    expect(lists[0]?.input.Prefix).toBe("p/");
    expect(lists[1]?.input).toMatchObject({ KeyMarker: "p/b", VersionIdMarker: "v2" });
    expect(client.calls.every((c) => c.input.Bucket === "bkt")).toBe(true);
  });

  it("is idempotent: nothing left means 0 and no DeleteObjects call", async () => {
    const client = s3(() => ({ IsTruncated: false }));
    expect(await createStorage(client, "b").deleteAllVersions("p/")).toBe(0);
    expect(client.calls.map((c) => c.name)).toEqual(["ListObjectVersions"]);
  });

  it("per-key delete errors throw a StorageError with the code only; NoSuchVersion is tolerated", async () => {
    const mk = (code: string) =>
      s3((name) =>
        name === "ListObjectVersions"
          ? { IsTruncated: false, Versions: [{ Key: "p/a", VersionId: "v" }] }
          : { Errors: [{ Key: "p/a", Code: code, Message: "secret detail" }] },
      );
    await expect(
      createStorage(mk("AccessDenied"), "b").deleteAllVersions("p/"),
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "AccessDenied",
    });
    await expect(createStorage(mk("NoSuchVersion"), "b").deleteAllVersions("p/")).resolves.toBe(1);
    const err = await createStorage(mk("AccessDenied"), "b")
      .deleteAllVersions("p/")
      .catch((e) => e);
    expect(err.message).not.toContain("secret detail");
  });

  it("SDK failures become StorageError(<error name>) without the SDK message (no URLs, no signatures)", async () => {
    const client = s3(() => {
      throw awsError("AccessDenied");
    });
    const err = await createStorage(client, "b")
      .deleteAllVersions("p/")
      .catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code).toBe("AccessDenied");
    expect(err.message).not.toContain("signed.example");
    expect(err.message).not.toContain("X-Amz");
  });

  it("refuses an empty prefix (would wipe the bucket)", async () => {
    const client = s3(() => ({}));
    await expect(createStorage(client, "b").deleteAllVersions("")).rejects.toMatchObject({
      code: "EmptyPrefix",
    });
    expect(client.calls).toEqual([]);
  });

  it("versions without a VersionId (unversioned bucket) are deleted by key", async () => {
    const deletes: unknown[] = [];
    const client = s3((name, input) => {
      if (name === "ListObjectVersions") return { IsTruncated: false, Versions: [{ Key: "p/a" }] };
      deletes.push((input as DeleteInput).Delete.Objects);
      return {};
    });
    await createStorage(client, "b").deleteAllVersions("p/");
    expect(deletes).toEqual([[{ Key: "p/a" }]]);
  });
});

describe("getObject", () => {
  const body = (bytes: Uint8Array) => ({
    transformToByteArray: async () => bytes,
    destroy: () => undefined,
  });

  it("returns the bytes as a Buffer", async () => {
    const client = s3(() => ({ ContentLength: 3, Body: body(new Uint8Array([1, 2, 3])) }));
    expect(await createStorage(client, "b").getObject("k")).toEqual(Buffer.from([1, 2, 3]));
  });

  it("refuses objects over the cap by ContentLength (without reading the body) and by actual size", async () => {
    let read = false;
    const big = s3(() => ({
      ContentLength: 11,
      Body: {
        transformToByteArray: async () => {
          read = true;
          return new Uint8Array(11);
        },
        destroy: () => undefined,
      },
    }));
    await expect(createStorage(big, "b", 10).getObject("k")).rejects.toMatchObject({
      code: "ObjectTooLarge",
    });
    expect(read).toBe(false);
    const liar = s3(() => ({ ContentLength: 5, Body: body(new Uint8Array(11)) }));
    await expect(createStorage(liar, "b", 10).getObject("k")).rejects.toMatchObject({
      code: "ObjectTooLarge",
    });
  });

  it("missing body and SDK errors are StorageErrors", async () => {
    await expect(
      createStorage(
        s3(() => ({})),
        "b",
      ).getObject("k"),
    ).rejects.toMatchObject({ code: "EmptyBody" });
    const nf = s3(() => {
      throw awsError("NoSuchKey");
    });
    await expect(createStorage(nf, "b").getObject("k")).rejects.toMatchObject({
      code: "NoSuchKey",
    });
  });

  it("odd error names collapse to the generic code", async () => {
    const weird = s3(() => {
      throw Object.assign(new Error("x"), { name: "bad name with spaces/and-slashes" });
    });
    await expect(createStorage(weird, "b").getObject("k")).rejects.toMatchObject({ code: "error" });
  });
});

describe("putObject / multipart", () => {
  it("putObject sends content type, length and cache control", async () => {
    const client = s3(() => ({}));
    await createStorage(client, "b").putObject("k", Buffer.from("abc"), "image/jpeg", {
      cacheControl: "private, max-age=3600",
    });
    expect(client.calls[0]?.input).toMatchObject({
      Bucket: "b",
      Key: "k",
      ContentType: "image/jpeg",
      ContentLength: 3,
      CacheControl: "private, max-age=3600",
    });
  });

  it("abortMultipartUpload treats NoSuchUpload as success and rethrows other failures", async () => {
    await expect(
      createStorage(
        s3(() => {
          throw awsError("NoSuchUpload");
        }),
        "b",
      ).abortMultipartUpload("k", "u"),
    ).resolves.toBeUndefined();
    await expect(
      createStorage(
        s3(() => {
          throw awsError("AccessDenied");
        }),
        "b",
      ).abortMultipartUpload("k", "u"),
    ).rejects.toMatchObject({ code: "AccessDenied" });
  });

  it("listMultipartUploads pages through markers and filters on the prefix client-side", async () => {
    const pages = [
      {
        IsTruncated: true,
        NextKeyMarker: "babies/a",
        NextUploadIdMarker: "u1",
        Uploads: [{ Key: "babies/a", UploadId: "u1", Initiated: new Date(0) }],
      },
      {
        IsTruncated: false,
        Uploads: [
          { Key: "babies/b", UploadId: "u2" },
          { Key: "other/x", UploadId: "u3" },
          { Key: "babies/c" },
        ],
      },
    ];
    const client = s3(() => pages.shift());
    const out = await createStorage(client, "b").listMultipartUploads("babies/");
    expect(out).toEqual([
      { key: "babies/a", uploadId: "u1", initiated: new Date(0) },
      { key: "babies/b", uploadId: "u2", initiated: null },
    ]);
    expect(client.calls[1]?.input).toMatchObject({ KeyMarker: "babies/a", UploadIdMarker: "u1" });
    // MinIO only matches Prefix exactly on this call, so it must not be sent.
    expect(client.calls[0]?.input).not.toHaveProperty("Prefix");
  });
});
