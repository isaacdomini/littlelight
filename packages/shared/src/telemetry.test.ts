import { describe, expect, it } from "vitest";
import {
  REDACTED,
  redactUrl,
  scrubTelemetryEvent,
  scrubTelemetryString,
  TELEMETRY_MAX_DEPTH,
  TELEMETRY_MAX_ITEMS,
  TELEMETRY_MAX_NODES,
  TELEMETRY_MAX_STRING_CHARS,
  TELEMETRY_SCRUB_PATTERNS,
} from "./telemetry";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const SHARE_TOKEN = "Ab3dE6gH9jK2mN5pQ8sT1v"; // 22 chars
const INVITE_TOKEN = "Zq9Xw3Er7Ty1Ui5Op8As2Df6Gh0Jk4Lz7Xc1Vb5Nm9Q"; // 43 chars
const UUID = "0b5c9c55-6c3e-4d2c-9a2e-8f1d7e6a4b21";
const SIG = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

describe("redactUrl", () => {
  it.each([
    ["/api/babies/" + UUID + "/photos", "/api/babies/" + UUID + "/photos"],
    ["/api/invites/" + INVITE_TOKEN, "/api/invites/[redacted]"],
    ["/api/invites/short", "/api/invites/[redacted]"],
    ["/s/" + SHARE_TOKEN, "/s/[redacted]"],
    ["/api/share/session", "/api/share/session"],
    ["/api/share/photos?cursor=abc", "/api/share/photos?[redacted]"],
    [
      "/api/share/manifest.webmanifest?t=" + SHARE_TOKEN,
      "/api/share/manifest.webmanifest?[redacted]",
    ],
    ["/api/share/some-unknown-word", "/api/share/[redacted]"],
    ["/share/" + UUID + "/urls", "/share/" + UUID + "/urls"],
    ["/api/babies/" + UUID + "/exports", "/api/babies/" + UUID + "/exports"],
    ["/healthz", "/healthz"],
    ["/", "/"],
  ])("%s", (input, out) => {
    expect(redactUrl(input)).toBe(out);
  });

  it("drops every query string, even an innocent one", () => {
    expect(redactUrl("/api/search?q=first+bath")).toBe("/api/search?[redacted]");
  });

  it("redacts a token-shaped path segment anywhere", () => {
    expect(redactUrl(`/api/whatever/${SIG}`)).toBe("/api/whatever/[redacted]");
  });
});

describe("TELEMETRY_SCRUB_PATTERNS", () => {
  it("exports every documented pattern without the g flag", () => {
    expect(Object.keys(TELEMETRY_SCRUB_PATTERNS).sort()).toEqual(
      [
        "jwt",
        "authCredential",
        "amzParam",
        "secretPair",
        "urlOrPath",
        "queryOrFragment",
        "email",
        "coordinatePair",
        "wktPoint",
        "labelledCoordinate",
        "pgRowDetail",
        "tokenRun",
        // step 10 (photo import)
        "googleAccessToken",
        "googleRefreshToken",
        "googleAuthCode",
        "fakeGoogleToken",
        "googleMediaUrl",
        "googlePickerUrl",
        "nativeUploadPath",
        "photoLibraryPath",
        "phAssetId",
        "oauthParam",
      ].sort(),
    );
    for (const re of Object.values(TELEMETRY_SCRUB_PATTERNS)) expect(re.flags).not.toContain("g");
  });

  it.each([
    ["jwt", JWT],
    ["authCredential", "Bearer abcdefghijklmnop"],
    ["authCredential", "basic dXNlcjpwYXNzd29yZA=="],
    ["amzParam", "X-Amz-Signature=" + SIG],
    ["amzParam", "X-Amz-Credential=AKIA%2F2026%2Fs3"],
    ["amzParam", "AWSAccessKeyId=AKIAIOSFODNN7EXAMPLE"],
    ["secretPair", "pushToken=abc123"],
    ["secretPair", 'refresh_token: "abc"'],
    ["secretPair", "password=hunter2"],
    ["secretPair", "api_key=zzz"],
    ["email", "mom@example.com"],
    ["coordinatePair", "47.6062, -122.3321"],
    ["wktPoint", "POINT(-122.3321 47.6062)"],
    ["labelledCoordinate", "lat=47.6062"],
    ["labelledCoordinate", '"gps_lng": -122.33'],
    ["pgRowDetail", "Failing row contains (a, b, c)"],
    ["pgRowDetail", "Key (email)=(mom@example.com)"],
    ["tokenRun", " " + SHARE_TOKEN],
    ["urlOrPath", "https://x.test/a/b?c=d"],
    ["queryOrFragment", "callback?code=123"],
    ["googleAccessToken", "ya29.a0AfH6SMBx-_abc123"],
    ["googleRefreshToken", "1//0gAbCdEfGhIjKlMn-op"],
    ["googleAuthCode", "4/0AfJohXkAbCdEfGhIj_k"],
    ["fakeGoogleToken", "fake-access-abc123"],
    ["fakeGoogleToken", "fake-refresh-abc123"],
    ["fakeGoogleToken", "fake-code-abc123"],
    ["googleMediaUrl", "https://lh3.googleusercontent.com/pw/AP1Gcz=d"],
    ["googlePickerUrl", "photospicker.googleapis.com/v1/sessions/abc123"],
    ["nativeUploadPath", "/Library/Caches/ll-uploads/1234.heic"],
    ["photoLibraryPath", "/var/mobile/Media/DCIM/100APPLE/IMG_0001.HEIC"],
    ["phAssetId", "ABCDEF01-2345-6789-ABCD-EF0123456789/L0/001"],
    ["oauthParam", "callback code=abc&state=def"],
  ] as [keyof typeof TELEMETRY_SCRUB_PATTERNS, string][])("%s matches %j", (name, sample) => {
    expect(TELEMETRY_SCRUB_PATTERNS[name].test(sample)).toBe(true);
  });
});

