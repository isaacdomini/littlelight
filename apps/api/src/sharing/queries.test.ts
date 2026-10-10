import { viewerPhotoSchema, viewerPhotosResponseSchema } from "@tinyglow/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/errors";
import type { SignGetOptions, UrlSigner } from "../storage/sign";
import {
  sharedBy,
  signViewerKey,
  strictViewerBody,
  toViewerPhoto,
  type ViewerPhotoRow,
} from "./queries";

// Pure parts of the sharing queries (docs/plans/step-8.md 2.6; PRD "Privacy and child safety":
// signed URLs scoped to one object, never originals, never the analysis copy).

const BABY = "11111111-1111-4111-8111-111111111111";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const key = (photo: string, kind: string) => `babies/${BABY}/derivatives/${photo}/${kind}.jpg`;

function recordingSigner() {
  const calls: { key: string; opts: SignGetOptions | undefined }[] = [];
  const signer: UrlSigner = {
    async signGet(k, opts) {
      calls.push({ key: k, opts });
      return { url: `https://files.test/${k}?sig=x`, expiresAt: new Date("2026-10-08T12:05:00Z") };
    },
    async signUploadPart() {
      throw new Error("not for viewers");
    },
  };
  return { signer, calls };
}

/** `signViewerKey` throws synchronously for a bad key; callers await it, so both shapes count. */
async function refused(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

describe("signViewerKey", () => {
  it("signs this photo's thumb or display key and forwards the TTL and disposition", async () => {
    const { signer, calls } = recordingSigner();
    const a = await signViewerKey(signer, key(P1, "thumb"), P1, "thumb", 120);
    expect(a.url).toContain(key(P1, "thumb"));
    await signViewerKey(
      signer,
      key(P1, "display"),
      P1,
      "display",
      60,
      'attachment; filename="a.jpg"',
    );
    expect(calls[0]?.opts).toEqual({ ttlSec: 120 });
    expect(calls[1]?.opts).toEqual({
      ttlSec: 60,
      contentDisposition: 'attachment; filename="a.jpg"',
    });
  });

  it("refuses an original, an analysis derivative and every other key shape (500, nothing signed)", async () => {
    const { signer, calls } = recordingSigner();
    const bad = [
      `babies/${BABY}/originals/${P1}`,
      key(P1, "analysis"),
      `babies/${BABY}/derivatives/${P1}/original.jpg`,
      `babies/${BABY}/derivatives/${P1}/thumb.png`,
      `babies/${BABY}/derivatives/${P1}/thumb.jpg/../../originals/${P1}`,
      `../babies/${BABY}/derivatives/${P1}/thumb.jpg`,
      `x/babies/${BABY}/derivatives/${P1}/thumb.jpg`,
      `babies/${BABY}/derivatives/${P1}/thumb.jpg?x=1`,
      "",
    ];
    for (const k of bad) {
      expect(await refused(() => signViewerKey(signer, k, P1, "thumb", 60)), k).toMatchObject({
        status: 500,
        code: "internal",
      });
    }
    expect(calls).toEqual([]);
  });

  it("refuses another photo's key and a kind mismatch", async () => {
    const { signer, calls } = recordingSigner();
    for (const [k, photo, kind] of [
      [key(P2, "thumb"), P1, "thumb"],
      [key(P1, "display"), P1, "thumb"],
      [key(P1, "thumb"), P1, "display"],
    ] as const) {
      const err = await refused(() => signViewerKey(signer, k, photo, kind, 60));
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 500 });
    }
    expect(calls).toEqual([]);
  });
});

