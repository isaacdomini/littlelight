import { healthzResponseSchema } from "@littlelight/shared";
import { useQuery } from "@tanstack/react-query";
import { apiUrl, authUrl } from "../platform/apiBase";
import { clientKind, isNative } from "../platform/platform";

async function fetchApi(): Promise<"ok" | "degraded"> {
  const res = await fetch(apiUrl("/healthz"), {
    headers: { "X-Littlelight-Client": clientKind() },
  });
  // 503 still carries a valid body with status "degraded".
  // Production returns only `{status}` to non-loopback callers; dev returns the full body.
  const body: unknown = await res.json();
  const full = healthzResponseSchema.safeParse(body);
  if (full.success) return full.data.status;
  return healthzResponseSchema.pick({ status: true }).parse(body).status;
}

async function fetchAuth(): Promise<"ok" | "degraded"> {
  const res = await fetch(authUrl("/health"));
  return res.ok ? "ok" : "degraded";
}

function Row({ label, state }: { label: string; state: "loading" | "ok" | "degraded" | "error" }) {
  const color = state === "ok" ? "bg-success" : state === "loading" ? "bg-fill" : "bg-danger";
  return (
    <li className="flex min-h-11 items-center justify-between">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />
        <span data-testid={`status-${label.toLowerCase()}`}>{state}</span>
      </span>
    </li>
  );
}

export function SystemStatus() {
  const api = useQuery({ queryKey: ["status", "api"], queryFn: fetchApi, retry: false });
  // GoTrue sends no CORS headers for native origins and the app never calls it directly, so the
  // probe would read as a false error there; the API row already covers sign-in (via the API).
  const native = isNative();
  const auth = useQuery({
    queryKey: ["status", "auth"],
    queryFn: fetchAuth,
    retry: false,
    enabled: !native,
  });
  const state = (q: { isPending: boolean; isError: boolean; data?: "ok" | "degraded" }) =>
    q.isPending ? "loading" : q.isError ? "error" : (q.data ?? "error");

  return (
    <section aria-label="System status" className="ll-card">
      <h2 className="mb-2 text-sm font-semibold text-muted">System status</h2>
      <ul>
        <Row label="API" state={state(api)} />
        {native ? null : <Row label="Auth" state={state(auth)} />}
      </ul>
    </section>
  );
}
