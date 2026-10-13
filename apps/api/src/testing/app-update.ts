import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AppUpdateManifest, appUpdateContentId } from "@tinyglow/shared";

// Live-update test fixtures (docs/plans/step-14.md 2.10): the committed dev signing key (read
// from `.env.dev`, the same value the dev stack uses), foreign keys, and manifest builders.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** `APP_UPDATE_SIGNING_KEY_BASE64` from `.env.dev` (dev-only throwaway key, public half = `dev`). */
export const DEV_APP_UPDATE_KEY: string = (() => {
  const text = readFileSync(join(repoRoot, ".env.dev"), "utf8");
  const m = /^APP_UPDATE_SIGNING_KEY_BASE64=(\S+)$/m.exec(text);
  if (!m?.[1]) throw new Error(".env.dev has no APP_UPDATE_SIGNING_KEY_BASE64");
  return m[1];
})();

/** A fresh P-256 key nobody trusts (base64 PKCS#8 DER). */
export function foreignP256Key(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
}

/** An RSA key (wrong algorithm) as base64 PKCS#8 DER. */
export function rsaKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  return privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
}

/** A P-384 key (wrong curve) as base64 PKCS#8 DER. */
export function p384Key(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
  return privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
}

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** A valid manifest over the given file bodies (`index.html` added when missing). */
export function testManifest(
  bodies: Record<string, string> = { "index.html": "<html>A</html>" },
  over: Partial<AppUpdateManifest> = {},
): AppUpdateManifest {
  const all = { "index.html": "<html>A</html>", ...bodies };
  const files = Object.entries(all)
    .map(([path, body]) => ({ path, sha256: sha256Hex(body), size: Buffer.byteLength(body) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    schema: 1,
    version: appUpdateContentId(files),
    webVersion: "1.0.0",
    minNativeBuild: { ios: 1, android: 1 },
    builtAt: "2026-10-12T10:00:00.000Z",
    files,
    ...over,
  };
}

export interface FakeUpstream {
  fetch: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
  /** Next responses (a function per call); the last one repeats. */
  respond: (r: () => Response | Promise<Response>) => void;
}

/** A recording `fetch` for the manifest upstream. */
export function fakeUpstream(initial: () => Response | Promise<Response>): FakeUpstream {
  let current = initial;
  const calls: FakeUpstream["calls"] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return current();
  }) as typeof fetch;
  return {
    fetch: f,
    calls,
    respond: (r) => {
      current = r;
    },
  };
}

export const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
