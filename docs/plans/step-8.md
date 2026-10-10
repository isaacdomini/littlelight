# Step 8 plan: Sharing

Status: proposed (architect, 2026-10-09). PRD step: "Build handoff for Claude Code → Build order →
8. Sharing: share links (24 h default, renew, passcode, revoke), viewer sessions, manual add,
auto-share rules, sensitive-photo gate." Acceptance (verbatim): "Check: expired or revoked link
returns the expired page; sensitive photos never auto-share."

PRD sections implemented: "FR-9 Sharing" (9.1–9.8), "Accounts and authentication → Share-link
viewers (no account)", "Roles and permissions" (create/renew/revoke links: admins only; viewers:
shared photos only, no chat), "Auth security requirements" (audit: share link
created/renewed/revoked), "Non-functional requirements → Privacy and child safety" (signed URLs
≤ 1 h scoped to one object; sensitive photos never auto-shared and blurred in the share-link grid
until an admin explicitly shares them; GPS/EXIF stripped from viewer derivatives), "Security"
(tokens ≥ 128-bit random, stored hashed; passcode attempts 5 / 15 min per IP + token; share-link
access through a separate narrowly scoped role), "Mobile and Capacitor → Capacitor plugins" (deep
link `tinyglow.app/s/{token}`: the web route now, native association in step 9),
"Responsive web" (installable PWA for viewers; share links work in any mobile browser), FR-8.4
("add to shared album" in the photo viewer), "AI pipeline" stage 6 ("Post-process: auto-share
rules run"), FR-5.8 (sharing is in the free tier; AI is not), "Conventions".
`CLAUDE.md` clarifications applied: links expire after **24 hours by default**; **viewers get no
chat**; contributors are in v1 (and cannot share); AI features are paid tier only and free-tier
photos are never sent to a model (this step makes **no model call at all**: rules read stored AI
tags). No per-step reviewer pass (user instruction); the combined review after step 9 covers this.

What already exists (step 2, verified in `packages/db/migrations/1791520000500_sharing.sql` and
`1791700000100_uploads-and-ingest.sql`): tables `share_links` (sha256 `token_hash`,
`passcode_hash`, `expires_at` default now()+24 h, `allow_download`, `revoked_at`, `view_count`,
`last_viewed_at`), `share_rules` (`mode all|milestones|tags`, include/exclude tags), `shared_photos`
(`added_by user|rule`), `viewer_sessions` (hashes only); helpers `auth_share_link_id()`,
`is_share_link_active()`, `share_link_baby()`, `viewer_baby_id()`, `viewer_can_see_photo()` (a
sensitive photo is visible to a viewer only when `added_by = 'user'`); trigger `shared_photos_gate`
(same baby, approved, live; **"sensitive photos are never auto-shared"** for `added_by = 'rule'`);
trigger `photos_sensitive_unshare_rules` (a photo that becomes sensitive loses its rule shares at
once); the `viewer` role's allow-list (`photos` columns incl. `is_sensitive`, `photo_derivatives`
thumb/display, `photo_details.milestone_id`, `milestones`, `babies (id,name,nickname,birth_date)`,
own `share_links` row); demo link "Grandparents" (dev token `demo-grandparents-share-token`, rule
`milestones`, photos 2, 9, 10 shared by mom). API: `runAs(pool, "viewer", …)` exists
(`apps/api/src/plugins/db.ts`), `withServiceRole(app, reason, …)`, in-memory `createThrottle`,
`clientIp`, cookie plugin, CSRF header guard. Worker: the AI poller already sends
`photo.reindex {reason:"ai"}` for every new `photo_ai` row and the API sends `photo.reindex` after
every details/milestone/override edit; that handler (`apps/worker/src/reindex.ts`,
backend-owned) is where PRD stage 6 runs. Web: `FEATURES.sharing = false`, disabled "Add to
shared album" buttons in the timeline batch bar (`batch-share`) and the photo viewer
(`viewer-share`), Family tab with members/invites. nginx already masks `/s/<token>` in the access
log and serves the SPA fallback for `/s/*`.

## 1. Goal

