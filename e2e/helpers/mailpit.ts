// Mailpit client for the dev stack (all dev mail lands there). Codes and invite links are read
// from the HTML body; nothing here is ever logged.
const MAILPIT =
  process.env.E2E_MAILPIT_URL ?? `http://localhost:${process.env.MAILPIT_PORT ?? 8025}`;

interface Summary {
  ID: string;
}

async function summaries(email: string): Promise<Summary[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
  const body = (await res.json()) as { messages?: Summary[] };
  return body.messages ?? []; // newest first
}

async function html(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT}/api/v1/message/${id}`);
  if (!res.ok) throw new Error(`mailpit message failed: ${res.status}`);
  const body = (await res.json()) as { HTML?: string; Text?: string };
  return `${body.HTML ?? ""}\n${body.Text ?? ""}`;
}

/** Message ids already in the inbox: snapshot before triggering mail, pass to the wait helpers. */
export async function seenIds(email: string): Promise<Set<string>> {
  return new Set((await summaries(email)).map((m) => m.ID));
}

async function waitFor(
  email: string,
  seen: Set<string>,
  extract: (body: string) => string | null,
  what: string,
  timeoutMs = 30_000,
): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const m of await summaries(email)) {
      if (seen.has(m.ID)) continue;
      const found = extract(await html(m.ID));
      if (found) return found;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no new ${what} email arrived for the test address within ${timeoutMs} ms`);
}

/** The newest 6-digit sign-in code that arrived after `seen`. */
export function waitForCode(email: string, seen: Set<string>): Promise<string> {
  return waitFor(
    email,
    seen,
    (b) => /(?:>|\s)(\d{6})(?:<|\s)/.exec(b)?.[1] ?? null,
    "sign-in code",
  );
}

/** The invite token (43-char base64url) from the newest invite mail after `seen`. */
export function waitForInviteToken(email: string, seen: Set<string>): Promise<string> {
  return waitFor(
    email,
    seen,
    (b) => /\/invite\/([A-Za-z0-9_-]{43})/.exec(b)?.[1] ?? null,
    "invite",
  );
}

/** Convenience: wait for the OTP mail triggered by `trigger`. */
export async function codeAfter(email: string, trigger: () => Promise<unknown>): Promise<string> {
  const seen = await seenIds(email);
  await trigger();
  return waitForCode(email, seen);
}
