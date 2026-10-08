import type { MailEnv } from "@littlelight/shared";
import type { FastifyBaseLogger } from "fastify";
import { createTransport } from "nodemailer";

// Transactional mail sent by the API (docs/plans/step-3.md 2.7, D9): invites and new-device
// alerts. SMTP to Mailpit in dev (`mail:1025`), Postmark/Resend SMTP in production. GoTrue sends
// its own OTP/magic-link mail. Logging rule: template name and SMTP message id only, never
// recipients, subjects, bodies or links (invite links carry a bearer token).

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Template name for logs (e.g. `invite`), the only message attribute ever logged. */
  template?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Thrown when SMTP delivery fails. Carries a safe category only (no cause: it may quote addresses). */
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

export type SmtpConfig = MailEnv & { NODE_ENV?: string };

/**
 * nodemailer SMTP implementation. With credentials configured and implicit TLS off, STARTTLS is
 * required (`requireTLS`) so credentials never cross the wire in clear text; without credentials
 * (Mailpit) STARTTLS is opportunistic.
 */
export function createSmtpMailer(config: SmtpConfig, log: FastifyBaseLogger): Mailer {
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
  const from = config.MAIL_FROM;

  return {
    async send(msg) {
      const template = msg.template ?? "unnamed";
      try {
        const info = await transport.sendMail({
          from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        });
        log.info({ template, messageId: info.messageId }, "mail sent");
      } catch (err) {
        const category = mailErrorCategory(err);
        log.warn({ template, category }, "mail delivery failed");
        throw new MailError(category);
      }
    },
  };
}

export interface CaptureMailer extends Mailer {
  readonly sent: MailMessage[];
  clear(): void;
}

/** In-memory mailer for tests: records every message, sends nothing. */
export function captureMailer(): CaptureMailer {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(msg) {
      sent.push({ ...msg });
    },
    clear() {
      sent.length = 0;
    },
  };
}
