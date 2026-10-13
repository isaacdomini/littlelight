// Visual check for passkeys (step 13, task 13.5): the Welcome screen with "Sign in with a passkey"
// (and the autofill request armed on the email field), the generic failure line, the Turnstile
// step, the one-time "Add a passkey" card (before and after a real ceremony against Chromium's
// virtual authenticator), and Settings -> Passkeys (empty, list, rename, at the limit, remove
// needing a fresh sign-in). The whole API is mocked with Playwright routes (no dev stack). Point
// E2E_BASE_URL at any web build (e.g. a local `vite` on another port). Output next to the other
// shots: apps/mobile-web/.vite/screenshots/<scheme>-<size>/passkeys-*.png
//
//   E2E_BASE_URL=http://localhost:5199 pnpm exec tsx apps/mobile-web/scripts/screenshots-passkeys.ts [--scheme=dark] [--size=phone] [--scene=a,b]

import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium, expect, type Page, type Route } from "@playwright/test";
import { MAYA } from "../../../e2e/helpers/demo";
import { tid } from "../../../e2e/helpers/ui";

const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;
const OUT = path.resolve(import.meta.dirname, "../.vite/screenshots");
const SIZES = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
} as const;
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const schemes = (arg("scheme")?.split(",") ?? ["light", "dark"]) as ("light" | "dark")[];
const only = arg("scene")?.split(",");
const sizes = (arg("size")?.split(",") ?? ["phone", "desktop"]) as (keyof typeof SIZES)[];

const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
const err = (error: string, message: string, details?: unknown) => ({
  error,
  message,
  requestId: "r",
  ...(details ? { details } : {}),
});

const SCENES = [
  "welcome",
  "welcome-failed",
  "welcome-captcha",
  "prompt",
  "prompt-added",
  "settings-empty",
  "settings-list",
  "settings-rename",
  "settings-limit",
  "settings-remove-fresh",
] as const;
type SceneName = (typeof SCENES)[number];

const USER = "00000000-0000-4000-8000-000000000001";
const PK = (n: number) => `00000000-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`;
const CHALLENGE = "00000000-0000-4000-8000-000000000777";
const b64url = (s: string) => Buffer.from(s).toString("base64url");

const passkey = (n: number, name: string, lastUsed: string | null) => ({
  id: PK(n),
  name,
  createdAt: `2026-0${n}-10T09:00:00.000Z`,
  lastUsedAt: lastUsed,
});
const LIST = [passkey(3, "Sam's iPhone", "2026-10-10T18:20:00.000Z"), passkey(1, "MacBook", null)];
const FULL = [1, 2, 3, 4, 5].map((n) => passkey(n, n === 1 ? "Passkey" : `Device ${n}`, null));

/** The W3C JSON options the API passes through from GoTrue (RP = the page's host). */
const requestOptions = {
  challenge: b64url("sign-in-challenge-0123456789"),
  rpId: "localhost",
  timeout: 300_000,
  userVerification: "preferred",
  allowCredentials: [],
};
const creationOptions = {
  rp: { id: "localhost", name: "Tinyglow" },
  user: { id: b64url(USER), name: "mom@example.com", displayName: "mom@example.com" },
  challenge: b64url("register-challenge-0123456789"),
  pubKeyCredParams: [
    { type: "public-key", alg: -7 },
    { type: "public-key", alg: -257 },
  ],
  timeout: 300_000,
  attestation: "none",
  authenticatorSelection: {
    residentKey: "required",
    requireResidentKey: true,
    userVerification: "preferred",
  },
  excludeCredentials: [],
};
const optionsBody = (options: unknown) => ({
  challengeId: CHALLENGE,
  options,
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
});

const baby = {
  id: MAYA,
  name: "Maya",
  nickname: null,
  birthDate: "2026-01-15",
  plan: "plus",
  role: "admin",
};

async function mockConfig(page: Page, siteKey: string | null = null) {
  // Registered first so every more specific route below wins.
  await page.route(
    (u) => u.pathname.startsWith("/api/"),
    (r) => json(r, err("not_found", "Not found"), 404),
  );
  await page.route("**/api/auth/config", (r) =>
    json(r, {
      providers: { apple: false, google: false },
      turnstileSiteKey: siteKey,
      termsVersion: "1",
      privacyVersion: "1",
      passkeys: true,
    }),
  );
  // Turnstile's script never loads here; the placeholder is what matters for the shot.
  await page.route("https://challenges.cloudflare.com/**", (r) => r.abort());
}

async function mockSignedOut(page: Page, siteKey: string | null = null) {
  await mockConfig(page, siteKey);
  await page.route("**/api/me", (r) => json(r, err("unauthorized", "Sign in"), 401));
}