describe("scrubTelemetryString: photo import (step 10)", () => {
  const FAKE_TOKENS = ["fake-access-9f8e7d6c", "fake-refresh-9f8e7d6c", "fake-code-9f8e7d6c"];
  const REAL_TOKENS = [
    "ya29.a0AfH6SMBx-_abc123",
    "1//0gAbCdEfGhIjKlMn-op",
    "4/0AfJohXkAbCdEfGhIj_k",
  ];

  it.each([...FAKE_TOKENS, ...REAL_TOKENS])("scrubs the token %s", (tok) => {
    const out = scrubTelemetryString(`exchange failed for ${tok} at upstream`);
    expect(out).not.toContain(tok);
    expect(out).toContain(REDACTED);
    expect(out).toContain("upstream");
  });

  it("scrubs googleusercontent URLs, keeping only the host", () => {
    const out = scrubTelemetryString("GET https://lh3.googleusercontent.com/pw/AP1GczSECRET=d 403");
    expect(out).not.toContain("AP1GczSECRET");
    expect(out).not.toContain("/pw/");
    expect(out).toContain("lh3.googleusercontent.com");
  });

  it("scrubs picker session URLs", () => {
    const out = scrubTelemetryString(
      "DELETE https://photospicker.googleapis.com/v1/sessions/SESS-123 404",
    );
    expect(out).not.toContain("SESS-123");
  });

  it("scrubs the native upload cache path and photo-library paths", () => {
    const out = scrubTelemetryString(
      "open /var/mobile/Containers/Data/Caches/ll-uploads/AAAA-1.heic and /var/mobile/Media/DCIM/100APPLE/IMG_0001.HEIC",
    );
    expect(out).not.toContain("AAAA-1.heic");
    expect(out).not.toContain("IMG_0001");
    expect(out).toContain("ll-uploads/");
  });

  it.each([
    [
      "ll-sync-export",
      "/var/mobile/Containers/Data/Caches/ll-sync-export/MayaBirthday-IMG_0042.heic",
    ],
    [
      "ll-sync",
      "/var/mobile/Containers/Data/Library/Application Support/ll-sync/9f86d081884c7d65.json",
    ],
    ["ll-share", "/private/var/mobile/Containers/Shared/AppGroup/X/ll-share/Maya-first-bath.jpg"],
  ])("scrubs files under %s/ but keeps the directory name", (dir, path) => {
    const out = scrubTelemetryString(`open failed: ${path} (ENOENT)`);
    const leaf = path.split("/").pop() as string;
    expect(out).not.toContain(leaf);
    expect(out).toContain(`${dir}/`);
    expect(out).toContain("(ENOENT)");
  });

  it("scrubs PHAsset local identifiers", () => {
    const out = scrubTelemetryString("asset ABCDEF01-2345-6789-ABCD-EF0123456789/L0/001 failed");
    expect(out).not.toContain("ABCDEF01");
    expect(out).toContain("[asset-id]");
  });

  it("scrubs OAuth callback code/state pairs", () => {
    const out = scrubTelemetryString("callback code=xyz789secret state=st4te123");
    expect(out).not.toContain("xyz789secret");
    expect(out).not.toContain("st4te123");
  });

  it("is idempotent on all of the above", () => {
    const once = scrubTelemetryString(
      `${FAKE_TOKENS.join(" ")} ${REAL_TOKENS.join(" ")} https://lh3.googleusercontent.com/pw/AAA=d ll-uploads/x.heic`,
    );
    expect(scrubTelemetryString(once)).toBe(once);
  });

  it("drops the values of keys that carry Google capabilities and device-only ids", () => {
    const out = JSON.stringify(
      scrubTelemetryEvent({
        exception: { values: [{ type: "Error", value: "x" }] },
        extra: {},
        contexts: {
          trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef" },
        },
        tags: {
          baseUrl: "https://lh3.googleusercontent.com/SECRETBASE",
          pickerUri: "https://photos.google.com/picker/SECRETPICKER",
          albumTitle: "Mia first year",
          deviceLabel: "Dad iPhone",
          localIdentifier: "SECRETLOCAL",
        },
      }),
    );
    for (const s of ["SECRETBASE", "SECRETPICKER", "Mia first year", "Dad iPhone", "SECRETLOCAL"])
      expect(out, s).not.toContain(s);
  });
});

