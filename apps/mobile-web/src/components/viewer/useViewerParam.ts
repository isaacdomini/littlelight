import { useCallback, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useRouteActive } from "../../auth/guards";

/**
 * Viewer state lives in `?photo=<id>` (plan D10): nothing but ids in the URL, back closes,
 * reload reopens. `routePath` is the tab the param belongs to; hidden Ionic pages keep their last
 * search so a viewer never opens over another tab.
 */
export function useViewerParam(routePath: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const active = useRouteActive(routePath);
  const [search, setSearch] = useState(location.search);
  if (active && search !== location.search) setSearch(location.search);
  const params = new URLSearchParams(search);
  const photoId = active ? params.get("photo") : null;

  const go = useCallback(
    (id: string | null, mode: "push" | "replace") => {
      const next = new URLSearchParams(location.search);
      if (id) next.set("photo", id);
      else next.delete("photo");
      const qs = next.toString();
      navigate(
        { pathname: location.pathname, search: qs ? `?${qs}` : "" },
        { replace: mode === "replace", state: id && mode === "push" ? { viewer: true } : null },
      );
    },
    [location.pathname, location.search, navigate],
  );

  /** Opens a photo (pushes a history entry so back closes the viewer). */
  const open = useCallback((id: string) => go(id, "push"), [go]);
  /** Moves to another photo while the viewer is open (no history spam). */
  const change = useCallback((id: string) => go(id, "replace"), [go]);
  const close = useCallback(() => {
    const state = location.state as { viewer?: boolean } | null;
    if (state?.viewer) navigate(-1);
    else go(null, "replace");
  }, [go, location.state, navigate]);

  return { photoId, params, open, change, close };
}
