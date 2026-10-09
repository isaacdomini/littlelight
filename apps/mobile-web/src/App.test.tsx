import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";

afterEach(cleanup);

describe("App", () => {
  it("renders the five-tab bar", async () => {
    const { container } = render(<App />);
    const tabs = Array.from(container.querySelectorAll("ion-tab-button")).map((t) =>
      t.getAttribute("tab"),
    );
    // Ionic lazy-loads component chunks; wait for them so none import after teardown.
    const ionEls = Array.from(container.querySelectorAll("*")).filter((el) =>
      el.tagName.startsWith("ION-"),
    ) as Array<Element & { componentOnReady?: () => Promise<unknown> }>;
    await Promise.all(ionEls.map((el) => el.componentOnReady?.().catch(() => undefined)));
    expect(tabs).toEqual(["chat", "timeline", "upload", "milestones", "family"]);
    const labels = container.textContent ?? "";
    for (const label of ["Chat", "Timeline", "Upload", "Milestones", "Family"]) {
      expect(labels).toContain(label);
    }
  });
});
