# Step 11 plan: free-tier abuse safeguards (amended: family model)

Status: **amended** (architect, 2026-10-11) after the user's decisions of 2026-10-11; supersedes
the 2026-10-10 proposal in full. Not a PRD build-order step: the user's request "stop people
abusing the free tier (1,000 photos) with multiple accounts or albums". Latest commit `f397718`.
Most of the first proposal is **built but not committed** (migration 21
`1792400000100_free-tier-abuse.sql`, shared contracts, API pool pre-checks, sign-up guards,
operator tools, frontend `FreeTierNotice` and sign-in errors, env/compose/guide). This amendment
re-aims it; section 3 lists only the **delta** against the working tree. Edit migration 21 **in
place** (it was never committed); keep it down/up-safe.

PRD sections touched: FR-5.8 ("The free tier (up to 1,000 photos)"), "Pricing" takeaway,
"Accounts and authentication" ("One email = one account" — unchanged: GoTrue keeps exact-email
uniqueness; `+tag` variants are different emails), "Invites", "Roles and permissions" (max two
admins), FR-2.7 (contributor uploads wait for approval), "Account deletion and recovery"
(FR-10.3), "Non-functional requirements → Privacy and child safety / Security", "Conventions".
`CLAUDE.md` clarifications: self-hosted GoTrue via `/api/auth/*`; AI is paid-tier only and this
step makes **no model call**; RLS on every table (the two new ones too); never log emails, IPs or
tokens; dev stack stays zero-setup. User constraints restated: never compare photos across
accounts (no cross-baby SHA/pHash joins, the report included); fake AI only; `docs/DESIGN.md`
screenshot check before any UI commit; no per-step reviewer pass.

## 0. The user's model (verbatim intent, 2026-10-11)

1. **Limit per family.** A family has up to 1,000 free photos in total; its albums
   (twins/siblings), whoever created them, share that one limit.
2. **One family per account as parent.** An account is a parent (admin) in at most one family.
   Another family needs another account, which must pass the checks. An invite to become
   co-parent is refused when the account is already a parent elsewhere; the message says to use a
   different account.
3. **Guests are free.** An account can be a guest (contributor) in any number of families. A
   guest's photo counts against **that** family's limit, and only **after approval**; pending
   photos don't count; approving into a full family is refused with the "full" message. Pending
   photos are capped per guest per family (default 200) so the queue cannot fill the server.
4. **Abuse checks run when an account starts a family** (creates its first album), not at
   sign-up: disposable-email block, canonical-email duplicate check, N new families per network
   per day (default 5). Joining as a guest is never blocked; no invite caps.
5. Each account's own family has its own limit; being a guest gives nothing and costs nothing.

## 1. Goal

Replace the per-account pool with a **per-family pool** on a real `families` table: every album
belongs to exactly one family, a family's free, live albums share 1,000 **approved** photos, and
an account is a parent in at most one family (DB-enforced, race-free). Sign-up is never refused
again (only suspension is checked); the three abuse checks move to the moment an account starts
its family (`POST /babies` with no family yet), with the canonical-email check arbitrated by the
database. Guests upload freely into a bounded approval queue (200 pending per guest per family);
approval, restore, import booking and direct inserts all pass through the same two triggers with
the same message prefixes every caller already maps. Operator tooling reports per family. Plus
stays per album; the pool counts only the family's free albums.

## 2. Interfaces first

### 2.1 Topology (after the amendment)

```
sign-in  ── POST /auth/otp ──▶ throttles → Turnstile → suspended? 202 silent : GoTrue /otp → 202
         ── POST /auth/verify ─▶ GoTrue /verify → issueSession: profile upsert (no guards), suspended ⇒ 403
first album ── POST /babies ──▶ my_family_id() IS NULL ⇒ family-start guards (service_role):
                                  disposable domain → 400 email_not_allowed
                                  families from this IP in 24 h ≥ FAMILIES_PER_IP_PER_DAY → 429 family_limited
                                INSERT babies (claims) → trigger babies_set_family:
                                  creator's family, else new family (advisory lock on canonical email;
                                  another parent with the same inbox ⇒ 23514 → 409 inbox_has_family)
                                → babies_add_creator_admin → baby_members_one_family (no-op here)
                                success & first ⇒ INSERT family_starts (ip_hash, flags), prune > 30 d
later albums ── POST /babies ──▶ no guards; babies_set_family joins the creator's family
admin invite accept / promote ── INSERT|UPDATE baby_members role='admin' ──▶ baby_members_one_family:
                                  parent in another family ⇒ 23514 → 409 already_parent_elsewhere
photo insert / approve / restore ── photos_free_tier_cap (approved, free, live; per-family advisory lock)
                                 ── photos_pending_cap (pending; per family+uploader advisory lock)
operator ── pnpm admin:abuse-report [--days 7] [--show-emails] [--json]   (per family)
         ── pnpm admin:suspend <userId> [--lift]   (unchanged)   ── pnpm db:plan <babyId> plus|free (exists)
```

No new service, no new dependency. The vendored disposable list stays.

### 2.2 Database (security-engineer): migration 21 rewritten in place

Conventions unchanged: reversible; `ENABLE` + `FORCE` RLS on new tables; `TO <role>` policies;
column grants; SECURITY DEFINER functions pin `search_path = pg_catalog, public` and `REVOKE …
FROM PUBLIC`; fixed RAISE messages naming no value. Regenerate `packages/db/src/generated`.

**A. Families (new; replaces `cap_owner_user_id`, which is removed from the migration entirely)**

```sql
CREATE TABLE public.families (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by  uuid REFERENCES public.profiles (user_id) ON DELETE SET NULL,   -- founder; NULL after deletion
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.babies ADD COLUMN family_id uuid REFERENCES public.families (id) ON DELETE RESTRICT;
-- backfill (below), then: ALTER TABLE public.babies ALTER COLUMN family_id SET NOT NULL;
CREATE INDEX babies_family_free_live_idx ON public.babies (family_id) WHERE deleted_at IS NULL AND plan = 'free';
CREATE INDEX babies_family_idx ON public.babies (family_id);
```

- RLS: `families_authenticated_select` USING `EXISTS (SELECT 1 FROM babies b JOIN baby_members m
  ON m.baby_id = b.id WHERE b.family_id = families.id AND m.user_id = public.auth_uid())` (any
  member of any album of the family, admins of trashed ones included). `GRANT SELECT ON
  families TO authenticated`; no INSERT/UPDATE/DELETE for any user role (trigger-maintained);
  `viewer`, `pipeline`: nothing. `GRANT SELECT (family_id) ON babies TO authenticated`; no
  INSERT/UPDATE grant on the column for user roles (seeds/service_role may pass it explicitly).
