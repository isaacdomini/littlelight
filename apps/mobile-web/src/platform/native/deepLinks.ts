import { APP_LINK_HOST_DEFAULT, DEEP_LINK_PATTERNS, DEV_URL_SCHEME } from "@tinyglow/shared";

// Deep-link allow-list (docs/plans/step-9.md 2.4). The URL is never logged, stored or sent
// anywhere: it is only turned into an in-app route. Anything outside the allow-list is ignored.

function allowedHosts(): string[] {
  const raw = (import.meta.env.VITE_APP_LINK_HOSTS as string | undefined) ?? "";
  const hosts = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length > 0 ? hosts : [APP_LINK_HOST_DEFAULT];
}

function devSchemeEnabled(): boolean {
  return import.meta.env.VITE_DEEPLINK_DEV_SCHEME === "1";
}

/**
 * The in-app route for a URL the OS handed to the app, or `null` to ignore it. Accepts
 * `https://<allowed host>/…` and, only in debug builds, `tinyglow://…`. Query and fragment are
 * kept only for `/signin/native`.
 */
export function toAppPath(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  let pathname: string;
  if (url.protocol === "https:") {
    if (url.username || url.password || url.port) return null;
    if (!allowedHosts().includes(url.hostname.toLowerCase())) return null;
    pathname = url.pathname;
  } else if (url.protocol === `${DEV_URL_SCHEME}:` && devSchemeEnabled()) {
    // tinyglow://s/<token> parses as host "s" + path "/<token>"; rebuild the full path.
    pathname = `/${url.host}${url.pathname}`;
  } else {
    return null;
  }
  if (DEEP_LINK_PATTERNS.invite.test(pathname) || DEEP_LINK_PATTERNS.share.test(pathname)) {
    return pathname;
  }
  if (DEEP_LINK_PATTERNS.nativeSignIn.test(pathname)) {
    return `${pathname}${url.search}${url.hash}`;
  }
  return null;
}