Let the two admins of a baby give family a private, read-only, beautiful album through a link,
without accounts, without ever exposing a sensitive photo by accident. Admins create one or more
named links per baby (FR-9.1), each a 128-bit random token stored only as its SHA-256, valid 24 h
by default and renewable (same token, new expiry) or regenerable (new token, old link and every
open viewer session dead) in one tap, with an optional 6-digit passcode (scrypt-hashed; 5 failures
per IP + token per 15 min, and a per-link lock after 20 failures per hour), an allow-download
toggle and revoke (FR-9.2, FR-9.7). Admins add or remove photos by multi-select from the timeline
and from the photo viewer (FR-9.3, FR-8.4); paid-tier babies can also set one auto-share rule per
link (all / milestone photos / photos with tags, minus excluded tags) that the worker evaluates
after AI analysis and after every details edit of an analysed photo (FR-9.4, PRD stage 6). The
sensitive gate (FR-9.5) is a database rule in four places: a rule can never insert a sensitive or
unanalysed photo, a photo that becomes sensitive loses its rule shares instantly, a hand-added
sensitive photo is shown to viewers as a hidden ("blurred") tile with **no image URL at all**
until an admin explicitly chooses "Show to family" for that link, and the viewer role cannot even
read the storage key of such a photo. A viewer opens `https://tinyglow.app/s/{token}`
in any mobile browser (FR-9.6); the SPA exchanges the token (POST body, never a path segment the
API logs) for an httpOnly `ll_viewer` cookie holding a short JWT (`role=viewer`, `share_link_id`,
`exp` = the link's expiry, `jti` = the `viewer_sessions` row) whose session the API re-checks
against `share_links.revoked_at`/`expires_at` and `viewer_sessions.revoked_at` on every request;
all viewer reads run as the Postgres `viewer` role. Expired, revoked, regenerated-away and unknown
links all render one friendly "This link has expired. Ask the parents for a new link." page. Viewer
media are 5-minute signed URLs of EXIF-free `thumb`/`display` derivatives with
`Cache-Control: private`, so revocation leaves nothing in any shared cache to purge (FR-9.7 in a
stack with no CDN cache of its own). Admins see views and last visit per link (FR-9.8). The viewer
UI is an installable PWA page with no chat, no search and no account.

## 2. Interfaces first

### 2.1 Topology

```
viewer browser  GET /s/<token> ─► nginx SPA fallback (Referrer-Policy no-referrer, noindex, access log masks token)
                POST /api/share/session {token, passcode?} ─► api sharing/viewer-session.ts ─service_role─► share_links by sha256(token)
                    ◄─ Set-Cookie ll_viewer=<viewer JWT>; HttpOnly; SameSite=Lax; Path=/api/share; [Secure]
                GET  /api/share/album | /api/share/photos | POST /api/share/photos/urls | POST /api/share/photos/:id/download
                    ─► withViewer: verify JWT ─► runAs("viewer", claims) ─► viewer_session_check(jti) ─► RLS-scoped SELECTs
                    ◄─ 5-min presigned GETs (thumb/display only, response-cache-control private) ─► files.… (MinIO)
admin SPA       /api/babies/:id/share-links, /api/share-links/:id/… ─► sharing/admin-routes.ts ─authenticated (RLS: admin)─►
                    share_links / share_rules / shared_photos / shared_photo_exclusions  ──► enqueue share.apply {shareLinkId}
worker          photo.reindex batch ─► reindex.ts: autoSharer.evaluatePhotos(ids) (pipeline) then indexer.reindex(ids)
                share.apply {shareLinkId} ─► autoSharer.applyLink(id)        cron share.reconcile (41 * * * *) ─► autoSharer.reconcile()
```

No new service, no new dependency (passcodes use `node:crypto` scrypt; JWTs use the existing
`jose`; R1). No model call anywhere in this step.

### 2.2 Tokens, hashes, passcodes, viewer JWT (security-engineer, `apps/api/src/sharing/crypto.ts`)

| Item | Decision |
| --- | --- |
| Share token | `randomBytes(16)` → base64url, 22 chars (128 bits, PRD "token is 128-bit random"). Accepted shape on input: `shareTokenSchema = /^[A-Za-z0-9_-]{22,64}$/` (the dev seed token `demo-grandparents-share-token` fits) |
| Stored | `share_links.token_hash = sha256(token utf-8)` (bytea 32; high-entropy input, so a fast hash is correct). Lookup `WHERE token_hash = $1` under `service_role` only (users cannot read the column) |
| URL | `${PUBLIC_URL}${SHARE_PATH}/${token}` with `SHARE_PATH = "/s"`. Returned **only** in the create and regenerate responses (D1); never logged, never stored in plaintext, never in an audit row |
| Passcode | exactly 6 ASCII digits. Hash `scrypt$1$<N=16384>$<r=8>$<p=1>$<salt b64url 16 B>$<dk b64url 32 B>` via `crypto.scrypt`; verify with `timingSafeEqual`. Never logged; `req.body.passcode` redacted (2.9) |
| IP / UA hashes | `HMAC-SHA256(k_ip, ip)` and `HMAC-SHA256(k_ip, userAgentLabel(ua))` (32 B) where `k_ip = HKDF-SHA256(JWT_SECRET, salt "tinyglow", info "share-ip-v1", 32)`. Keyed so a DB leak cannot brute-force the IPv4 space |
| Viewer JWT | HS256 with `k_viewer = HKDF-SHA256(JWT_SECRET, salt "tinyglow", info "viewer-session-v1", 32)` (a different key from GoTrue's, so a viewer token can never verify as a user token or vice versa, R2); `iss = ${PUBLIC_URL}/api/share`, `aud = "tinyglow-viewer"`; payload exactly `viewerClaimsSchema`: `{ role: "viewer", share_link_id, exp, iat, jti }` with `jti = viewer_sessions.id` and `exp = min(share_links.expires_at, now + SHARE_LINK_MAX_TTL_HOURS)` (PRD: `exp` = the link's expiry). Clock tolerance 5 s like `jwt.ts` |
| Cookie | `ll_viewer` (`VIEWER_COOKIE`), `HttpOnly; SameSite=Lax; Path=/api/share; Max-Age = exp − now`, `Secure` under the same rule as `ll_access` (`apps/api/src/auth/session.ts` `secure(config)`). Separate name **and** path from the parent session (`ll_access` Path `/api`, `ll_refresh` Path `/api/auth`): the viewer cookie never reaches a parent route, so a viewer can never call chat, search or any `/babies` route |
| Native (step 9 seam) | `X-Tinyglow-Client: native` on the exchange ⇒ the JWT comes back in the body (`viewerToken`) instead of a cookie, and viewer routes accept `Authorization: Bearer <viewer JWT>` (same transport rule as step 3). The web never uses it |

### 2.3 Database (migration `1792100000100_sharing-v1.sql`, security-engineer)

Conventions as before (reversible; `IF (NOT) EXISTS`; policies `TO <role>` named
`<table>_<role>_<verb>`; column grants; SECURITY DEFINER with pinned `search_path`, `REVOKE … FROM
PUBLIC`; shape triggers raising `check_violation` with fixed messages instead of CHECKs on tables
that hold parent text; every policy change tested; nothing echoes tokens, passcodes, names or tags).

1. **`share_links`**
   - `ttl_hours smallint NOT NULL DEFAULT 24` (the duration "Renew" re-applies; 1..720).
   - `token_rotated_at timestamptz` (set by regenerate; passcode-failure windows count only rows
     with `created_at > COALESCE(token_rotated_at, '-infinity')`, so a regenerate clears a lock).
     `GRANT SELECT, UPDATE (token_rotated_at)` to `authenticated`.
   - `has_passcode boolean GENERATED ALWAYS AS (passcode_hash IS NOT NULL) STORED`; `GRANT SELECT
     (ttl_hours, has_passcode)` to `authenticated`; `GRANT INSERT (ttl_hours)`, `UPDATE (ttl_hours)`
     to `authenticated`. `viewer` and `pipeline` column grants unchanged.
   - `share_links_shape` (existing trigger, extended; now `BEFORE INSERT OR UPDATE OF name,
     passcode_hash, expires_at, ttl_hours`): name 1..80 (unchanged), `ttl_hours` 1..720
     (`share_links.ttl_hours must be 1 to 720`), `expires_at <= now() + interval '721 hours'`
     (`share link expiry must be within 30 days`), `passcode_hash IS NULL OR passcode_hash LIKE
     'scrypt$%'` (`share_links.passcode_hash has an unknown format`). Down restores the step-5 body.
   - `share_links_cap` (BEFORE INSERT, SECURITY DEFINER, locks the baby row): at most
     `SHARE_LINKS_PER_BABY_MAX = 20` links per baby (`share link limit reached`).
   - `share_links_end_sessions` (AFTER UPDATE OF `token_hash, passcode_hash, revoked_at`, SECURITY
     DEFINER): when `token_hash` changed, or `passcode_hash` changed to a non-NULL value, or
     `revoked_at` went from NULL to set, `UPDATE viewer_sessions SET revoked_at = now() WHERE
     share_link_id = NEW.id AND revoked_at IS NULL`. Regenerate, a new passcode and revoke end every
     open viewer session as a database rule, not an API promise.
   - Column comment on `passcode_hash` updated to "scrypt string computed by the API" (step 2 said
     argon2id; D7).
2. **`viewer_sessions`**: add `revoked_at timestamptz`; `GRANT SELECT (revoked_at)` to
   `authenticated` (admins count active viewers). Index `(share_link_id) WHERE revoked_at IS NULL`.
3. **`viewer_session_check(p_session_id uuid) RETURNS TABLE (share_link_id uuid, baby_id uuid,
   link_name text, baby_name text, baby_nickname text, expires_at timestamptz, allow_download
   boolean)`** — VOLATILE, SECURITY DEFINER, `viewer` and `service_role` only. Returns one row iff:
   `auth_share_link_id()` is not NULL, a `viewer_sessions` row with `id = p_session_id` and
   `share_link_id = auth_share_link_id()` exists with `revoked_at IS NULL`, and
   `is_share_link_active(auth_share_link_id())`. Side effects in the same call (the viewer role
   has no write grant anywhere; this function is its only write path): `last_seen_at = now()`; when
   the previous `last_seen_at` is NULL or older than `SHARE_VISIT_GAP_MIN = 30` minutes,
   `share_links.view_count += 1, last_viewed_at = now()` (one "visit", FR-9.8); when the link's
   `expires_at` is later than the session's (the link was renewed), `viewer_sessions.expires_at =
   share_links.expires_at` (the API then re-mints the cookie, 2.6). Reads no hash column.
4. **`shared_photos`**
   - `sensitive_released_at timestamptz`, `sensitive_released_by uuid REFERENCES profiles(user_id)
     ON DELETE SET NULL` — "an admin explicitly shared this sensitive photo with this link" (D4).
   - Grants: `authenticated` INSERT gains the two columns; **UPDATE narrowed** (`REVOKE UPDATE`,
     then `GRANT UPDATE (added_by, added_by_user_id, sensitive_released_at, sensitive_released_by)`).
     Policies `shared_photos_authenticated_insert`/`_update` `WITH CHECK` become: admin of the
     link's baby AND `added_by = 'user'` AND `added_by_user_id = auth_uid()` AND
     (`sensitive_released_at IS NULL OR sensitive_released_by = auth_uid()`). An admin touching a
     rule row converts it into a hand-picked row (it then survives a later sensitive flag, shown
     hidden).
   - `viewer`: `REVOKE SELECT`, then `GRANT SELECT (share_link_id, photo_id, added_by, added_at,
     sensitive_released_at)` (no parent user ids for viewers).
   - `pipeline`: `GRANT DELETE`, policy `shared_photos_pipeline_delete USING (added_by = 'rule')`
     (rule sync may remove only its own rows).
   - **`shared_photos_gate` rewritten** (same trigger name, BEFORE INSERT OR UPDATE): `SELECT … FROM
     photos WHERE id = NEW.photo_id FOR SHARE` (serialises with a concurrent `is_sensitive` update:
     whichever commits second sees the other, so a rule row and a sensitive flag can never both
     survive, R5); refuses — besides the step-2 rules — `quarantined_at IS NOT NULL`, and for
     `added_by = 'rule'`: no `photo_ai` row for the photo (`only analysed photos can be
     auto-shared`; free-tier photos are never analysed, so rules never reach them, D3), an
     exclusion row for (link, photo) (`photo was removed from this album by an admin`), or
     `sensitive_released_at IS NOT NULL`. Messages fixed. Down restores the step-2 body verbatim.
5. **`shared_photo_exclusions`** (new): `share_link_id uuid REFERENCES share_links ON DELETE
   CASCADE`, `photo_id uuid REFERENCES photos ON DELETE CASCADE`, `excluded_by uuid REFERENCES
   profiles(user_id) ON DELETE SET NULL`, `created_at`, PK `(share_link_id, photo_id)`. "An admin
   removed this photo from this album; rules must not re-add it." ENABLE + FORCE RLS.
   `authenticated` SELECT/DELETE `USING (is_baby_admin(share_link_baby(share_link_id)))`, INSERT
   `(share_link_id, photo_id, excluded_by)` `WITH CHECK (… AND excluded_by = auth_uid())`;
   `pipeline` SELECT; `service_role` ALL; `viewer` nothing. Guard trigger
   `shared_photo_exclusions_guard` (BEFORE INSERT, SECURITY DEFINER): the photo belongs to the
   link's baby (`photo does not belong to the share link's baby`).
6. **`viewer_can_see_media(p_photo_id uuid) RETURNS boolean`** (STABLE, SECURITY DEFINER, `viewer`/
   `service_role`): `viewer_can_see_photo(p_photo_id)` AND the link's row for the photo has
   `NOT p.is_sensitive OR (sp.added_by = 'user' AND sp.sensitive_released_at IS NOT NULL)`.
   `photo_derivatives_viewer_select` becomes `USING (kind IN ('thumb','display') AND
   viewer_can_see_media(photo_id))`: the viewer role cannot read the storage key of a hidden
   photo, so the API could not sign it even by mistake. Down restores the step-2 policy.
7. **`share_rules`**
   - `evaluated_at timestamptz` (watermark of the last full sync), `GRANT UPDATE (evaluated_at)` to
     `pipeline` + policy `share_rules_pipeline_update USING (true) WITH CHECK (true)`.
   - `share_rules_shape` (BEFORE INSERT OR UPDATE OF `mode, include_tags, exclude_tags`, SECURITY
     DEFINER): each tag array ≤ 20 entries, each entry 1..60 chars and already lower-case/trimmed
     (`share_rules tags must be …`); `mode = 'tags'` needs ≥ 1 include tag (`share rule needs at
     least one include tag`); and **`baby_ai_enabled(share_link_baby(share_link_id))`** (`auto-share
     rules need the paid plan`, D3). DELETE is always allowed (a downgraded baby can remove its rule).
8. **`share_passcode_failures`** (new): `id bigint GENERATED ALWAYS AS IDENTITY PK`,
   `share_link_id uuid NOT NULL REFERENCES share_links ON DELETE CASCADE`, `ip_hash bytea NOT NULL`
   (32 B, plain CHECK allowed: no parent text), `created_at timestamptz NOT NULL DEFAULT now()`;
   indexes `(share_link_id, ip_hash, created_at)` and `(share_link_id, created_at)`. ENABLE + FORCE
   RLS; **`service_role` only** (no other grant). Persistent, so limits survive API restarts and
   replicas (D8). Helper **`share_link_passcode_locked(p_share_link_id uuid) RETURNS boolean`**
   (STABLE, SECURITY DEFINER, `authenticated`/`service_role`): false unless the caller is an admin of
   the link's baby (or service_role); true when ≥ 20 failures in the last 60 minutes.
9. **Seed** (`packages/db/src/seed.ts`): the demo link gets `ttl_hours = 24`; the sensitive bath
   photo (nn 4) is added by mom as a hand-picked share with `sensitive_released_at NULL` (a hidden
   tile for the e2e/smoke); still idempotent; nothing else changes (the demo link keeps no passcode).
10. Regenerate `packages/db/src/generated` (`pnpm db:types`); README: migration row + "Sharing
    (step 8)" section (token/hash/passcode storage, who may write what, the four sensitive rules,
    session ending trigger, `viewer_session_check` contract, exclusions, passcode failure ledger,
    pipeline rule-sync rights). `pgmigrations` becomes 15.

**Who may write what after this step.**

| Table | `authenticated` (admins of the baby) | `viewer` | `pipeline` | `service_role` |
| --- | --- | --- | --- | --- |
| `share_links` | INSERT/UPDATE/DELETE (hash columns write-only), SELECT without hashes | SELECT own active row (no hashes) | SELECT id, baby_id, expires_at, revoked_at | ALL (token exchange, passcode failures) |
| `share_rules` | ALL (paid babies for INSERT/UPDATE) | – | SELECT, UPDATE (evaluated_at) | ALL |
| `shared_photos` | SELECT/INSERT/UPDATE/DELETE as `user` rows | SELECT (no user ids), only visible rows | SELECT, INSERT + DELETE `rule` rows | ALL |
| `shared_photo_exclusions` | SELECT/INSERT/DELETE | – | SELECT | ALL |
| `viewer_sessions` | SELECT (no hashes) | via `viewer_session_check()` only | – | ALL (exchange inserts) |
| `share_passcode_failures` | – (`share_link_passcode_locked()` only) | – | – | ALL |

Contributors: nothing new (every sharing policy requires `is_baby_admin`).

### 2.4 Shared contracts (`@tinyglow/shared`; architect-defined, security-engineer writes in 8.2 with orchestrator approval)

`src/constants.ts` (append): `SHARE_PATH = "/s"`, `SHARE_TOKEN_BYTES = 16`,
`SHARE_LINK_TTL_CHOICES_HOURS = [24, 72, 168, 720] as const` (UI choices; default stays
`SHARE_LINK_DEFAULT_TTL_HOURS = 24`), `SHARE_LINK_MAX_TTL_HOURS = 720`, `SHARE_LINKS_PER_BABY_MAX = 20`,
`SHARE_PASSCODE_LENGTH = 6`, `SHARE_PASSCODE_FAILURES_PER_IP = 5`, `SHARE_PASSCODE_IP_WINDOW_MIN = 15`,
`SHARE_PASSCODE_FAILURES_PER_LINK = 20`, `SHARE_PASSCODE_LINK_WINDOW_MIN = 60`,
`SHARE_EXCHANGES_PER_IP_PER_HOUR = 120`, `SHARE_VISIT_GAP_MIN = 30`, `SHARE_RULE_TAGS_MAX = 20`,
`SHARE_RULE_TAG_MAX_CHARS = 60`, `SHARE_VIEWER_PAGE_SIZE = 100`, `SHARE_VIEWER_URLS_MAX = 200`,
`SHARE_DOWNLOAD_URL_TTL_SEC = 60`, `DEMO_IDS.shareToken = "demo-grandparents-share-token"` (dev only).

