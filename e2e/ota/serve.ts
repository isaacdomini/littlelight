/**
 * Tiny static server for live-update bundles (docs/plans/step-14.md 2.10): `GET /manifest.json`
 * answers the current variant's `app-update/manifest.json` (or an override text), every other
 * path a file of the current variant's directory. No directory listing, no `..`, no symlinks
 * followed outside the root, no ETag (the api re-fetches after its 60 s cache).
 *
 *   tsx e2e/ota/serve.ts <bundleDir> [port=18090]     # native gates: serve one variant
 *
 * The api (in Docker) reaches it at http://host.docker.internal:<port>/manifest.json; the phone /
 * host at http://localhost:<port> (Android: `adb reverse tcp:<port> tcp:<port>`).
 */
import { readFile, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";

export interface OtaServer {
  port: number;
  /** Serve this bundle directory (a vite `dist` with `app-update/manifest.json`). */
  setVariant(dir: string): void;
  /** Answer `/manifest.json` with this text instead of the variant's manifest (`null`: off). */
  setManifest(text: string | null): void;
  /** Answer `/manifest.json` with this status (e.g. 404); `null`: off. */
  setManifestStatus(status: number | null): void;
  requests: string[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export async function startOtaServer(
  dir: string,
  port = 18090,
  host = "0.0.0.0",
): Promise<OtaServer> {
  let root = dir;
  let manifestText: string | null = null;
  let manifestStatus: number | null = null;
  const requests: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = decodeURIComponent(url.pathname);
    requests.push(p);
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      if (p === "/manifest.json") {
        if (manifestStatus !== null) {
          res.writeHead(manifestStatus, { "content-type": "text/plain" }).end("no");
          return;
        }
        const text =
          manifestText ?? (await readFile(path.join(root, "app-update", "manifest.json"), "utf8"));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
        res.end(text);
        return;
      }
      const base = await realpath(root);
      const file = await realpath(path.join(base, p)).catch(() => null);
      if (!file?.startsWith(`${base}${path.sep}`)) {
        res.writeHead(404).end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "content-length": String(body.length),
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return {
    port,
    requests,
    setVariant: (d) => {
      root = d;
    },
    setManifest: (t) => {
      manifestText = t;
    },
    setManifestStatus: (s) => {
      manifestStatus = s;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: tsx e2e/ota/serve.ts <bundleDir> [port]");
    process.exit(2);
  }
  const port = Number(process.argv[3] ?? 18090);
  const s = await startOtaServer(path.resolve(dir), port);
  console.log(`ota server on :${s.port} serving ${dir}`);
}
