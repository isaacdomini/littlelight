import { describe, expect, it } from "vitest";
import { captureMailer } from "./mailer";
import { escapeHtml, inviteEmail, newDeviceEmail, passkeyChangedEmail } from "./templates";

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
    // The template's own logo is an <img>; the injected markup must never appear unescaped.
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).not.toContain('onerror="alert(1)"');
    expect(m.html).toContain("&lt;img src=x");
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

describe("passkeyChangedEmail (step 13, Q7: no links, no name)", () => {
  const base = {
    when: new Date("2026-10-11T12:34:00Z"),
    deviceLabel: "Safari on iPhone",
    country: "DE" as string | null,
    publicUrl: "http://localhost:8080",
  };

  it.each([
    ["added", "passkey_added", "A passkey was added to your Tinyglow account"],
    ["removed", "passkey_removed", "A passkey was removed from your Tinyglow account"],
  ] as const)(
    "%s: template %s, subject %j, device/time/country, no <a> and no URL in the text",
    (action, template, subject) => {
      const m = passkeyChangedEmail({ ...base, action });
      expect(m.template).toBe(template);
      expect(m.subject).toBe(subject);
      expect(m.text).toContain("Safari on iPhone");
      expect(m.text).toContain("country DE");
      expect(m.text).toContain("UTC");
      expect(m.html).toContain("Safari on iPhone");
      // Q7: no links a phisher could imitate.
      expect(m.html).not.toContain("<a ");
      expect(m.html).not.toContain("href=");
      expect(m.text).not.toMatch(/https?:\/\//);
      // never an IP
      expect(m.text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
      expect(m.subject).not.toMatch(/[\r\n]/);
    },
  );

  it("never carries the passkey's name (the caller has no field for it) and omits an unknown country", () => {
    const m = passkeyChangedEmail({
      ...base,
      action: "added",
      country: null,
      ...({ name: "Mom's iPhone" } as Record<string, unknown>),
    });
    expect(m.text).not.toContain("Mom's iPhone");
    expect(m.html).not.toContain("Mom's iPhone");
    expect(m.text).not.toContain("country");
  });

  it("escapes a hostile device label and strips line breaks", () => {
    const m = passkeyChangedEmail({
      ...base,
      action: "removed",
      deviceLabel: '<img src=x onerror="alert(1)">\r\nBcc: evil@example.com',
    });
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain("&lt;img src=x");
    // the injected CR/LF collapsed into one line: "Bcc:" never starts a line of its own
    expect(m.text.split("\n").some((l) => l.startsWith("Bcc:"))).toBe(false);
    expect(m.text).not.toContain("\r");
    expect(m.subject).not.toContain("Bcc");
  });
});
