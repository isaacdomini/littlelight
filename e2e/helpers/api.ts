import { type APIRequestContext, request } from "@playwright/test";
import { codeAfter, seenIds, waitForInviteToken } from "./mailpit";

const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;

/** Unique, run-scoped address (`e2e-<ts>-<rand>-<tag>@example.com`). */
export function uniqueEmail(tag: string): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${tag}@example.com`;
}

let ipCounter = Math.floor(Math.random() * 200);
/** A fresh TEST-NET-3 address (`203.0.113.0/24` rolls into `198.51.100.0/24`) per API client. */
export function nextClientIp(): string {
  ipCounter += 1;
  const n = ipCounter % 500;
  return n < 250 ? `203.0.113.${1 + n}` : `198.51.100.${1 + (n - 250)}`;
}

/** Mirror of the API's maskEmail for the first-letter + domain shape: `o***@example.com`. */
export function masked(email: string): string {
  const [local, domain] = email.split("@");
  return `${local?.[0]}***@${domain}`;
}

export interface Res<T = unknown> {
  status: number;
  body: T;
  /** Response headers, lowercased names (e.g. `retry-after`). */
  headers?: Record<string, string>;
}

/** Cookie-jar API client for the web client kind (sends the CSRF client header). */
export class ApiClient {
  private constructor(
    readonly ctx: APIRequestContext,
    readonly email: string,
  ) {}

  /**
   * `extraHeaders` ride on every request, e.g. a `CF-Connecting-IP` to give one account its own
   * "network" (nginx passes it through unchanged in the dev stack).
   */
  static async create(
    email: string,
    storageState?: Awaited<ReturnType<APIRequestContext["storageState"]>>,
    extraHeaders: Record<string, string> = {},
  ): Promise<ApiClient> {
    // Each client gets its own client IP unless the caller chose one: the api throttles OTP
    // requests per IP (30 / h), and a full `pnpm e2e` run signs in far more accounts than that
    // from one machine. nginx passes CF-Connecting-IP through unchanged on the dev stack.
    const headers: Record<string, string> = { "X-Tinyglow-Client": "web", ...extraHeaders };
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "cf-connecting-ip")) {
      headers["CF-Connecting-IP"] = nextClientIp();
    }
    const ctx = await request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: headers,
      ...(storageState ? { storageState } : {}),
    });
    return new ApiClient(ctx, email);
  }

  /** OTP sign-in through the API (code read from Mailpit). */
  async signIn(): Promise<void> {
    const code = await codeAfter(this.email, async () => {
      const r = await this.ctx.post("/api/auth/otp", { data: { email: this.email } });
      if (r.status() !== 202) throw new Error(`otp request answered ${r.status()}`);
    });
    const v = await this.ctx.post("/api/auth/verify", { data: { email: this.email, code } });
    if (!v.ok()) throw new Error(`verify answered ${v.status()}`);
  }

  async call<T = unknown>(method: string, path: string, data?: unknown): Promise<Res<T>> {
    const r = await this.ctx.fetch(`/api${path}`, { method, data });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      /* empty body */
    }
    return { status: r.status(), body: body as T, headers: r.headers() };
  }

  /** Sign in and finish consent + profile (no baby). */
  async onboard(displayName: string): Promise<void> {
    await this.signIn();
    const me = (
      await this.call<{
        consent: { requiredTermsVersion: string; requiredPrivacyVersion: string };
      }>("GET", "/me")
    ).body;
    const consent = await this.call("POST", "/me/consent", {
      termsVersion: me.consent.requiredTermsVersion,
      privacyVersion: me.consent.requiredPrivacyVersion,
      isAdult: true,
    });
    if (consent.status !== 200) throw new Error(`consent answered ${consent.status}`);
    const profile = await this.call("PATCH", "/me/profile", {
      displayName,
      relationshipLabel: "Mom",
      timezone: "UTC",
      units: "metric",
    });
    if (profile.status !== 200) throw new Error(`profile answered ${profile.status}`);
  }

  async createBaby(name: string): Promise<string> {
    const r = await this.call<{ id: string }>("POST", "/babies", {
      name,
      birthDate: "2026-01-15",
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`create baby answered ${r.status}`);
    return r.body.id;
  }

  /** Invite and return the token read from the emailed link (used only to navigate). */
  async invite(
    babyId: string,
    email: string,
    role: "admin" | "contributor" = "admin",
  ): Promise<{ status: number; token?: string; body: { error?: string; message?: string } }> {
    const seen = await seenIds(email);
    const r = await this.call<{ error?: string; message?: string }>(
      "POST",
      `/babies/${babyId}/invites`,
      { email, role },
    );
    if (r.status !== 201 && r.status !== 200) return { status: r.status, body: r.body };
    return { status: r.status, body: r.body, token: await waitForInviteToken(email, seen) };
  }

  /** Cookie state, to open a browser context that is already signed in as this user. */
  storageState() {
    return this.ctx.storageState();
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }
}
