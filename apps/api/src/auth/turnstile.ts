// Cloudflare Turnstile verification (docs/plans/step-3.md 2.9; PRD "Auth security
// requirements": Turnstile on the web sign-up form after 3 attempts). Inert without
// `TURNSTILE_SECRET_KEY` (dev, CI): `createTurnstile(undefined)` returns `null`, and the OTP
// route then never asks for a captcha. The secret and the token are only ever sent to
// Cloudflare; neither is logged.

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface Turnstile {
  /** True when Cloudflare accepts the token for this client IP. Network errors count as failure. */
  verify(token: string, remoteIp: string): Promise<boolean>;
}

export interface TurnstileOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  url?: string;
}

export function createTurnstile(
  secretKey: string | undefined,
  options: TurnstileOptions = {},
): Turnstile | null {
  if (!secretKey) return null;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const url = options.url ?? TURNSTILE_VERIFY_URL;

  return {
    async verify(token, remoteIp) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const form = new URLSearchParams({
          secret: secretKey,
          response: token,
          remoteip: remoteIp,
        });
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: controller.signal,
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { success?: unknown };
        return body.success === true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