describe("toViewerPhoto", () => {
  const row = (over: Partial<ViewerPhotoRow> = {}): ViewerPhotoRow => ({
    id: P1,
    taken_at: "2026-06-14",
    taken_at_estimated: false,
    age_days: 105,
    width: 800,
    height: 600,
    sort_key: "2026-06-14T10:00:00.000000Z",
    hidden: false,
    milestone_id: null,
    milestone_name: null,
    thumb_key: key(P1, "thumb"),
    ...over,
  });

  it("a visible photo gets a thumb URL and exactly the viewer photo keys", async () => {
    const { signer } = recordingSigner();
    const out = await toViewerPhoto(signer, row(), 120);
    expect(viewerPhotoSchema.parse(out)).toEqual(out);
    expect(Object.keys(out).sort()).toEqual(
      [
        "ageDays",
        "height",
        "hidden",
        "id",
        "milestone",
        "takenAt",
        "takenAtEstimated",
        "thumbUrl",
        "urlExpiresAt",
        "width",
      ].sort(),
    );
    expect(out.thumbUrl).toContain(key(P1, "thumb"));
  });

  it("a hidden photo never gets a URL, even if a storage key came back, and the signer is not called", async () => {
    const { signer, calls } = recordingSigner();
    const out = await toViewerPhoto(signer, row({ hidden: true }), 120);
    expect(out.hidden).toBe(true);
    expect(out.thumbUrl).toBeNull();
    expect(out.urlExpiresAt).toBeNull();
    expect(calls).toEqual([]);
  });

  it("no thumb key means no URL", async () => {
    const { signer } = recordingSigner();
    expect((await toViewerPhoto(signer, row({ thumb_key: null }), 120)).thumbUrl).toBeNull();
  });

  it("maps a milestone only when both id and name exist", async () => {
    const { signer } = recordingSigner();
    const m = await toViewerPhoto(
      signer,
      row({ milestone_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", milestone_name: "First steps" }),
      60,
    );
    expect(m.milestone).toEqual({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "First steps",
    });
    expect((await toViewerPhoto(signer, row({ milestone_id: "x" }), 60)).milestone).toBeNull();
  });
});

describe("strictViewerBody", () => {
  const log = () => ({ error: vi.fn() }) as never;
  const photo = {
    id: P1,
    takenAt: null,
    takenAtEstimated: false,
    ageDays: null,
    width: null,
    height: null,
    milestone: null,
    hidden: false,
    thumbUrl: null,
    urlExpiresAt: null,
  };

  it("returns the parsed body when it matches the schema", () => {
    const body = { photos: [photo], nextCursor: null };
    expect(strictViewerBody(viewerPhotosResponseSchema, body, log())).toEqual(body);
  });

  it("turns an extra key into a 500 and logs field paths only (never the value)", () => {
    for (const extra of [
      { babyId: BABY },
      { caption: "SECRET-CAPTION" },
      { isSensitive: true },
      { displayUrl: "https://files.test/x" },
      { gps: { lat: 1, lng: 2 } },
    ]) {
      const l = { error: vi.fn() };
      let thrown: unknown;
      try {
        strictViewerBody(
          viewerPhotosResponseSchema,
          { photos: [{ ...photo, ...extra }], nextCursor: null },
          l as never,
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown, JSON.stringify(extra)).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).status).toBe(500);
      expect((thrown as ApiError).code).toBe("internal");
      expect(JSON.stringify(l.error.mock.calls)).not.toContain("SECRET-CAPTION");
      expect(l.error).toHaveBeenCalledTimes(1);
    }
  });

  it("a hidden photo that carries a URL is refused", () => {
    expect(() =>
      strictViewerBody(
        viewerPhotosResponseSchema,
        {
          photos: [
            {
              ...photo,
              hidden: true,
              thumbUrl: "https://files.test/x",
              urlExpiresAt: "2026-10-08T12:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
        log(),
      ),
    ).toThrow(ApiError);
  });
});

describe("sharedBy", () => {
  it("maps anything but `rule` to `user`", () => {
    expect(sharedBy("rule")).toBe("rule");
    expect(sharedBy("user")).toBe("user");
    expect(sharedBy("other")).toBe("user");
  });
});
