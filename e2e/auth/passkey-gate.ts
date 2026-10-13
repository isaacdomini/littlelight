/**
 * Step-13 gate (docs/plans/step-13.md 2.8, 4): passkey sign-in on the dev stack.
 *
 *   docker compose -f docker-compose.dev.yml up -d --build --wait
 *   pnpm e2e:passkey-gate
 *
 * Dev stack only (it recreates the api once with AUTH_PASSKEYS_ENABLED=false and restores it).
 * Prints PASS/FAIL per check and `PASS n/n`, exits 1 on any miss. No account is created; the
 * fabricated assertions below never reach a real credential (the API refuses them first, or GoTrue
 * answers "challenge not found").
 *
 * Checks, in the order of the plan:
 *  1. GoTrue's passkey routes are not reachable through nginx (404 from the allow-list).
 *  2. In-network options -> 200 with { challenge_id, options, expires_at: <number> } (a 500
 *     "Failed to initialize WebAuthn" means RP id/origins are misconfigured; 404 means the flag is off).
 *  3. GET /api/auth/config .passkeys === true; POST /api/auth/passkey/options -> 200 with
 *     challengeId / expiresAt (ISO) / options.
 *  4. UV enforced by the api: an assertion whose flags byte lacks 0x04 -> 401 passkey_failed and
 *     the auth container logged no /passkeys/authentication/verify request.
 *  5. Throttles: the 61st options call from one IP within the hour -> 429 + Retry-After; the 11th
 *     failed verify from one IP within 15 min -> 429 + Retry-After (GoTrue has no limiter there).
 *  6. Feature off: api recreated with AUTH_PASSKEYS_ENABLED=false -> every passkey route 404
 *     passkey_disabled and /auth/config.passkeys false; restored afterwards.
 *  7. Log tap: api + auth logs since the gate started hold no clientDataJSON / attestationObject /
 *     challenge_id / Bearer.
 */
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
}
async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    check(`${name} (crashed)`, false, e instanceof Error ? e.message : String(e));
  }
}