async function mockSignedIn(page: Page, passkeys: unknown[], fresh = true) {
  await mockConfig(page);
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
      babies: [baby],
      session: { createdAt: new Date().toISOString(), isFresh: fresh },
    }),
  );
  await page.route(`**/api/babies/${MAYA}`, (r) =>
    json(r, {
      ...baby,
      birthDateIsDueDate: false,
      birthWeightG: null,
      birthLengthMm: null,
      avatarPhotoId: null,
      createdAt: "2026-01-15T00:00:00.000Z",
      deletedAt: null,
      freeTier: null,
    }),
  );
  await page.route("**/api/me/import/google/connection", (r) =>
    json(r, { available: false, connected: false, connectedAt: null, needsReconnect: false }),
  );
  await page.route("**/api/me/passkeys", (r) =>
    r.request().method() === "GET"
      ? json(r, { passkeys, max: 5 })
      : json(r, passkey(9, "Passkey", null), 201),
  );
  await page.route("**/api/me/passkeys/options", (r) => json(r, optionsBody(creationOptions)));
}

/** A platform authenticator (UV-capable, resident keys) so `supported()` is true and ceremonies run. */
async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function scene(page: Page, name: SceneName) {
  await virtualAuthenticator(page);
  if (name.startsWith("welcome")) {
    await mockSignedOut(page, name === "welcome-captcha" ? "1x00000000000000000000AA" : null);
    await page.route("**/api/auth/passkey/options", (r) =>
      name === "welcome-failed"
        ? json(r, err("passkey_failed", "x"), 401)
        : name === "welcome-captcha"
          ? json(r, err("captcha_required", "Please complete the verification"), 403)
          : json(r, optionsBody(requestOptions)),
    );
    await page.goto("/welcome");
    await expect(tid(page, "welcome-passkey")).toBeVisible({ timeout: 20_000 });
    // Autofill: the field advertises `webauthn` and a conditional request is armed.
    await expect(tid(page, "welcome-email")).toHaveAttribute("autocomplete", "username webauthn");
    if (name === "welcome-failed") {
      // The armed autofill request hits the 401 silently (the user did nothing); the generic
      // line only shows after an explicit press, with the email code form still primary.
      await page.waitForTimeout(500);
      await expect(tid(page, "welcome-error")).toHaveCount(0);
      await tid(page, "welcome-passkey").click();
      await expect(tid(page, "welcome-error")).toHaveText(/didn't work/);
    } else if (name === "welcome-captcha") {
      await tid(page, "welcome-passkey").click();
      await expect(tid(page, "welcome-error")).toBeVisible();
      await expect(tid(page, "turnstile")).toBeAttached();
    }
  } else if (name.startsWith("prompt")) {
    await mockSignedIn(page, []);
    await page.goto("/settings");
    await expect(tid(page, "settings")).toBeVisible({ timeout: 20_000 });
    const sheet = page.locator('[data-testid="passkey-prompt"]');
    await expect(sheet.locator('[data-testid="passkey-prompt-add"]')).toBeVisible({
      timeout: 20_000,
    });
    if (name === "prompt-added") {
      await sheet.locator('[data-testid="passkey-prompt-add"]').click();
      await expect(sheet.locator('[data-testid="passkey-prompt-added"]')).toBeVisible({
        timeout: 20_000,
      });
    }
  } else {
    const list = name === "settings-empty" ? [] : name === "settings-limit" ? FULL : LIST;
    await mockSignedIn(page, list, false);
    await page.route(`**/api/me/passkeys/${PK(3)}`, (r) =>
      r.request().method() === "DELETE"
        ? json(r, err("fresh_sign_in_required", "Please sign in again"), 403)
        : r.fallback(),
    );
    await page.route("**/api/auth/otp", (r) => json(r, { ok: true }, 202));
    await page.goto("/settings/passkeys");
    await expect(tid(page, "passkeys")).toBeVisible({ timeout: 20_000 });
    if (name === "settings-empty") {
      await expect(tid(page, "passkeys-empty")).toBeVisible();
    } else if (name === "settings-limit") {
      await expect(tid(page, "passkeys-full")).toBeVisible();
    } else if (name === "settings-rename") {
      await tid(page, "passkey-rename").click();
      await expect(tid(page, "passkey-rename-input")).toBeVisible();
    } else if (name === "settings-remove-fresh") {
      await tid(page, "passkey-remove").click();
      const confirm = page.getByRole("button", { name: "Remove passkey" });
      await expect(confirm).toBeVisible();
      await confirm.click();
      await expect(page.locator('[data-testid="fresh-gate-passkey"]')).toBeVisible({
        timeout: 20_000,
      });
    } else {
      await expect(tid(page, "passkeys-list")).toBeVisible();
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
    await ctx.addInitScript(
      ([b, prompt]) => {
        localStorage.setItem("ll_current_baby", b);
        // The marker an email-code sign-in leaves for the one-time card.
        if (prompt) sessionStorage.setItem("ll_passkey_offer", "1");
      },
      [MAYA, name.startsWith("prompt")] as const,
    );
    const page = await ctx.newPage();
    try {
      await scene(page, name);
      await page.screenshot({ path: path.join(dir, `passkeys-${name}.png`) });
      console.log("  ", `${scheme}-${size}/passkeys-${name}.png`);
    } catch (e) {
      await page.screenshot({ path: path.join(dir, `passkeys-${name}-FAILED.png`) });
      console.log(`   !! ${name}: ${(e as Error).message.split("\n")[0]}`);
    }
    await ctx.close();
  }
}

const browser = await chromium.launch();
try {
  for (const scheme of schemes) for (const size of sizes) await run(browser, scheme, size);
} finally {
  await browser.close();
}