describe("scrubTelemetryString: each pattern", () => {
  it("replaces a JWT", () => {
    const out = scrubTelemetryString(`token was ${JWT} here`);
    expect(out).toBe("token was [jwt] here");
    expect(out).not.toContain("eyJ");
  });

  it("replaces a JWT even inside a URL query or JSON", () => {
    expect(scrubTelemetryString(`{"access":"${JWT}"}`)).not.toContain("eyJ");
    expect(scrubTelemetryString(`https://a.test/cb#access_token=${JWT}`)).not.toContain("eyJ");
  });

  it("replaces Bearer and Basic credentials", () => {
    expect(scrubTelemetryString("Authorization: Bearer abc.def-ghi_jkl123")).not.toContain(
      "abc.def",
    );
    expect(scrubTelemetryString("Bearer abc.def-ghi_jkl123")).toBe(`Bearer ${REDACTED}`);
    expect(scrubTelemetryString("Basic dXNlcjpwYXNzd29yZA==")).toBe(`Basic ${REDACTED}`);
  });

  it("replaces X-Amz-* and signature parameters, keeping the parameter names", () => {
    const url = `X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20260101&X-Amz-Signature=${SIG}`;
    const out = scrubTelemetryString(url);
    expect(out).not.toContain(SIG);
    expect(out).not.toContain("AKIA");
    expect(out).toContain(`X-Amz-Signature=${REDACTED}`);
  });

  it("replaces a presigned export URL entirely down to path", () => {
    const url = `http://localhost:9000/littlelight/babies/${UUID}/exports/${UUID}.zip?X-Amz-Signature=${SIG}&X-Amz-Expires=600`;
    const out = scrubTelemetryString(`GET ${url} failed`);
    expect(out).not.toContain("X-Amz");
    expect(out).not.toContain(SIG);
    expect(out).toContain("?[redacted]");
    expect(out).toContain("failed");
  });

  it.each([
    ["pushToken=abc123def", "pushToken=[redacted]"],
    ["refresh_token: abc123def", "refresh_token: [redacted]"],
    ['{"token_hash":"abc123def"}', '{"token_hash":"[redacted]"}'],
    ["password=hunter2 next", "password=[redacted] next"],
    ["otp=123456", "otp=[redacted]"],
    ["client_secret=zzzz", "client_secret=[redacted]"],
    ["api_key=zzzz", "api_key=[redacted]"],
    ["passcode: 482913", "passcode: [redacted]"],
  ])("secret pair %j", (input, out) => {
    expect(scrubTelemetryString(input)).toBe(out);
  });

  it("removes URL user-info and query strings and fragments", () => {
    const out = scrubTelemetryString("fetch https://user:pw@host.test:8080/path?a=b#frag failed");
    expect(out).toBe(`fetch https://${REDACTED}@host.test:8080/path?${REDACTED} failed`);
    expect(scrubTelemetryString("http://h.test/p#access_token=abc")).toBe(
      `http://h.test/p#${REDACTED}`,
    );
  });

  it("redacts the segment after /invites/ and /s/ (SPA share link)", () => {
    expect(scrubTelemetryString(`GET /api/invites/${INVITE_TOKEN} 404`)).toBe(
      "GET /api/invites/[redacted] 404",
    );
    expect(scrubTelemetryString(`https://app.test/s/${SHARE_TOKEN}`)).toBe(
      "https://app.test/s/[redacted]",
    );
    expect(scrubTelemetryString("https://app.test/s/short-but-secret")).toBe(
      "https://app.test/s/[redacted]",
    );
  });

  it("keeps UUIDs readable", () => {
    expect(scrubTelemetryString(`baby ${UUID} not found`)).toBe(`baby ${UUID} not found`);
    expect(scrubTelemetryString(`/api/babies/${UUID}/photos`)).toBe(`/api/babies/${UUID}/photos`);
  });

  it("replaces glued query strings and fragments", () => {
    expect(scrubTelemetryString("callback?code=123")).toBe(`callback?${REDACTED}`);
    expect(scrubTelemetryString("x#token_hash=abc")).toBe(`x#${REDACTED}`);
  });

  it.each(["mom@example.com", "first.last+tag@sub.example.co.uk", "demo-mom@littlelight.local"])(
    "replaces the email %s",
    (email) => {
      const out = scrubTelemetryString(`user ${email} not found`);
      expect(out).toBe("user [email] not found");
    },
  );

  it.each([
    ["at 47.6062, -122.3321 today", "at [coords] today"],
    ["47.6062,-122.3321", "[coords]"],
    ["POINT(-122.3321 47.6062)", "POINT([coords])"],
    ["point ( 1 2 )", "POINT([coords])"],
  ])("replaces coordinates in %j", (input, out) => {
    expect(scrubTelemetryString(input)).toBe(out);
  });

  it("replaces labelled coordinates", () => {
    expect(scrubTelemetryString("lat=47.6 lng=-122.3")).toBe(`lat=${REDACTED} lng=${REDACTED}`);
    expect(scrubTelemetryString('{"gps_lat": 47.6062}')).toBe(`{"gps_lat": ${REDACTED}}`);
    expect(scrubTelemetryString("latitude: 47.6")).toBe(`latitude: ${REDACTED}`);
  });

  it("replaces Postgres row details", () => {
    const m =
      'new row violates check constraint "x"\nDetail: Failing row contains (1, mom@x.test, 47.6062).';
    const out = scrubTelemetryString(m);
    expect(out).not.toContain("1, mom");
    expect(out).toContain("Failing row contains (");
    expect(scrubTelemetryString("duplicate key\nKey (email)=(mom@x.test) already exists.")).toBe(
      `duplicate key\nKey (email)=(${REDACTED}) already exists.`,
    );
  });

  it("replaces token-shaped runs (share, invite, hex digests) but keeps identifiers", () => {
    expect(scrubTelemetryString(`link ${SHARE_TOKEN} used`)).toBe(`link ${REDACTED} used`);
    expect(scrubTelemetryString(`invite ${INVITE_TOKEN}`)).toBe(`invite ${REDACTED}`);
    expect(scrubTelemetryString(`sha ${SIG}`)).toBe(`sha ${REDACTED}`);
    expect(scrubTelemetryString("at processTicksAndRejections (node:internal)")).toContain(
      "processTicksAndRejections",
    );
    expect(scrubTelemetryString("FST_ERR_CTP_INVALID_MEDIA_TYPE")).toBe(
      "FST_ERR_CTP_INVALID_MEDIA_TYPE",
    );
  });

  it("leaves a plain message alone", () => {
    expect(scrubTelemetryString("connect ECONNREFUSED")).toBe("connect ECONNREFUSED");
    expect(scrubTelemetryString("")).toBe("");
  });

  it("random share tokens never survive in free text (bulk check)", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let leaked = 0;
    for (let i = 0; i < 2000; i++) {
      let t = "";
      for (let j = 0; j < 43; j++) t += alphabet[Math.floor(rnd() * alphabet.length)];
      if (scrubTelemetryString(`opened ${t} ok`).includes(t)) leaked++;
    }
    expect(leaked).toBe(0);
  });
});

