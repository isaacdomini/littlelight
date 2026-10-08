import { describe, expect, it } from "vitest";
import { captureMailer } from "./mailer";
import { escapeHtml, inviteEmail, newDeviceEmail } from "./templates";

const expiresAt = new Date("2026-10-15T12:00:00Z");

describe("inviteEmail", () => {
  const base = {
    babyName: "Mia",
    inviterName: "Maria",
    role: "admin" as const,
    acceptUrl: "http://localhost:8080/invite/TOKEN",
    expiresAt,
  };

  it("names baby, inviter and role, and carries the link in both bodies", () => {
    const m = inviteEmail(base);
    expect(m.template).toBe("invite");
    expect(m.subject).toContain("Mia");
    expect(m.text).toContain("http://localhost:8080/invite/TOKEN");
    expect(m.html).toContain('href="http://localhost:8080/invite/TOKEN"');
    expect(m.text).toContain("co-admin");
    expect(inviteEmail({ ...base, role: "contributor" }).text).toContain("contributor");
  });

  it("escapes HTML and strips control characters from the subject", () => {
    const m = inviteEmail({
      ...base,
      babyName: '<img src=x onerror="alert(1)">\r\nBcc: evil@example.com',
      inviterName: "<b>Eve</b>",
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).not.toContain("<b>Eve</b>");
    expect(m.html).toContain("&lt;b&gt;Eve&lt;/b&gt;");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  it("refuses non-http(s) links", () => {
    expect(() => inviteEmail({ ...base, acceptUrl: "javascript:alert(1)" })).toThrow();
    expect(() => inviteEmail({ ...base, acceptUrl: "not a url" })).toThrow();
  });
});

describe("newDeviceEmail", () => {
  it("mentions device, time and country but never an IP", () => {
    const m = newDeviceEmail({
      when: new Date("2026-10-08T12:34:00Z"),
      deviceLabel: "Safari on iPhone",
      country: "DE",
      devicesUrl: "http://localhost:8080/settings/devices",
    });
    expect(m.template).toBe("new_device");
    expect(m.text).toContain("Safari on iPhone");
    expect(m.text).toContain("country DE");
    expect(m.text).toContain("UTC");
    expect(m.text).toContain("/settings/devices");
    expect(m.text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });

  it("omits the country when unknown", () => {
    const m = newDeviceEmail({
      when: new Date(),
      deviceLabel: "Chrome on Windows",
      country: null,
      devicesUrl: "http://localhost:8080/settings/devices",
    });
    expect(m.text).not.toContain("country");
  });
});

describe("escapeHtml / captureMailer", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("records messages and can be cleared", async () => {
    const mailer = captureMailer();
    await mailer.send({ to: "a@b.co", subject: "s", html: "h", text: "t" });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe("a@b.co");
    mailer.clear();
    expect(mailer.sent).toHaveLength(0);
  });
});