- `public.parent_family_of(p_user uuid) RETURNS uuid` STABLE SECURITY DEFINER, **not** granted
  to user roles: the family of the oldest baby (`created_at, id`) where `p_user` is admin,
  trashed babies included (a parent who trashed their only album still belongs to that family
  until purge; this also stops trash-cycling to reset the pool). NULL when the user is a parent
  nowhere. `public.my_family_id() RETURNS uuid` = `parent_family_of(auth_uid())`, EXECUTE to
  `authenticated`.
- Trigger `babies_set_family` BEFORE INSERT ON `babies`, SECURITY DEFINER:
  ```
  IF NEW.family_id IS NULL THEN
    NEW.family_id := public.parent_family_of(NEW.created_by);           -- NULL creator ⇒ NULL
    IF NEW.family_id IS NULL THEN
      -- Starting a family. Canonical-inbox arbiter (D-B): serialise on the canonical address and
      -- refuse when another live account with the same canonical form is already a parent.
      v_canon := (SELECT p.email_canonical FROM profiles p WHERE p.user_id = NEW.created_by);
      IF v_canon IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(1013, hashtext(v_canon));
        IF EXISTS (SELECT 1 FROM profiles p WHERE p.email_canonical = v_canon AND p.user_id <> NEW.created_by
                     AND p.deleted_at IS NULL AND public.parent_family_of(p.user_id) IS NOT NULL) THEN
          RAISE EXCEPTION 'another account for this inbox already has a family' USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      INSERT INTO public.families (created_by) VALUES (NEW.created_by) RETURNING id INTO NEW.family_id;
    END IF;
  END IF;
  ```
  Fires for every role (seeds included); fixtures that insert babies with `created_by NULL` get a
  family of their own each.