describe("scrubTelemetryString: size and shape", () => {
  it("caps a long string at the limit, marker included", () => {
    const out = scrubTelemetryString("word ".repeat(2000));
    expect(out.length).toBeLessThanOrEqual(TELEMETRY_MAX_STRING_CHARS);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("does not leave a token fragment when the pre-cut lands inside a token", () => {
    const filler = "a ".repeat(TELEMETRY_MAX_STRING_CHARS * 4 - 5);
    const out = scrubTelemetryString(`${filler}${SHARE_TOKEN}${SHARE_TOKEN}`);
    expect(out).not.toContain(SHARE_TOKEN.slice(0, 8));
  });

  it("is linear enough on adversarial input (no catastrophic backtracking)", () => {
    const t0 = Date.now();
    scrubTelemetryString("a".repeat(16_000));
    scrubTelemetryString("/".repeat(16_000));
    scrubTelemetryString("?".repeat(16_000));
    scrubTelemetryString("a@".repeat(8_000));
    scrubTelemetryString("1.234,".repeat(3_000));
    scrubTelemetryString(`token=${"=".repeat(10_000)}`);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("is idempotent over a varied corpus", () => {
    const corpus = [
      `Bearer abcdefghijklmnop at https://u:p@h.test/s/${SHARE_TOKEN}?x=1#y`,
      `lat=47.6 mom@x.test 47.6062, -122.3321 ${JWT}`,
      `Key (email)=(a@b.cc) ${SIG} POINT(1 2)`,
      "x".repeat(5000),
      "callback?code=123 and a#token_hash=abc",
    ];
    for (const s of corpus) {
      const once = scrubTelemetryString(s);
      expect(scrubTelemetryString(once)).toBe(once);
    }
  });
});

/** A Sentry-shaped event with sensitive data in every place the plan lists. */
function fixtureEvent() {
  return {
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1_790_000_000.5,
    platform: "node",
    level: "error",
    release: "littlelight@1.0.0",
    environment: "production",
    server_name: "host-mom-laptop.local",
    transaction: "POST /api/babies/x/photos",
    message: `failed for mom@example.com at 47.6062, -122.3321 with ${JWT}`,
    request: {
      url: `https://app.test/s/${SHARE_TOKEN}?t=${SHARE_TOKEN}`,
      method: "POST",
      headers: { cookie: "sb-access-token=" + JWT, "x-forwarded-for": "10.0.0.7" },
      cookies: { session: JWT },
      data: { note: "Maya took her first steps today" },
      query_string: "t=" + SHARE_TOKEN,
    },
    user: { id: UUID, email: "mom@example.com", ip_address: "203.0.113.9" },
    breadcrumbs: [
      { category: "fetch", data: { url: `/api/invites/${INVITE_TOKEN}` } },
      { category: "console", message: "mom@example.com" },
    ],
    extra: { prompt: "Describe the photo. Parent note: first bath", lat: 47.6 },
    tags: {
      route: "/api/babies/:id/exports",
      owner: "mom@example.com",
      where: "47.6062, -122.3321",
      sig: `X-Amz-Signature=${SIG}`,
    },
    contexts: {
      runtime: { name: "node", version: "v22.12.0" },
      culture: { locale: "en-US", timezone: "America/Los_Angeles" },
      device: { model: "MacBookPro" },
      app: { app_memory: 123456, app_start_time: "2026-01-01T00:00:00Z" },
      trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef" },
    },
    exception: {
      values: [
        {
          type: "Error",
          value: `Failing row contains (${UUID}, mom@example.com, 47.6062). token=abc123`,
          stacktrace: {
            frames: [
              {
                filename: `/app/dist/routes.js?X-Amz-Signature=${SIG}`,
                function: "handler",
                lineno: 42,
                vars: { email: "mom@example.com", token: JWT, other: "x" },
                context_line: `const url = "https://u:pw@host/?token=abc"; // mom@example.com`,
                pre_context: ["lat = 47.6062"],
                post_context: [`Bearer abcdefghijklmnop`],
              },
            ],
          },
          mechanism: { type: "generic", handled: false },
        },
      ],
    },
  };
}

describe("scrubTelemetryEvent", () => {
  const SECRETS = [
    JWT,
    "eyJ",
    SHARE_TOKEN,
    INVITE_TOKEN,
    SIG,
    "mom@example.com",
    "47.6062",
    "-122.3321",
    "X-Amz-Signature=" + SIG,
    "first steps",
    "first bath",
    "203.0.113.9",
    "host-mom-laptop",
    "America/Los_Angeles",
    "abc123",
    "hunter2",
    "u:pw@",
  ];

  it("no secret survives anywhere in a Sentry-shaped event", () => {
    const out = JSON.stringify(scrubTelemetryEvent(fixtureEvent()));
    for (const s of SECRETS) expect(out, s).not.toContain(s);
  });

  it("deletes request, user, breadcrumbs, extra, server_name and transaction", () => {
    const out = scrubTelemetryEvent(fixtureEvent()) as Record<string, unknown>;
    for (const k of ["request", "user", "breadcrumbs", "extra", "server_name", "transaction"])
      expect(out).not.toHaveProperty(k);
  });

  it("deletes contexts.culture/device/app and keeps runtime and trace", () => {
    const out = scrubTelemetryEvent(fixtureEvent()) as { contexts: Record<string, unknown> };
    expect(Object.keys(out.contexts).sort()).toEqual(["runtime", "trace"]);
    expect(out.contexts.trace).toEqual({
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
    });
  });

  it("keeps the useful parts: type, frame names and line numbers, release, level, route tag", () => {
    const out = scrubTelemetryEvent(fixtureEvent()) as ReturnType<typeof fixtureEvent>;
    expect(out.event_id).toBe("0123456789abcdef0123456789abcdef");
    expect(out.release).toBe("littlelight@1.0.0");
    expect(out.level).toBe("error");
    expect(out.tags.route).toBe("/api/babies/:id/exports");
    const ex = out.exception.values[0];
    expect(ex?.type).toBe("Error");
    expect(ex?.stacktrace.frames[0]).toMatchObject({ function: "handler", lineno: 42 });
    expect(ex?.mechanism).toEqual({ type: "generic", handled: false });
  });

  it("drops frame vars entirely and scrubs frame context lines", () => {
    const out = scrubTelemetryEvent(fixtureEvent());
    const frame = (out as ReturnType<typeof fixtureEvent>).exception.values[0]?.stacktrace
      .frames[0];
    expect(frame).not.toHaveProperty("vars");
    expect(frame?.context_line).not.toContain("mom@example.com");
    expect(frame?.pre_context?.[0]).not.toContain("47.6062");
    expect(frame?.post_context?.[0]).not.toContain("abcdefghijklmnop");
  });

  it("is idempotent", () => {
    const once = scrubTelemetryEvent(fixtureEvent());
    expect(scrubTelemetryEvent(once)).toEqual(once);
  });

  it("does not mutate its input", () => {
    const ev = fixtureEvent();
    const snapshot = JSON.stringify(ev);
    scrubTelemetryEvent(ev);
    expect(JSON.stringify(ev)).toBe(snapshot);
  });

  it("returns an empty object for non-object input", () => {
    expect(scrubTelemetryEvent(null as never)).toEqual({});
    expect(scrubTelemetryEvent([] as never)).toEqual({});
    expect(scrubTelemetryEvent("x" as never)).toEqual({});
  });

  it("is safe on an empty event", () => {
    expect(scrubTelemetryEvent({})).toEqual({});
  });
});

describe("scrubTelemetryEvent: sensitive keys at any depth", () => {
  const keys = [
    "cookie",
    "cookies",
    "Set-Cookie",
    "authorization",
    "Proxy-Authorization",
    "headers",
    "body",
    "data",
    "query_string",
    "query",
    "params",
    "vars",
    "token",
    "pushToken",
    "refresh_token",
    "access_token",
    "password",
    "client_secret",
    "passcode",
    "otp",
    "api_key",
    "X-Api-Key",
    "apiKey",
    "dsn",
    "signature",
    "email",
    "ownerEmail",
    "ip",
    "ip_address",
    "X-Forwarded-For",
    "CF-Connecting-IP",
    "phone",
    "displayName",
    "babyName",
    "lat",
    "lng",
    "latitude",
    "longitude",
    "gps_lat",
    "gps_lng",
    "home_lat",
    "coords",
    "location",
    "exif",
    "note",
    "notes",
    "caption",
    "description",
    "prompt",
    "systemPrompt",
    "userPrompt",
    "messages",
    "content",
    "text",
    "question",
    "answer",
    "searchTags",
    "people",
  ];

  it.each(keys)("drops %s at the top, nested, and inside arrays", (key) => {
    const ev = {
      tags: { [key]: "VALUE-A", keep: "ok" },
      contexts: { custom: { deep: { deeper: [{ [key]: "VALUE-B", keep: "ok" }] } } },
    };
    const out = JSON.stringify(scrubTelemetryEvent(ev));
    expect(out).not.toContain("VALUE-A");
    expect(out).not.toContain("VALUE-B");
    expect(out).toContain('"keep":"ok"');
  });

  it("does not drop innocuous keys that merely share letters", () => {
    const out = scrubTelemetryEvent({
      tags: { service: "api", queue: "data.export", status: "500", route: "/x" },
    });
    expect(out.tags).toEqual({ service: "api", queue: "data.export", status: "500", route: "/x" });
  });

  it("scrubs keys that carry data (a tag named after an email)", () => {
    const out = JSON.stringify(scrubTelemetryEvent({ tags: { "mom@example.com": "x" } }));
    expect(out).not.toContain("mom@example.com");
  });
});

describe("scrubTelemetryEvent: structure limits", () => {
  it("replaces values deeper than the maximum depth", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < TELEMETRY_MAX_DEPTH + 5; i++) deep = { n: deep };
    const out = JSON.stringify(scrubTelemetryEvent({ tags: deep as object }));
    expect(out).toContain("[depth]");
    expect(out).not.toContain("leaf");
  });

  it("cuts cycles", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = JSON.stringify(scrubTelemetryEvent({ tags: a }));
    expect(out).toContain("[circular]");
  });

  it("turns a reference back to the event into [circular], not a second unscrubbed copy", () => {
    const ev: Record<string, unknown> = { request: { url: "mom@example.com" }, tags: {} };
    (ev.tags as Record<string, unknown>).evt = ev;
    const out = JSON.stringify(scrubTelemetryEvent(ev));
    expect(out).toContain("[circular]");
    expect(out).not.toContain("mom@example.com");
  });

  it("caps arrays and objects", () => {
    const arr = Array.from({ length: TELEMETRY_MAX_ITEMS + 50 }, (_, i) => i);
    const obj = Object.fromEntries(arr.map((i) => [`k${i}`, i]));
    const out = scrubTelemetryEvent({ tags: { arr, obj } }) as {
      tags: { arr: unknown[]; obj: object };
    };
    expect(out.tags.arr).toHaveLength(TELEMETRY_MAX_ITEMS);
    expect(Object.keys(out.tags.obj)).toHaveLength(TELEMETRY_MAX_ITEMS);
  });

  it("bounds total work on shared references", () => {
    const shared = Array.from({ length: 200 }, (_, i) => ({ i }));
    const wide = Array.from({ length: 200 }, () => shared);
    const out = JSON.stringify(scrubTelemetryEvent({ tags: { wide } }));
    expect(out).toContain("[limit]");
    expect(TELEMETRY_MAX_NODES).toBeGreaterThan(0);
  });

  it("normalises exotic values", () => {
    const out = scrubTelemetryEvent({
      tags: {
        n: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        big: 10n,
        fn: () => 1,
        sym: Symbol("x"),
        undef: undefined,
        date: new Date("2026-06-14T10:00:00Z"),
        badDate: new Date("nope"),
        err: new Error("boom for mom@example.com"),
        map: new Map([["a", 1]]),
        nul: null,
        flag: true,
      },
    }) as { tags: Record<string, unknown> };
    expect(out.tags).toEqual({
      n: null,
      inf: null,
      big: "10",
      date: "2026-06-14T10:00:00.000Z",
      badDate: null,
      err: { name: "Error", message: "boom for [email]" },
      map: "[object]",
      nul: null,
      flag: true,
    });
  });

  it("ignores prototype-polluting keys without crashing", () => {
    const evil = JSON.parse('{"tags":{"__proto__":{"polluted":true},"ok":1}}');
    const out = scrubTelemetryEvent(evil) as { tags: Record<string, unknown> };
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.tags.ok).toBe(1);
  });

  it("keeps event ids only when they have their documented shape", () => {
    const ok = scrubTelemetryEvent({ event_id: "0123456789abcdef0123456789abcdef" });
    expect(ok.event_id).toBe("0123456789abcdef0123456789abcdef");
    const bad = scrubTelemetryEvent({ event_id: "mom@example.com" });
    expect(JSON.stringify(bad)).not.toContain("mom@example.com");
  });
});