`src/auth.ts`: `VIEWER_COOKIE = "ll_viewer"`, `VIEWER_COOKIE_PATH = "/api/share"`,
`VIEWER_JWT_AUDIENCE = "tinyglow-viewer"`. `AUDIT_EVENTS` append: `share_link.created`,
`share_link.updated` (name/download/passcode/ttl; metadata says which, never values),
`share_link.renewed`, `share_link.regenerated`, `share_link.revoked`, `share_link.deleted`,
`share_link.rule_updated`, `share_link.rule_removed`, `share_link.photos_added`,
`share_link.photos_removed`, `share_link.sensitive_shown`, `share_link.sensitive_hidden`,
`share_link.passcode_locked` (written by the exchange under service_role, `actor_user_id NULL`).
`auditMetadataSchema` gains `mode: shareRuleModeSchema.optional()`, `allow_download: boolean
optional`, `has_passcode: boolean optional`, `hours: int 1..720 optional`, `fields:
z.array(z.enum(["name","allow_download","passcode","ttl_hours"])).optional()`; `count` (exists) is
used for photo add/remove; the row's `share_link_id` column names the link.

`src/jwt-claims.ts`: unchanged (`viewerClaimsSchema` already has `role`, `share_link_id`, `exp`,
`iat`, `jti`); doc comment updated ("minted in step 8; `jti` = `viewer_sessions.id`").

`src/db-enums.ts`: `shareLinkStatusSchema = z.enum(["active","expired","revoked"])`.

`src/share-rules.ts` (new; browser-safe, only `zod` and this package):
- `normalizeShareTag(s) → string` (NFC, trim, collapse inner whitespace, lower-case);
  `shareTagSchema` = string → normalized, 1..`SHARE_RULE_TAG_MAX_CHARS`.
- `ShareRuleFacts { analyzed: boolean; isSensitive: boolean; hasMilestone: boolean; tags: string[] }`.
- `shareRuleMatches(rule: { mode; includeTags; excludeTags }, facts) → boolean`: false unless
  `analyzed && !isSensitive`; false if any `excludeTags` ∈ `facts.tags`; then `all` ⇒ true,
  `milestones` ⇒ `hasMilestone` (the **parent-tagged** `photo_details.milestone_id`, never the AI's
  `possible_milestones`), `tags` ⇒ any `includeTags` ∈ `facts.tags`. Tags compared after
  `normalizeShareTag`.
- `src/search-document.ts`: export the existing private `buildTags` as `searchTagsFor(ai,
  milestoneName)` (no behaviour change; `buildSearchDocument` keeps calling it). Rule facts use
  exactly the `photo_search.tags` definition, so the tags an admin sees in search facets are the
  tags rules match.

`src/api/share-links.ts` (new; admin):
- `shareRuleInputSchema = z.strictObject({ mode: shareRuleModeSchema, includeTags:
  z.array(shareTagSchema).max(20).default([]), excludeTags: … })` refine `tags ⇒ includeTags ≥ 1`;
  `shareRuleSchema = shareRuleInputSchema.extend({ updatedAt, evaluatedAt: nullable })`.
- `shareLinkSchema { id, babyId, name, status: shareLinkStatus, expiresAt, revokedAt|null,
  ttlHours, allowDownload, hasPasscode, passcodeLocked, rule: shareRule|null, photoCount,
  hiddenCount (sensitive, not shown), viewCount, lastViewedAt|null, activeViewers, createdAt,
  createdBy|null }`; `shareLinksResponseSchema { links: shareLink[] }` (newest first).
- `shareLinkCreateRequestSchema = z.strictObject({ name: trim 1..80, ttlHours: int 1..720 default
  24, passcode: /^\d{6}$/ nullable optional, allowDownload: boolean default false, rule:
  shareRuleInput nullable optional })`; `shareLinkCreatedResponseSchema { link: shareLink, url:
  z.url() }` (the only responses carrying the token, with regenerate).
- `shareLinkPatchRequestSchema = z.strictObject({ name?, allowDownload?, passcode?: 6 digits |
  null (null clears), ttlHours? })` at least one key.
