import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingLog } from "../testing/stubs";

const sendMail = vi.fn();
const close = vi.fn();
const createTransport = vi.fn((..._args: unknown[]) => ({ sendMail, close }));
vi.mock("nodemailer", () => ({
  createTransport: (...a: unknown[]) => (createTransport as (...x: unknown[]) => unknown)(...a),
}));

const {
  MailError,
  createExportMailer,
  escapeHtml,
  exportFailedContent,
  exportReadyContent,
  formatExpiry,
  plainName,
} = await import("./mailer");

const EXPIRES = new Date("2026-10-17T14:05:00Z");

beforeEach(() => {
  sendMail.mockReset();
  close.mockReset();
  createTransport.mockClear();
});

describe("export notices carry no link", () => {
  it("ready: names the album, says where to download, has no URL, token or key", () => {
    const m = exportReadyContent({ babyName: "Maya", expiresAt: EXPIRES });
    expect(m.subject).toBe("Your Littlelight export of Maya is ready");
    for (const part of [m.subject, m.text, m.html]) {
      expect(part).not.toMatch(/https?:|www\.|href|token|X-Amz|\.zip|exports\//i);
    }
    expect(m.text).toContain("Settings, then Export album data");
    expect(m.text).toContain("October 17, 2026");
    expect(m.text).toContain("14:05 UTC");
    expect(m.text).toContain("If you did not request this export");
  });

  it("failed: too_large explains the limit, others stay generic and reveal nothing internal", () => {
    const big = exportFailedContent({ babyName: "Maya", error: "too_large" });
    expect(big.text).toContain("larger than this server's export limit");
    const other = exportFailedContent({ babyName: "Maya", error: "storage_error" });
    expect(other.text).toContain("Something went wrong");
    expect(other.text).not.toContain("storage_error");
    for (const m of [big, other]) expect(m.text + m.html).not.toMatch(/https?:|href/i);
  });

  it("escapes HTML in the album name and strips header-injection characters from the subject", () => {
    const m = exportReadyContent({
      babyName: "Maya<script>alert(1)</script>\r\nBcc: evil@x.test",
      expiresAt: EXPIRES,
    });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("plainName collapses whitespace, caps at 80 characters and falls back", () => {
    expect(plainName("  Maya \t\n Rose ")).toBe("Maya Rose");
    expect(Array.from(plainName("x".repeat(200)))).toHaveLength(80);
    expect(plainName("   ")).toBe("your album");
    expect(plainName("\u0000\u0007")).toBe("your album");
  });

  it("formats the expiry in UTC", () => {
    expect(formatExpiry(new Date("2026-01-02T03:04:00Z"))).toBe("January 2, 2026 at 03:04 UTC");
  });
});

describe("createExportMailer", () => {
  const smtp = {
    SMTP_HOST: "mail",
    SMTP_PORT: 1025,
    SMTP_SECURE: false,
    MAIL_FROM: "noreply@littlelight.test",
  };

  it("sends from MAIL_FROM to the recipient and logs the template and message id only", async () => {
    sendMail.mockResolvedValue({ messageId: "<abc@mail>" });
    const log = recordingLog();
    const mailer = createExportMailer(smtp, log);
    await mailer.sendExportReady("mom@example.test", { babyName: "Maya", expiresAt: EXPIRES });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
      from: "noreply@littlelight.test",
      to: "mom@example.test",
    });
    expect(log.lines).toEqual([
      {
        level: "info",
        obj: { template: "export_ready", messageId: "<abc@mail>" },
        msg: "mail sent",
      },
    ]);
    expect(JSON.stringify(log.lines)).not.toContain("mom@example.test");
  });

  it("requires STARTTLS only when credentials are set and implicit TLS is off", () => {
    createExportMailer(smtp, recordingLog());
    expect(createTransport.mock.calls[0]?.[0]).toMatchObject({
      requireTLS: false,
      auth: undefined,
    });
    createExportMailer({ ...smtp, SMTP_USER: "u", SMTP_PASS: "p" }, recordingLog());
    expect(createTransport.mock.calls[1]?.[0]).toMatchObject({
      requireTLS: true,
      auth: { user: "u", pass: "p" },
    });
    createExportMailer(
      { ...smtp, SMTP_USER: "u", SMTP_PASS: "p", SMTP_SECURE: true },
      recordingLog(),
    );
    expect(createTransport.mock.calls[2]?.[0]).toMatchObject({ requireTLS: false, secure: true });
  });

  it("a delivery failure throws a MailError with a safe category and logs no address", async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error("550 mom@example.test rejected"), { code: "EENVELOPE" }),
    );
    const log = recordingLog();
    const mailer = createExportMailer(smtp, log);
    const err = await mailer
      .sendExportFailed("mom@example.test", { babyName: "Maya", error: "internal" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err.category).toBe("EENVELOPE");
    expect(err.message).not.toContain("mom@example.test");
    expect(JSON.stringify(log.lines)).not.toContain("mom@example.test");
    const weird = createExportMailer(smtp, log);
    sendMail.mockRejectedValue(Object.assign(new Error("x"), { code: "weird code!" }));
    expect(
      await weird
        .sendExportReady("a@b.test", { babyName: "M", expiresAt: EXPIRES })
        .catch((e) => e),
    ).toMatchObject({ category: "error" });
  });

  it("close closes the transport", () => {
    createExportMailer(smtp, recordingLog()).close();
    expect(close).toHaveBeenCalled();
  });
});
