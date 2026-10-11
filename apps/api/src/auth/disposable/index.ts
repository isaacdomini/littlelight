import { type AbuseEnv, NEVER_BLOCKED_EMAIL_DOMAINS, normalizeEmail } from "@tinyglow/shared";
import { DISPOSABLE_DOMAINS } from "./blocklist.generated";

// Disposable-domain check for starting a family (docs/plans/step-11.md, amended: 2.3, 2.4). Sign-in
// is never refused on it; only an account's first album (a family start) is. The list is the
// vendored upstream file compiled into `blocklist.generated.ts` (see README.md here); the env vars
// only tune it:
// - `BLOCK_DISPOSABLE_EMAIL=false` turns the vendored list off (deny-list additions still apply);
// - `EMAIL_DOMAIN_DENYLIST` adds domains;
// - `EMAIL_DOMAIN_ALLOWLIST` and `NEVER_BLOCKED_EMAIL_DOMAINS` (Apple relay, our own and the
//   dev/e2e domains) unblock.
// A domain matches when it equals a listed domain or is a subdomain of one. Allowed entries win
// over blocked ones at the same or a more specific level: the most specific listed suffix of the
// domain decides (`EMAIL_DOMAIN_ALLOWLIST=sub.listed.example` unblocks that subdomain only).
// The caller (family-guards.ts) decides what a match means.

export interface DomainBlocklist {
  /** `domain` lowercased/trailing dots stripped here; true when it may not start a family. */
  isBlocked(domain: string): boolean;
  /** `isBlocked` of the part after the last `@` (false for a string without one). */
  isBlockedEmail(email: string): boolean;
}

type BlocklistEnv = Pick<
  AbuseEnv,
  "BLOCK_DISPOSABLE_EMAIL" | "EMAIL_DOMAIN_DENYLIST" | "EMAIL_DOMAIN_ALLOWLIST"
>;

function cleanDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
}

/** Built once per process (the vendored list is ~9,000 entries; a Set lookup per label). */
export function createDomainBlocklist(
  env: BlocklistEnv,
  vendored: readonly string[] = DISPOSABLE_DOMAINS,
): DomainBlocklist {
  const blocked = new Set<string>(env.BLOCK_DISPOSABLE_EMAIL ? vendored : []);
  for (const d of env.EMAIL_DOMAIN_DENYLIST) blocked.add(cleanDomain(d));
  const allowed = new Set<string>([
    ...NEVER_BLOCKED_EMAIL_DOMAINS,
    ...env.EMAIL_DOMAIN_ALLOWLIST.map(cleanDomain),
  ]);
  for (const d of allowed) blocked.delete(d);

  function isBlocked(domain: string): boolean {
    const d = cleanDomain(domain);
    if (d === "" || blocked.size === 0) return false;
    // Walk from the full domain to its parents; the first listed suffix decides.
    let suffix = d;
    for (;;) {
      if (allowed.has(suffix)) return false;
      if (blocked.has(suffix)) return true;
      const dot = suffix.indexOf(".");
      if (dot < 0) return false;
      suffix = suffix.slice(dot + 1);
    }
  }

  return {
    isBlocked,
    isBlockedEmail(email: string): boolean {
      const e = normalizeEmail(email);
      const at = e.lastIndexOf("@");
      return at >= 0 && isBlocked(e.slice(at + 1));
    },
  };
}
