import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";

afterEach(cleanup);

describe("App", () => {
  it("renders the five-tab bar", () => {
    const { container } = render(<App />);
    const tabs = Array.from(container.querySelectorAll("ion-tab-button")).map((t) =>
      t.getAttribute("tab"),
    );
    expect(tabs).toEqual(["chat", "timeline", "upload", "milestones", "family"]);
    const labels = container.textContent ?? "";
    for (const label of ["Chat", "Timeline", "Upload", "Milestones", "Family"]) {
      expect(labels).toContain(label);
    }
  });
});