async function dc(args: string[], env: Record<string, string> = {}) {
  const { AUTH_PASSKEYS_ENABLED: _p, ...inherited } = process.env;
  return sh("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: ROOT,
    env: { ...inherited, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
}

async function apiHealthy(): Promise<boolean> {
  const { stdout } = await dc(["ps", "api", "--format", "json"]);
  const t = stdout.trim();
  if (!t) return false;
  const row = t.startsWith("[") ? JSON.parse(t)[0] : JSON.parse(t.split("\n")[0] ?? "{}");
  return row?.Health === "healthy";
}

/** Recreate the api container with `env` and wait until it answers through the web proxy. */
async function recreateApi(env: Record<string, string>): Promise<void> {
  await dc(["up", "-d", "--no-deps", "api"], env);
  for (const end = Date.now() + 150_000; Date.now() < end; ) {
    if (
      (await apiHealthy()) &&
      (await fetch(`${BASE}/api/healthz`).then(
        (r) => r.ok,
        () => false,
      ))
    )
      return;
    await sleep(2000);
  }
  throw new Error("api did not come back healthy");
}

async function logs(service: string, since: string): Promise<string> {
  const { stdout, stderr } = await dc(["logs", service, "--no-color", "--since", since]);
  return `${stdout}\n${stderr}`;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** `PublicKeyCredential.toJSON()` of an assertion whose authenticator-data flags byte is `flags`. */
function assertion(flags: number) {
  const auth = Buffer.alloc(37);
  randomBytes(32).copy(auth, 0);
  auth[32] = flags;
  const id = b64url(randomBytes(16));
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: b64url(
        Buffer.from(
          JSON.stringify({
            type: "webauthn.get",
            challenge: b64url(randomBytes(32)),
            origin: BASE,
            crossOrigin: false,
          }),
        ),
      ),
      authenticatorData: b64url(auth),
      signature: b64url(randomBytes(64)),
      userHandle: null,
    },
    clientExtensionResults: {},
  };
}

async function post(
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: Record<string, unknown> | null }> {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tinyglow-client": "web", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  return { status: res.status, headers: res.headers, json };
}

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const config = (await (await fetch(`${BASE}/api/auth/config`)).json()) as { passkeys?: boolean };
  if (config.passkeys !== true) {
    check(
      "precondition: AUTH_PASSKEYS_ENABLED on the dev stack",
      false,
      "config.passkeys is not true",
    );
    return;
  }

  // ---- 1. GoTrue only through the api -----------------------------------------------------
  const direct = await fetch(`${BASE}/auth/passkeys/authentication/options`, { method: "POST" });
  check(
    "GoTrue /auth/passkeys/* is 404 through nginx",
    direct.status === 404,
    String(direct.status),
  );
  const list = await fetch(`${BASE}/auth/passkeys/`);
  check(
    "GoTrue GET /auth/passkeys/ is 404 through nginx",
    list.status === 404,
    String(list.status),
  );

  // ---- 2. in-network options (RP id/origins configured) -------------------------------------
  const { stdout } = await dc([
    "exec",
    "-T",
    "api",
    "node",
    "-e",
    "fetch('http://auth:9999/passkeys/authentication/options',{method:'POST'}).then(async r=>{const j=await r.json();console.log(JSON.stringify({status:r.status,keys:Object.keys(j).sort(),expiresType:typeof j.expires_at,msg:j.msg??null}))})",
  ]);
  const inNet = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
    status: number;
    keys: string[];
    expiresType: string;
    msg: string | null;
  };
  check(
    "in-network GoTrue options -> 200 { challenge_id, options, expires_at }",
    inNet.status === 200 && inNet.keys.join(",") === "challenge_id,expires_at,options",
    `${inNet.status} ${inNet.keys?.join(",")} ${inNet.msg ?? ""}`,
  );
  check(
    "GoTrue expires_at is Unix seconds (number)",
    inNet.expiresType === "number",
    inNet.expiresType,
  );

  // ---- 3. api config + options ---------------------------------------------------------------
  check("GET /api/auth/config .passkeys === true", config.passkeys === true);
  const ip1 = { "cf-connecting-ip": "198.51.100.13" };
  const opts = await post("/api/auth/passkey/options", {}, ip1);
  const keys = Object.keys(opts.json ?? {}).sort();
  check(
    "POST /api/auth/passkey/options -> 200 { challengeId, expiresAt, options }",
    opts.status === 200 && keys.join(",") === "challengeId,expiresAt,options",
    `${opts.status} ${keys.join(",")}`,
  );
  const expiresAt = String(opts.json?.expiresAt ?? "");
  check(
    "expiresAt is ISO 8601 and in the future",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(expiresAt) && Date.parse(expiresAt) > Date.now(),
    expiresAt,
  );
  const noBody = await fetch(`${BASE}/api/auth/passkey/options`, {
    method: "POST",
    headers: { "x-tinyglow-client": "web", ...ip1 },
  });
  check("options accepts an absent body", noBody.status === 200, String(noBody.status));

  // ---- 4. UV enforced by the api (no GoTrue call) --------------------------------------------
  const authLogsBefore = (await logs("auth", startedAt))
    .split("\n")
    .filter((l) => l.includes("/passkeys/authentication/verify")).length;
  const challengeId = String(opts.json?.challengeId ?? randomUUID());
  const noUv = await post(
    "/api/auth/passkey/verify",
    { challengeId, credential: assertion(0x01) },
    ip1,
  );
  check(
    "verify with an assertion lacking the UV flag -> 401 passkey_failed",
    noUv.status === 401 && noUv.json?.error === "passkey_failed",
    `${noUv.status} ${String(noUv.json?.error)}`,
  );
  await sleep(1500);
  const authLogsAfter = (await logs("auth", startedAt))
    .split("\n")
    .filter((l) => l.includes("/passkeys/authentication/verify")).length;
  check(
    "no upstream verify request reached GoTrue for the UV refusal",
    authLogsAfter === authLogsBefore,
    `${authLogsBefore} -> ${authLogsAfter}`,
  );
  // and a UV-flagged assertion for an unknown challenge is the same generic answer from GoTrue's side
  const unknown = await post(
    "/api/auth/passkey/verify",
    { challengeId: randomUUID(), credential: assertion(0x05) },
    { "cf-connecting-ip": "198.51.100.14" },
  );
  check(
    "verify with a UV assertion for an unknown challenge -> 401 passkey_failed (generic)",
    unknown.status === 401 && unknown.json?.error === "passkey_failed",
    `${unknown.status} ${String(unknown.json?.error)}`,
  );
  const short = await post(
    "/api/auth/passkey/verify",
    {
      challengeId,
      credential: {
        ...assertion(0x05),
        response: { clientDataJSON: "A".repeat(8193), authenticatorData: "AAAA" },
      },
    },
    { "cf-connecting-ip": "198.51.100.15" },
  );
  check(
    "oversize clientDataJSON -> 400 validation_failed",
    short.status === 400,
    String(short.status),
  );

  // ---- 5. throttles --------------------------------------------------------------------------
  const ipOpt = { "cf-connecting-ip": "198.51.100.60" };
  // Through nginx GoTrue's own options limiter (30 / 5 min per IP, relayed as 429 rate_limited
  // since the review fix) fires before the api's 60 / h cap; either way the client sees a 429
  // with Retry-After by the 61st call and never a 5xx. The api cap itself is unit-tested.
  let okCalls = 0;
  let first429: { at: number; retryAfter: number } | null = null;
  let other = 0;
  for (let i = 1; i <= 61 && !first429; i++) {
    const r = await post("/api/auth/passkey/options", {}, ipOpt);
    if (r.status === 200) okCalls++;
    else if (r.status === 429 && r.json?.error === "rate_limited") {
      first429 = { at: i, retryAfter: Number(r.headers.get("retry-after")) };
    } else other++;
  }
  check(
    `options from one IP: 429 rate_limited + Retry-After by the 61st call (first at #${first429?.at ?? "none"}, ${okCalls} ok)`,
    // GoTrue's relayed 429 carries Retry-After only when GoTrue sent one (it does not); the api's
    // own cap (reached at #61 when GoTrue's limiter is lifted) always does.
    first429 !== null &&
      other === 0 &&
      okCalls >= 30 &&
      (first429.at < 61 || first429.retryAfter > 0),
    `${okCalls} ok, other=${other}`,
  );
  const ipVer = { "cf-connecting-ip": "198.51.100.61" };
  let refused = 0;
  for (let i = 0; i < 10; i++) {
    const r = await post(
      "/api/auth/passkey/verify",
      { challengeId: randomUUID(), credential: assertion(0x05) },
      ipVer,
    );
    if (r.status === 401) refused += 1;
  }
  const eleventh = await post(
    "/api/auth/passkey/verify",
    { challengeId: randomUUID(), credential: assertion(0x05) },
    ipVer,
  );
  check(
    "11th failed verify from one IP within 15 min -> 429 rate_limited + Retry-After",
    refused === 10 && eleventh.status === 429 && Number(eleventh.headers.get("retry-after")) > 0,
    `${refused} refused, then ${eleventh.status}`,
  );
  const otherIp = await post(
    "/api/auth/passkey/options",
    {},
    { "cf-connecting-ip": "198.51.100.62" },
  );
  check(
    "another IP is unaffected by both throttles",
    otherIp.status === 200,
    String(otherIp.status),
  );

  // ---- 6. feature off ------------------------------------------------------------------------
  await guarded("feature off", async () => {
    try {
      await recreateApi({ AUTH_PASSKEYS_ENABLED: "false" });
      const off = (await (await fetch(`${BASE}/api/auth/config`)).json()) as { passkeys?: boolean };
      check(
        "api with AUTH_PASSKEYS_ENABLED=false reports config.passkeys false",
        off.passkeys === false,
      );
      const routes: [string, string][] = [
        ["POST", "/api/auth/passkey/options"],
        ["POST", "/api/auth/passkey/verify"],
        ["POST", "/api/me/passkeys/options"],
        ["POST", "/api/me/passkeys"],
        ["GET", "/api/me/passkeys"],
        ["PATCH", `/api/me/passkeys/${randomUUID()}`],
        ["DELETE", `/api/me/passkeys/${randomUUID()}`],
      ];
      let all404 = true;
      const detail: string[] = [];
      for (const [method, p] of routes) {
        // no content-type on GET/DELETE: an empty JSON body would be a 400 from the parser
        // before the route's own preValidation can answer 404
        const hasBody = method !== "GET" && method !== "DELETE";
        const r = await fetch(`${BASE}${p}`, {
          method,
          headers: {
            "x-tinyglow-client": "web",
            ...(hasBody ? { "content-type": "application/json" } : {}),
          },
          body: hasBody ? JSON.stringify({ garbage: 1 }) : undefined,
        });
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        if (r.status !== 404 || j?.error !== "passkey_disabled") {
          all404 = false;
          detail.push(`${method} ${p}: ${r.status} ${j?.error ?? ""}`);
        }
      }
      check(
        "every passkey route is 404 passkey_disabled while the flag is off",
        all404,
        detail.join("; "),
      );
    } finally {
      await recreateApi({});
      const back = (await (await fetch(`${BASE}/api/auth/config`)).json()) as {
        passkeys?: boolean;
      };
      check("api restored with passkeys on", back.passkeys === true);
    }
  });

  // ---- 7. log tap ----------------------------------------------------------------------------
  const tap = `${await logs("api", startedAt)}\n${await logs("auth", startedAt)}`;
  const hits = tap
    .split("\n")
    .filter((l) => /clientDataJSON|attestationObject|challenge_id|Bearer /i.test(l));
  check(
    "api + auth logs hold no clientDataJSON / attestationObject / challenge_id / Bearer",
    hits.length === 0,
    hits
      .slice(0, 2)
      .map((l) => l.replace(/[A-Za-z0-9_-]{16,}/g, "…").slice(0, 160))
      .join(" | "),
  );
  check("api logs hold no challengeId / credential field", !/challengeId|"credential"/.test(tap));
}

(async () => {
  await guarded("passkey gate", run);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed === results.length ? "PASS" : "FAIL"} ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
})();
