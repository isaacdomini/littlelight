import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// Render helpers for component tests. Test-only.

export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function Where() {
  const loc = useLocation();
  return <output data-testid="location">{`${loc.pathname}${loc.search}`}</output>;
}

/** Router + query client around `ui`; a `<output data-testid="location">` shows the route. */
export function renderApp(ui: ReactElement, opts: { route?: string; client?: QueryClient } = {}) {
  const client = opts.client ?? newQueryClient();
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[opts.route ?? "/"]}>
        <Where />
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client, location: () => result.getByTestId("location").textContent };
}

/** Wait for Ionic's lazy custom elements so none import after teardown. */
export async function ionReady(container: HTMLElement): Promise<void> {
  const els = Array.from(container.querySelectorAll("*")).filter((el) =>
    el.tagName.startsWith("ION-"),
  ) as Array<Element & { componentOnReady?: () => Promise<unknown> }>;
  await Promise.all(els.map((el) => el.componentOnReady?.().catch(() => undefined)));
}
