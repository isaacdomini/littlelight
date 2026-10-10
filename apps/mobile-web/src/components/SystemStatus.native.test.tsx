import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../testing/native";
import { renderApp } from "../testing/render";
import { SystemStatus } from "./SystemStatus";

// GoTrue sends no CORS headers for native origins and the app never calls it directly, so the
// native build shows only the API row (docs/plans/step-9.md 2.3, 2.15).

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", "https://api.example.test");
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("SystemStatus", () => {
  it("native: probes the API at VITE_API_URL with the native header and never the auth service", async () => {
    setNativePlatform("ios");
    const f = stubFetch(() => jsonResponse({ status: "ok" }));
    renderApp(<SystemStatus />);
    await waitFor(() => expect(screen.getByTestId("status-api").textContent).toBe("ok"));
    expect(screen.queryByTestId("status-auth")).toBeNull();
    expect(f.calls.map((c) => c.url)).toEqual(["https://api.example.test/api/healthz"]);
    expect(f.calls[0]?.headers.get("X-Tinyglow-Client")).toBe("native");
  });

  it("web: both rows", async () => {
    setNativePlatform(null);
    const f = stubFetch((c) =>
      c.url.endsWith("/healthz") ? jsonResponse({ status: "ok" }) : jsonResponse({}, 200),
    );
    renderApp(<SystemStatus />);
    await waitFor(() => expect(screen.getByTestId("status-auth").textContent).toBe("ok"));
    expect(f.calls.some((c) => c.url === "/auth/health")).toBe(true);
  });

  it("a 503 with a degraded body reads as degraded", async () => {
    setNativePlatform("ios");
    stubFetch(() => jsonResponse({ status: "degraded" }, 503));
    renderApp(<SystemStatus />);
    await waitFor(() => expect(screen.getByTestId("status-api").textContent).toBe("degraded"));
  });
});
