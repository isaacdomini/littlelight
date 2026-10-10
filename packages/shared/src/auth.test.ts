import { describe, expect, it } from "vitest";
import { userAgentLabel } from "./auth";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Tinyglow/1.0.0";
const IPAD_APP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Tinyglow/1.2.3";
const IPAD_APP_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Tinyglow/1.0.0";
const ANDROID_APP =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 Tinyglow/1.0.0+12";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("userAgentLabel", () => {
  it("labels the native apps by platform, without versions", () => {
    expect(userAgentLabel(IPHONE_APP)).toBe("Tinyglow app on iPhone");
    expect(userAgentLabel(IPAD_APP_UA)).toBe("Tinyglow app on iPad");
    expect(userAgentLabel(ANDROID_APP)).toBe("Tinyglow app on Android");
  });

  it("an iPad WKWebView sends a Macintosh UA: the app on Mac is an iPad", () => {
    expect(userAgentLabel(IPAD_APP)).toBe("Tinyglow app on iPad");
  });

  it("the app token wins over the Chrome/Safari tokens in the same UA", () => {
    expect(userAgentLabel(ANDROID_APP)).not.toContain("Chrome");
  });

  it("does not turn a real Mac Safari into an iPad or an app", () => {
    expect(userAgentLabel(MAC_SAFARI)).toBe("Safari on Mac");
  });

  it("still labels ordinary browsers", () => {
    expect(userAgentLabel(IPHONE_SAFARI)).toBe("Safari on iPhone");
    expect(
      userAgentLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36"),
    ).toBe("Chrome on Windows");
  });

  it("requires the product token to be a whole token", () => {
    expect(userAgentLabel("Mozilla/5.0 (iPhone) XTinyglow/1.0")).not.toContain("Tinyglow app");
    expect(userAgentLabel("Mozilla/5.0 (iPhone) Tinyglow")).not.toContain("Tinyglow app");
  });

  it("falls back for empty or unknown input", () => {
    expect(userAgentLabel(null)).toBe("Unknown device");
    expect(userAgentLabel(undefined)).toBe("Unknown device");
    expect(userAgentLabel("")).toBe("Unknown device");
    expect(userAgentLabel("curl/8.0")).toBe("Unknown device");
  });

  it("ignores anything past 512 characters", () => {
    expect(userAgentLabel(`${"x".repeat(600)} Tinyglow/1.0.0 (iPhone)`)).toBe("Unknown device");
  });
});
