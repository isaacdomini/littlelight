import { type ReactNode, useEffect, useState } from "react";

export type Breakpoint = "phone" | "tablet" | "desktop";

// PRD "Responsive web": phone single column, tablet (>= 768 px) two panes, desktop (>= 1024 px) three.
const TABLET_QUERY = "(min-width: 768px)";
const DESKTOP_QUERY = "(min-width: 1024px)";

function read(): Breakpoint {
  if (typeof window === "undefined" || !window.matchMedia) return "phone";
  if (window.matchMedia(DESKTOP_QUERY).matches) return "desktop";
  return window.matchMedia(TABLET_QUERY).matches ? "tablet" : "phone";
}

/** Current layout class, kept in sync with the viewport (works the same in a WebView). */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(read);
  useEffect(() => {
    if (!window.matchMedia) return;
    const lists = [window.matchMedia(TABLET_QUERY), window.matchMedia(DESKTOP_QUERY)];
    const update = () => setBp(read());
    for (const l of lists) l.addEventListener("change", update);
    update();
    return () => {
      for (const l of lists) l.removeEventListener("change", update);
    };
  }, []);
  return bp;
}

/** `navigator.onLine`, live. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/**
 * Pane layout: phone = the grid only (the viewer is a modal); tablet = grid | viewer
 * (`minmax(360px, 45%)`); desktop = chat pane (280 px) | grid | details (360 px).
 */
export function Panes({
  breakpoint,
  chat,
  grid,
  viewer,
}: {
  breakpoint: Breakpoint;
  chat: ReactNode;
  grid: ReactNode;
  viewer: ReactNode;
}) {
  if (breakpoint === "phone") {
    return <div className="h-full min-h-0">{grid}</div>;
  }
  if (breakpoint === "tablet") {
    return (
      <div
        className="grid h-full min-h-0"
        style={{ gridTemplateColumns: "minmax(0,1fr) minmax(360px,45%)" }}
        data-testid="panes-tablet"
      >
        <div className="min-h-0 min-w-0">{grid}</div>
        <aside className="min-h-0 min-w-0 border-l border-line">{viewer}</aside>
      </div>
    );
  }
  return (
    <div
      className="grid h-full min-h-0"
      style={{ gridTemplateColumns: "280px minmax(0,1fr) 360px" }}
      data-testid="panes-desktop"
    >
      <aside className="min-h-0 overflow-auto border-r border-line">{chat}</aside>
      <div className="min-h-0 min-w-0">{grid}</div>
      <aside className="min-h-0 min-w-0 border-l border-line">{viewer}</aside>
    </div>
  );
}
