// Visual check for video uploads (step 12, task 12.8): the upload rows (a clip mid-upload with
// per-part progress, the free-plan "too long" and "too large" refusals, a failed transcode), the
// timeline with duration-badged video tiles and the All / Photos / Videos chips, the viewer in
// its ready / "Preparing video…" / failed states, the family usage line with the video count and
// the share-link viewer playing and offering the MP4 download. The whole API is mocked with
// Playwright routes (no dev stack, no dev DB). Point E2E_BASE_URL at any web build (e.g. a local
// `vite --port 5199`). Tiny real MP4s are rendered with ffmpeg when it is on PATH (so the browser
// can read their duration); otherwise opaque bytes stand in. Output next to the other shots:
// apps/mobile-web/.vite/screenshots/<scheme>-<size>/video-*.png
//
//   E2E_BASE_URL=http://localhost:5199 pnpm exec tsx apps/mobile-web/scripts/screenshots-video.ts [--scheme=dark] [--size=phone] [--scene=a,b]
//
// Google Chrome (`channel: "chrome"`) is preferred over Playwright's Chromium, which cannot
// demux H.264; set SCREENSHOT_CHANNEL=chromium to force the bundled build.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium, expect, type Page, type Route } from "@playwright/test";
import { MAYA } from "../../../e2e/helpers/demo";
import { tid } from "../../../e2e/helpers/ui";
import { sceneJpeg } from "../../worker/src/testing/images";

const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;
const OUT = path.resolve(import.meta.dirname, "../.vite/screenshots");
const FIXTURES = path.join(OUT, ".video-fixtures");
const SIZES = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
} as const;
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const schemes = (arg("scheme")?.split(",") ?? ["light", "dark"]) as ("light" | "dark")[];
const only = arg("scene")?.split(",");
const sizes = (arg("size")?.split(",") ?? ["phone", "desktop"]) as (keyof typeof SIZES)[];

const SCENES = [
  "upload-rows",
  "timeline-tiles",
  "timeline-videos",
  "viewer-ready",
  "viewer-pending",
  "viewer-failed",
  "usage-videos",
  "share-grid",
  "share-viewer",
] as const;
type SceneName = (typeof SCENES)[number];

const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
const err = (error: string, message: string, details?: unknown) => ({
  error,
  message,
  requestId: "r",
  ...(details ? { details } : {}),
});
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

