import {
  idParamsSchema,
  SHARE_DOWNLOAD_URL_TTL_SEC,
  SHARE_PATH,
  shareAlbumSchema,
  shareManifestQuerySchema,
  viewerDownloadResponseSchema,
  viewerPhotosQuerySchema,
  viewerPhotosResponseSchema,
  viewerUrlsRequestSchema,
  viewerUrlsResponseSchema,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { shareSettings } from "../config";
import { forbidden, notFound } from "../lib/errors";
import { decodeCursor, encodeCursor } from "../photos/queries";
import { shareMediaTtlSec } from "../storage/sign";
import {
  listViewerPhotoRows,
  loadViewerAlbum,
  signViewerKey,
  strictViewerBody,
  toViewerPhoto,
  viewerDerivativeKeys,
  viewerDownloadRow,
} from "./queries";
import { requireViewer, type ViewerSession, withViewer } from "./viewer-auth";

// Viewer routes (docs/plans/step-8.md 2.6; PRD "FR-9 Sharing" 9.5-9.7, "Share-link viewers (no
// account)", "Privacy and child safety": signed URLs scoped to one object, GPS/EXIF stripped from
// viewer derivatives; D4, D9, D10, D11). No chat, no search, no account: this is the viewer's
// whole surface besides the exchange.
//
// - Every route but the manifest: `requireViewer` (verified `ll_viewer` JWT) + `withViewer`
//   (role `viewer`, `viewer_session_check(jti)` first: any dead link or session is 410).
// - Media: presigned GETs of `thumb`/`display` derivatives only, keys read through viewer RLS
//   (a hidden sensitive photo's key is unreadable, so it is never signed), TTL =
//   `min(SHARE_MEDIA_URL_TTL_SEC, link expiry)` with `Cache-Control: private` from the signer.
//   Downloads are the 1600 px `display` derivative (never the original, D9), only when the link
//   allows downloads, valid `SHARE_DOWNLOAD_URL_TTL_SEC`.
// - Every response is parsed with its strict shared schema before it is sent (fail closed).
// - Never logged: URLs, tokens, names.

const downloadsOff = () => forbidden("Downloads are turned off for this album");
const photoNotShared = () => notFound("That photo isn't in this album");

/** ASCII-only file name stem from the baby's name (`Zoë Ann` -> `Zoe-Ann`), `photo` if empty. */
export function downloadStem(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return ascii || "photo";
}

/** `attachment; filename="<baby>-<YYYY-MM-DD>.jpg"` (ASCII, no quotes or separators inside). */
export function downloadDisposition(babyName: string, day: string): string {
  const safeDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "photo";
  return `attachment; filename="${downloadStem(babyName)}-${safeDay}.jpg"`;
}

/** Viewer media URL lifetime for this link (≤ setting, ≤ the link's expiry). */
function mediaTtl(app: FastifyInstance, session: ViewerSession): number {
  return shareMediaTtlSec(shareSettings(app.config).SHARE_MEDIA_URL_TTL_SEC, session.expiresAt);
}

/** The per-link PWA manifest (D11): the installed app opens exactly this link. */
export function viewerManifest(token: string) {
  return {
    name: "Family album · Tinyglow",
    short_name: "Album",
    description: "A private family photo album shared with you.",
    start_url: `${SHARE_PATH}/${token}`,
    scope: `${SHARE_PATH}/`,
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/viewer-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/viewer-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/viewer-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

export function viewerRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "GET",
    url: "/share/album",
    preHandler: requireViewer,
    handler: async (request, reply) => {
      const { result } = await withViewer(request, reply, (client, session) =>
        loadViewerAlbum(client, session),
      );
      return strictViewerBody(shareAlbumSchema, result, request.log);
    },
  });

  r.route({
    method: "GET",
    url: "/share/photos",
    schema: { querystring: viewerPhotosQuerySchema },
    preHandler: requireViewer,
    handler: async (request, reply) => {
      const { limit } = request.query;
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const { session, result: rows } = await withViewer(request, reply, (client, s) =>
        listViewerPhotoRows(client, s, cursor, limit),
      );
      const ttl = mediaTtl(app, session);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const body = {
        photos: await Promise.all(page.map((row) => toViewerPhoto(app.signer, row, ttl))),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ sortKey: last.sort_key, id: last.id })
            : null,
      };
      return strictViewerBody(viewerPhotosResponseSchema, body, request.log);
    },
  });

  r.route({
    method: "POST",
    url: "/share/photos/urls",
    schema: { body: viewerUrlsRequestSchema },
    preHandler: requireViewer,
    handler: async (request, reply) => {
      const { ids, kind } = request.body;
      const { session, result: keys } = await withViewer(request, reply, (client) =>
        viewerDerivativeKeys(client, ids, kind),
      );
      const ttl = mediaTtl(app, session);
      const urls = await Promise.all(
        keys.map(async (k) => {
          const signed = await signViewerKey(app.signer, k.storage_key, k.photo_id, kind, ttl);
          return { id: k.photo_id, url: signed.url, expiresAt: signed.expiresAt.toISOString() };
        }),
      );
      return strictViewerBody(viewerUrlsResponseSchema, { urls }, request.log);
    },
  });

  r.route({
    method: "POST",
    url: "/share/photos/:id/download",
    schema: { params: idParamsSchema },
    preHandler: requireViewer,
    handler: async (request, reply) => {
      const { id } = request.params;
      const { session, result: row } = await withViewer(request, reply, async (client, s) =>
        s.allowDownload ? viewerDownloadRow(client, id) : null,
      );
      if (!session.allowDownload) throw downloadsOff();
      if (!row) throw photoNotShared();
      const signed = await signViewerKey(
        app.signer,
        row.storage_key,
        id,
        "display",
        shareMediaTtlSec(SHARE_DOWNLOAD_URL_TTL_SEC, session.expiresAt),
        downloadDisposition(session.babyName, row.day),
      );
      request.log.info({ shareLinkId: session.shareLinkId, photoId: id }, "viewer download");
      return strictViewerBody(
        viewerDownloadResponseSchema,
        { url: signed.url, expiresAt: signed.expiresAt.toISOString() },
        request.log,
      );
    },
  });

  // Public, no database: the token is only echoed into `start_url` after a shape check. The
  // query string never reaches a log (`redactUrl`, nginx `$ll_log_path`, pino `req.query.t`).
  r.route({
    method: "GET",
    url: "/share/manifest.webmanifest",
    schema: { querystring: shareManifestQuerySchema },
    handler: async (request, reply) => {
      return reply
        .type("application/manifest+json; charset=utf-8")
        .header("cache-control", "no-store")
        .send(JSON.stringify(viewerManifest(request.query.t)));
    },
  });
}