- Trigger `baby_members_one_family` BEFORE INSERT OR UPDATE OF role ON `baby_members`, SECURITY
  DEFINER, when `NEW.role = 'admin' AND (TG_OP = 'INSERT' OR OLD.role <> 'admin')`:
  `pg_advisory_xact_lock(1012, hashtext(NEW.user_id::text))` (two invites accepted at once
  serialise on the user), then `IF EXISTS (SELECT 1 FROM baby_members m JOIN babies b ON b.id =
  m.baby_id WHERE m.user_id = NEW.user_id AND m.role = 'admin' AND b.family_id <> (SELECT
  family_id FROM babies WHERE id = NEW.baby_id)) THEN RAISE EXCEPTION 'user is already a parent in
  another family' USING ERRCODE = 'check_violation'`. Trashed babies count (see
  `parent_family_of`). The creator-admin row inserted by `babies_add_creator_admin` always passes
  (the baby was placed in the creator's family a moment earlier).
- Trigger `babies_release_family` AFTER DELETE ON `babies`, SECURITY DEFINER: `DELETE FROM
  families f WHERE f.id = OLD.family_id AND NOT EXISTS (SELECT 1 FROM babies b WHERE b.family_id =
  f.id)`. The purge of the last trashed album removes the family; the FK `RESTRICT` protects the
  other direction.
- Leaving / removal / demotion / account deletion need **no** trigger: `family_id` is on the
  baby, so the family survives with its remaining parent; `families.created_by` goes NULL on
  founder deletion. The existing `baby_members_keep_last_admin` and the `sole_admin` rule in
  `account.ts` are unchanged. The three `*_reassign_cap_owner` triggers and `babies_set_cap_owner`
  are **deleted** from the migration.
- **Backfill** (dev databases only; production has no data): assign every baby to a family by
  connected components of "shares an admin" — loop over babies ordered by `created_at, id`;
  collect the distinct `family_id`s already held by babies that share an admin with this baby;
  0 ⇒ new family (`created_by` = the baby's `created_by`, else its earliest-joined admin, else
  NULL); 1 ⇒ that family; >1 ⇒ merge into the oldest family (`UPDATE babies SET family_id`),
  delete the emptied ones. Then `SET NOT NULL`. `RAISE NOTICE` with counts only (families
  created, merges). Note for operators of a dev DB: Pixel (perf seed) merges into the demo family
  here because demo-mom was its admin; re-running `pnpm perf:seed` after migrating re-homes it (2.6).

**B. Pool and cap trigger (per family, approved only)**

Counting predicate (one definition, copied verbatim into the two places):
`p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL AND p.status NOT IN ('failed','duplicate')`.
Pool of a baby: free, live babies with the same `family_id`.

```sql
CREATE FUNCTION public.free_tier_pool_used(p_baby_id uuid) RETURNS integer     -- SECURITY DEFINER STABLE
CREATE FUNCTION public.free_tier_pool_albums(p_baby_id uuid) RETURNS integer   -- SECURITY DEFINER STABLE
```
Both: 0 for a caller with claims who is not a member of `p_baby_id`, full value without claims;
EXECUTE to `authenticated, pipeline, service_role`. `free_tier_photo_count(uuid)` (per album,
unchanged predicate) stays for the per-album "N photos" display.

`photos_free_tier_cap()` BEFORE INSERT OR UPDATE OF `approval, deleted_at` ON `photos`:
```
counts(r) := r.approval = 'approved' AND r.deleted_at IS NULL AND r.quarantined_at IS NULL AND r.status NOT IN ('failed','duplicate')
IF counts(NEW) AND (TG_OP = 'INSERT' OR NOT counts(OLD)) THEN
  SELECT b.plan, b.family_id INTO v_plan, v_family FROM babies b WHERE b.id = NEW.baby_id;
  IF v_plan = 'free' THEN
    PERFORM pg_advisory_xact_lock(1011, hashtext(v_family::text));
    SELECT count(*) INTO v_used FROM photos p JOIN babies b ON b.id = p.baby_id
     WHERE b.family_id = v_family AND b.deleted_at IS NULL AND b.plan = 'free' AND <counts(p)>;
    IF v_used >= 1000 THEN
      RAISE EXCEPTION 'free tier photo limit reached (1000 approved photos per family)' USING ERRCODE = 'check_violation';
```
So: an admin's upload (inserted `approved`) is checked at insert; a guest's upload (`pending`)
is not; `POST /photos/:id/approve` (pending → approved) is checked and refused atomically when
the family is full; restore of an approved photo is checked; restore of a rejected photo (→
pending) is not. Prefix `free tier photo limit reached` unchanged (every mapper keys on it).
Grandfathering as before: a family already ≥ 1000 keeps its photos and refuses the next.

**C. Pending cap (new)**

```sql
CREATE FUNCTION public.pending_photo_limit() RETURNS integer LANGUAGE sql STABLE
  -- COALESCE(NULLIF(current_setting('app.pending_photo_limit', true), '')::int, 200)
CREATE FUNCTION public.my_pending_photo_count(p_baby_id uuid) RETURNS integer   -- SECURITY DEFINER STABLE
  -- live pending photos uploaded by auth_uid() across the family of p_baby_id (member-gated; 0 otherwise)
```
EXECUTE both to `authenticated, pipeline, service_role`. The operator override is one SQL
statement, documented in `docs/PRODUCTION.md`: `ALTER DATABASE tinyglow SET
app.pending_photo_limit = '500'` (D-D). `PENDING_PHOTOS_PER_GUEST_PER_FAMILY = 200` in shared is
the mirror of the SQL default (consistency test like the 1000).

`photos_pending_cap()` BEFORE INSERT OR UPDATE OF `approval, deleted_at` ON `photos`:
```
pending(r) := r.approval = 'pending' AND r.deleted_at IS NULL AND r.quarantined_at IS NULL AND r.status NOT IN ('failed','duplicate')
IF pending(NEW) AND (TG_OP = 'INSERT' OR NOT pending(OLD)) THEN
  v_family := (SELECT family_id FROM babies WHERE id = NEW.baby_id);
  PERFORM pg_advisory_xact_lock(1014, hashtext(v_family::text || ':' || NEW.uploaded_by::text));
  SELECT count(*) INTO v_pending FROM photos p JOIN babies b ON b.id = p.baby_id
   WHERE b.family_id = v_family AND b.deleted_at IS NULL AND p.uploaded_by = NEW.uploaded_by AND <pending(p)>;
  IF v_pending >= public.pending_photo_limit() THEN
    RAISE EXCEPTION 'pending photo limit reached (per guest per family)' USING ERRCODE = 'check_violation';
```
Applies to every plan (D-C). Admins never have pending rows, so it only ever bites guests.

**D. Canonical email (kept as a lookup, no longer unique)**

- `email_canonical(text)` function unchanged (mirror of `canonicalEmail`, fixtures test).
- `profiles.email_canonical` trigger-filled on INSERT as built; replace the partial **unique**
  index and the grandfathering backfill with a plain index `profiles_email_canonical_idx` and a
  plain backfill from `auth.users` (NOTICE: count only). Uniqueness is no longer a rule: two
  accounts may share an inbox; only **starting a family** is arbitrated (A).
- Invites: canonical matching in `invite_allows_join`, `baby_members_consume_invite` and the
  `invites_email_canonical_live_idx` stay (D9 of the first plan: an invite to `mom+baby@gmail.com`
  is accepted by `mom@gmail.com`).
- Helpers (SECURITY DEFINER, service_role only): keep `account_state_for_email(text)` (OTP
  "silent" for suspended accounts); **drop** `live_invite_exists_for_email`; replace
  `email_for_canonical` with `family_holder_email_for_canonical(p_canonical text) RETURNS text`:
  the `auth.users.email` of a live profile with that canonical form that is a parent
  (`parent_family_of(user_id) IS NOT NULL`), else NULL (the masked hint of 409
  `inbox_has_family`).

**E. Family-start ledger (replaces `signup_ledger`)**

```sql
CREATE TABLE public.family_starts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id    uuid REFERENCES public.families (id) ON DELETE SET NULL,     -- kept after purge
  user_id      uuid REFERENCES public.profiles (user_id) ON DELETE SET NULL, -- kept after deletion
  ip_hash      bytea NOT NULL CHECK (octet_length(ip_hash) = 32),            -- HMAC-SHA256(ip), key info 'family-ip-v1'
  ip_country   text CHECK (ip_country ~ '^[A-Z0-9]{2}$'),
  client       text NOT NULL CHECK (client IN ('web','native')),
  plus_tag     boolean NOT NULL DEFAULT false,
  dots_folded  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- indexes (ip_hash, created_at DESC), (created_at), (user_id) WHERE NOT NULL; ENABLE + FORCE RLS;
-- REVOKE ALL from every role, GRANT SELECT, INSERT, DELETE TO service_role; sequence revoked.
CREATE FUNCTION public.family_starts_prune() RETURNS integer  -- 30 days; EXECUTE to service_role, pipeline
```
No `disposable`, `invited` or `method` column (none applies: a family start is never invited and
a disposable address is always refused). Never an email, a raw IP or a user agent (CI grep).

**F. Suspension, `auth_session_info`** — as built, unchanged.

**G. `import_book_photo()`** — `CREATE OR REPLACE` in migration 21 (its step-10 body cannot be
edited: committed): the `check_violation` handler gains `ELSIF v_message LIKE 'pending photo
limit%' THEN RETURN 'pending_limit'`; everything else verbatim. The down migration restores the
step-10 body verbatim.

**Down migration**: drop `photos_pending_cap`, `pending_photo_limit`, `my_pending_photo_count`,
`family_starts(+prune)`, `family_holder_email_for_canonical`, `account_state_for_email`,
`my_family_id`, `parent_family_of`, the three family triggers, `babies.family_id`, `families`;
restore the step-4 cap trigger (INSERT only, per-baby message), the step-2 invite functions, the
step-10 `import_book_photo`, the step-3 `auth_session_info`; drop `email_canonical` column/index/
function and the suspension columns.

Advisory-lock classes (document in `packages/db/README.md`): 1011 pool (per family), 1012 one
family per parent (per user), 1013 inbox arbiter (per canonical address), 1014 pending cap (per
family + uploader).

### 2.3 Shared contracts (`@tinyglow/shared`; backend-engineer edits with orchestrator approval)

- `src/api/errors.ts` `apiErrorCodeSchema`: **remove** `account_exists`, `signup_limited`;
  **keep** `email_not_allowed` (now 400 at family start), `account_suspended`, `free_tier_limit`;
  **add** `inbox_has_family` (409, `details: { existingEmailMasked }`), `family_limited` (429 +
  `Retry-After`), `already_parent_elsewhere` (409), `pending_limit` (409, `details: { pending,
  limit }`).
- `src/api/auth.ts`: `accountExistsDetailsSchema` → `inboxHasFamilyDetailsSchema` (same shape);
  new `pendingLimitDetailsSchema = z.object({ pending: int ≥ 0, limit: int ≥ 1 })`.
- `src/api/babies.ts`: `freeTierSchema = z.object({ used, limit: z.literal(1000), familyAlbums:
  int ≥ 1 })` (rename `albums`); doc: "approved photos across the family's free, live albums".
  `babySchema.freeTier` nullable as built.
- `src/upload.ts`: `UploadFileError` += `pending_limit`.
- `src/api/imports.ts`: the `last_error` enum and the item-outcome enum += `pending_limit`.
- `src/constants.ts`: `FREE_TIER_PHOTO_LIMIT` comment → per family, approved only; new
  `PENDING_PHOTOS_PER_GUEST_PER_FAMILY = 200`.
- `src/auth.ts`: `SIGNUPS_PER_IP_PER_DAY_DEFAULT` → `FAMILIES_PER_IP_PER_DAY_DEFAULT = 5`;
  `SIGNUP_LEDGER_RETENTION_DAYS` → `FAMILY_START_RETENTION_DAYS = 30`; keep `SUPPORT_EMAIL`,
  `NEVER_BLOCKED_EMAIL_DOMAINS`, `canonicalEmail`, `emailShape`, `CANONICAL_EMAIL_FIXTURES`,
  suspension reasons and audit events as built.
- `src/env.ts` `abuseEnvSchema` (api only), renamed keys, same types/defaults:

  | Var | Default | Meaning |
  | --- | --- | --- |
  | `FAMILIES_PER_IP_PER_DAY` | 5 (dev compose 1000) | New families per client IP per rolling 24 h |
  | `BLOCK_DISPOSABLE_EMAIL` | true | Refuse starting a family from a vendored disposable domain |
  | `EMAIL_DOMAIN_DENYLIST` | empty | Extra domains treated as disposable |
  | `EMAIL_DOMAIN_ALLOWLIST` | empty | Domains removed from the block |

  `SIGNUP_DOMAIN_LIST_MAX` → `EMAIL_DOMAIN_LIST_MAX`.

### 2.4 Auth API (`apps/api/src/auth/**`, security-engineer)

- `signup-guards.ts` → **`family-guards.ts`** (delete the old file):
  - `familyStartGuards(app, blocklist, limitPerDay, { email, ip, country, client }) →
    { flags, ipHash }` or throws 400 `email_not_allowed` (blocklist, no exemption) / 429
    `family_limited` (`Retry-After` = seconds until the limit-th newest `family_starts` row of this
    `ip_hash` leaves the 24 h window). service_role, reason `"family-start guards"`.
  - `recordFamilyStart(app, { familyId, userId, ipHash, country, client, flags })` → INSERT
    `family_starts`, then `SELECT family_starts_prune()`. Reason `"family-start ledger"`.
  - `familyHolderEmailHint(app, email) → string | null` = `maskEmail(family_holder_email_for_canonical(email_canonical($1)))`.
  - `callerFamilyId(client: Tx) → string | null` = `SELECT public.my_family_id()` under claims
    (exported for `routes/babies.ts`).
  - Nothing here logs; callers log `{ outcome }` only.
- `session.ts`: the new-account branch reverts to the step-3 behaviour (profile upsert under
  claims, no guards, no GoTrue delete, no ledger); keep the suspended check and
  `endSuspendedSession`. Remove `createAccount`, `removeRefusedUser`, `signupMethodOf`,
  `refusalOutcome`, `CANONICAL_EMAIL_KEY`; `IssueOptions.method` keeps only `"review"`.
- `routes.ts` `POST /auth/otp`: the pre-check keeps only the suspended → 202-silent branch
  (`account_state_for_email`), inline or in `family-guards.ts`; the `refuse_disposable` branch
  and the ledger `method` labels go.
- `invites.ts` accept and `members.ts` promote: no new code; the 23514 `user is already a parent
  in another family` maps through `CHECK_VIOLATIONS` (2.5). Make sure the accept route's
  "invite died between lookup and insert" catch **rethrows** it rather than turning it into
  `invite_expired`. Invite **creation** is not changed (refusing an admin invite by the
  invitee's address would reveal that the address has a family: D-I).
- `ip-hash.ts`: HKDF info `family-ip-v1`. `runtime.ts`, `disposable/**`, `context.ts`: unchanged.

### 2.5 Backend API (`apps/api/**` except `auth/**`, `sharing/**`; backend-engineer)

- `config.ts`: renamed env keys.
- `lib/errors.ts`: remove `accountExists`, `signupLimited`; add `inboxHasFamily(masked | null)`
  409, `familyLimited(retryAfterSec)` 429, `alreadyParentElsewhere()` 409, `pendingLimit(pending,
  limit)` 409; `CHECK_VIOLATIONS` += `["user is already a parent in another family", alreadyParentElsewhere]`,
  `["pending photo limit reached", () => pendingLimit(…)]` (details filled by the route when
  known, else omitted), `["another account for this inbox already has a family", () => inboxHasFamily(null)]`;
  `freeTierLimit()` message per 2.9.
- `routes/babies.ts` `POST /babies`: read `callerFamilyId` under claims; when NULL run
  `familyStartGuards` (service_role) **before** the insert transaction; insert as today; catch the
  inbox 23514 first (`err.message.startsWith("another account for this inbox")`) → hint →
  `inboxHasFamily(hint)`; after commit, when it was a family start, `recordFamilyStart` with the
  new baby's `family_id` (read back in the same tx) — a failure logs `warn`, never fails the
  create. `BABY_COLUMNS` / `toFreeTier` → `familyAlbums`. Audit `baby.created` metadata gains
  `family_start: true` when applicable (add the optional boolean to `auditMetadataSchema`).
- `uploads/service.ts`: `createSession` pre-check — admin: pool ≥ 1000 ⇒ `freeTierLimit()`;
  contributor: `my_pending_photo_count ≥ pending_photo_limit()` ⇒ `pendingLimit`. `registerFiles`
  headroom — admin: `1000 − pool − registered`; contributor: `pending_limit − my_pending −
  registered`, failed outcome error `pending_limit`. `completeFile` catch: prefix `pending photo
  limit` ⇒ `markFile(failed, "pending_limit")` + throw `pendingLimit`.
- `photos/queries.ts`: `countPoolPhotos` unchanged; add `countMyPending(client, babyId)` and
  `pendingLimit(client)` (`SELECT public.pending_photo_limit()`).
- `photos/routes.ts`: approve — no pre-check; the trigger's 23514 maps to 409 `free_tier_limit`
  (make sure `explainNoRow` is not reached: the UPDATE throws, it does not return 0 rows).
  Restore — the pool pre-check applies only when `photo.approval === 'approved'`.
- Worker (`apps/worker/**`, backend): `purge.ts` step 8 → `family_starts_prune()` and the result
  field `familyStartsPruned`; the import handler treats `pending_limit` like `free_tier_limit`
  (stop the run, `last_error = 'pending_limit'`); `tools/perf-seed.ts` per 2.6.

### 2.6 Seeds, fixtures and gates that make one user an admin of several babies

| Where | Today | Under the family model | Change |
| --- | --- | --- | --- |
| `packages/db/src/seed.ts` Maya | mom + dad admins, nanny contributor; `created_by` mom | one family (demo) via `babies_set_family` | none required; optionally add `families` to `COUNT_TABLES` |
| `apps/worker/src/ai/search-seed.ts` Golden | `created_by` mom, admins mom + dad, plan plus | joins the demo family (mom's), plus ⇒ outside the pool | none (comment only; ai-engineer, optional) |
| `apps/worker/src/tools/perf-seed.ts` Pixel | `created_by`/cap owner perf owner; admins perf owner + mom; dad contributor | mom admin ⇒ **violates** one-family (mom is a parent of demo) | **own perf family**: pass `family_id` explicitly (`SELECT parent_family_of(owner)` else `INSERT families`), owner the only admin, **mom and dad contributors** (demote mom before upserting the owner's row on re-runs; pin `family_id` on re-run too); drop the `cap_owner_user_id` column from `UPSERT_BABY_SQL`; `--remove` unchanged (`babies_release_family` drops the family). Header comment: "free, far over the cap; the owner never signs in; mom/dad are guests". |
| `packages/db/src/review-family.ts` Sunny | single admin | own family | none |
| `packages/db/test/fixtures.ts` | A: adminA1 + adminA2; B: adminB; trash babies no admins | A and B are separate families; `created_by NULL` babies get families of their own | none |
| `packages/db/ai-pipeline.integration.test.ts:180-200` | `U.admin` admin of `paid` **and** `free`, inserted without `created_by` | two families ⇒ **violates** | insert `free` with `family_id = (SELECT family_id FROM babies WHERE id = paid)` (or `created_by = U.admin` on both) |
| other `packages/db/*.integration.test.ts` direct `baby_members … 'admin'` inserts (`search-chat:226,1627,1631`, `triggers:80-282`, `rls:348,539`, `plan-triggers:251`, `uploads:133`, `set-plan:73,106`, `timeline:131`, `photo-import:469,526,792,1524`, `review-fixes:573`, `review-family:239`) | fixture users as admins | breaks only where one user is made admin of babies in two families | test-engineer audits each (4.1 grep); fix by `created_by` / explicit `family_id` or fresh users |
| `apps/api/src/**/*.integration.test.ts` `h.member(baby, user, "admin")` (`account:32,115,315,402`, `members:24,473`, `invites:165`, `review:230`, `milestones:238`, `measurements:132`, `chat:229`, plus the `dad` co-admin pattern in `photos/ai/chat/imports/exports/sharing/uploads/search`) | second admin added directly | breaks where that user already admins a baby of another creator | audit; expected hot spot: `account.integration.test.ts` (a user with their own baby **and** admin of `shared`) |
| `apps/api/src/testing/integration.ts` harness | `baby(user)` through the API | every first baby runs the family-start guards from `127.0.0.1` | `testConfig` sets `FAMILIES_PER_IP_PER_DAY: 100000` |
| `e2e/ai/gate.ts`, `e2e/sharing/gate.ts`, `e2e/native/push-gate.ts` | one account creates two babies | same family; the free one draws from the family pool | none |
| `e2e/auth/invite.spec.ts`, `e2e/auth/account.spec.ts:46`, `e2e/export/gate.ts:244` | admin invites to fresh accounts | fine while invitees are fresh | audit that `co`/`second`/`third` never already own a baby |
| perf check (manual; no e2e references Pixel) | signs in as mom | mom is a guest of Pixel: timeline/album views still work | if an admin-only screen is needed, sign in as `perf-owner@tinyglow.local` through Mailpit (D-G) |

### 2.7 Operator tools (`packages/db/src/tools/**`, security-engineer)

`abuse-report.ts` re-aimed per family (read-only, no `@` without `--show-emails`, no SHA/pHash):
1. **Family starts per network** (`family_starts`, window): network (12 hex), `starts`,
   `first_at`, `last_at`; rows with `starts ≥ 3`.
2. **Families near or over the cap**: `family_id`, `parents` (distinct admins across the family's
   babies), `free_albums`, `photos` (approved, counting), `pending` (live pending across the
   family), `bytes`, `pct`; `photos ≥ 800` or over; `OVER` marker.
3. **Top storage**: albums (`baby_id`, `family_id`, `plan`, `photos`, `pending`, `bytes`,
   `trashed`) and families (`family_id`, `parents`, `albums`, `photos`, `bytes`), top `--limit`.
4. **Recent family starts** (window): `family_id` (or `purged`), `user_id` (or `deleted`),
   `created_at`, `client`, flags `plus_tag`, `dots_folded`, `canonical_dup` (another live profile
   shares the founder's canonical address), `suspended` (any parent suspended).
5. **Pending queues**: `family_id`, `user_id`, `pending` for guests at ≥ 50 % of
   `pending_photo_limit()`.
`--show-emails` appends the parents' emails (comma-joined) to 2–5 with the personal-data warning.
`suspend.ts` unchanged.

### 2.8 Frontend (`apps/mobile-web/src/**`, frontend-engineer)

- `lib/signInErrors.ts`: drop the `account_exists` / `signup_limited` branches (keep `retryWhen`);
  `CodeEntry`/Verify lose the "sign in with that address" state; `welcome.useMasked` goes.
- New `lib/familyErrors.ts`: `familyStartError(e)` for `email_not_allowed`, `inbox_has_family`
  (masked hint), `family_limited` (retry time), used by the create-album flow (onboarding and
  Settings → add album); `memberError(e)` for `already_parent_elsewhere` with two copies: invitee
  (InvitePage accept) and promoter (FamilyPage role change).
- `FreeTierNotice`: `familyAlbums`; parent copy "Your family's free photos…", guest copy "This
  family's free photos…"; near/over variants as built. Upload page for contributors: a one-line
  note that photos wait for approval and count toward the family's free photos once approved;
  `upload.err.pending_limit` (+ native variant). Approval queue: toast for 409 `free_tier_limit`
  on approve (`approve.err.free_tier_limit`). Sync card string per 2.9.
- `scripts/screenshots-abuse.ts`: states = create-album errors (3), family usage line (parent,
  guest, over), guest pending note, approve-full toast. Light/dark × phone/desktop per
  `docs/DESIGN.md` before the UI commit.

### 2.9 User-facing copy (English; `i18n/en.ts` mirrors)

| Where | Code | Text |
| --- | --- | --- |
| API photo insert/approve/restore | 409 `free_tier_limit` | Your family's free albums are full: free albums hold 1,000 photos per family. Upgrade to Plus or delete photos to add more. |
| API create album | 400 `email_not_allowed` | Temporary or disposable email addresses can't start a family. Use your regular email address, or join a family as a guest. |
| API create album | 409 `inbox_has_family` | Another Tinyglow account for this inbox ({existingEmailMasked}) already has a family. Sign in with that account to add an album, or use a different email. |
| API create album | 429 `family_limited` | Too many new families were started from your network today. Try again tomorrow, or join a family as a guest. |
| API accept admin invite / promote | 409 `already_parent_elsewhere` | This account is already a parent in another family. Use a different account to be a parent here, or join as a guest. |
| API upload/import | 409 `pending_limit` | You have {pending} photos waiting for approval in this family (the most is {limit}). Wait for a parent to review them before adding more. |
| API any | 403 `account_suspended` | This account has been suspended. Contact support@tinyglow.app. |
| App usage line (parent) | — | Your family's free photos: {used} of 1,000 ({n} album / across {n} albums) |
| App usage line (guest) | — | This family's free photos: {used} of 1,000 |
| App over cap (parent, web) | — | Your family's free albums are full ({used} of 1,000). Upgrade to Plus or delete photos to add more. |
| App over cap (guest / native) | — | This family's free albums are full ({used} of 1,000). Ask a parent to make room. |
| App guest upload note | — | Photos you add wait for a parent's approval and count toward the family's free photos once approved. |
| App invite accept error | — | You're already a parent in another family. To be a parent here, sign in with a different account — or ask for a guest invite instead. |
| App promote error | — | {name} is already a parent in another family and can stay as a guest here. |
| App sync card | — | Your family's free albums are full ({n} photos in total) |

### 2.10 Env, Compose, CI, guide (devops-engineer)

- Rename the four variables everywhere (`.env.example` block "Family-start safeguards (api
  only)", `.env.dev`, `docker-compose.yml`, `docker-compose.dev.yml` with `FAMILIES_PER_IP_PER_DAY:
  ${FAMILIES_PER_IP_PER_DAY:-1000}`).
- `.github/scripts/abuse-hygiene.sh` / `.mjs`: (a) `family_starts` DDL has no email / user-agent
  / raw-IP column; (d) no `clientIp(`/`request.ip` result reaches `log.` in
  `apps/api/src/auth/family-guards.ts`, `apps/api/src/routes/babies.ts`, `session.ts`,
  `routes.ts`, `ip-hash.ts`; (b), (c), (e) unchanged. CI runs `pnpm e2e:abuse-gate` as planned.
- `docs/PRODUCTION.md` Part J rewritten: the family model (one family per parent, guests free,
  approved-only pool, pending cap and its `ALTER DATABASE … SET app.pending_photo_limit`
  override), the renamed variables, the report's five sections, `admin:suspend`, `db:plan`.

## 3. Delta tasks (against the working tree)

Owners per `CLAUDE.md`. Groups run in parallel (disjoint paths); later groups depend on earlier.

### Group 0 — contracts and schema (parallel)

**11.1b Shared contracts** — backend-engineer (orchestrator approval). Owns
`packages/shared/src/{auth,constants,env,upload,index}.ts`, `packages/shared/src/api/{errors,auth,babies,imports}.ts`.
Inputs: 2.3. Done when: codes/fields/constants/env keys match 2.3; no `SIGNUP*`, `account_exists`,
`signup_limited`, `albums` (in `freeTierSchema`) remain; `pnpm --filter @tinyglow/shared test
typecheck` green.

**11.2b Migration 21 rewritten in place + README + generated types** — security-engineer. Owns
`packages/db/migrations/1792400000100_free-tier-abuse.sql`, `packages/db/README.md`,
`packages/db/src/generated/**`, `packages/db/src/seed.ts` (optional `families` count). Inputs:
2.2 A–G. Done when: up and down both succeed on a fresh DB with the GoTrue stub **and** on a
dev DB holding the demo, Golden and Pixel seeds (backfill NOTICE: families created / merges);
`\d babies` has `family_id NOT NULL` and no `cap_owner_user_id`; `\dt` has `families`,
`family_starts`, no `signup_ledger`; hand checks 4.2 pass; README section "Families and the
free-tier pool (step 11)" with the four lock classes; `pnpm db:types` regenerated.

### Group 1 — API, worker, frontend, devops (parallel; after 11.1b, 11.5b integrates once 11.2b lands)

**11.3b Auth API** — security-engineer. Owns `apps/api/src/auth/**` (`family-guards.ts` new,
`signup-guards.ts` deleted, `session.ts`, `routes.ts`, `ip-hash.ts`, `invites.ts`). Inputs: 2.4,
2.3. Done when: a brand-new account signs in with no guard (any domain, any `+tag`), suspended
accounts still get 202-silent / 403; `familyStartGuards` refuses disposable (400) and the
network cap (429 + `Retry-After`); accepting an admin invite while a parent elsewhere answers 409
`already_parent_elsewhere` (route test); `grep -n "log\." apps/api/src/auth/family-guards.ts` is
empty.

**11.4b Operator tools** — security-engineer, same lane as 11.3b (order free). Owns
`packages/db/src/tools/{abuse-report,suspend}.ts`. Inputs: 2.7. Done when: the five sections
render for the seeded dev DB (per family), no `@` without `--show-emails`, `--json` valid,
`sha256|phash` absent from the source.

**11.5b Backend API + worker** — backend-engineer. Owns `apps/api/src/{config,app}.ts`,
`apps/api/src/lib/errors.ts`, `apps/api/src/routes/babies.ts`, `apps/api/src/uploads/service.ts`,
`apps/api/src/photos/{routes,queries}.ts`, `apps/worker/src/purge.ts`, `apps/worker/src/imports/**`,
`apps/worker/src/tools/perf-seed.ts`. Inputs: 2.5, 2.6 (Pixel row), 2.3, function names in 2.2.
Done when: `POST /babies` runs the guards only for a caller with `my_family_id() IS NULL`, maps
the inbox 23514 to 409 with a masked hint, records `family_starts` once per family start;
`GET /babies/:id` returns `freeTier.familyAlbums`; upload pre-checks branch on role (pool vs
pending); approve into a full family → 409 `free_tier_limit`; restore pre-check only for approved
photos; purge step 8 prunes `family_starts`; the import worker stops on `pending_limit`;
`pnpm perf:seed` (dev stack) makes Pixel its own family with mom and dad as contributors and
`pnpm perf:seed --remove` leaves no family row.

**11.6b Frontend** — frontend-engineer. Owns `apps/mobile-web/src/**`,
`apps/mobile-web/scripts/screenshots*.ts`. Inputs: 2.8, 2.9, 2.3. Done when: the four
create-album/invite/promote errors render their copy; `FreeTierNotice` shows parent/guest/over
variants with `familyAlbums`; guest upload note and `pending_limit` error; approve-full toast;
sign-in no longer references `account_exists`/`signup_limited`; unit tests updated; screenshots
reviewed per `docs/DESIGN.md`.

**11.7b Env, Compose, hygiene, guide** — devops-engineer. Owns `.env.example`, `.env.dev`,
`docker-compose.yml`, `docker-compose.dev.yml`, `.github/scripts/abuse-hygiene.{sh,mjs}`,
`docs/PRODUCTION.md`. Inputs: 2.10. Done when: both `docker compose … config` validate; the dev
api receives `FAMILIES_PER_IP_PER_DAY=1000`; hygiene script passes against 11.2b/11.3b/11.5b
output; Part J rewritten.

### Group 2 — tests and gate (after group 1)

**11.8b Tests, fixtures audit, abuse gate** — test-engineer. Owns `**/*.test.ts`,
`**/*.test.tsx`, `e2e/**`, `packages/db/test/{harness,fixtures}.ts`, `apps/api/src/testing/*`,
root `package.json` script `e2e:abuse-gate` (orchestrator approves the line). Inputs: everything
above, 2.6, section 4. Done when:
- **fixture audit** (2.6 table) complete: every direct admin insert makes a user a parent in one
  family only (`ai-pipeline` `free` baby fixed; `account.integration.test.ts` and any other hit
  rewritten); `testConfig` sets `FAMILIES_PER_IP_PER_DAY: 100000`.
- **db integration** (`packages/db/free-tier-abuse.integration.test.ts`): `babies_set_family`
  (creator's family reused, new family otherwise, trashed-only parent still reuses); inbox
  arbiter (second account with the same canonical: refused when the first is a parent, allowed
  when the first is only a guest; two concurrent starts admit one); `baby_members_one_family`
  (accept/promote refused across families, allowed within one; two concurrent accepts admit one;
  demote/leave/delete leave the family intact; `families.created_by` NULL after founder delete);
  `babies_release_family` on hard delete; pool: approved-only (pending excluded), per family
  across two free albums, Plus and trashed albums excluded, approve at 1000 refused with the
  prefix, restore of approved refused / of rejected allowed, concurrent inserts at 999 admit one;
  pending cap: 201st pending by one guest in one family refused, another guest or another family
  unaffected, GUC override honoured (`SET app.pending_photo_limit = '2'` in the test session —
  `current_setting` reads session scope); `import_book_photo` → `pending_limit`;
  `family_starts` deny-all for `authenticated`/`pipeline`/`viewer`, DDL has no email/IP column;
  `families` SELECT visible to members only; helpers' EXECUTE grants; `email_canonical` parity;
  backfill test (three babies sharing admins → one family; two separate → two).
- **api integration**: `routes/babies` family start (guards only on first album; 400/409/429
  paths with `adminDeleteUser` **not** called; ledger row written; `freeTier.familyAlbums`);
  `auth/invites` + `auth/members` `already_parent_elsewhere`; uploads pre-checks per role and
  `pending_limit` register outcome; approve-full 409; restore rules; suspended paths unchanged;
  `purge.test` `familyStartsPruned`.
- **tools unit**: report sections/`--json` shape, no `@` without `--show-emails`.
- **web unit**: `familyErrors`, `FreeTierNotice` variants, guest note, approve toast.
- **e2e** `e2e/family/guards.spec.ts` (replaces the planned `signup-guards.spec.ts`): sign in as
  `e2e-…+twin@example.com` after `e2e-…@example.com` has an album → create album shows the inbox
  error inline; `x@mailinator.com` signs in fine, create album shows the disposable error, accepts
  a contributor invite fine.
- **gate** `pnpm e2e:abuse-gate` (`e2e/abuse/gate.ts`) per 4.4. Full suites green: `pnpm test`,
  `pnpm test:integration`, `pnpm e2e`, smoke, upload/import/share gates.

### Group 3 — CI wiring (after 11.8b)

**11.9b** — devops-engineer, as in the first plan (hygiene step in the lint job, abuse gate in
the dev-stack job with the log tap, `check-integration-report.mjs` lists the new suites).

### Group 4 — gate, PROGRESS, commit (orchestrator)

| Group | Tasks |
| --- | --- |
| 0 | 11.1b (backend) ‖ 11.2b (security) |
| 1 | 11.3b + 11.4b (security, one lane) ‖ 11.5b (backend) ‖ 11.6b (frontend) ‖ 11.7b (devops) |
| 2 | 11.8b (test-engineer) |
| 3 | 11.9b (devops) |
| 4 | orchestrator |

No two tasks in one group share a path.

## 4. Acceptance checks

### 4.1 Static, unit, integration, audit

```sh
pnpm lint && pnpm typecheck && pnpm typecheck:e2e
bash .github/scripts/abuse-hygiene.sh && bash .github/scripts/ai-hygiene.sh && bash .github/scripts/share-hygiene.sh
pnpm test && pnpm test:integration
pnpm --filter @tinyglow/db db:types && git diff --exit-code packages/db/src/generated
pnpm --filter @tinyglow/api disposable:build && git diff --exit-code apps/api/src/auth/disposable
# nothing of the old model survives:
! rg -n "cap_owner|signup_ledger|SIGNUPS_PER_IP|SIGNUP_BLOCK|SIGNUP_DOMAIN|account_exists|signup_limited|signup-guards" --glob '!docs/plans/**' --glob '!docs/PROGRESS.md' .
# fixture audit helper (every hit must be a user who is a parent in one family only):
rg -n "member\([^)]*\"admin\"\)|'admin'\)|, \"admin\"\]" apps/api/src packages/db e2e --glob '*.ts'
```

### 4.2 Database by hand (dev stack, superuser `psql`)

```sh
D='docker compose -f docker-compose.dev.yml exec -T db psql -U postgres tinyglow -v ON_ERROR_STOP=1'
$D -c "select count(*) from families"                                      # ≥ 1 (demo), + perf/review if seeded
$D -c "select name, family_id from babies order by created_at"            # Maya and Golden share one family; Pixel its own
# one family per parent: demo-mom (parent of the demo family) made admin of Pixel must fail
$D -c "insert into baby_members (baby_id,user_id,role) values ('00000000-0000-4000-8000-000000000900','00000000-0000-4000-8000-000000000001','admin')"
#   → ERROR: user is already a parent in another family
# pool counts approved only; pending excluded; approve at the cap refused (free_tier_photo_limit prefix)
$D -c "select free_tier_pool_used('<free baby>'), free_tier_pool_albums('<free baby>')"
# pending cap: as superuser insert 200 pending rows by <guest> into <baby>, then one more → ERROR: pending photo limit reached
$D -c "set app.pending_photo_limit = '1'; select pending_photo_limit()"   # 1 (GUC override works)
```

### 4.3 API by hand (`B=http://localhost:8080`, `H='x-tinyglow-client: web'`)

```sh
# any address signs in (OTP via Mailpit); no refusal at verify, including x@mailinator.com and demo-mom+x@tinyglow.local
# first album runs the guards:
curl -s -b mail.jar -H "$H" -H 'content-type: application/json' -d '{"name":"Nope","birthDate":"2026-01-15"}' $B/api/babies   # 400 email_not_allowed (mailinator)
curl -s -b twin.jar  … $B/api/babies   # 409 inbox_has_family {"existingEmailMasked":"d***@tinyglow.local"} (demo-mom+x, mom is a parent)
# guest join works for both: accept a contributor invite → 200
# second parent elsewhere: account B owns an album; A invites B as admin; B accepts → 409 already_parent_elsewhere; as contributor → 200
# approve into a full family → 409 free_tier_limit; trash one approved photo → approve succeeds
# network cap: FAMILIES_PER_IP_PER_DAY=2 docker compose -f docker-compose.dev.yml up -d --no-deps api; 3rd first-album → 429 + Retry-After; restore
docker compose -f docker-compose.dev.yml run --rm migrate pnpm admin:abuse-report --days 30 | tee /tmp/r.txt; ! grep -q '@' /tmp/r.txt
docker compose -f docker-compose.dev.yml logs api --since 30m | grep -Ei 'example\.com|tinyglow\.local|mailinator|([0-9]{1,3}\.){3}[0-9]{1,3}|bearer'; echo "exit $? (expect 1)"
```

### 4.4 Gate (`pnpm e2e:abuse-gate`, `e2e/abuse/gate.ts`, dev stack; prints `PASS n/n`)

1. Fresh account A: two albums ⇒ one `families` row (psql); 499 approved rows inserted into
   each (superuser); upload 3 JPEGs → 2 `registered` + 1 `failed/free_tier_limit`;
   `GET /babies/:id` → `freeTier { used: 1000, familyAlbums: 2 }`.
2. Guest G (contributor invite): uploads 2 → pending, `used` stays 1000; A approves one → 409
   `free_tier_limit`; A trashes an approved photo → approve → 200; `used` 1000.
3. Pending cap: 200 pending rows by G (psql); G registers one file → `failed/pending_limit`; G
   creates an album of their own → own family, upload succeeds (own pool).
4. One family per parent: account B with an album; A's admin invite to B → accept 409
   `already_parent_elsewhere`; contributor invite → 200.
5. Family-start guards: api with `FAMILIES_PER_IP_PER_DAY=2` → two first albums pass, third 429;
   a guest join still works; restore the api + `restart-api.sh`. Disposable and `+twin` accounts
   sign in, get 400 / 409 on create album, join as guests fine.
6. Report: section 2 lists A's family at 100 %, section 1 the network with ≥ 3 starts, section 5
   G's queue; no `@`; `--show-emails` shows A's address.
7. Suspend A → `/me` 403; `--lift` restores.
8. Log tap: no emails, IPs, `Bearer`. Cleanup via the existing reset helpers (ledger rows stay).

### 4.5 Gate procedure (orchestrator)

4.1 green → fresh dev stack (`up -d --build --wait`), smoke, `restart-api.sh`, `pnpm e2e`,
upload/import/share gates, `pnpm e2e:abuse-gate` → 4.2, 4.3 by hand once → screenshots →
`docs/PROGRESS.md` (built, decisions D-A…D-K with the user's confirmations, fixture audit list,
open issues) → `git commit -m "step 11: free-tier abuse safeguards (family model)"`.

## 5. Risks and decisions

### 5.1 Decisions (defaults; the user confirms or overrides before group 0 starts)

- **D-A Real `families` table** rather than deriving the family from "albums sharing an admin".
  Derivation has no stable identity when parents change (a co-parent leaving would split or merge
  pools silently) and makes "one family per parent" a graph property instead of a row check; a
  table gives the pool, the ledger, the report and future per-family billing one key. The row is
  trigger-maintained; the API never writes it.
- **D-B Canonical duplicates are allowed as guests** and refused only when starting a family.
  A guest costs the server nothing (their photos count against the host family and sit behind the
  pending cap and approval), so a second account for the same inbox gains no storage as a guest;
  refusing at verify time would strand legitimate cases and bring back the GoTrue orphan cleanup,
  the generic-response leak and the `adminDeleteUser` dependency this amendment removes. The
  arbiter lives in `babies_set_family` under an advisory lock, so two first-albums for one inbox
  admit exactly one. Deviation from the first plan's "verify-time 409" — flagged.
- **D-C Pending cap applies to every plan** (Plus families too): it protects storage, not the
  free tier; a paying family with 200 unreviewed photos from one guest is still a queue to clear.
  Flag if Plus should be exempt.
- **D-D Pending cap configurability**: SQL default 200 (`PENDING_PHOTOS_PER_GUEST_PER_FAMILY`
  mirrors it) with a database GUC override `app.pending_photo_limit` set once by the operator.
  Env plumbing would need the API, the worker and the DB to agree on a value; the GUC keeps the
  trigger (the hard stop) and the API pre-check (`pending_photo_limit()`) identical by
  construction. "Cheap" as the user asked; flag if a compose variable is preferred.
- **D-E Trashed albums**: a parent of only trashed albums still belongs to that family (new
  albums join it; no trash-cycling to a fresh pool); trashed albums' photos stay **excluded**
  from the pool (first plan's D2: trash doesn't count; purge bounds it to 30 days; the report's
  storage section shows them).
- **D-F Plus stays per album** (`babies.plan`, `plan_owner_user_id`, `db:plan` unchanged); the
  pool counts only the family's free, live albums. Per-family Plus can come with billing (the
  `families` key makes it a one-column move).
- **D-G Pixel** becomes its own perf family (perf owner the only parent; mom and dad guests).
  The perf check is manual and nothing under `e2e/` references Pixel; a guest sees the timeline
  and album. If an admin-only screen is needed, sign in as the perf owner via Mailpit.
- **D-H Env and code renames now** (`FAMILIES_PER_IP_PER_DAY`, `BLOCK_DISPOSABLE_EMAIL`,
  `EMAIL_DOMAIN_{DENY,ALLOW}LIST`; codes `inbox_has_family`, `family_limited`): nothing is
  committed, and the old names would describe behaviour that no longer exists.
- **D-I No refusal at admin-invite creation**: checking the invitee's address against "is a
  parent elsewhere" would tell the inviter that the address has an account with a family. The
  refusal happens at accept (and at promote), where the account is known.
- **D-J Network cap counts family starts**, not sign-ups; invited guests are never counted (they
  start nothing). Default 5 per IP per day, dev 1000. Rows outlive purge and account deletion.
- **D-K Report gains "pending queues"** (section 5) because the approval queue is now the only
  unmetered intake; threshold 50 % of the pending cap.

### 5.2 Risks

- **Fixture audit volume**: ~45 direct admin inserts across `packages/db`, `apps/api` and `e2e`
  (2.6). Most are one admin per baby and pass; the known breakers are `ai-pipeline` (`free`) and
  likely `account.integration.test.ts`. Budget a full `pnpm test:integration` run after 11.8b.
- **Dev databases after migrating**: the backfill merges Pixel into the demo family (shared
  admin); run `pnpm perf:seed` again (re-homes it) or reset the stack. Production has no data.
- **API harness per-IP cap**: without `FAMILIES_PER_IP_PER_DAY: 100000` in `testConfig`, the
  sixth test baby of a run gets 429.
- **`babies_set_family` is SECURITY DEFINER and inserts into `families`** under `authenticated`
  callers: `families` must have no user-role INSERT grant, and the function must pin
  `search_path`. Same pattern as `baby_members_release_plan`.
- **`import_book_photo` redefined in migration 21** (step-10 body copied verbatim plus one
  branch): the down migration must restore the step-10 text exactly; the hand-check script
  compares `pg_get_functiondef` before/after a down/up cycle.
- **Approve path now raises** inside the UPDATE: `photos/routes.ts` must not mistake the thrown
  23514 for "0 rows" (`explainNoRow`); the mapper handles it, but the test must cover it.
- **Pending restore** (rejected → pending) passes through `photos_pending_cap`; a guest at the
  cap whose rejected photo an admin restores gets a 409 on the admin's screen — acceptable, copy
  explains it; flag if restore should bypass the cap.
- **Fable weekly limit**: 11.2b–11.4b are security-engineer tasks; run on Opus if hit (memory).

### 5.3 Deferred (record in `docs/PROGRESS.md`)

Per-family Plus; a parent-facing "your family" screen listing albums and parents; moving a baby
between families; automatic blocklist refresh; Yahoo `-` subaddressing; captcha-on-first-album.