const USER = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-00000000aa01";
const pid = (n: number) => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`;
const uid = (n: number) => `00000000-0000-4000-8000-0000000004${String(n).padStart(2, "0")}`;

// ---- fixtures ---------------------------------------------------------------------------------

/** `ffmpeg` renders a tiny H.264 MP4 (`seconds` long, `size` px); without ffmpeg, opaque bytes. */
function mp4(name: string, seconds: number, size: number, fallbackBytes: number): Buffer {
  mkdirSync(FIXTURES, { recursive: true });
  const file = path.join(FIXTURES, name);
  if (!existsSync(file)) {
    try {
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=size=${size}x${size}:rate=12:duration=${seconds}`,
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=440:duration=${seconds}`,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          "-movflags",
          "+faststart",
          file,
        ],
        { stdio: "ignore" },
      );
    } catch {
      return Buffer.alloc(fallbackBytes, 0x5a);
    }
  }
  return readFileSync(file);
}

const CLIP = mp4("clip-4s.mp4", 4, 320, 180_000); // mid-upload, 2 parts
const LONG = mp4("clip-70s.mp4", 70, 64, 90_000); // free plan: video_too_long
const BROKEN = Buffer.alloc(250_001, 0x11); // transcode_failed after a complete
const BIG_BYTES = 262_144_000 + 1; // 250 MiB + 1: declared through a fake size (see below)

// ---- API mocks ---------------------------------------------------------------------------------

const baby = (role: "admin" | "contributor", plan: "free" | "plus" = "free") => ({
  id: MAYA,
  name: "Maya",
  nickname: null,
  birthDate: "2026-01-15",
  plan,
  role,
});

type Media = { kind: "photo" } | { kind: "video"; durationMs: number; rendition: string };

const summary = (n: number, m: Media, ageDays: number) => ({
  id: pid(n),
  babyId: MAYA,
  status: "ingested",
  approval: "approved",
  takenAt: iso(now - n * 3 * HOUR),
  takenAtEstimated: false,
  ageDays,
  width: m.kind === "video" ? 1920 : 1200,
  height: m.kind === "video" ? 1080 : 1600,
  mime: m.kind === "video" ? "video/quicktime" : "image/jpeg",
  mediaKind: m.kind,
  durationMs: m.kind === "video" ? m.durationMs : null,
  renditionStatus: m.kind === "video" ? m.rendition : "none",
  isSensitive: false,
  duplicateOfPhotoId: null,
  uploadedBy: USER,
  createdAt: iso(now - n * 3 * HOUR),
  deletedAt: null,
  thumbUrl: `${BASE}/mock/derivatives/${pid(n)}/thumb.jpg`,
  urlExpiresAt: iso(now + HOUR),
  milestoneId: null,
  caption: null,
  aiStatus: "not_available",
});

/** 18 items: videos at 2, 7, 11 (ready / pending / failed) and 15; the rest photos. */
const ITEMS: Array<[number, Media, number]> = [
  [1, { kind: "photo" }, 240],
  [2, { kind: "video", durationMs: 42_000, rendition: "ready" }, 240],
  [3, { kind: "photo" }, 240],
  [4, { kind: "photo" }, 239],
  [5, { kind: "photo" }, 238],
  [6, { kind: "photo" }, 238],
  [7, { kind: "video", durationMs: 12_500, rendition: "pending" }, 237],
  [8, { kind: "photo" }, 237],
  [9, { kind: "photo" }, 210],
  [10, { kind: "photo" }, 210],
  [11, { kind: "video", durationMs: 58_000, rendition: "failed" }, 209],
  [12, { kind: "photo" }, 208],
  [13, { kind: "photo" }, 180],
  [14, { kind: "photo" }, 180],
  [15, { kind: "video", durationMs: 185_000, rendition: "ready" }, 179],
  [16, { kind: "photo" }, 178],
  [17, { kind: "photo" }, 150],
  [18, { kind: "photo" }, 150],
];
const PHOTOS = ITEMS.map(([n, m, a]) => summary(n, m, a));
const VIDEOS = PHOTOS.filter((p) => p.mediaKind === "video");

const detail = (p: (typeof PHOTOS)[number]) => ({
  ...p,
  displayUrl: `${BASE}/mock/derivatives/${p.id}/display.jpg`,
  videoUrl:
    p.mediaKind === "video" && p.renditionStatus === "ready"
      ? `${BASE}/mock/derivatives/${p.id}/web.mp4`
      : null,
  videoCodec: p.mediaKind === "video" ? "hevc" : null,
  hasAudio: p.mediaKind === "video" ? true : null,
  exif: {
    takenAt: p.takenAt,
    tzOffsetMinutes: -240,
    cameraMake: "Apple",
    cameraModel: "iPhone 17",
    placeLabel: null,
  },
  details: { milestoneId: null, note: null, people: [], locationLabel: null },
  measurements: [],
  canEdit: true,
  ai: {
    status: "not_available",
    description: null,
    raw: null,
    overrides: {},
    model: null,
    promptVersion: null,
    schemaVersion: null,
    analyzedAt: null,
    failure: null,
    canRetry: false,
  },
});

async function mockMedia(page: Page) {
  const poster = await sceneJpeg(900, 900, 4242);
  const posterWide = await sceneJpeg(1600, 900, 1717);
  await page.route(`${BASE}/mock/derivatives/**`, (r) => {
    const u = r.request().url();
    if (u.endsWith("web.mp4")) {
      return r.fulfill({ status: 200, contentType: "video/mp4", body: CLIP });
    }
    return r.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: u.endsWith("display.jpg") ? posterWide : poster,
    });
  });
}

/** The parent app: session, a free demo album with a family usage, timeline pages, details. */
async function mockApp(page: Page, opts: { plan?: "free" | "plus"; videos?: number } = {}) {
  const plan = opts.plan ?? "free";
  await page.route(
    (u) => u.pathname.startsWith("/api/"),
    (r) => json(r, err("not_found", "Not found"), 404),
  );
  await page.route("**/api/me", (r) =>
    json(r, {
      user: { id: USER, email: "mom@example.com" },
      profile: {
        userId: USER,
        displayName: "Sam",
        relationshipLabel: "Mom",
        timezone: "America/New_York",
        units: "metric",
        termsVersion: "1",
        privacyVersion: "1",
        acceptedAt: "2026-01-01T00:00:00.000Z",
        notifyPhotosAnalyzed: true,
        notifyShareViewed: true,
      },
      consent: { ok: true, requiredTermsVersion: "1", requiredPrivacyVersion: "1" },
      profileComplete: true,
      babies: [baby("admin", plan)],
      session: { createdAt: new Date().toISOString(), isFresh: true },
    }),
  );
  await page.route(`**/api/babies/${MAYA}`, (r) =>
    json(r, {
      ...baby("admin", plan),
      birthDateIsDueDate: false,
      birthWeightG: null,
      birthLengthMm: null,
      avatarPhotoId: null,
      createdAt: "2026-01-15T00:00:00.000Z",
      deletedAt: null,
      freeTier:
        plan === "free"
          ? { used: 612, limit: 1000, familyAlbums: 2, videos: opts.videos ?? 37, videoLimit: 100 }
          : null,
    }),
  );
  await page.route(`**/api/babies/${MAYA}/milestones*`, (r) => json(r, { milestones: [] }));
  await page.route(`**/api/babies/${MAYA}/photos?*`, (r) => {
    const media = new URL(r.request().url()).searchParams.get("media");
    const photos = media ? PHOTOS.filter((p) => p.mediaKind === media) : PHOTOS;
    return json(r, { photos, nextCursor: null, prevCursor: "c", pendingCount: 0 });
  });
  await page.route(`**/api/babies/${MAYA}/photos/summary?*`, (r) => {
    const media = new URL(r.request().url()).searchParams.get("media");
    const photos = media ? PHOTOS.filter((p) => p.mediaKind === media) : PHOTOS;
    const groups = new Map<string, number>();
    for (const p of photos) {
      const k = p.ageDays >= 210 ? "m7" : p.ageDays >= 180 ? "m6" : "m5";
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
    return json(r, {
      total: photos.length,
      groups: [...groups].map(([key, count]) => ({ key, count, cursor: `c-${key}` })),
    });
  });
  await page.route(`**/api/babies/${MAYA}/photos/urls`, (r) => {
    const { photoIds } = r.request().postDataJSON() as { photoIds: string[] };
    const urls: Record<string, unknown> = {};
    for (const id of photoIds) {
      const p = PHOTOS.find((x) => x.id === id);
      if (!p) continue;
      const d = detail(p);
      urls[id] = {
        thumbUrl: p.thumbUrl,
        displayUrl: d.displayUrl,
        videoUrl: d.videoUrl,
        urlExpiresAt: iso(now + HOUR),
      };
    }
    return json(r, { urls });
  });
  await page.route("**/api/photos/*", (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop() ?? "";
    const p = PHOTOS.find((x) => x.id === id);
    return p ? json(r, detail(p)) : json(r, err("not_found", "Not found"), 404);
  });
  await mockMedia(page);
}

/** Upload API: one session; register answers per declared size; part 2 of the clip never lands. */
async function mockUploads(page: Page) {
  const hang = () => new Promise<never>(() => {});
  const file = (clientId: string, bytes: number, extra: Record<string, unknown>) => ({
    id: uid(1),
    clientId,
    kind: "video",
    state: "registered",
    error: null,
    bytes,
    partSize: 1024,
    partCount: 1,
    duplicateOfPhotoId: null,
    photo: null,
    ...extra,
  });
  const session = (files: unknown[]) => ({
    id: SESSION,
    babyId: MAYA,
    createdAt: iso(now),
    expiresAt: iso(now + 24 * HOUR),
    finishedAt: null,
    details: {},
    summary: { registered: 0, completed: 0, ingested: 0, duplicates: 0, failed: 0, aborted: 0 },
    files,
  });
  await page.route(`**/api/babies/${MAYA}/uploads`, (r) =>
    r.request().method() === "POST" ? json(r, session([]), 201) : r.fallback(),
  );
  await page.route(`**/api/uploads/${SESSION}/files`, (r) => {
    const body = r.request().postDataJSON() as { files: { clientId: string; bytes: number }[] };
    return json(r, {
      files: body.files.map((f, i) => {
        if (f.bytes === CLIP.length) {
          return file(f.clientId, f.bytes, {
            id: uid(1),
            partSize: Math.ceil(f.bytes / 2),
            partCount: 2,
            parts: [1, 2].map((n) => ({ partNumber: n, url: `${BASE}/mock/put/${n}` })),
          });
        }
        if (f.bytes === LONG.length) {
          return file(f.clientId, f.bytes, {
            id: uid(2),
            state: "failed",
            error: "video_too_long",
          });
        }
        if (f.bytes === BROKEN.length) {
          return file(f.clientId, f.bytes, {
            id: uid(3),
            partSize: f.bytes,
            partCount: 1,
            parts: [{ partNumber: 1, url: `${BASE}/mock/put/ok` }],
          });
        }
        return file(f.clientId, f.bytes, {
          id: uid(10 + i),
          state: "failed",
          error: "file_too_large",
        });
      }),
    });
  });
  await page.route(`${BASE}/mock/put/1`, (r) => r.fulfill({ status: 200, body: "" }));
  await page.route(`${BASE}/mock/put/ok`, (r) => r.fulfill({ status: 200, body: "" }));
  await page.route(`${BASE}/mock/put/2`, () => hang());
  await page.route(`**/api/uploads/${SESSION}/files/${uid(3)}/complete`, (r) =>
    json(r, file("x", BROKEN.length, { id: uid(3), state: "completed" })),
  );
  await page.route(`**/api/uploads/${SESSION}`, (r) =>
    json(
      r,
      session([
        file("x", CLIP.length, { id: uid(1), state: "registered" }),
        file("x", BROKEN.length, { id: uid(3), state: "failed", error: "transcode_failed" }),
      ]),
    ),
  );
  await page.route(`**/api/uploads/${SESSION}/finish`, (r) => json(r, session([])));
}

/** The share-link viewer: album, photos (videos included), per-kind URLs and the MP4 download. */
async function mockShare(page: Page) {
  await page.route(
    (u) => u.pathname.startsWith("/api/"),
    (r) => json(r, err("not_found", "Not found"), 404),
  );
  const viewerPhotos = PHOTOS.filter((p) => p.renditionStatus !== "failed").map((p, i) => ({
    id: p.id,
    mediaKind: p.mediaKind,
    durationMs: p.durationMs,
    takenAt: p.takenAt.slice(0, 10),
    takenAtEstimated: false,
    ageDays: p.ageDays,
    width: p.width,
    height: p.height,
    milestone: i === 3 ? { id: uid(50), name: "First smile" } : null,
    hidden: false,
    thumbUrl: `${BASE}/mock/derivatives/${p.id}/thumb.jpg`,
    urlExpiresAt: iso(now + HOUR),
  }));
  await page.route("**/api/share/session", (r) =>
    json(r, {
      album: {
        linkName: "Grandparents",
        babyName: "Maya",
        babyNickname: null,
        allowDownload: true,
        expiresAt: iso(now + 20 * HOUR),
        photoCount: viewerPhotos.length,
        hiddenCount: 0,
      },
    }),
  );
  await page.route("**/api/share/photos?*", (r) =>
    json(r, { photos: viewerPhotos, nextCursor: null }),
  );
  await page.route("**/api/share/photos/urls", (r) => {
    const { ids, kind } = r.request().postDataJSON() as { ids: string[]; kind: string };
    const urls = ids
      .filter((id) => kind !== "web" || VIDEOS.some((v) => v.id === id))
      .map((id) => ({
        id,
        url: `${BASE}/mock/derivatives/${id}/${kind === "web" ? "web.mp4" : `${kind}.jpg`}`,
        expiresAt: iso(now + (kind === "web" ? 30 * 60_000 : 5 * 60_000)),
      }));
    return json(r, { urls });
  });
  await page.route("**/api/share/photos/*/download", (r) =>
    json(r, { url: `${BASE}/mock/derivatives/${pid(2)}/web.mp4`, expiresAt: iso(now + 60_000) }),
  );
  await mockMedia(page);
}

// ---- scenes -------------------------------------------------------------------------------------

async function openViewer(page: Page, n: number) {
  await mockApp(page);
  await page.goto("/timeline");
  await expect(tid(page, `photo-${pid(n)}`)).toBeVisible({ timeout: 20_000 });
  await tid(page, `photo-${pid(n)}`).click();
  await expect(page.getByTestId("video-slide").first()).toBeVisible({ timeout: 20_000 });
}

async function scene(page: Page, name: SceneName) {
  if (name === "upload-rows") {
    await mockApp(page);
    await mockUploads(page);
    await page.goto("/upload");
    await expect(tid(page, "upload-choose")).toBeVisible({ timeout: 20_000 });
    await tid(page, "upload-input").setInputFiles([
      { name: "Bath time.mov", mimeType: "video/quicktime", buffer: CLIP },
      { name: "First steps (long).mp4", mimeType: "video/mp4", buffer: LONG },
      { name: "Giggles.mp4", mimeType: "video/mp4", buffer: BROKEN },
    ]);
    // A 250 MB+ file cannot be handed to the picker cheaply: the "too large" row is produced by
    // the client-side gate from a File whose `size` is spoofed, through the page's own manager.
    await page.evaluate(
      ([bytes]) => {
        const input = document.querySelector<HTMLInputElement>('[data-testid="upload-input"]');
        const f = new File([new Uint8Array(16)], "Beach day 4K.mov", { type: "video/quicktime" });
        Object.defineProperty(f, "size", { value: bytes });
        const dt = new DataTransfer();
        dt.items.add(f);
        if (input) {
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
      [BIG_BYTES],
    );
    await expect(tid(page, "upload-list")).toBeVisible({ timeout: 20_000 });
    await tid(page, "upload-list").scrollIntoViewIfNeeded();
    const row = (state: string) =>
      page.locator(`[data-testid^="upload-row-"][data-state="${state}"]`);
    await expect(row("uploading")).toHaveCount(1, { timeout: 30_000 });
    await expect(row("failed")).toHaveCount(3, { timeout: 30_000 });
    const list = tid(page, "upload-list");
    await expect(list).toContainText("couldn't be prepared");
    await expect(list).toContainText("up to 1 minute");
    await expect(list).toContainText("up to 250 MB");
    await page.waitForTimeout(800);
    await tid(page, "upload-list").scrollIntoViewIfNeeded();
  } else if (name === "timeline-tiles" || name === "timeline-videos") {
    await mockApp(page);
    await page.goto("/timeline");
    await expect(tid(page, `photo-video-${pid(2)}`)).toBeVisible({ timeout: 20_000 });
    if (name === "timeline-videos") {
      await tid(page, "media-chip-video").click();
      await expect(tid(page, "timeline-total")).toHaveText(/4 photos/, { timeout: 20_000 });
      await expect(tid(page, `photo-${pid(1)}`)).toHaveCount(0);
    }
  } else if (name === "viewer-ready") {
    await openViewer(page, 2);
    await expect(page.getByTestId(`viewer-video-${pid(2)}`)).toBeVisible({ timeout: 20_000 });
  } else if (name === "viewer-pending") {
    await openViewer(page, 7);
    await expect(page.getByTestId("video-pending")).toBeVisible({ timeout: 20_000 });
  } else if (name === "viewer-failed") {
    await openViewer(page, 11);
    await expect(page.getByTestId("video-failed")).toBeVisible({ timeout: 20_000 });
  } else if (name === "usage-videos") {
    await mockApp(page, { videos: 100 });
    await page.goto("/upload");
    await expect(tid(page, "free-tier-notice")).toBeVisible({ timeout: 20_000 });
    await expect(tid(page, "free-tier-videos-full")).toBeVisible();
  } else if (name === "share-grid" || name === "share-viewer") {
    await mockShare(page);
    await page.goto("/s/screenshot-token-screenshot-token");
    await expect(page.getByTestId(`share-video-${pid(2)}`)).toBeVisible({ timeout: 20_000 });
    if (name === "share-viewer") {
      await page.getByTestId(`share-thumb-${pid(2)}`).click();
      await expect(page.getByTestId(`share-video-player-${pid(2)}`)).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByTestId("share-download")).toBeVisible();
      await page.waitForTimeout(600);
      await page.mouse.move(40, 300); // bring the faded chrome (info bar, download) back
    }
  }
  await page.waitForTimeout(600);
}

async function run(browser: Browser, scheme: "light" | "dark", size: keyof typeof SIZES) {
  const dir = path.join(OUT, `${scheme}-${size}`);
  mkdirSync(dir, { recursive: true });
  console.log(`\n${scheme} ${size}`);
  for (const name of SCENES) {
    if (only && !only.includes(name)) continue;
    const ctx = await browser.newContext({
      baseURL: BASE,
      viewport: SIZES[size],
      colorScheme: scheme,
      reducedMotion: "reduce",
      isMobile: size === "phone",
      hasTouch: size === "phone",
    });
    await ctx.addInitScript((b) => localStorage.setItem("ll_current_baby", b), MAYA);
    const page = await ctx.newPage();
    if (process.env.SCREENSHOT_DEBUG) {
      page.on("request", (r) => console.log("   >", r.method(), r.url()));
      page.on("console", (m) => console.log("   #", m.type(), m.text()));
    }
    try {
      await scene(page, name);
      await page.screenshot({ path: path.join(dir, `video-${name}.png`) });
      console.log("  ", `${scheme}-${size}/video-${name}.png`);
    } catch (e) {
      await page.screenshot({ path: path.join(dir, `video-${name}-FAILED.png`) });
      console.log(`   !! ${name}: ${(e as Error).message.split("\n")[0]}`);
    }
    await ctx.close();
  }
}

async function launch(): Promise<Browser> {
  const channel = process.env.SCREENSHOT_CHANNEL ?? "chrome";
  if (channel !== "chromium") {
    try {
      return await chromium.launch({ channel });
    } catch {
      console.log(
        `(${channel} not available; using Playwright's Chromium, which cannot play H.264)`,
      );
    }
  }
  return chromium.launch();
}

const browser = await launch();
try {
  for (const scheme of schemes) for (const size of sizes) await run(browser, scheme, size);
} finally {
  await browser.close();
}
