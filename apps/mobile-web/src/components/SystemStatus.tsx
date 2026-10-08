import { healthzResponseSchema } from "@littlelight/shared";
import { useQuery } from "@tanstack/react-query";

async function fetchApi(): Promise<"ok" | "degraded"> {
  const res = await fetch("/api/healthz");
  // 503 still carries a valid body with status "degraded".
  return healthzResponseSchema.parse(await res.json()).status;
}

async function fetchAuth(): Promise<"ok" | "degraded"> {
  const res = await fetch("/auth/health");
  return res.ok ? "ok" : "degraded";
}

function Row({ label, state }: { label: string; state: "loading" | "ok" | "degraded" | "error" }) {
  const color =
    state === "ok" ? "bg-green-500" : state === "loading" ? "bg-gray-400" : "bg-red-500";
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
    <section aria-label="System status" className="rounded-xl border border-gray-500/30 p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-70">
        System status
      </h2>
      <ul>
        <Row label="API" state={state(api)} />
        <Row label="Auth" state={state(auth)} />
      </ul>
    </section>
  );
}
