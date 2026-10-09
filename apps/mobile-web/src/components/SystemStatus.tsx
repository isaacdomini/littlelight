import { healthzResponseSchema } from "@littlelight/shared";
import { useQuery } from "@tanstack/react-query";

async function fetchApi(): Promise<"ok" | "degraded"> {
  const res = await fetch("/api/healthz");
  // 503 still carries a valid body with status "degraded".
  // Production returns only `{status}` to non-loopback callers; dev returns the full body.
  const body: unknown = await res.json();
  const full = healthzResponseSchema.safeParse(body);
  if (full.success) return full.data.status;
  return healthzResponseSchema.pick({ status: true }).parse(body).status;
}

async function fetchAuth(): Promise<"ok" | "degraded"> {
  const res = await fetch("/auth/health");
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
  const auth = useQuery({ queryKey: ["status", "auth"], queryFn: fetchAuth, retry: false });
  const state = (q: { isPending: boolean; isError: boolean; data?: "ok" | "degraded" }) =>
    q.isPending ? "loading" : q.isError ? "error" : (q.data ?? "error");

  return (
    <section aria-label="System status" className="ll-card">
      <h2 className="mb-2 text-sm font-semibold text-muted">System status</h2>
      <ul>
        <Row label="API" state={state(api)} />
        <Row label="Auth" state={state(auth)} />
      </ul>
    </section>
  );
}
