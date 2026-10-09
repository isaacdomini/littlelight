import { codeAfter } from "./mailpit";

// Bearer-token API client for the native client kind (`X-Littlelight-Client: native`), used by the
// push gate and the Android gate. Plain fetch: there is no cookie jar, and every response is
// checked for a stray Set-Cookie (native transport must never set one).
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;

export interface NativeRes<T = unknown> {
  status: number;
  body: T;
  setCookie: boolean;
}

export class NativeClient {
  accessToken: string | null = null;
  refreshToken: string | null = null;
  /** Any response so far carried a Set-Cookie header. */
  sawSetCookie = false;

  constructor(
    readonly email: string,
    readonly origin: string = BASE,
  ) {}

  async call<T = unknown>(
    method: string,
    path: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ): Promise<NativeRes<T>> {
    const h: Record<string, string> = { "x-littlelight-client": "native", ...headers };
    if (this.accessToken && !h.authorization) h.authorization = `Bearer ${this.accessToken}`;
    if (data !== undefined) h["content-type"] = "application/json";
    const res = await fetch(`${this.origin}/api${path}`, {
      method,
      headers: h,
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    const setCookie = res.headers.has("set-cookie");
    if (setCookie) this.sawSetCookie = true;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* empty body */
    }
    return { status: res.status, body: body as T, setCookie };
  }

  /** OTP sign-in (code from Mailpit); keeps the bearer tokens in memory only. */
  async signIn(): Promise<void> {
    const code = await codeAfter(this.email, async () => {
      const r = await this.call("POST", "/auth/otp", { email: this.email });
      if (r.status !== 202) throw new Error(`otp request answered ${r.status}`);
    });
    const v = await this.call<{ tokens?: { accessToken: string; refreshToken: string } }>(
      "POST",
      "/auth/verify",
      { email: this.email, code },
    );
    if (v.status !== 200 || !v.body.tokens) throw new Error(`verify answered ${v.status}`);
    this.accessToken = v.body.tokens.accessToken;
    this.refreshToken = v.body.tokens.refreshToken;
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
}
