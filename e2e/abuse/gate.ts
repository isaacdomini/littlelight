/**
 * Step-11 gate (docs/plans/step-11.md 4.4, family model): "stop people abusing the free tier
 * (1,000 photos) with multiple accounts or albums".
 *
 *   docker compose -f docker-compose.dev.yml up -d --build --wait
 *   pnpm e2e:abuse-gate
 *
 * Dev stack only (it recreates the api once with FAMILIES_PER_IP_PER_DAY=2 and restores it).
 * No model is involved (free-tier photos are never analysed). Accounts are fresh
 * `e2e-*@example.com` ones, plus one `@mailinator.com` address for the disposable case. Prints
 * PASS/FAIL per check and `PASS n/n`, exits 1 on any miss. The family-start ledger rows stay
 * (30-day retention); the gate's albums are deleted again in `finally`.
 *
 * Checks, in the order of the plan:
 *  1. Account A: two albums are ONE family; 499 approved rows each; 3 JPEGs -> 2 registered + 1
 *     failed/free_tier_limit; GET /babies/:id -> freeTier { used: 1000, familyAlbums: 2 }.
 *  2. Guest G (contributor invite): uploads stay pending, `used` stays 1000; approving into the
 *     full family is 409 free_tier_limit; trashing an approved photo makes the approval pass.
 *  3. Pending cap: G at 200 pending -> the session is 409 pending_limit and a registered file is
 *     failed/pending_limit; G's own album is a family of its own with its own pool.
 *  4. One family per parent: B (with an album) accepting A's admin invite is 409
 *     already_parent_elsewhere (invite not consumed); a contributor invite is fine.
 *  5. Family-start guards: api at FAMILIES_PER_IP_PER_DAY=2 -> two first albums pass, the third is
 *     429 + Retry-After, a guest join and a sibling album still work; a disposable address and a
 *     +twin of A sign in, get 400 / 409 on create album, and join as guests.
 *  6. Report: A's family at 100 %, a network with >= 3 starts, G's pending queue, no '@' by
 *     default, A's address with --show-emails.
 *  7. Suspend A -> 403 account_suspended and no sign-in code; --lift restores.
 *  8. Log tap: the api's logs hold no gate address, raw IP or Bearer token.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { sceneJpeg } from "../../apps/worker/src/testing/images";
import { ApiClient, masked, uniqueEmail } from "../helpers/api";
import { psql } from "../helpers/db";
import { seenIds } from "../helpers/mailpit";
import { assertDevStack, restartApi } from "../helpers/reset";
import { BASE, uploadPhotos, waitForThumbs } from "../helpers/share";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
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
  // A caller's value must not leak into compose.
  const { FAMILIES_PER_IP_PER_DAY: _f, ...inherited } = process.env;
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
  throw new Error("api did not come up");
}

async function apiLogs(since: string): Promise<string> {
  return (await dc(["logs", "--no-color", "--since", since, "api"])).stdout;
}

/** The operator report through the migrate image. pnpm's "> script" banner lines are dropped. */
async function report(args: string[]): Promise<string> {
  const { stdout } = await dc(["run", "--rm", "migrate", "pnpm", "admin:abuse-report", ...args]);
  return stdout
    .split("\n")
    .filter((l) => !l.startsWith("> "))
    .join("\n");
}
interface ReportJson {
  familyStartsPerNetwork: { network: string; starts: number }[];
  families: { familyId: string; photos: number; pct: number; over: boolean }[];
  pendingQueues: { familyId: string; userId: string; pending: number }[];
  canonicalInboxes: { userIds: string[]; accounts: number; parents: number }[];
}
async function reportJson(): Promise<ReportJson> {
  const out = await report(["--days", "30", "--limit", "1000", "--json"]);
  const at = out.indexOf("{");
  if (at < 0) throw new Error("report --json printed no JSON");
  return JSON.parse(out.slice(at)) as ReportJson;
}

async function suspend(userId: string, lift: boolean): Promise<void> {
  await dc([
    "run",
    "--rm",
    "migrate",
    "pnpm",
    "admin:suspend",
    userId,
    ...(lift ? ["--lift"] : []),
  ]);
}

const q = (sql: string) => psql(sql);
const scalar = async (sql: string): Promise<string | undefined> => (await q(sql))[0];