- `shareLinkRenewRequestSchema { ttlHours?: 1..720 }` (absent ⇒ the link's `ttl_hours`).
- `shareLinkPhotosAddRequestSchema { photoIds: uuid[] 1..PHOTO_BATCH_MAX unique, showSensitive:
  boolean default false }` → `shareLinkPhotosAddResponseSchema { added: int, alreadyShared: int,
  hidden: int (sensitive added without showSensitive), skipped: { photoId, reason:
  "not_found"|"not_approved"|"trashed" }[] }`.
- `shareLinkPhotosRemoveRequestSchema { photoIds 1..500 }` → `{ removed: int }`.
- `shareLinkPhotoPatchRequestSchema { showSensitive: boolean }`.
- `shareLinkPhotosQuerySchema { cursor?, limit 1..200 default 100 }` →
  `shareLinkPhotosResponseSchema { photos: (photoSummarySchema & { sharedBy: sharedPhotoAddedBy,
  hiddenFromViewers: boolean, addedAt })[], nextCursor|null }` (newest first by `sort_at, id`).
- `photoShareLinksResponseSchema { links: { shareLinkId, name, status, shared: boolean, sharedBy:
  sharedPhotoAddedBy|null, hiddenFromViewers: boolean, excluded: boolean }[] }` (`GET
  /photos/:id/share-links`, for the add/remove sheet's checked state).

`src/api/share-viewer.ts` (new; viewer):
- `shareTokenSchema` (2.2); `shareSessionRequestSchema = z.strictObject({ token: shareTokenSchema,
  passcode: /^\d{6}$/ optional })`.
- `shareAlbumSchema { linkName, babyName, babyNickname|null, allowDownload, expiresAt, photoCount,
  hiddenCount }`; `shareSessionResponseSchema { album: shareAlbum, viewerToken?: string }`
  (`viewerToken` only for `native`).
- `viewerPhotoSchema { id, takenAt|null, takenAtEstimated, ageDays|null, width|null, height|null,
  milestone: { id, name }|null, hidden: boolean, thumbUrl: url|null (null when hidden),
  urlExpiresAt|null }` — **no** `babyId`, status, uploader, caption, AI fields, `isSensitive`
  (only `hidden`), never `displayUrl` in lists (D9, D10).
- `viewerPhotosQuerySchema { cursor?, limit 1..200 default SHARE_VIEWER_PAGE_SIZE }` →
  `viewerPhotosResponseSchema { photos, nextCursor|null }` (newest first, `sort_at DESC, id DESC`).
- `viewerUrlsRequestSchema { ids: uuid[] 1..SHARE_VIEWER_URLS_MAX, kind: z.enum(["thumb","display"]) }`
  → `viewerUrlsResponseSchema { urls: { id, url, expiresAt }[] }` (hidden / non-visible ids
  silently omitted).
- `viewerDownloadResponseSchema { url, expiresAt }`.

`src/api/errors.ts`: add `share_link_expired` (410: unknown, expired, revoked, regenerated-away or
deleted-baby link; one friendly message "This link has expired. Ask the parents for a new link."),
`passcode_required` (401), `passcode_invalid` (401, `details: { attemptsLeft }`), `passcode_locked`
(429 + `Retry-After`: per-link lock).

`src/jobs.ts`: `JOBS.shareApply = "share.apply"` (`shareApplyJobSchema = z.strictObject({
shareLinkId: z.uuid(), reason: z.enum(["rule_changed","manual"]) })`, singleton key =
`shareLinkId`), `JOBS.shareReconcile = "share.reconcile"` (cron, `shareReconcileJobSchema =
z.strictObject({})`).

`src/env.ts`: `shareEnvSchema { SHARE_MEDIA_URL_TTL_SEC: int 30..900 default 300,
SHARE_RECONCILE_CRON: cron default "41 * * * *" }` with `emptyAsUndefined`; `SHARE_DEFAULTS`.

`index.ts` re-exports everything.

### 2.5 API: admin share-link routes (security-engineer, `apps/api/src/sharing/admin-routes.ts`, `queries.ts`, `crypto.ts`)

Every route: `requireAuth` + `withClaims` + `requireConsent` + the step-5 `babyAccess` (stranger ⇒
404, contributor ⇒ 403 `forbidden` "Only the baby's parents can share"); **no `withServiceRole`**
(admins write hashes through their own column grants; RLS is the backstop). Link ids resolve to
their baby with `share_link_baby()` under the caller's claims (a stranger's id ⇒ 404).

| Method, path | Behaviour |
| --- | --- |
| `GET /babies/:id/share-links` | `shareLinksResponse`. `status` = revoked if `revoked_at`, else expired if `expires_at <= now()`, else active. Counts in one SQL (photoCount, hiddenCount = sensitive and not released, activeViewers = sessions `revoked_at IS NULL AND expires_at > now()`), `passcodeLocked` via `share_link_passcode_locked(id)` |
| `POST /babies/:id/share-links` | Body `shareLinkCreateRequest`. New token + hash, optional passcode hash, `expires_at = now() + ttlHours`, `created_by = uid`; optional rule (free baby + rule ⇒ 403 `plan_required`, nothing created). 409 `conflict` at 20 links. Audit `share_link.created {hours, has_passcode, allow_download, mode?}`. After commit: `enqueueShareApply({shareLinkId, reason:"rule_changed"})` when a rule was set. 201 `shareLinkCreatedResponse` |
| `PATCH /share-links/:id` | `shareLinkPatchRequest`; passcode set/changed ends open sessions (DB trigger); audit `share_link.updated {fields}` |
| `POST /share-links/:id/renew` | `expires_at = now() + (ttlHours ?? ttl_hours)` and stores `ttl_hours`; **409 `conflict` "This link was revoked. Regenerate it to share again."** when revoked; token unchanged, open sessions continue (sliding re-mint, 2.6); audit `share_link.renewed {hours}` |
| `POST /share-links/:id/regenerate` | New token + hash, `token_rotated_at = now()`, `revoked_at = NULL`, `expires_at = now() + ttl_hours`, passcode kept; old token ⇒ 410 and every open session ended (DB trigger); the passcode lock clears because failure windows only count rows newer than `token_rotated_at`. Audit `share_link.regenerated`. 200 `shareLinkCreatedResponse` (new URL) |
| `POST /share-links/:id/revoke` | `revoked_at = now()` (idempotent: already revoked ⇒ 200 unchanged, no second audit); sessions ended (trigger); audit `share_link.revoked` |
| `DELETE /share-links/:id` | Deletes link, rule, album rows, exclusions, sessions (cascade); audit `share_link.deleted` (written **before** the delete so `share_link_id` is set, then SET NULL by the FK). 204 |
| `PUT /share-links/:id/rule` | `shareRuleInput` (tags normalized). Free baby ⇒ 403 `plan_required` "Auto-share checks every photo for sensitive content first; it's part of Plus". Upsert; audit `share_link.rule_updated {mode}`; after commit `enqueueShareApply(rule_changed)`. Returns `shareRule` |
| `DELETE /share-links/:id/rule` | Deletes the rule; photos it added **stay** (D5); audit `share_link.rule_removed`; 204 |
| `GET /share-links/:id/photos` | `shareLinkPhotosQuery` → `shareLinkPhotosResponse` (reuses `photos/queries.ts` `photoRowsByIds`/`toPhotoSummary` for signed thumbs, read-only import) |
| `POST /share-links/:id/photos` | `shareLinkPhotosAddRequest`. One statement: `INSERT … SELECT … ON CONFLICT (share_link_id, photo_id) DO UPDATE SET added_by='user', added_by_user_id=uid[, sensitive_released_at/by when showSensitive and the photo is sensitive]`, pre-filtered to approved, live, unquarantined photos of the link's baby (others ⇒ `skipped` with reason; the gate trigger is the backstop); deletes matching exclusions. `hidden` = sensitive photos added without `showSensitive`. Audit `share_link.photos_added {count}` (+ one `share_link.sensitive_shown {photo_id}` per released photo, capped at 20 rows, then `count`). Works on free babies (FR-5.8: sharing is free) |
| `POST /share-links/:id/photos/remove` | Deletes the rows (any `added_by`) and inserts exclusions (so rules never re-add them); audit `share_link.photos_removed {count}` |
| `PATCH /share-links/:id/photos/:photoId` | `{showSensitive}`: sets/clears `sensitive_released_at/by` (row becomes `user`); 404 when not in the album; audit `share_link.sensitive_shown|hidden {photo_id}` |
| `GET /photos/:id/share-links` | `photoShareLinksResponse` for the photo's baby (admin only) |

### 2.6 API: viewer session and viewer routes (security-engineer, `apps/api/src/sharing/viewer-session.ts`, `viewer-auth.ts`, `viewer-routes.ts`)

**`viewer-auth.ts`**: `registerViewerAuth(app, config)` adds an `onRequest` hook for URLs under
`/share/` only that sets `request.viewer: { claims, transport } | null` and `request.viewerError`
from the `ll_viewer` cookie (or `Authorization: Bearer` when `X-Tinyglow-Client: native`),
verified with `k_viewer`/iss/aud (2.2) and `viewerClaimsSchema` (`jti` required). Cookie-transport
non-GET requests need `X-Tinyglow-Client: web` (403 `csrf_rejected`, same rule as step 3).
`requireViewer` preHandler ⇒ 401 `unauthorized` "Open the link again" when absent/invalid/expired
JWT. `withViewer(request, reply, fn)`: `runAs(app.db, "viewer", { claimsJson:
claimsToSql(claims) }, …)`; first statement `SELECT … FROM public.viewer_session_check($jti)`; no
row ⇒ throw 410 `share_link_expired` and `reply.clearCookie(ll_viewer, {path})`; when the returned
`expires_at` is later than `claims.exp + 60 s`, re-mint the JWT/cookie with the new `exp` (renewed
link: open tabs keep working). Responses get `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
The step-3 user auth hook is untouched and ignored on `/share/*`.

| Method, path | Behaviour |
| --- | --- |
| `POST /share/session` | Body `shareSessionRequest`; requires `X-Tinyglow-Client`. In-memory throttle `SHARE_EXCHANGES_PER_IP_PER_HOUR` per IP ⇒ 429. One `withServiceRole(app, "share token exchange")` transaction (the **only** service_role site of this step): look up by `sha256(token)` joined to the live baby. Unknown / revoked / expired / trashed baby ⇒ **410 `share_link_expired`** (one response for all, no timing-relevant branches beyond the lookup). If the request already carries a valid viewer JWT for this link whose session is live ⇒ reuse it (no passcode prompt on reload, no new session, no view count). Else, passcode set: (a) ≥ `SHARE_PASSCODE_FAILURES_PER_LINK` failures in 60 min (after `token_rotated_at`) ⇒ 429 `passcode_locked` + `Retry-After`; (b) ≥ 5 failures for `(link, ip_hash)` in 15 min ⇒ 429 `rate_limited` + `Retry-After` — both checked **before** verifying, so a locked caller learns nothing; (c) no passcode ⇒ 401 `passcode_required` (not a failure); (d) wrong ⇒ insert a failure row (and prune that link's rows older than 24 h), 401 `passcode_invalid {attemptsLeft}`; reaching the per-link threshold writes `share_link.passcode_locked` once. Success ⇒ insert `viewer_sessions (share_link_id, expires_at = link.expires_at, ip_hash, user_agent_hash, last_seen_at = now())`, `view_count + 1, last_viewed_at = now()`; mint JWT; `Set-Cookie`; 200 `shareSessionResponse` (album read in the same transaction). Never logs the token, its hash or the passcode |
| `DELETE /share/session` | Clears the cookie; marks the session revoked through `withServiceRole("viewer sign-out")` only if the JWT verifies; 204 |
| `GET /share/album` | `requireViewer` + `withViewer`: `shareAlbum` from `viewer_session_check` + counts under `viewer` RLS |
| `GET /share/photos` | Keyset page (reuse the step-5 cursor encoding; `ORDER BY p.sort_at DESC, p.id DESC`) of `shared_photos ⋈ photos ⋈ photo_details ⋈ milestones` under `viewer` RLS; `hidden = p.is_sensitive AND NOT (added_by='user' AND sensitive_released_at IS NOT NULL)`; thumb URLs only for non-hidden rows, read from `photo_derivatives` (RLS already refuses hidden ones), signed with `ttlSec = min(SHARE_MEDIA_URL_TTL_SEC, link expiry − now)` and `cacheControl: "private, max-age=<ttl>"` |
| `POST /share/photos/urls` | `viewerUrlsRequest` ⇒ fresh `thumb` or `display` URLs (same TTL rule) for visible ids only |
| `POST /share/photos/:id/download` | 403 `forbidden` "Downloads are turned off for this album" unless `allow_download`; else the **`display` derivative** (1600 px, all metadata stripped; never the original, D9) signed for `SHARE_DOWNLOAD_URL_TTL_SEC` with `contentDisposition: attachment; filename="<baby>-<YYYY-MM-DD>.jpg"` (ASCII-safe) and `cacheControl: private`; hidden photo ⇒ 404 |
| `GET /share/manifest.webmanifest?t=<token>` | Public, no DB: validates `t` with `shareTokenSchema` and returns `application/manifest+json` `{ name: "Family album · Tinyglow", short_name: "Album", start_url: "/s/<t>", scope: "/s/", display: "standalone", background_color, theme_color, icons: [/icons/viewer-192.png, /icons/viewer-512.png (+ maskable)] }`, `Cache-Control: no-store`. Gives the installed PWA the exact link as its start URL (D11). The query string never reaches a log (`redactUrl`, nginx `$ll_log_path`) |

Logging in `sharing/**`: link ids, session ids, counts, outcomes, durations. **Never** tokens, token
hashes, passcodes, passcode hashes, IPs, IP hashes, user agents, names or tags. `req.body.token`,
`req.body.passcode` added to the pino redact list (2.9).

### 2.7 Worker: auto-share (backend-engineer, `apps/worker/src/sharing/autoshare.ts`)

```ts
export interface AutoSharerDeps { pool: PipelinePool; log: WorkerLog; now?: () => Date }
export interface AutoShareResult { links: number; photos: number; added: number; removed: number; skipped: number }
export function createAutoSharer(deps: AutoSharerDeps): {
  evaluatePhotos(photoIds: string[]): Promise<AutoShareResult>;   // reindex hook (stage 6)
  applyLink(shareLinkId: string): Promise<AutoShareResult>;        // share.apply: full sync of one link
  reconcile(): Promise<AutoShareResult>;                           // share.reconcile: watermark sync of every rule
};
```

- All SQL through `runAsPipeline(pool, {}, …)` — **never with `dataKey`**; selects no GPS column,
  no note, no people (facts need only `photos` flags, `photo_details.milestone_id`, the tagged
  milestone's `name`, `photo_ai.description`, `photo_ai_overrides`).
- Facts per photo: `analyzed = photo_ai row exists`, `isSensitive = photos.is_sensitive`,
  `hasMilestone = photo_details.milestone_id IS NOT NULL`, `tags = searchTagsFor(applyAiOverrides(
  description, overrides), milestoneName)`; decision `shareRuleMatches(rule, facts)` (shared, 2.4).
- Sync for (link with a rule, photo): eligible = approved, live, unquarantined, analysed, not
  sensitive, no exclusion. Match ⇒ `INSERT … (added_by 'rule') ON CONFLICT DO NOTHING` (a `user`
  row stays `user`). Live + analysed but no longer matching (or excluded) ⇒ `DELETE` the `rule` row.
  Trashed photos are left alone (viewers never see them; restore brings them back). A
  `check_violation` from the gate (raced sensitive flag) counts as `skipped`, never an error.
- `evaluatePhotos(ids)`: one query loads the ids' babies' rules (any link state: an expired link
  stays current so a renew shows today's album), then facts for the ids, then the sync, in one
  transaction per baby.
- `applyLink(id)`: full sync of that link's baby in pages of 500 photos; sets
  `share_rules.evaluated_at = <start time>`. No rule ⇒ no-op.
- `reconcile()`: per rule, photos whose `GREATEST(photos.updated_at, photo_ai.updated_at,
  photo_details.updated_at, max(photo_ai_overrides.updated_at), milestones.updated_at)` is newer
  than `evaluated_at − 10 min` (all photos when `evaluated_at` is NULL or older than
  `share_rules.updated_at`), then sync and advance `evaluated_at`. Catches anything the reindex
  hook missed (pg-boss exclusive drops, reconcile-driven re-indexes, restores).
- Logging: ids and counts only.

### 2.8 Worker wiring (backend-engineer)

- `apps/worker/src/reindex.ts`: `ReindexDeps` gains `autoSharer: Pick<AutoSharer,
  "evaluatePhotos">`; `handleReindexJobs` calls `autoSharer.evaluatePhotos(photoIds)` **first**,
  inside its own try/catch (a failure is logged with the error category and does not block
  indexing; the hourly reconcile repairs it), then `indexer.reindex` as today. This is PRD stage 6
  ("rules run after AI analysis": the poller's `photo.reindex {reason:"ai"}`) and "on details
  change for already-described photos" (the API's `photo.reindex {details|milestone|ai_override}`).
- `apps/worker/src/queues.ts`: queues `share.apply` (exclusive, `retryLimit 2`, `retryDelay 30`,
  `expireInSeconds 900`, singleton key `shareLinkId`) and `share.reconcile` (exclusive, `retryLimit
  0`, `expireInSeconds 3000`); `schedules(config)` adds `[JOBS.shareReconcile,
  config.SHARE_RECONCILE_CRON]`; handlers validate payloads (invalid ⇒ warn + drop);
  `sendShareApply`. `queues ready` ⇒ **`queues: 12`**.
- `apps/worker/src/config.ts`: `shareEnvSchema`. `main.ts`: create the auto-sharer, pass it to
  `startWorkers` and the reindex handler. `run-job.ts`: `share.apply '{"shareLinkId":"…",
  "reason":"manual"}'` and `share.reconcile` (direct and `--enqueue`).

### 2.9 API wiring (backend-engineer)

- `apps/api/src/config.ts`: `shareEnvSchema` (`SHARE_MEDIA_URL_TTL_SEC`).
- `apps/api/src/storage/sign.ts`: `SignGetOptions.cacheControl?: string` →
  `ResponseCacheControl`; **every** presigned GET (parents too) now carries `private,
  max-age=<ttl>` unless the caller overrides, so no shared cache (Cloudflare in front of
  `files.`) may store a signed photo response (D6). Tests in 8.10.
- `apps/api/src/plugins/jobs.ts`: `enqueueShareApply(job: ShareApplyJob): Promise<boolean>` (send
  options = the worker's `share.apply` queue options, singleton key `shareLinkId`), sent outside the
  claims transaction like `enqueueReindex`.
- `apps/api/src/app.ts`: `registerViewerAuth(app, config)` and `await registerSharing(app)` (both
  exported by `apps/api/src/sharing/index.ts`; 8.2 creates a compiling stub); pino redact
  `req.body.token`, `req.body.passcode`; `redactUrl` also redacts the `t` query value (already
  drops every query string — keep and test).
- `apps/api/src/lib/errors.ts`: map `share_link_expired` 410, `passcode_*`; DB messages: `share link
  limit reached` ⇒ 409, `auto-share rules need the paid plan` ⇒ 403 `plan_required`, `share rule
  needs at least one include tag` / `share_rules tags …` / `share_links.* …` ⇒ 400
  `validation_failed`, the gate's messages on manual adds ⇒ 409 `conflict` (the route pre-filters,
  so they only surface on a race).

### 2.10 Frontend (frontend-engineer, `apps/mobile-web/src/**`)

**Parent side (8.8)**
- `lib/features.ts`: `sharing: true`. `lib/queries/sharing.ts`: `useShareLinks(babyId)`,
  `useCreateShareLink`, `usePatchShareLink`, `useRenew`, `useRegenerate`, `useRevoke`, `useDelete`,
  `useSaveRule`/`useRemoveRule`, `useShareLinkPhotos(linkId)`, `useAddToShareLink`,
  `useRemoveFromShareLink`, `useShowSensitive`, `usePhotoShareLinks(photoId)`; all through
  `apiRequest` with the shared schemas.
- **Family tab** (`pages/FamilyPage.tsx` gets a `<ShareLinksSection>` above members, admins only;
  contributors never see it): `components/share/ShareLinkCard.tsx` per link — name, status pill
  ("Active · expires in 5 h" / "Expired" / "Revoked"), photo count, hidden count, visits and last
  visit ("Viewed 12 times · last visit 2 h ago"), passcode/download badges, "Passcode locked"
  warning; one-tap **Renew** (`share-renew`), **Regenerate** (`share-regenerate`, confirm: "The old
  link stops working for everyone"), **Revoke** (`share-revoke`, confirm), **Delete**
  (`share-delete`, confirm), **Manage photos** (route `/family/share/:linkId`), **Settings** sheet
  (name, duration choices from `SHARE_LINK_TTL_CHOICES_HOURS`, passcode set/change/clear with a
  6-digit field, allow downloads). `components/share/CreateShareLinkSheet.tsx` (`share-create`):
  name (suggestions "Grandparents", "Close friends"), duration (24 h default), optional passcode,
  allow downloads, auto-share rule (Plus only; free babies see the upsell `share-rule-upsell`).
  After create/regenerate: `components/share/ShareUrlSheet.tsx` (`share-url`) shows the URL once with
  **Copy** (`share-copy`, Clipboard API) and **Share…** (`navigator.share` when available; native
  share is step 9), and the line "For your privacy we only show this link once. To send it to
  someone new later, regenerate it (the old link stops working) or ask a family member to forward
  it." (D1). The URL is kept in memory only (never storage, never logs).
- `components/share/RuleEditor.tsx` (`share-rule-mode-<manual|all|milestones|tags>`, include/exclude
  tag chips with suggestions from `useSearchFacets` tags when Plus; normalized lower-case): copy
  "Sensitive photos (bath, diaper, nudity, medical) are never shared automatically. Photos added by
  a rule that stop matching it are removed; photos you add by hand stay."
- `pages/ShareLinkPhotosPage.tsx` (`/family/share/:linkId`): virtualized grid of the album (reuse
  `TimelineGrid` pieces / `Thumb`), "Added by rule" / "Hidden from family" badges, select mode with
  **Remove** (`share-photos-remove`), per sensitive photo a **Show to family** / **Hide** toggle
  (`share-show-sensitive`) with confirm "This photo was flagged as sensitive (bath, diaper,
  nudity or medical). Show it to everyone with this link?".
- **Add to shared album** (FR-9.3, FR-8.4): `components/share/AddToShareSheet.tsx` opened by the
  timeline batch button `batch-share` (now enabled) and the photo viewer's `viewer-share`: lists
  the baby's links with checkboxes (`share-target-<linkId>`; single photo: pre-checked from
  `usePhotoShareLinks`, unchecking removes), a "Create a new link" shortcut, and when the selection
  contains sensitive photos the notice "N photos are marked sensitive. Family will see them hidden
  unless you turn on Show sensitive photos" with the `share-show-sensitive-toggle` (default off).
  Result toast from the add response (`added`, `hidden`, `skipped`). Contributors: buttons absent.
- `App.tsx`: route `/family/share/:linkId` (admin app route).

**Viewer side (8.9)** — public, no `AuthProvider` dependency, no tab bar, no chat, no search:
- `App.tsx`: route `/s/:token` → `pages/share/SharedAlbumPage.tsx` outside every auth guard
  (`TAB_ROUTES` unchanged, so the tab bar stays hidden). `lib/shareApi.ts`: fetch wrapper for
  `/api/share/*` (credentials same-origin, `X-Tinyglow-Client: web`, shared schemas, never logs
  the token; on 401/410 mid-session it re-runs the exchange once, then shows the expired state).
- Flow: mount ⇒ `POST /api/share/session {token}` ⇒ 200 album | 401 `passcode_required` ⇒
  `components/share/PasscodeForm.tsx` (`share-passcode`, reuses `CodeEntry`, shows
  `attemptsLeft`, 429 copy "Too many tries. Try again in N minutes.") | 410 ⇒
  `components/share/ShareExpired.tsx` (`share-expired`): illustration, "This link has expired",
  "Ask the parents for a new link.", no baby name, no retry loop. Any 410 later in the session (link
  revoked while open) swaps to the same view and drops cached photos from memory.
- Album (`share-album`): header with the baby's name/nickname and the link name; virtualized
  age-grouped timeline newest first (`GroupedVirtuoso`, `ageGroupKey`/age labels from the shared
  helpers, milestone badges), 375 px first, 3/4/6 columns by breakpoint; tiles `share-thumb-<id>`;
  hidden photos render `share-hidden-<id>`: a frosted gradient tile with an eye-off icon and "Hidden
  by the parents" (no image request at all, not tappable). Tap opens `components/share/
  SharedPhotoViewer.tsx` (Swiper, pinch-zoom; display URLs fetched via `/share/photos/urls
  {kind:"display"}` for the current ±2 slides; age, date, milestone only; **Download**
  (`share-download`) only when `allowDownload`). URLs refreshed 30 s before `urlExpiresAt`. Alt text
  "Photo of <name> at <age>" (+ milestone). Dark mode, 44 px targets, `aria-live` for state changes.
- PWA (D11): the page injects `<link rel="manifest" href="/api/share/manifest.webmanifest?t=<token>">`,
  `<meta name="robots" content="noindex">` and `<meta name="referrer" content="no-referrer">`;
  `components/share/InstallPrompt.tsx` (`share-install`): Chrome/Android `beforeinstallprompt`
  ⇒ "Add this album to your home screen" button; iOS Safari ⇒ instruction sheet (Share → Add to Home
  Screen); dismissible, remembered in `localStorage` (a boolean flag only, never the token).
- Icons: `apps/mobile-web/public/icons/viewer-192.png`, `viewer-512.png`,
  `viewer-maskable-512.png` (simple brand mark; path outside the ownership table, see D14).
- i18n keys `share.*`, `shareViewer.*`.

### 2.11 Env, compose, nginx, docs, CI (devops-engineer)

| Item | Change |
| --- | --- |
| `.env.dev` | `SHARE_MEDIA_URL_TTL_SEC=300`, `SHARE_RECONCILE_CRON=41 * * * *` with one-line comments |
| `.env.example`, `docker-compose.yml` `x-app-env` | same, passed to `api` (TTL) and `worker` (cron) with `${VAR:-default}`; nothing else new (no new secret: viewer/IP keys derive from `JWT_SECRET`) |
| `docker-compose.dev.yml` | api gets `SHARE_MEDIA_URL_TTL_SEC: ${SHARE_MEDIA_URL_TTL_SEC:-300}` as a Compose interpolation so the gate can recreate the api with 30 s (like `VISION_PROVIDER`) |
| `docker/nginx/default.conf` | `location ^~ /s/ { expires -1; add_header Referrer-Policy "no-referrer" always; add_header X-Robots-Tag "noindex, nofollow" always; <repeat the four server-level security headers>; try_files /index.html =404; }` (the access-log token mask already covers `/s/<token>`; add a comment); `location ^~ /api/share/` nested like the chat block is **not** needed (normal buffering) — but ensure `/api/share/manifest.webmanifest` keeps `Content-Type` from the api |
| Vite | nothing (SPA fallback serves `/s/*`; `/api/share` goes through the `/api` proxy) — verify in 8.9 |
| `docker/cloudflared/config.example.yml` | comment block: on the Cloudflare dashboard add a Cache Rule "Bypass cache" for `files.tinyglow.app` (belt and braces; responses already say `private`); production action for the user (D6) |
| Root `package.json` | `"e2e:share-gate": "tsx e2e/sharing/gate.ts"` |
| CI (8.12) | integration suite names for step 8 in `check-integration-report.mjs`; dev-stack job runs `pnpm e2e:share-gate` after the search gate (15-min timeout, upload `e2e/share-gate/` on failure); hygiene step: `grep -rn "withServiceRole" apps/api/src/sharing` ⇒ exactly 2 call sites (exchange, viewer sign-out); `grep -rnE "gps_lat_enc\|gps_lng_enc\|decrypt_coord\|dataKey" apps/worker/src/sharing` ⇒ empty; the "no token/passcode in logs" proof is the sentinel integration test (8.10) plus the gate's log scan |

### 2.12 Tests and gate (test-engineer; `**/*.test.ts`, `e2e/**`, test helpers)

- **Unit, shared**: `share-rules.test.ts` (matrix: analysed × sensitive × mode × include/exclude;
  normalization; AI milestones never count), `api/share-links.test.ts`, `api/share-viewer.test.ts`
  (viewer photo schema has no `babyId`/`caption`/`isSensitive`/`displayUrl`; token/passcode
  shapes), `search-document.test.ts` (`searchTagsFor` = `buildSearchDocument().tags`), jobs, env,
  audit metadata keys, errors enum.
- **Unit, api**: `sharing/crypto.test.ts` (token 22 chars/128 bits, sha256 hash, scrypt format and
  verify, timing-safe compare, HKDF keys differ, viewer JWT rejects GoTrue tokens and vice versa,
  `exp` = link expiry), `sharing/viewer-auth.test.ts` (cookie vs bearer, CSRF, expired JWT),
  `storage/sign.test.ts` (`response-cache-control=private` in every signed GET), `lib/errors` mapping.
- **Unit, worker**: `sharing/autoshare.test.ts` with stubs (sensitive/unanalysed never inserted;
  removal sync; exclusions; user rows untouched; gate `check_violation` ⇒ skipped),
  `reindex.test.ts` (auto-share runs first, its failure does not block indexing), queues (12),
  run-job.
- **Integration, db** (`packages/db/sharing.integration.test.ts`): migration count 15, every table
  FORCE RLS, types diff clean, down/up round trip; `shared_photos_gate`: rule insert of a sensitive,
  an unanalysed, an excluded, a quarantined, a pending and a trashed photo all refused (also as
  `pipeline`), user insert of a sensitive photo allowed; **race**: two connections — pipeline
  inserts a rule row while another flags the photo sensitive, both orders ⇒ no rule row of a
  sensitive photo survives (`FOR SHARE`); `photos_sensitive_unshare_rules` still removes rule rows
  and keeps user rows; viewer RLS matrix: hidden photo's derivatives invisible (`viewer_can_see_media`),
  released one visible, rule+sensitive invisible entirely, other link's photos invisible, expired /
  revoked link ⇒ 0 rows everywhere, `shared_photos.added_by_user_id` not selectable by viewer;
  `share_links_end_sessions` on regenerate / passcode change / revoke; `viewer_session_check`
  (live, revoked session, other link's jti, expired link, visit counting with 30-min gap, expiry
  extension after renew); `share_rules_shape` (free baby refused, tags mode without include tags
  refused, delete allowed after downgrade); `share_links_shape` (expiry > 30 days refused, bad
  passcode format refused); cap 20; exclusions RLS (contributor cannot insert, stranger 0 rows);
  `share_passcode_failures` unreachable below service_role; `share_link_passcode_locked`.
- **Integration, api** (`apps/api/src/sharing/admin.integration.test.ts`,
  `viewer.integration.test.ts`): CRUD as admin, 403 for the nanny, 404 for a stranger; create
  returns the URL and default expiry ≈ now + 24 h; renew keeps token, regenerate changes it (old ⇒
  410, old cookie ⇒ 410, new ⇒ 200); revoke ⇒ exchange 410 and live cookie 410 on next request;
  rule on free baby 403 `plan_required`; add/remove/show sensitive; exchange: cookie attributes
  (HttpOnly, SameSite=Lax, Path=/api/share, Secure under production config), JSON body never
  carries the token back, reuse of a live cookie skips the passcode; passcode: required, invalid
  with `attemptsLeft` 4..0, 6th from the same IP ⇒ 429 even with the right code, 20 failures across
  4 IPs (`CF-Connecting-IP`) ⇒ `passcode_locked` for a fifth IP with the right code, regenerate
  clears the lock; viewer routes: newest-first paging, hidden tile has no URL, `/share/photos/urls`
  omits non-shared and hidden ids, download 403 when off and returns a `display` key (never the
  original) with attachment disposition when on, signed URL TTL ≤ `SHARE_MEDIA_URL_TTL_SEC` and ≤
  link expiry; viewer cookie on `/api/babies/:id/chat/messages`, `/api/babies/:id/photos`,
  `/api/photos/:id/original` ⇒ 401 (cookie path) and a forged bearer viewer JWT there ⇒ 401;
  manifest endpoint echoes `start_url` only for valid token shapes; a sentinel token and passcode
  never appear in the captured API log; audit rows for created/renewed/regenerated/revoked/rule/
  photos with the strict metadata.
- **Integration, worker** (`apps/worker/src/sharing/autoshare.integration.test.ts`, real DB):
  paid baby with fake-described photos (incl. a sensitive one) and rules `all`, `milestones`,
  `tags` + exclude ⇒ exact expected rows, the sensitive photo in none; details edit adding a
  milestone ⇒ `evaluatePhotos` adds it to the milestones link; adding an exclude tag ⇒ `applyLink`
  removes the rule rows, keeps user rows; removed (excluded) photo never re-added; later sensitive
  flag removes rule rows; free baby's photos never added; `reconcile` watermark.
- **e2e (Playwright)** `e2e/sharing/share.spec.ts`: mom creates a link in the Family tab, copies
  the URL from `share-url`; a fresh browser context (no parent cookies) opens it at 375 px, sees
  `share-album` with thumbs and the hidden tile, opens a photo, no download button; mom revokes ⇒
  the open viewer swaps to `share-expired` on the next action and a reload shows `share-expired`;
  passcode link ⇒ `share-passcode` then album; the nanny sees no share section; timeline multi-select
  → `batch-share` → add to link → toast; demo token smoke (`/s/demo-grandparents-share-token`).
- **Gate** `e2e/sharing/gate.ts` (`pnpm e2e:share-gate [--keep]`), modelled on `e2e/ai/gate.ts`:
  1. Recreate `worker` with `VISION_PROVIDER=fake AI_BATCH_FLUSH_MINUTES=0` and `api` with
     `SHARE_MEDIA_URL_TTL_SEC=30` (both restored in a `finally` to the stack default).
  2. Fresh admin (OTP via Mailpit), baby "Share Gate" set to plus (`migrate pnpm db:plan`), a
     second free baby "Share Free".
  3. Links on the paid baby: `L-all` (rule all), `L-ms` (rule milestones), `L-tags` (rule tags
     include `outdoor`, exclude `bath`), `L-manual` (no rule, passcode `482913`), `L-dl` (manual,
     allow downloads).
  4. Upload synthetic JPEGs (half with EXIF GPS, via `jpegWithExif`) in rounds of 16 until ≥ 3
     photo ids start with `0` (the fake provider flags those as `bath`) and ≥ 32 photos (cap 160);
     batch details tag 4 of them with a milestone; force `ai.flush`/`ai.poll` until all `ready`;
     drain `photo.reindex`; then `run-job share.reconcile`.
  5. Assert **sensitive never auto-shares**: `select count(*) from shared_photos sp join photos p on
     p.id = sp.photo_id where sp.added_by = 'rule' and p.is_sensitive` = 0; every non-sensitive
     analysed photo is in `L-all`; exactly the milestone photos in `L-ms`; `L-tags` = photos whose
     tags include `outdoor` minus `bath` (recomputed with the shared matcher); the viewer of `L-all`
     sees no sensitive id through the API; free baby: rule ⇒ 403 `plan_required`, manual add works,
     no `photo_ai` rows.
  6. Manual sensitive: add one sensitive photo to `L-manual` without `showSensitive` ⇒ viewer gets
     `hidden: true, thumbUrl: null`, `/share/photos/urls` omits it; `PATCH showSensitive` ⇒ visible.
  7. Every viewer-served `thumb`/`display` and the `L-dl` download: no EXIF GPS/camera tags
     (exifr), bytes ≠ the original's SHA-256, `Cache-Control` contains `private`; `L-all` download
     ⇒ 403.
  8. **Expired**: `UPDATE share_links SET expires_at = now() - interval '1 minute'` on `L-ms`
     (simulates the 24 h passing; superuser psql) ⇒ exchange 410 `share_link_expired`, the open
     viewer cookie ⇒ 410; renew ⇒ same token 200 again. Default expiry of a fresh link = now + 24 h
     (± 2 min).
  9. **Revoked**: revoke `L-dl` ⇒ exchange 410, open cookie ⇒ 410, a media URL issued before the
     revoke ⇒ MinIO 403 after 35 s; renew ⇒ 409.
  10. **Regenerated**: regenerate `L-manual` ⇒ old token 410, old cookie 410, new token ⇒
      `passcode_required`.
  11. **Passcode lockout**: 5 wrong ⇒ 6th (right code, same IP) 429 `rate_limited`; 20 wrong across
      4 IPs ⇒ right code from a new IP 429 `passcode_locked`; regenerate clears it.
  12. Scope: the viewer cookie never reaches `/api/babies/*` (401), viewer API never returns a
      non-shared photo id, `babyId`, caption or GPS key; `/s/<token>` HTML response carries
      `Referrer-Policy: no-referrer` (through the Vite dev server: checked against nginx in the
      prod-image smoke only, see 4.4).
  13. Logs: no plaintext token, passcode, `X-Amz-Signature` or GPS in `api`/`worker` logs.
  Prints a table, writes `e2e/share-gate/results.json`, exits 1 on any miss, trashes both babies
  unless `--keep`.
- **Smoke** (`e2e/smoke/dev-stack.sh`): `pgmigrations` 15, worker log `queues: 12`, `POST
  /api/share/session` with the demo token ⇒ 200 + `ll_viewer` cookie, `GET /api/share/album` ⇒
  `photoCount` 4, `hiddenCount` 1; unknown token ⇒ 410.
- **Perf (dev machine, not CI)**: share every photo of the perf baby "Pixel" (10,000, real
  derivatives) to a scratch link by SQL, then 200 runs of `GET /api/share/photos` first and deep
  pages as that viewer ⇒ p95 < 300 ms (R4).

## 3. Tasks

Owners per `CLAUDE.md`. Lanes: D = devops, S = security, B = backend, F = frontend, T = test.
Same-lane tasks run in sequence. mobile-engineer and ai-engineer have no step-8 work (native deep
links for `/s` are step 9; no model calls here).

### 8.1 Env, compose, nginx, cloudflared note, scripts (devops-engineer) — group 0

- Owned: `.env.dev`, `.env.example`, `docker-compose.dev.yml`, `docker-compose.yml`,
  `docker/nginx/default.conf`, `docker/cloudflared/config.example.yml`, root `package.json` scripts.
- Build 2.11 except CI. Explicit: no new secret or env beyond the two settings; `/s/` location keeps
  every server-level security header (add_header inheritance) and adds `no-referrer` + noindex;
  a fresh clone still starts with no env files.
- Done-when: both `docker compose … config -q` pass; `curl -sI localhost:8080/s/abc` through the
  prod web image (`docker build --target prod` + run) shows `Referrer-Policy: no-referrer` and
  `X-Content-Type-Options`; `SHARE_MEDIA_URL_TTL_SEC=30 docker compose -f docker-compose.dev.yml up
  -d --no-deps api` passes the value through (`docker compose exec api printenv`).

### 8.2 Shared contracts + sharing module stub (security-engineer, with orchestrator approval) — group 0

- Owned: `packages/shared/src/{share-rules.ts, api/share-links.ts, api/share-viewer.ts}` (new);
  edits to `constants.ts`, `auth.ts`, `db-enums.ts`, `jobs.ts`, `env.ts`, `api/errors.ts`,
  `search-document.ts` (export `searchTagsFor` only), `jwt-claims.ts` (comment), `index.ts`;
  `apps/api/src/sharing/index.ts` (stub `registerSharing(app)` and `registerViewerAuth(app,
  config)` no-ops so 8.4 compiles).
- Build 2.4 literally; browser-safe (no `node:*`).
- Done-when: `pnpm typecheck` green; existing shared tests green (search document output
  unchanged); `shareRuleMatches` returns false for every `isSensitive: true` or `analyzed: false`
  input.

### 8.3 Migration, helpers, seed, README, types (security-engineer) — group 1 (after 8.2)

- Owned: `packages/db/migrations/1792100000100_sharing-v1.sql`, `packages/db/src/seed.ts`,
  `packages/db/src/generated/**`, `packages/db/README.md`.
- Build 2.3. Enforce and state in SQL comments: ENABLE + FORCE RLS on both new tables; `viewer`
  gains only `viewer_session_check`/`viewer_can_see_media` EXECUTE and loses column access to
  `shared_photos.added_by_user_id`; `pipeline` gains only DELETE of `rule` rows, SELECT on
  exclusions and UPDATE `share_rules.evaluated_at`; the gate locks the photo row `FOR SHARE`; the
  down migration restores the step-2 gate, the step-2 derivative policy, the step-2 shared_photos
  grants/policies and the step-5 `share_links_shape` verbatim.
- Measure (R4): as `viewer` on the perf baby with 10,000 shared photos, first page of the 2.6 list
  query; if p95 > 150 ms, rewrite the viewer `shared_photos`/`photos` SELECT policies on a
  set-returning `viewer_photo_ids()` ARRAY helper (step-7 pattern) in this same migration, with the
  matrix test proving identical visibility. Report the numbers either way.
- Done-when: `pnpm db:migrate` applies 15, second run no-op, `db:migrate:down 1 && db:migrate`
  round-trips, applies on the bare stub; `pnpm db:types` committed with no diff; every-table-forced
  query returns 0; viewer spot check (README) shows 4 shared rows for the demo link, 3 with
  derivatives readable and 0 for the bath photo; README updated.

### 8.4 API wiring: config, signer cache-control, job sender, errors, registration (backend-engineer) — group 1 (after 8.2; parallel with 8.3)

- Owned: `apps/api/src/config.ts`, `apps/api/src/storage/sign.ts`, `apps/api/src/plugins/jobs.ts`,
  `apps/api/src/lib/errors.ts`, `apps/api/src/app.ts`.
- Build 2.9. Explicit: `private, max-age=<ttl>` on every presigned GET; `req.body.token` and
  `req.body.passcode` redacted; the share-apply send never carries anything but the link id and
  reason.
- Done-when: typecheck/tests green; a signed URL from `GET /api/babies/<maya>/photos` contains
  `response-cache-control=private`; `curl -s -X POST localhost:8080/api/share/session` hits the stub
  (404 until 8.7).

### 8.5 Worker auto-share, queues, reindex hook, run-job (backend-engineer) — group 2 (after 8.3)

- Owned: `apps/worker/src/sharing/**` (new), `apps/worker/src/{reindex,queues,main,run-job,config}.ts`.
- Build 2.7 + 2.8. Explicit: `runAsPipeline(pool, {}, …)` only, never a data key; no GPS, note or
  people column selected (extend the step-6 hygiene grep to `apps/worker/src/sharing`); sensitive
  and unanalysed photos never inserted (and the DB refuses anyway); auto-share runs before indexing
  and cannot fail the reindex batch; no model call.
- Done-when: `queues: 12` in the boot log; on the fake dev stack `pnpm --filter @tinyglow/worker
  run-job share.reconcile` exits 0 and adds no rule row for Maya's bath photo; 8.10's worker tests
  green.

### 8.6 API admin share-link routes (security-engineer) — group 2 (after 8.3, 8.4)

- Owned: `apps/api/src/sharing/{index,admin-routes,queries,crypto}.ts`.
- Build 2.2 (crypto) + 2.5. Explicit: authenticated role only (no service_role); every input
  through the shared zod schemas; token returned only by create/regenerate; passcode hashed with
  scrypt before the transaction; contributors 403, strangers 404, free-baby rules 403
  `plan_required`; audit rows with strict metadata; `enqueueShareApply` after commit; no token,
  hash or passcode in any log line or error.
- Done-when: walkthrough 4.3 steps 1–6 pass on the dev stack; typecheck green.

### 8.7 API viewer session, viewer auth, viewer routes, manifest (security-engineer) — group 3 (after 8.6)

- Owned: `apps/api/src/sharing/{viewer-auth,viewer-session,viewer-routes}.ts` (+ `index.ts`
  registration).
- Build 2.6. Explicit: the exchange is the only service_role transaction (plus viewer sign-out);
  every viewer query runs as `viewer` after `viewer_session_check`; 410 for every dead-link case
  with the same body; passcode limits checked before verification; cookie name/path/flags exactly
  as 2.2; media URLs thumb/display only, TTL ≤ `SHARE_MEDIA_URL_TTL_SEC` and ≤ link expiry,
  `private` cache control; downloads are the display derivative; no chat or parent route accepts a
  viewer credential.
- Done-when: walkthrough 4.3 steps 7–14 pass; typecheck green.

### 8.8 Frontend parent UI: share links, rules, manage album, add-to-album sheet (frontend-engineer) — group 1/2 (after 8.2; integrates with 8.6)

- Owned: `apps/mobile-web/src/components/share/{ShareLinksSection,ShareLinkCard,CreateShareLinkSheet,ShareUrlSheet,RuleEditor,AddToShareSheet}.tsx`,
  `src/pages/ShareLinkPhotosPage.tsx`, `src/pages/FamilyPage.tsx`, `src/pages/TimelinePage.tsx`
  (enable `batch-share`), `src/components/viewer/PhotoViewer.tsx` (enable `viewer-share`),
  `src/lib/queries/sharing.ts`, `src/lib/features.ts`, `src/App.tsx` (admin route), `src/i18n/en.ts`.
- Build 2.10 "Parent side" with the listed `data-testid`s. Explicit: admins only (contributors see
  no share UI); the URL lives in memory only; sensitive photos are added hidden unless the toggle
  is on; confirm sheets for regenerate/revoke/delete/show sensitive; text rendering only.
- Done-when: on the dev stack as mom: create link → URL sheet → copy; renew/regenerate/revoke update
  the card; rule editor saves on Maya (Plus) and shows the upsell on a free baby; timeline
  multi-select adds to a link with a toast; viewer share sheet toggles membership; nanny sees none
  of it; `pnpm --filter @tinyglow/mobile-web typecheck && test` green.

### 8.9 Frontend viewer UI: `/s/:token`, passcode, expired page, album, PWA (frontend-engineer) — group 3 (after 8.8; integrates with 8.7)

- Owned: `apps/mobile-web/src/pages/share/**`, `src/components/share/{PasscodeForm,ShareExpired,SharedAlbumGrid,SharedPhotoViewer,InstallPrompt}.tsx`,
  `src/lib/shareApi.ts`, `src/App.tsx` (public route), `src/i18n/en.ts`,
  `apps/mobile-web/public/icons/**` (D14, orchestrator approval).
- Build 2.10 "Viewer side". Explicit: no request to any parent endpoint and no `AuthProvider`
  query from this page; the token never goes to storage, logs or analytics; hidden tiles request no
  image; works in mobile Safari and Chrome at 375 px; no chat/search entry points.
- Done-when: `/s/demo-grandparents-share-token` on the dev stack shows the album with one hidden
  tile at 375 px; a garbage token shows `share-expired`; a passcode link prompts and then shows the
  album; Chrome devtools "Application → Manifest" shows the manifest with `start_url
  /s/<token>` and no installability errors other than the documented service-worker note (R6);
  typecheck/test green.

### 8.10 Unit and integration tests (test-engineer) — group 4 (after 8.3–8.7)

- Owned: `**/*.test.ts`, `packages/db/test/{harness,fixtures}.ts`, `apps/api/src/testing/*`,
  `apps/worker/src/testing/*`.
- Build the unit and integration rows of 2.12 (incl. the `FOR SHARE` race test with two clients).
- Done-when: `pnpm test` and `pnpm test:integration` green on the dev stack and on bare pgvector +
  MinIO, none skipped.

### 8.11 e2e spec, share gate, smoke (test-engineer) — group 5 (after 8.5–8.10)

- Owned: `e2e/sharing/**`, `e2e/helpers/**`, `e2e/smoke/dev-stack.sh`.
- Build the e2e/gate/smoke rows of 2.12. The gate restores the stack in `finally`, writes
  `results.json`, exits non-zero on any miss.
- Done-when: `pnpm e2e:share-gate` passes twice in a row; `CI=1 pnpm e2e` green; `pnpm smoke` green.

### 8.12 CI (devops-engineer) — group 6 (after 8.11)

- Owned: `.github/workflows/ci.yml`, `.github/scripts/**`.
- Build the CI rows of 2.11; `actionlint` clean.
- Done-when: every job's commands pass locally in order.

### Parallelism summary

| Group | Tasks | Notes |
| --- | --- | --- |
| 0 (parallel) | 8.1 (D) · 8.2 (S) | 8.2 blocks everything else |
| 1 (parallel) | 8.3 (S, db) · 8.4 (B, api wiring) · 8.8 (F, parent UI) | disjoint paths; 8.8 codes against 2.4 and integrates when 8.6 lands |
| 2 (parallel) | 8.5 (B, worker) · 8.6 (S, api admin) | 8.6 after 8.3 + 8.4; 8.5 after 8.3 |
| 3 (parallel) | 8.7 (S, viewer api) · 8.9 (F, viewer UI) | 8.9 after 8.8 (same owner, shared `App.tsx`/`en.ts`) |
| 4 (serial) | 8.10 (T) | |
| 5 (serial) | 8.11 (T) | |
| 6 (serial) | 8.12 (D) | |
| Gate | orchestrator | section 4 |

Seams for step 9: native deep link `/s/{token}` (AASA/assetlinks paths, `@capacitor/app` URL
open ⇒ the same `SharedAlbumPage`), `@capacitor/share` for the URL sheet, the viewer bearer
transport (`X-Tinyglow-Client: native`), push "Grandma viewed the album" (the visit counter in
`viewer_session_check` is the hook), full service worker/offline for the viewer PWA.

## 4. Acceptance checks

Verbatim, PRD step 8: "Check: expired or revoked link returns the expired page; sensitive photos
never auto-share." Run from the repo root with Docker Desktop running and `pnpm` 12.10.1 on PATH.
The project's git-ignored `.env` pins `VISION_PROVIDER=fake`; nothing here needs a key or spends.

### 4.1 The PRD check end to end (always run, also in CI)

```sh
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d --build --wait
pnpm install --frozen-lockfile
docker compose -f docker-compose.dev.yml logs worker | grep 'queues: 12'
pnpm e2e:share-gate
# expected table (all PASS): uploads >= 32 with >= 3 fake-sensitive; rule rows of sensitive photos = 0;
#   L-all = every non-sensitive analysed photo; L-ms = milestone photos; L-tags = matcher result;
#   free baby rule -> 403 plan_required; hidden tile has no URL until "show"; viewer media: 0 GPS/EXIF,
#   Cache-Control private; expired link -> 410 share_link_expired (exchange and open session), renew -> 200;
#   revoked -> 410, old media URL -> 403 after 35 s; regenerated -> old 410 / new passcode_required;
#   passcode: 6th try 429, link lock after 20 -> 429 passcode_locked; viewer cookie on parent routes -> 401;
#   no token/passcode/signature/GPS in logs
CI=1 pnpm e2e -- e2e/sharing/share.spec.ts
# "expired page": the viewer context shows data-testid=share-expired after revoke and on reload,
#   and for an unknown token
```

### 4.2 Database proof of "sensitive photos never auto-share"

```sh
PSQL="docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d tinyglow -Atc"
$PSQL "select count(*) from pgmigrations"                                             # 15
$PSQL "select count(*) from shared_photos sp join photos p on p.id=sp.photo_id where sp.added_by='rule' and p.is_sensitive"   # 0
$PSQL "select count(*) from shared_photos sp where sp.added_by='rule' and not exists (select 1 from photo_ai a where a.photo_id=sp.photo_id)"   # 0
# the gate itself refuses a rule share of the seeded bath photo, even for the superuser:
$PSQL "insert into shared_photos (share_link_id, photo_id, added_by) values ('00000000-0000-4000-8000-000000000200','00000000-0000-4000-8000-000000000304','rule')"
#   ERROR: sensitive photos are never auto-shared
$PSQL "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname<>'pgmigrations' and not (c.relrowsecurity and c.relforcerowsecurity)"   # 0
```

### 4.3 API walkthrough (`B=http://localhost:8080`, `H='x-tinyglow-client: web'`, `MAYA=00000000-0000-4000-8000-000000000100`, `a.jar` = demo mom, `n.jar` = nanny, `v.jar` = a fresh viewer jar)

1. `curl -s -b a.jar "$B/api/babies/$MAYA/share-links" | jq '.links[0] | .name, .status, .photoCount, .hiddenCount'` → `"Grandparents"`, `"active"`, 4, 1; as the nanny → 403 `forbidden`.
2. `curl -s -b a.jar -H "$H" -H 'content-type: application/json' -X POST $B/api/babies/$MAYA/share-links -d '{"name":"Gate","passcode":"482913"}' | tee /tmp/l.json | jq -r '.url, .link.expiresAt, .link.hasPasscode'` → `http://localhost:8080/s/<22 chars>`, ≈ now + 24 h, `true`.
3. `L=$(jq -r .link.id /tmp/l.json); T=$(jq -r .url /tmp/l.json | sed 's#.*/s/##')`; `psql -c "select encode(token_hash,'hex') = encode(sha256('$T'::bytea),'hex') from share_links where id='$L'"` → `t`; `grep -c "$T"` over `docker compose logs api` → 0.
4. `curl -s -b a.jar -H "$H" -X PUT $B/api/share-links/$L/rule -H 'content-type: application/json' -d '{"mode":"all"}'` → rule; a free baby's link → 403 `plan_required`.
5. `curl -s -b a.jar -H "$H" -X POST $B/api/share-links/$L/photos -H 'content-type: application/json' -d '{"photoIds":["…304","…303"]}' | jq` → `added 2, hidden 1`.
6. `curl -s -b a.jar -H "$H" -X POST $B/api/share-links/$L/renew | jq .status` → `"active"`; `…/regenerate | jq -r .url` → a different token.
7. `curl -s -c v.jar -H "$H" -H 'content-type: application/json' -X POST $B/api/share/session -d '{"token":"demo-grandparents-share-token"}' -D - -o /dev/null | grep -i '^set-cookie: ll_viewer=' | grep -i 'httponly' | grep -i 'path=/api/share' | grep -i 'samesite=lax'` → one line (attribute order does not matter).
8. `curl -s -b v.jar $B/api/share/photos | jq '[.photos[] | select(.hidden)] | length, (.photos[0] | keys)'` → 1; keys without `babyId`, `caption`, `isSensitive`, `displayUrl`.
9. `curl -s -b v.jar $B/api/share/photos | jq -r '.photos[] | select(.hidden|not) | .thumbUrl' | head -1 | grep -o 'X-Amz-Expires=[0-9]*\|response-cache-control=[^&]*'` → `X-Amz-Expires=300`, `response-cache-control=private…`.
10. `curl -s -b v.jar -H "$H" -X POST $B/api/share/photos/…302/download -o /dev/null -w '%{http_code}'` → 403 (downloads off on the demo link).
11. `curl -s -b v.jar $B/api/babies/$MAYA/photos -o /dev/null -w '%{http_code}'` → 401; `curl -s -b v.jar -H "$H" -X POST $B/api/babies/$MAYA/chat/messages -o /dev/null -w '%{http_code}'` → 401.
12. Revoke the demo link as mom (`POST /api/share-links/…200/revoke`) → `curl -s -b v.jar $B/api/share/album | jq .error` → `"share_link_expired"`; new exchange with the demo token → 410; `docker compose run --rm migrate pnpm db:seed` restores it.
13. Passcode: with the "Gate" link's new token, five `{"token":…,"passcode":"000000"}` → `passcode_invalid` with `attemptsLeft` 4…0; sixth with `482913` → 429 `rate_limited` + `Retry-After`.
14. `curl -s "$B/api/share/manifest.webmanifest?t=$T" | jq -r .start_url` → `/s/<T>`; `?t=bad!` → 400.

### 4.4 Production-image checks (nginx)

```sh
docker build -f apps/mobile-web/Dockerfile --target prod -t ll-web-prod .
docker run --rm -d --name ll-web-prod -p 127.0.0.1:18080:80 ll-web-prod
curl -sI http://127.0.0.1:18080/s/abcdefghijklmnopqrstuv | grep -Ei 'referrer-policy: no-referrer|x-robots-tag: noindex|x-content-type-options'   # 3 lines
docker logs ll-web-prod 2>&1 | grep -c abcdefghijklmnopqrstuv   # 0 (logged as /s/:token)
docker stop ll-web-prod
```

### 4.5 Suites and hygiene

```sh
pnpm lint && pnpm typecheck && pnpm test
DATABASE_URL=postgres://postgres:dev@localhost:5432/tinyglow AUTH_DB_PASSWORD=dev API_DB_PASSWORD=dev \
WORKER_DB_PASSWORD=dev DATA_ENCRYPTION_KEY=dev-only-data-encryption-key-32-chars-min SEED_DEMO_FAMILY=true \
JWT_SECRET=dev-only-jwt-secret-at-least-32-characters PUBLIC_URL=http://localhost:8080 \
MAIL_FROM=noreply@tinyglow.local SMTP_HOST=localhost \
S3_ENDPOINT=http://localhost:9000 S3_PUBLIC_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=dev S3_SECRET_KEY=devdevdev \
S3_BUCKET=tinyglow-test VISION_PROVIDER=fake pnpm test:integration
pnpm smoke && CI=1 pnpm e2e
grep -rn "withServiceRole" apps/api/src/sharing | wc -l        # 2 (token exchange, viewer sign-out)
grep -rnE "gps_lat_enc|gps_lng_enc|decrypt_coord|dataKey|\.note\b|\.people\b" apps/worker/src/sharing ; echo "exit $?"   # exit 1
git diff --exit-code -- packages/db/src/generated
docker compose -f docker-compose.dev.yml logs api worker | grep -Ei 'demo-grandparents-share-token|"passcode"|X-Amz-Signature|latitude' ; echo "no tokens/passcodes/signatures in logs: exit $?"   # exit 1
```

### 4.6 Optional perf (dev machine)

As in 2.12 "Perf": share the 10,000 perf-baby photos to a scratch link, 200 runs of the first and
a deep `GET /api/share/photos` page as its viewer ⇒ p95 < 300 ms; remove the link afterwards.

## 5. Risks and decisions (orchestrator to confirm or override)

- **D1 — The share URL is shown once (create/regenerate) and never stored in plaintext.** The PRD
  says the token is "stored hashed"; storing an encrypted copy would let admins re-copy the link
  later but means a DB + key leak exposes live album links. UX cost: to send the link to someone
  new later, the admin regenerates (old link dies) or asks family to forward it; "Renew" keeps the
  same link working, which covers the 24 h-expiry case. **Needs the user's confirmation**;
  alternative: `share_links.token_enc` with `encrypt_coord`-style pgcrypto under
  `DATA_ENCRYPTION_KEY` and a "Copy link" button.
- **D2 — Expiry choices 24 h (default) / 3 days / 7 days / 30 days; max 30 days in the DB.** The
  PRD fixes the default, not a maximum. `ttl_hours` is remembered per link so "Renew" re-applies
  the admin's choice in one tap. Override: lower the max (e.g. 7 days) by changing one constant +
  the shape trigger.
- **D3 — Auto-share rules are a Plus feature and only ever share AI-analysed photos.** Rules "run
  after AI analysis" (FR-9.4) and the sensitive gate (FR-9.5) depends on AI flags; free-tier photos
  are never analysed (FR-5.8), so a free-tier "share everything" rule would publish unscreened bath
  photos. Free babies keep manual sharing (FR-5.8 "sharing" is free). DB-enforced in
  `share_rules_shape` and `shared_photos_gate`. Photos whose AI run failed are never auto-shared
  (manual only).
- **D4 — "Blurred until an admin explicitly shares them" = hidden tile per link until "Show to
  family".** A hand-added sensitive photo (or a hand-added photo that is flagged later) is listed to
  viewers as a frosted placeholder with no image URL; the admin releases it per link
  (`sensitive_released_at`). The viewer role cannot read its derivative keys (DB). Rule-added
  sensitive photos are never visible at all (step-2 rule kept). Alternative rejected: client-side CSS
  blur of a real thumbnail (the image would still be downloadable). A server-rendered blurred
  derivative is a possible P2 polish.
- **D5 — Rules sync, not append.** Saving or changing a rule applies to all existing analysed
  photos (not only new ones), adds matches and removes `rule` rows that no longer match; hand-added
  rows are never touched; removing a photo by hand records an exclusion so rules never re-add it;
  deleting the rule keeps what it added. UI copy states this. Override: "new photos only" would need
  an `applies_from` column.
- **D6 — FR-9.7 "purges CDN cache" without a CDN cache.** This stack serves media from MinIO through
  Cloudflare Tunnel. Revocation is immediate for every API call (session checked per request);
  already-issued viewer media URLs live ≤ `SHARE_MEDIA_URL_TTL_SEC` (300 s, also capped at the
  link's expiry; parents keep 1 h); every presigned GET carries `response-cache-control: private,
  max-age=<ttl>`, so Cloudflare (or any shared cache) never stores a photo and there is nothing to
  purge. Production action for the user: a Cloudflare Cache Rule "Bypass cache" on
  `files.tinyglow.app` (documented in `docker/cloudflared/config.example.yml`). A
  proxying media endpoint (instant revocation of bytes) was rejected: the PRD keeps photo bytes off
  the API server.
- **D7 — scrypt (node:crypto) instead of argon2id for passcodes.** No new native dependency; a
  6-digit space is protected by the rate limits, not by hash cost; the step-2 column comment is
  corrected. Override: add `argon2` (new dependency, needs approval).
- **D8 — Passcode limits are persistent and two-level.** PRD: 5 attempts / 15 min per IP + token
  (kept). Added: 20 failures / hour per link locks the passcode for that link (a 6-digit code falls
  to a botnet in a day otherwise); regenerate clears it; the admin card shows the lock. Stored in
  `share_passcode_failures` (survives restarts and replicas) unlike the in-memory step-3 throttles;
  the exchange-per-IP throttle (120/h) stays in memory like step 3.
- **D9 — Viewer downloads are the 1600 px `display` derivative, never the original.** Originals
  carry GPS and device EXIF (FR-4.4 says viewers get stripped derivatives only), and the viewer role
  cannot read `storage_key_original`. Override: a stripped full-resolution derivative would need a
  new derivative kind and worker change.
- **D10 — Viewers see age, date and milestone, not AI captions or parent notes.** Minimal data to
  family; captions could echo AI-detected content of a photo (or a parent's override). Alt text is
  "Photo of <name> at <age>" (WCAG still met). Override: expose the override-merged caption (needs
  a viewer grant path to `photo_ai`/overrides; not recommended).
- **D11 — PWA: per-link manifest from the API (`start_url = /s/<token>`), no service worker in
  this step.** The installed album opens the exact link; full offline/service worker is step 9's
  PWA work (step-5 note).
- **D12 — One viewer session per browser.** The cookie holds one link; opening a second family
  link replaces the first session (re-opening the first link re-exchanges silently unless it has a
  passcode). Multi-album viewers are rare; avoids cookie sprawl.
- **D13 — Renew is refused on a revoked link (409); regenerate revives it with a new token.**
  Revocation must never be undone for people holding the old token. Regenerate, a new passcode and
  revoke end every open viewer session (DB trigger).
- **D14 — `apps/mobile-web/public/**` has no owner in `CLAUDE.md`.** The viewer PWA icons go to
  frontend-engineer (8.9) with orchestrator approval; step 9's store icons stay with
  mobile-engineer.
- **D15 — FR-9.8 (P2) included minimally:** visits per link (`view_count`, one per session per
  30-minute gap), last visit, active viewers. No per-visitor log, no IPs shown, no push (step 9).
- **D16 — Auto-share runs inside the `photo.reindex` handler (before indexing) plus `share.apply`
  and an hourly `share.reconcile`.** The poller already sends `photo.reindex {reason:"ai"}` after
  every `photo_ai` write and the API after every details edit, which is exactly "after AI analysis
  and on details change"; no ai-engineer file changes. Two new queues (12 total).
- **D17 — No admin "mark as sensitive" toggle in this step.** Sensitivity comes from AI flags
  (paid) only; free-tier manual shares are the admin's explicit choice. Worth adding with the
  combined review if the user wants it (a `photos.is_sensitive` UPDATE grant for admins + UI).
- **R1 — No new dependencies.** scrypt, HKDF, HMAC, randomBytes from `node:crypto`; `jose` exists.
  If anyone needs one, stop and report.
- **R2 — Key separation.** Viewer JWTs and IP hashes use HKDF-derived keys from `JWT_SECRET`
  (distinct `info` strings), so no new secret is needed and a viewer token can never pass
  `verifyAccessToken` (different key, issuer and audience — tested both ways). Rotating
  `JWT_SECRET` logs out viewers and resets IP-hash windows; acceptable.
- **R3 — MinIO honouring `response-cache-control`.** S3 presigned `response-*` overrides are
  supported by MinIO for GetObject; the gate asserts the header on a real response. Fallback: a
  MinIO bucket-level `Cache-Control` default is not available, so the Cloudflare cache rule (D6)
  becomes mandatory in production.
- **R4 — Viewer list performance under RLS.** The viewer policies call SECURITY DEFINER helpers
  per row (step-2 design); 8.3 measures at 10,000 shared photos and rewrites to a set-returning
  helper if the first page exceeds 150 ms (step-5/7 lesson).
- **R5 — Concurrency between rule inserts and sensitive flags.** Closed by `FOR SHARE` in the gate
  (tested with two connections), and the viewer policy hides rule+sensitive rows regardless.
- **R6 — PWA installability without a service worker.** Current Chrome no longer requires a fetch
  handler for the install prompt on Android/desktop, but older versions do; iOS uses "Add to Home
  Screen" regardless. If 8.9 finds Chrome refuses, add a minimal pass-through service worker scoped
  to `/s/` (no caching of photos) and note it.
- **R7 — In-memory exchange throttle** resets on API restart and does not span replicas (same as
  step 3); the persistent passcode ledger covers the brute-force case that matters.
- **Needs the user:** nothing for the gate. Confirmations: D1 (show-once link vs encrypted copy),
  D2 (30-day maximum), D3 (auto-share Plus-only), D9 (downloads at 1600 px). Production only: the
  Cloudflare cache-bypass rule for `files.tinyglow.app` (D6). Still open from earlier
  steps: production credentials (tunnel config, SMTP, B2, storage keys), Apple/Google IDs,
  Turnstile, legal text, CSAM provider.
