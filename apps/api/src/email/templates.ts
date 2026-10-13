import type { BabyRole } from "@tinyglow/shared";
import type { MailMessage } from "./mailer";

// API email templates (docs/plans/step-3.md 2.7). Plain and branded: the only image is the brand
// logo, served by web at `${PUBLIC_URL}/email/logo.png` (alt text "Tinyglow" when images are
// blocked). No trackers, no other remote content. Every interpolated value is HTML-escaped; links
// are http(s) only. Pair with `Mailer.send({ to, ...content })`.

export type EmailContent = Required<Omit<MailMessage, "to">>;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Strip CR/LF and other control characters from values that land in a subject line. */
function oneLine(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function safeUrl(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("email links must be http(s)");
  }
  return u.toString();
}

function formatUtc(d: Date): string {
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(d)} UTC`;
}

const ROLE_LABEL: Readonly<Record<BabyRole, string>> = {
  admin: "a co-admin",
  contributor: "a contributor",
};

/** Path of the email logo under `PUBLIC_URL` (apps/mobile-web/public/email/logo.png, 480x108). */
export const EMAIL_LOGO_PATH = "/email/logo.png";

/**
 * The logo URL for an email whose link is `link`. Every link in these emails is built from
 * `PUBLIC_URL`, the browser origin, so the link's origin is `PUBLIC_URL`.
 */
function logoUrl(link: string): string {
  return `${new URL(link).origin}${EMAIL_LOGO_PATH}`;
}

function layout(title: string, bodyHtml: string, logoSrc: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:24px;background:#faf7f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#2b2b2b;">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
<p style="margin:0 0 24px;"><img src="${escapeHtml(logoSrc)}" alt="Tinyglow" width="240" height="54" style="display:block;border:0;outline:none;text-decoration:none;font-size:20px;font-weight:600;color:#2b2b2b;"></p>
${bodyHtml}
<p style="margin:32px 0 0;font-size:12px;color:#777;">You're receiving this because someone used this address on Tinyglow, a private baby photo album.</p>
</div>
</body>
</html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;background:#3b6e5a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">${escapeHtml(label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#555;">Or paste this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(href)}</span></p>`;
}

export interface InviteEmailInput {
  babyName: string;
  inviterName: string;
  role: BabyRole;
  /** `${PUBLIC_URL}/invite/${token}`. Contains a bearer token: never log it. */
  acceptUrl: string;
  expiresAt: Date;
}

export function inviteEmail(input: InviteEmailInput): EmailContent {
  const baby = oneLine(input.babyName);
  const inviter = oneLine(input.inviterName);
  const url = safeUrl(input.acceptUrl);
  const role = ROLE_LABEL[input.role];
  const expires = formatUtc(input.expiresAt);
  const subject = `You're invited to ${baby}'s album on Tinyglow`;
  const html = layout(
    subject,
    `<p style="margin:0 0 16px;font-size:16px;">${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(baby)}</strong>'s album as ${escapeHtml(role)}.</p>
${button(url, "Accept invite")}
<p style="margin:0;font-size:14px;color:#555;">This invite expires in 7 days (${escapeHtml(expires)}); accept it by signing in with this email address.</p>`,
    logoUrl(url),
  );
  const text = `${inviter} invited you to join ${baby}'s album on Tinyglow as ${role}.

Accept the invite: ${url}

This invite expires in 7 days (${expires}); accept it by signing in with this email address.
`;
  return { template: "invite", subject, html, text };
}

export interface NewDeviceEmailInput {
  when: Date;
  /** `userAgentLabel()` output, e.g. "Safari on iPhone". */
  deviceLabel: string;
  /** `CF-IPCountry` code or `null`. */
  country: string | null;
  /** `${PUBLIC_URL}/settings/devices`. */
  devicesUrl: string;
}

export function newDeviceEmail(input: NewDeviceEmailInput): EmailContent {
  const device = oneLine(input.deviceLabel);
  const when = formatUtc(input.when);
  const where = input.country ? oneLine(input.country) : null;
  const url = safeUrl(input.devicesUrl);
  const subject = "New sign-in to your Tinyglow account";
  const details = `${device}, ${when}${where ? `, country ${where}` : ""}`;
  const html = layout(
    subject,
    `<p style="margin:0 0 16px;font-size:16px;">Your account was just signed in on a new device:</p>
<p style="margin:0 0 16px;font-size:15px;"><strong>${escapeHtml(details)}</strong></p>
<p style="margin:0 0 8px;font-size:14px;">If this was you, there's nothing to do. If not, sign that device out and check your email account's security.</p>
${button(url, "Review devices")}`,
    logoUrl(url),
  );
  const text = `Your Tinyglow account was just signed in on a new device:

${details}

If this was you, there's nothing to do. If not, sign that device out: ${url}
`;
  return { template: "new_device", subject, html, text };
}

export interface PasskeyChangedEmailInput {
  action: "added" | "removed";
  when: Date;
  /** `userAgentLabel()` output, e.g. "Safari on iPhone". */
  deviceLabel: string;
  /** `CF-IPCountry` code or `null`. */
  country: string | null;
  /** `PUBLIC_URL` (used for the logo only; this email carries no links by design). */
  publicUrl: string;
}

/**
 * Step 13 (docs/plans/step-13.md 0 Q7, 2.4): a passkey was added to or removed from the account.
 * New-device-alert family, deliberately without links or buttons (a phishing lookalike cannot
 * borrow a call to action from it). Never names the passkey.
 */
export function passkeyChangedEmail(input: PasskeyChangedEmailInput): EmailContent {
  const device = oneLine(input.deviceLabel);
  const when = formatUtc(input.when);
  const where = input.country ? oneLine(input.country) : null;
  const details = `${device}, ${when}${where ? `, country ${where}` : ""}`;
  const added = input.action === "added";
  const subject = added
    ? "A passkey was added to your Tinyglow account"
    : "A passkey was removed from your Tinyglow account";
  const lead = added
    ? "A passkey was just added to your Tinyglow account from:"
    : "A passkey was just removed from your Tinyglow account from:";
  const advice =
    "If this was you, there's nothing to do. If not, open Tinyglow, go to Settings, review your passkeys and devices, and check your email account's security.";
  const html = layout(
    subject,
    `<p style="margin:0 0 16px;font-size:16px;">${escapeHtml(lead)}</p>
<p style="margin:0 0 16px;font-size:15px;"><strong>${escapeHtml(details)}</strong></p>
<p style="margin:0;font-size:14px;">${escapeHtml(advice)}</p>`,
    logoUrl(safeUrl(input.publicUrl)),
  );
  const text = `${lead}

${details}

${advice}
`;
  return { template: added ? "passkey_added" : "passkey_removed", subject, html, text };
}