interface BabyBody {
  freeTier: { used: number; limit: number; familyAlbums: number } | null;
  role: string;
}
const babyOf = async (api: ApiClient, id: string) =>
  (await api.call<BabyBody>("GET", `/babies/${id}`)).body;

/** Tens of thousands of fake approved rows, fast (superuser; the cap trigger still fires). */
async function seedApproved(babyId: string, by: string, n: number): Promise<void> {
  await q(
    `insert into photos (baby_id, uploaded_by, storage_key_original, status, approval, approved_by, approved_at, bytes)
     select '${babyId}', '${by}', 'abuse-gate/' || gen_random_uuid()::text, 'ready', 'approved', '${by}', now(), 10
       from generate_series(1, ${n})`,
  );
}
async function seedPending(babyId: string, by: string, n: number): Promise<void> {
  await q(
    `insert into photos (baby_id, uploaded_by, storage_key_original, status, approval, bytes)
     select '${babyId}', '${by}', 'abuse-gate/' || gen_random_uuid()::text, 'ready', 'pending', 10
       from generate_series(1, ${n})`,
  );
}

interface Raw {
  sessionId: string;
  files: {
    id: string;
    clientId: string;
    state: string;
    error: string | null;
    parts?: { url: string }[];
  }[];
}
/** Open a session and register `count` distinct JPEGs (nothing is uploaded yet). */
async function registerJpegs(api: ApiClient, babyId: string, count: number, seed: number) {
  const samples = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const bytes = await sceneJpeg(1200, 900, seed + i, 85);
      return {
        clientId: `abuse-${seed}-${i}`,
        bytes,
        sha: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  const created = await api.call<{ id: string }>("POST", `/babies/${babyId}/uploads`, {});
  if (created.status !== 201) return { created, raw: null, samples };
  const reg = await api.call<Raw>("POST", `/uploads/${created.body.id}/files`, {
    files: samples.map((s) => ({
      clientId: s.clientId,
      bytes: s.bytes.length,
      mime: "image/jpeg",
      clientSha256: s.sha,
    })),
  });
  const raw: Raw | null = reg.status === 200 ? { ...reg.body, sessionId: created.body.id } : null;
  return { created, raw, samples, reg };
}
/** PUT the parts of a registered file and complete it. */
async function finishFile(
  api: ApiClient,
  sessionId: string,
  file: Raw["files"][number],
  bytes: Buffer,
): Promise<number> {
  for (const part of file.parts ?? []) {
    const res = await fetch(part.url, { method: "PUT", body: new Uint8Array(bytes) });
    if (!res.ok) throw new Error(`part PUT answered ${res.status}`);
    await res.arrayBuffer();
  }
  return (await api.call("POST", `/uploads/${sessionId}/files/${file.id}/complete`)).status;
}

const emailsUsed: string[] = [];
const babiesMade: string[] = [];
// A network of its own per run (benchmarking range): the api's sign-in-code limit is per IP, so a
// gate run right after other suites must not share their address.
const rnd = () => 1 + Math.floor(Math.random() * 250);
const mainIp = `198.19.${rnd()}.${rnd()}`;
const newUser = async (
  tag: string,
  headers: Record<string, string> = { "CF-Connecting-IP": mainIp },
  domain?: string,
) => {
  const base = uniqueEmail(tag);
  const email = domain ? base.replace("@example.com", `@${domain}`) : base;
  emailsUsed.push(email);
  const api = await ApiClient.create(email, undefined, headers);
  await api.onboard(`Gate ${tag}`);
  const me = await api.call<{ user: { id: string } }>("GET", "/me");
  return { api, id: me.body.user.id, email };
};
async function makeBaby(api: ApiClient, name: string): Promise<string> {
  const id = await api.createBaby(name);
  babiesMade.push(id);
  return id;
}
async function joinAs(
  host: ApiClient,
  babyId: string,
  guest: ApiClient,
  role: "admin" | "contributor",
) {
  const inv = await host.invite(babyId, guest.email, role);
  if (!inv.token) return { invite: inv, accept: null };
  const accept = await guest.call<{ error?: string }>("POST", `/invites/${inv.token}/accept`);
  return { invite: inv, accept };
}

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  await assertDevStack();

  // ---- 1. one family, one pool ---------------------------------------------------------------
  const A = await newUser("abuse-a");
  const baby1 = await makeBaby(A.api, "Gate One");
  const baby2 = await makeBaby(A.api, "Gate Two"); // a sibling album: same family
  const famA = await scalar(`select family_id from babies where id='${baby1}'`);
  const famA2 = await scalar(`select family_id from babies where id='${baby2}'`);
  check(
    "two albums of one account are one family (one families row)",
    !!famA &&
      famA === famA2 &&
      (await scalar(`select count(*) from families where id='${famA}'`)) === "1",
  );
  check(
    "exactly one family_starts row for A (the sibling is not a family start)",
    (await scalar(`select count(*) from family_starts where user_id='${A.id}'`)) === "1",
  );
  await seedApproved(baby1, A.id, 499);
  await seedApproved(baby2, A.id, 499);
  const first = await registerJpegs(A.api, baby1, 3, 970_100);
  const states = first.raw?.files.map((f) => `${f.state}${f.error ? `/${f.error}` : ""}`) ?? [];
  check(
    "3 JPEGs at 998 of 1,000: 2 registered + 1 failed/free_tier_limit",
    states.filter((s) => s === "registered").length === 2 &&
      states.filter((s) => s === "failed/free_tier_limit").length === 1,
    states.join(","),
  );
  const okFiles = first.raw?.files.filter((f) => f.state === "registered") ?? [];
  const sessionA = first.raw?.sessionId ?? "";
  const doneStatuses: number[] = [];
  for (const f of okFiles) {
    const sample = first.samples.find((s) => s.clientId === f.clientId);
    if (sample) doneStatuses.push(await finishFile(A.api, sessionA, f, sample.bytes));
  }
  check(
    "the two registered files complete (200 each)",
    doneStatuses.length === 2 && doneStatuses.every((s) => s === 200),
    doneStatuses.join(","),
  );
  const uploadedByA = await q(
    `select id from photos where baby_id='${baby1}' and storage_key_original not like 'abuse-gate/%' order by created_at`,
  );
  await waitForThumbs(uploadedByA).catch(() => undefined);
  const b1 = await babyOf(A.api, baby1);
  check(
    "GET /babies/:id -> freeTier { used: 1000, limit: 1000, familyAlbums: 2 }",
    b1.freeTier?.used === 1000 && b1.freeTier.limit === 1000 && b1.freeTier.familyAlbums === 2,
    JSON.stringify(b1.freeTier),
  );
  const refusedSession = await A.api.call<{ error?: string }>(
    "POST",
    `/babies/${baby2}/uploads`,
    {},
  );
  check(
    "a parent's new upload session in the full family is 409 free_tier_limit",
    refusedSession.status === 409 && refusedSession.body.error === "free_tier_limit",
    String(refusedSession.status),
  );

  // ---- 2. a guest uploads into the full family ------------------------------------------------
  const G = await newUser("abuse-g");
  const joinedG = await joinAs(A.api, baby1, G.api, "contributor");
  check(
    "guest G accepts a contributor invite (200)",
    joinedG.accept?.status === 200,
    String(joinedG.accept?.status),
  );
  const gPhotos = await uploadPhotos(G.api, baby1, 2, 970_300);
  const gRows = await q(
    `select approval from photos where uploaded_by='${G.id}' and baby_id='${baby1}'`,
  );
  check(
    "G's two uploads are pending",
    gRows.length === 2 && gRows.every((r) => r === "pending"),
    gRows.join(","),
  );
  check(
    "the pool still reads 1,000 (pending photos do not count)",
    (await babyOf(A.api, baby1)).freeTier?.used === 1000,
  );
  const gp1 = gPhotos[0] as string;
  const refusedApprove = await A.api.call<{ error?: string }>("POST", `/photos/${gp1}/approve`);
  check(
    "A approving G's photo into the full family is 409 free_tier_limit",
    refusedApprove.status === 409 && refusedApprove.body.error === "free_tier_limit",
    String(refusedApprove.status),
  );
  check(
    "the refused photo is still pending",
    (await scalar(`select approval from photos where id='${gp1}'`)) === "pending",
  );
  const victim = uploadedByA[0];
  const trashed = victim ? await A.api.call("DELETE", `/photos/${victim}`) : { status: 0 };
  check(
    "A trashes an approved photo (204)",
    trashed.status === 204 || trashed.status === 200,
    String(trashed.status),
  );
  const okApprove = await A.api.call("POST", `/photos/${gp1}/approve`);
  check("the approval then succeeds (200)", okApprove.status === 200, String(okApprove.status));
  check("used is 1000 again", (await babyOf(A.api, baby1)).freeTier?.used === 1000);

  // ---- 3. the pending cap, and a guest's own family -------------------------------------------
  const pendingNow = Number(
    (await scalar(
      `select count(*) from photos where uploaded_by='${G.id}' and approval='pending' and deleted_at is null`,
    )) ?? 0,
  );
  const sessionG = await registerJpegs(G.api, baby1, 1, 970_500); // opens a session while G has room
  await seedPending(baby1, G.id, 200 - pendingNow);
  check(
    "G has exactly 200 pending photos in A's family",
    (await scalar(
      `select count(*) from photos where uploaded_by='${G.id}' and approval='pending' and deleted_at is null`,
    )) === "200",
  );
  // registerJpegs registered the file before the rows were added; register another one now.
  const afterFill = await G.api.call<Raw>("POST", `/uploads/${sessionG.created.body.id}/files`, {
    files: [{ clientId: "abuse-over", bytes: 1000, mime: "image/jpeg" }],
  });
  const over = afterFill.body.files?.[0];
  check(
    "G registering one more file: failed/pending_limit",
    afterFill.status === 200 && over?.state === "failed" && over.error === "pending_limit",
    JSON.stringify(over ?? afterFill.status),
  );
  const newSession = await G.api.call<{
    error?: string;
    details?: { pending: number; limit: number };
  }>("POST", `/babies/${baby1}/uploads`, {});
  check(
    "G opening a new session: 409 pending_limit with the counts",
    newSession.status === 409 &&
      newSession.body.error === "pending_limit" &&
      newSession.body.details?.pending === 200 &&
      newSession.body.details.limit === 200,
    JSON.stringify(newSession.body),
  );
  const gBaby = await makeBaby(G.api, "G's own album");
  const famG = await scalar(`select family_id from babies where id='${gBaby}'`);
  check("G's own album is a family of its own", !!famG && famG !== famA);
  const gOwn = await uploadPhotos(G.api, gBaby, 1, 970_700).catch(() => []);
  const gb = await babyOf(G.api, gBaby);
  check(
    "G uploads into their own album (own pool: used 1 of 1,000, familyAlbums 1)",
    gOwn.length === 1 && gb.freeTier?.used === 1 && gb.freeTier.familyAlbums === 1,
    JSON.stringify(gb.freeTier),
  );

  // ---- 4. one family per parent ---------------------------------------------------------------
  const B = await newUser("abuse-b");
  const bBaby = await makeBaby(B.api, "B's album");
  const adminInvite = await A.api.invite(baby1, B.email, "admin");
  const adminAccept = adminInvite.token
    ? await B.api.call<{ error?: string }>("POST", `/invites/${adminInvite.token}/accept`)
    : null;
  check(
    "B (a parent elsewhere) accepting A's admin invite: 409 already_parent_elsewhere",
    adminAccept?.status === 409 && adminAccept.body.error === "already_parent_elsewhere",
    JSON.stringify(adminAccept?.body),
  );
  check(
    "the refused invite is not consumed",
    (await scalar(
      `select count(*) from invites where baby_id='${baby1}' and accepted_at is null and revoked_at is null and lower(email)='${B.email.toLowerCase()}'`,
    )) === "1",
  );
  const guestB = await joinAs(A.api, baby2, B.api, "contributor");
  check(
    "B joins A's other album as a guest (200)",
    guestB.accept?.status === 200,
    String(guestB.accept?.status),
  );

  // ---- 4b. a founder who hands over admin and leaves is still in the family ------------------
  const FD = await newUser("abuse-founder");
  const fdBaby = await makeBaby(FD.api, "Founder album");
  const fdFamily = await scalar(`select family_id from babies where id='${fdBaby}'`);
  const KP = await newUser("abuse-coparent");
  const handOver = await joinAs(FD.api, fdBaby, KP.api, "admin");
  check(
    "the founder's co-parent accepts the admin invite (200)",
    handOver.accept?.status === 200,
    String(handOver.accept?.status),
  );
  const left = await FD.api.call("DELETE", `/babies/${fdBaby}/members/${FD.id}`);
  check("the founder leaves the album (204)", left.status === 204, String(left.status));
  const again = await FD.api.call<{ id?: string }>("POST", "/babies", {
    name: "Founder again",
    birthDate: "2026-01-15",
  });
  if (again.status === 201 && again.body.id) babiesMade.push(again.body.id);
  check(
    "the founder's next album joins the OLD family (no second family, no new family start)",
    again.status === 201 &&
      (await scalar(`select family_id from babies where id='${again.body.id}'`)) === fdFamily &&
      (await scalar(`select count(*) from family_starts where user_id='${FD.id}'`)) === "1",
    String(again.status),
  );

  // ---- 5. family-start guards ----------------------------------------------------------------
  const logsBefore = await apiLogs(startedAt); // the recreate below drops this container's logs
  await recreateApi({ FAMILIES_PER_IP_PER_DAY: "2" });
  try {
    // A network of its own (a random benchmarking-range address): no history of earlier runs.
    const pick = () => 1 + Math.floor(Math.random() * 250);
    netIp = `198.18.${pick()}.${pick()}`;
    const net = { "CF-Connecting-IP": netIp };
    const C1 = await newUser("abuse-c1", net);
    const C2 = await newUser("abuse-c2", net);
    const C3 = await newUser("abuse-c3", net);
    const r1 = await C1.api.call("POST", "/babies", { name: "C1", birthDate: "2026-01-15" });
    const r2 = await C2.api.call("POST", "/babies", { name: "C2", birthDate: "2026-01-15" });
    for (const r of [r1, r2]) {
      const id = (r.body as { id?: string } | null)?.id;
      if (id) babiesMade.push(id);
    }
    const r3 = await C3.api.call<{ error?: string }>("POST", "/babies", {
      name: "C3",
      birthDate: "2026-01-15",
    });
    const retry = Number(r3.headers?.["retry-after"]);
    check(
      "two first albums from one network pass (201, 201)",
      r1.status === 201 && r2.status === 201,
      `${r1.status},${r2.status}`,
    );
    check(
      "the third is 429 family_limited with Retry-After 1..86400",
      r3.status === 429 && r3.body.error === "family_limited" && retry >= 1 && retry <= 86_400,
      `${r3.status} ${r3.body.error} ${r3.headers?.["retry-after"]}`,
    );
    const guestC3 = await joinAs(A.api, baby2, C3.api, "contributor");
    check(
      "the refused account still joins a family as a guest (200)",
      guestC3.accept?.status === 200,
      String(guestC3.accept?.status),
    );
    const sibling = await A.api.call("POST", "/babies", {
      name: "Gate Three",
      birthDate: "2026-01-15",
    });
    if (sibling.status === 201) babiesMade.push((sibling.body as { id: string }).id);
    check(
      "a parent's sibling album is not a family start (201 at the cap)",
      sibling.status === 201,
      String(sibling.status),
    );

    // Disposable and +twin accounts sign in fine (onboard did), are refused at create album, join as guests.
    const D = await newUser("abuse-disp", undefined, "mailinator.com");
    const dRes = await D.api.call<{ error?: string }>("POST", "/babies", {
      name: "D",
      birthDate: "2026-01-15",
    });
    check(
      "a disposable address signs in and gets 400 email_not_allowed on create album",
      dRes.status === 400 && dRes.body.error === "email_not_allowed",
      `${dRes.status} ${dRes.body.error}`,
    );
    const guestD = await joinAs(A.api, baby2, D.api, "contributor");
    check(
      "the disposable address joins as a guest (200)",
      guestD.accept?.status === 200,
      String(guestD.accept?.status),
    );

    const twinEmail = A.email.replace("@", "+twin@");
    emailsUsed.push(twinEmail);
    const T = await ApiClient.create(twinEmail, undefined, {
      "CF-Connecting-IP": `198.19.${rnd()}.${rnd()}`, // own network: the cap (2) must not answer first
    });
    await T.onboard("Gate twin");
    const tMe = await T.call<{ user: { id: string } }>("GET", "/me");
    const tRes = await T.call<{ error?: string; details?: { existingEmailMasked?: string } }>(
      "POST",
      "/babies",
      { name: "T", birthDate: "2026-01-15" },
    );
    check(
      "a +twin of A signs in and gets 409 inbox_has_family with A's masked address",
      tRes.status === 409 &&
        tRes.body.error === "inbox_has_family" &&
        tRes.body.details?.existingEmailMasked === masked(A.email),
      JSON.stringify(tRes.body),
    );
    // A cannot invite its own +twin (the invite is refused as "your own email"); B can.
    const guestT = await joinAs(B.api, bBaby, T, "contributor");
    check(
      "the +twin joins as a guest (200)",
      guestT.accept?.status === 200,
      String(guestT.accept?.status),
    );
    check(
      "none of the refused accounts has a family_starts row or an album",
      (await scalar(
        `select count(*) from family_starts where user_id in ('${C3.id}','${D.id}','${tMe.body.user.id}')`,
      )) === "0" &&
        (await scalar(
          `select count(*) from babies where created_by in ('${C3.id}','${D.id}','${tMe.body.user.id}')`,
        )) === "0",
    );
    twinId = tMe.body.user.id;
  } finally {
    await recreateApi({});
    await restartApi();
  }

  // ---- 6. the operator report ----------------------------------------------------------------
  const rj = await reportJson();
  const famRow = rj.families.find((f) => f.familyId === famA);
  check(
    "report section 2: A's family at 100 %",
    !!famRow && famRow.photos === 1000 && famRow.pct === 100 && !famRow.over,
    JSON.stringify(famRow),
  );
  check(
    "report section 1: a network with >= 3 family starts",
    rj.familyStartsPerNetwork.some((n) => n.starts >= 3),
  );
  check(
    "report section 5: G's queue (200 pending) in A's family",
    rj.pendingQueues.some((p) => p.familyId === famA && p.userId === G.id && p.pending === 200),
  );
  check(
    "report section 6: A and the +twin share a canonical inbox cluster",
    rj.canonicalInboxes.some(
      (c) => c.userIds.includes(A.id) && c.userIds.includes(twinId) && c.parents === 1,
    ),
  );
  const text = await report(["--days", "30"]);
  check("default text output contains no '@'", text.length > 0 && !text.includes("@"));
  const withEmails = await report(["--days", "30", "--limit", "1000", "--show-emails"]);
  check("--show-emails lists A's address", withEmails.includes(A.email));

  // ---- 7. suspension -------------------------------------------------------------------------
  await suspend(A.id, false);
  const me403 = await A.api.call<{ error?: string }>("GET", "/me");
  check(
    "suspended A: GET /me is 403 account_suspended",
    me403.status === 403 && me403.body.error === "account_suspended",
    `${me403.status} ${me403.body.error}`,
  );
  const seen = await seenIds(A.email);
  const otp = await A.api.call("POST", "/auth/otp", { email: A.email });
  await sleep(3000);
  check(
    "suspended A: the sign-in code request is the usual 202 and no mail goes out",
    otp.status === 202 && (await seenIds(A.email)).size === seen.size,
    String(otp.status),
  );
  await suspend(A.id, true);
  await A.api.signIn();
  check("--lift restores access (200)", (await A.api.call("GET", "/me")).status === 200);

  // ---- 8. log tap ----------------------------------------------------------------------------
  const logs = `${logsBefore}\n${await apiLogs(startedAt)}`;
  const leaked = emailsUsed.filter((e) => logs.toLowerCase().includes(e.toLowerCase()));
  check(
    "api logs hold none of the gate's email addresses",
    leaked.length === 0,
    `${leaked.length} address(es)`,
  );
  const ipLines = logs
    .split("\n")
    .filter(
      (l) =>
        /([0-9]{1,3}\.){3}[0-9]{1,3}/.test(l) &&
        !/healthz|listening|0\.0\.0\.0|127\.0\.0\.1:/i.test(l),
    );
  check(
    "api logs hold no raw IP address",
    ipLines.length === 0 && !logs.includes(netIp) && !logs.includes(mainIp),
    ipLines
      .slice(0, 2)
      .map((l) => l.replace(/[0-9]/g, "#").slice(0, 160))
      .join(" | "),
  );
  check("api logs hold no Bearer token", !/bearer/i.test(logs));
}

let twinId = "";
let netIp = "198.18.0.0";

async function cleanup(): Promise<void> {
  if (babiesMade.length === 0) return;
  const ids = babiesMade.map((i) => `'${i}'`).join(",");
  await q(`delete from babies where id in (${ids})`).catch((e) => console.warn(`cleanup: ${e}`));
}

(async () => {
  try {
    await guarded("abuse gate", run);
  } finally {
    await cleanup();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed === results.length ? "PASS" : "FAIL"} ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
})();
