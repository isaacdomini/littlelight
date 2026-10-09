import { isNative } from "./platform";

// API origin (docs/plans/step-9.md 2.3). On the web every URL is same-origin and relative; in
// the Capacitor shell the bundle is served from capacitor://localhost, so the API is reached at
// `VITE_API_URL` (an origin such as https://littlelight.tesarsoft.com, baked in at build time;
// it contains no secret).

function origin(): string {
  const raw = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
  return raw.replace(/\/+$/, "");
}

/** `/api<path>` on the web, `<VITE_API_URL>/api<path>` in the app. `path` starts with `/`. */
export function apiUrl(path: string): string {
  return isNative() ? `${origin()}/api${path}` : `/api${path}`;
}

/** `/auth<path>` (GoTrue health only; everything else goes through the API). */
export function authUrl(path: string): string {
  return isNative() ? `${origin()}/auth${path}` : `/auth${path}`;
}
