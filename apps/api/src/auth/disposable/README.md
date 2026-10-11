# Disposable email domains (vendored)

An account on a disposable (throwaway) email domain cannot **start a family** (create its first
album): `POST /babies` answers 400 `email_not_allowed` (docs/plans/step-11.md, amended: 2.4). Any
address may still sign in and join families as a guest.
The list lives here, vendored, so the api never fetches anything at runtime.

| File | What |
| --- | --- |
| `disposable_email_blocklist.conf` | Upstream list, verbatim. Do not edit by hand. |
| `LICENSE.txt` | Upstream license (CC0 1.0 Universal, public domain dedication). |
| `build.ts` | Compiles the `.conf` into `blocklist.generated.ts` (lowercase, sorted, de-duplicated; deterministic). |
| `blocklist.generated.ts` | Generated module bundled into the api. CI checks it matches a fresh build. |
| `index.ts` | `createDomainBlocklist(env)`: the list plus the `BLOCK_DISPOSABLE_EMAIL` / `EMAIL_DOMAIN_*` env overrides. |

## Source

- Repository: https://github.com/disposable-email-domains/disposable-email-domains
- File: `disposable_email_blocklist.conf` (branch `main`)
- License: CC0-1.0 (`LICENSE.txt`, copied from the same repository)
- Vendored: 2026-10-10, upstream commit `81a8976e63879a11bf4301a28c14e0eb7a7855cf`
  (2026-10-09), 9,222 domains

## How to update

From the repository root:

```sh
cd apps/api/src/auth/disposable
curl -fsSL https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf \
  -o disposable_email_blocklist.conf
cd -
pnpm --filter @tinyglow/api disposable:build
```

Then update the commit sha, date and domain count above, review the diff of both files (a real
mail provider must never appear: spot-check `gmail.com`, `outlook.com`, `icloud.com`,
`yahoo.com`, `proton.me`), and commit both files together.

## Operator overrides (no code change)

- `EMAIL_DOMAIN_ALLOWLIST=a.example,b.example`: unblock domains wrongly listed (the most specific
  listed suffix decides, so an allowed subdomain stays allowed under a blocked parent).
- `EMAIL_DOMAIN_DENYLIST=c.example`: block extra domains (subdomains too).
- `BLOCK_DISPOSABLE_EMAIL=false`: turn the vendored list off (deny-list entries still apply).
- `privaterelay.appleid.com` (Apple Hide My Email), `tinyglow.app`, `tinyglow.local` and
  `example.com` are never blocked (`NEVER_BLOCKED_EMAIL_DOMAINS` in `@tinyglow/shared`). The
  dev/e2e ones are harmless in production: `example.com` (RFC 2606) and `.local` addresses cannot
  receive the sign-in code, so nobody can sign in with them to start a family.
