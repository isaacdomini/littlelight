import type { MailEnv } from "@littlelight/shared";
import { createTransport } from "nodemailer";
import type { WorkerLog } from "../log-types";

// Worker mail (docs/plans/review-fixes.md 2.4, D6): "your export is ready / failed" notices to
// the requester. Same nodemailer transport rules as the api's (`apps/api/src/email/mailer.ts`):
// Mailpit in dev, the api's SMTP account in production. The messages carry NO link, token or
// signed URL and no album content beyond the baby's name: the download URL is minted in the app,
// for the requester only, after a fresh sign-in. Logging rule: template name and SMTP message id
// only, never the recipient, subject or body.

export interface ExportReadyMail {
  babyName: string;
  expiresAt: Date;
}

export interface ExportFailedMail {
  babyName: string;
  /** `data_exports.error`; only `too_large` changes the wording. */
  error: string;
}

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

export interface ExportMailer {
  sendExportReady(to: string, mail: ExportReadyMail): Promise<void>;
  sendExportFailed(to: string, mail: ExportFailedMail): Promise<void>;
  close(): void;
}

/** Thrown when SMTP delivery fails; a safe category only (the cause may quote addresses). */
export class MailError extends Error {
  readonly category: string;

  constructor(category: string) {
    super(`mail delivery failed (${category})`);
    this.name = "MailError";
    this.category = category;
  }
}

const SAFE_CATEGORY = /^[A-Za-z0-9_]{1,40}$/;

function mailErrorCategory(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && SAFE_CATEGORY.test(code) ? code : "error";
}

/** Control characters out, whitespace collapsed, at most 80 chars (subject-safe). */
export function plainName(name: string): string {
  const cleaned = Array.from(name)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const short = Array.from(cleaned).slice(0, 80).join("");
  return short.length > 0 ? short : "your album";
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** "October 17, 2026 at 14:05 UTC" (the worker cannot read the requester's time zone). */
export function formatExpiry(d: Date): string {
  const f = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
    hour12: false,
  });
  return `${f.format(d)} UTC`;
}

const WHERE = "Open Littlelight, then Settings, then Export album data";

function html(paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.5;color:#1f2933">\n${body}\n</body></html>`;
}

/** The "ready" notice. Pure; exported for tests (no URL, no token). */
export function exportReadyContent(mail: ExportReadyMail): MailContent {
  const name = plainName(mail.babyName);
  const paragraphs = [
    `Your Littlelight export of ${name} is ready.`,
    `${WHERE} to download it. For your security you may be asked to sign in again first.`,
    `The download is available until ${formatExpiry(mail.expiresAt)}.`,
    "If you did not request this export, open the app and delete it there, and tell your co-parent.",
  ];
  return {
    subject: `Your Littlelight export of ${name} is ready`,
    text: `${paragraphs.join("\n\n")}\n`,
    html: html(paragraphs),
  };
}

/** The "failed" notice. Pure; exported for tests (no URL, no token, no internal detail). */
export function exportFailedContent(mail: ExportFailedMail): MailContent {
  const name = plainName(mail.babyName);
  const why =
    mail.error === "too_large"
      ? "The album is larger than this server's export limit."
      : "Something went wrong while building it. Nothing was shared with anyone.";
  const paragraphs = [
    `Your Littlelight export of ${name} could not be completed.`,
    why,
    `${WHERE} to try again.`,
  ];
  return {
    subject: `Your Littlelight export of ${name} could not be completed`,
    text: `${paragraphs.join("\n\n")}\n`,
    html: html(paragraphs),
  };
}

export type WorkerSmtpConfig = MailEnv;

/**
 * nodemailer SMTP mailer. With credentials and implicit TLS off, STARTTLS is required so
 * credentials never cross the wire in clear text; without credentials (Mailpit) it is
 * opportunistic. Never logs the recipient.
 */
export function createExportMailer(config: WorkerSmtpConfig, log: WorkerLog): ExportMailer {
  const hasAuth = config.SMTP_USER !== undefined;
  const transport = createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    requireTLS: hasAuth && !config.SMTP_SECURE,
    auth: hasAuth ? { user: config.SMTP_USER ?? "", pass: config.SMTP_PASS ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
  });

  async function send(to: string, template: string, content: MailContent): Promise<void> {
    try {
      const info = await transport.sendMail({
        from: config.MAIL_FROM,
        to,
        subject: content.subject,
        text: content.text,
        html: content.html,
      });
      log.info({ template, messageId: info.messageId }, "mail sent");
    } catch (err) {
      const category = mailErrorCategory(err);
      log.warn({ template, category }, "mail delivery failed");
      throw new MailError(category);
    }
  }

  return {
    sendExportReady: (to, mail) => send(to, "export_ready", exportReadyContent(mail)),
    sendExportFailed: (to, mail) => send(to, "export_failed", exportFailedContent(mail)),
    close: () => transport.close(),
  };
}
