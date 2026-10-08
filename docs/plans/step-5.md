# Step 5 plan: Timeline and viewer

Status: proposed (architect, 2026-10-08). PRD step: "Build handoff for Claude Code → Build order →
5. Timeline and viewer: age-grouped timeline, photo viewer, details editing, milestones and
measurements." Acceptance (verbatim): "10,000 seeded photos scroll smoothly; edits persist."

PRD sections implemented: "FR-3 Parent-supplied details (optional)" (3.1–3.5; the search
re-indexing itself is step 7, the hook is defined here), "FR-8 Browsing" (8.1–8.4; "add to shared
album" is a disabled seam until step 8), "FR-5.6" (only the override-aware caption read path
needed for alt text; the AI edit UI is step 6), "Non-functional requirements → Performance"
(timeline 60 fps with 10,000 photos, virtualized grid), "Accessibility and UX" (alt text, dynamic
type, VoiceOver labels, 44 px targets, dark mode, offline viewing of recently opened photos — scoped
in D9), "Mobile and Capacitor → Frontend stack" (TanStack Query, `react-virtuoso`, Ionic, bottom
tabs incl. Milestones), "Responsive web" (phone single column, tablet 2-pane, desktop 3-pane),
"Data model" (`measurements`, `milestones`, `photo_details`, `photo_ai_overrides`), "Conventions".
`CLAUDE.md` clarifications applied: AI is paid-tier only and **no photo of any tier is sent to any
model in this step**; viewers get no chat; contributors are in v1. Per the user's instruction there
is **no per-step reviewer pass**; one combined review runs after step 9.

Step-4 open items closed here: the photo list sort now has a matching index (2.3), the grid is
virtualized (2.9), custom milestones have create/rename/delete endpoints (2.5), and a dev-only
10,000-photo seed creates real derivatives (2.8).

## 1. Goal

Turn the step-4 "minimal grid" into the real album: a virtualized timeline grouped by the baby's
age ("Week 3", "Month 4") with milestone badges and a month scrubber, backed by keyset pagination
over an expression index so the 50th page costs the same as the first; a full-screen photo viewer
(swipe between photos, pinch-zoom, details panel with age, date, place, parent details and the
AI caption slot) with editing of milestone (presets + custom), people chips, location label and
note — on one photo or a multi-selected batch — delete/restore, admin original download and a
disabled "Add to shared album" seam; a Milestones tab (a card per recorded milestone with its
photo and date, upcoming presets, custom milestone management); a Growth view (recorded weights,
heights and head circumferences over age as a plain data chart in the profile's units, with
metric storage) and measurement entry with or without a photo. Every edit is written under the
caller's claims (RLS decides who may edit what), audited without notes, and emits a reserved
`photo.reindex` job so step 7 can re-embed immediately. A dev-only, idempotent seed creates a
second baby with 10,000 photos (real thumb/display derivatives in MinIO, spread over 0–24 months
with milestones, people, notes and measurements) and a Playwright performance spec scrolls
through all of them measuring frame times, long tasks and DOM size.

## 2. Interfaces first

Everything here is a contract; agents build to it without asking each other. Deviations go through
the orchestrator.

### 2.1 Topology (unchanged from step 4, plus the reindex job)

```
browser ──/api/babies/:id/photos(+summary,+urls,+details)──► api ──SET LOCAL ROLE authenticated──► Postgres (RLS)
browser ──/api/photos/:id(/details)───────────────────────► api
browser ──/api/babies/:id/milestones, /api/milestones/:id──► api
browser ──/api/babies/:id/measurements, /api/measurements/:id─► api
browser ──GET thumb/display (signed, ≤ 1 h, one object) ────► MinIO (S3_PUBLIC_ENDPOINT)
api ──pg-boss send photo.reindex (after commit, outside runAs)──► worker (step 5: no-op handler; step 7: embed)
host ──pnpm perf:seed (superuser DB URL + MinIO root key, dev only)──► Postgres + MinIO
```

No new service. No model call anywhere (step 6). Signed URLs stay thumb/display only, ≤ 3600 s,
one object each (`signDerivative`); `analysis` and originals are never signed except the existing
admin-only original route.

### 2.2 Age groups and labels (`@littlelight/shared` `src/age.ts`, mirrored in SQL)

One definition, used by the API (summary + SQL function), the SPA (headers, scrubber, alt text)
and the seed. Input is `photos.age_days` (calendar days at the local capture date; step 4).

| `ageDays` | Key | Label (en) | Order |
| --- | --- | --- | --- |
| `null` (not ingested yet) | `unknown` | "Just uploaded" | first (newest) |
| `< 0` | `pre` | "Before birth" | last |
| `0 ≤ d < 84` | `w{n}`, `n = floor(d/7)+1` (1..12) | "Week n" | by n |
| `84 ≤ d < 730` | `m{n}`, `n = floor(d/30.4375)+1` (3..24) | "Month n" | by n |
| `d ≥ 730` | `y{n}`, `n = floor(d/365)` (2..) | "n years" | by n |

Constants `AGE_GROUP_WEEKS_UNTIL_DAYS = 84`, `AGE_GROUP_MONTHS_UNTIL_DAYS = 730`,
`AGE_MONTH_DAYS = 30.4375`. Functions: `ageGroupKey(ageDays: number | null): string`,
`ageGroupLabel(key): string` (en; i18n key in the SPA is `age.group.<prefix>` with `{n}`),
`ageGroupSortValue(key): number` (descending timeline order = descending sort value; `unknown`
= +∞, `pre` = −1, weeks `n*7`, months `84 + …`, simply the lower bound in days), and
`formatAge(ageDays): string` for the details panel ("3 days", "2 weeks 3 days", "11 months
2 weeks", "2 years 1 month"; negative ⇒ "before birth"). The SQL twin `public.age_group(age_days
integer) RETURNS text IMMUTABLE` (2.3) returns exactly the same keys; a unit/integration test
compares the two over `-10..2000`.

### 2.3 Database changes (migration `1791800000100_timeline-and-details.sql`, security-engineer)

Conventions as before (reversible, `IF (NOT) EXISTS`, policies `TO <role>` named
`<table>_<role>_<verb>`, column grants, every policy change tested).

1. **Timeline sort index** (closes the step-4 note). Replace `photos_baby_id_taken_at_idx` with
   `photos_baby_id_sort_idx ON public.photos (baby_id, COALESCE(taken_at, created_at) DESC, id DESC)
   WHERE deleted_at IS NULL`. The expression must be textually `COALESCE(taken_at, created_at)` so the
   planner matches the API's `ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.id DESC` and the
   keyset predicate `(COALESCE(p.taken_at, p.created_at), p.id) < ($2, $3)`. Down: drop it and
   recreate the step-2 index. Add `photos_baby_id_age_days_idx ON public.photos (baby_id, age_days)
   WHERE deleted_at IS NULL` for the group summary.
2. **`public.age_group(age_days integer) RETURNS text` IMMUTABLE, `SECURITY INVOKER`, executable by
   `authenticated, viewer, pipeline, service_role`** (2.2 table, `NULL` ⇒ `'unknown'`).
3. **`milestones`**: add `updated_at timestamptz NOT NULL DEFAULT now()` + `set_updated_at`
   trigger; `GRANT UPDATE (name, category, sort_order, updated_at)` to `authenticated` (replaces the
   step-2 column list). Policies unchanged: presets (`baby_id IS NULL`) are readable by every
   member and viewer and can never be updated or deleted by any user role; custom ones are
   admin-only for INSERT/UPDATE/DELETE. New trigger `milestones_cap` (BEFORE INSERT, SECURITY
   DEFINER): at most 200 custom milestones per baby (`check_violation` "milestone limit reached").
4. **`photo_details`**: `CHECK (cardinality(people) <= 20)`, `CHECK (location_label IS NULL OR
   length(location_label) <= 120)`; a trigger `photo_details_people_shape` is not needed (the API
   trims/limits each chip to 60 chars; the array cap is the DB rule). Add
   `photo_details_milestone_id_photo_id_idx (milestone_id, photo_id) WHERE milestone_id IS NOT NULL`
   (replaces `photo_details_milestone_id_idx`; the milestones list counts and covers use it).
5. **`measurements`**: trigger `measurements_photo_same_baby` (BEFORE INSERT OR UPDATE OF
   `photo_id, baby_id`, SECURITY DEFINER): `photo_id` NULL or a non-deleted photo of `baby_id`
   (`check_violation` "measurement photo must belong to the same baby"). `CHECK (value_metric <=
   200000)` (200 kg / 200 m: a sanity bound; real bounds are in `MEASUREMENT_LIMITS`, 2.7). Index
   `measurements_photo_id_idx (photo_id) WHERE photo_id IS NOT NULL`.
6. **`photo_ai_overrides`**: no DDL. The API reads `field_path = 'caption'` under the user's claims
   (`photo_visible`); writes are step 6.
7. No change to `photos` policies, to any viewer policy, or to the `pipeline` role. The
   `photo.reindex` job needs no DDL (`photo_details.updated_at` / `measurements.updated_at` /
   `milestones.updated_at` are the durable "stale" signal step 7 reconciles against; D5).

Regenerate `packages/db/src/generated` (`pnpm db:types`); README: migration table row, a
"Timeline and details (step 5)" section (sort index contract, `age_group`, milestone rules,
measurement rules, what the reindex hook is and is not), and the perf seed's existence (the seed
itself lives in the worker, 2.8). `pgmigrations` count becomes 12.

### 2.4 API routes (backend-engineer; all under `/api`, zod-validated, errors per `apiErrorSchema`)

Guards as in step 4: `requireAuth` + `withClaims` + `requireConsent`; RLS decides; the API reads
the role only to pick 403 vs 404 (`explainNoRow` pattern). Every query names its columns.
`edited_by` / `created_by` = `ctx.uid`. Nothing logs notes, people, labels or signed URLs.
`boss.send` only after commit, outside `runAs` (step-4 rule) through `app.jobs.enqueueReindex`.

| Method, path | File | Request → Response | Behaviour |
| --- | --- | --- | --- |
| `GET /babies/:id/photos` | `photos/routes.ts` | `photosListQuery` → `photosListResponse` | As step 4 plus: `milestoneId` filter (`JOIN photo_details d` … `d.milestone_id = $m`); `dir=older` (default, `<` cursor, DESC) or `dir=newer` (`>` cursor, ASC in SQL, reversed before returning; used after a scrubber jump); items gain `milestoneId` (LEFT JOIN `photo_details`) and `caption` (2.4a); response gains `prevCursor` (cursor of the first item, for `dir=newer`) and `nextCursor` as before; `limit` ≤ 200. `EXPLAIN` of the album query must show an Index Scan on `photos_baby_id_sort_idx` (integration test asserts). |
| `GET /babies/:id/photos/summary` | `photos/routes.ts` | `photosSummaryQuery {view: album\|pending\|trash default album}` → `photosSummaryResponse` | `{total, groups: [{key, count, cursor}]}` from one query: `SELECT age_group(age_days) AS key, count(*), max(COALESCE(taken_at, created_at)) AS top FROM photos p WHERE baby_id = $1 AND <view filter> GROUP BY 1` ordered by `ageGroupSortValue` desc in code; `cursor = encodeCursor({sortKey: top, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff'})` so `GET …/photos?cursor=<it>` starts exactly at the group's first (newest) item. The scrubber, the "N photos" header and `totalCount` for the grid come from here. |
| `POST /babies/:id/photos/urls` | `photos/routes.ts` | `photoUrlsRequest {photoIds: uuid[] 1..500}` → `photoUrlsResponse {urls: Record<photoId, {thumbUrl, displayUrl\|null, urlExpiresAt}>}` | Fresh signed URLs for visible photos (RLS-filtered `photoRowsByIds`; unknown ids absent). Used when an `<img>` errors after expiry or when `urlExpiresAt` passes for on-screen items; replaces the step-4 full refetch of every page every 45 min (2.9). |
| `GET /photos/:id` | `photos/routes.ts` | → `photo` | As step 4 plus `milestoneId` (in `details`), `caption` (2.4a), `measurements: measurement[]` (rows with `photo_id = $1`, RLS member-visible), `canEdit: boolean` (`role = 'admin' OR (uploaded_by = uid AND approval = 'pending' AND deleted_at IS NULL)`, the same rule as `photo_editable`), `ageLabel` is **not** sent (client formats). |
| `PATCH /photos/:id/details` | `photos/routes.ts` | `photoDetailsPatch` → `photo` | Upsert `photo_details` under claims: `INSERT … ON CONFLICT (photo_id) DO UPDATE SET <only the provided fields>, edited_by = $uid`. Provided fields replace (`people` replaces the array; `null` clears a scalar). `milestoneId` must be a preset or a custom milestone of the photo's baby (else 409 `conflict` "That milestone belongs to another album"). 0 rows / 42501 ⇒ `explainNoRow` (404 hidden, 403 "You can only edit details of your own photos that are still waiting for approval"). Audit `photo.details_updated {photo_id}` (never the values). After commit: `enqueueReindex({photoId, babyId, reason: 'details'})`. |
| `POST /babies/:id/photos/details` | `photos/routes.ts` | `photosBatchDetailsRequest {photoIds: uuid[] 1..500, milestoneId?: uuid\|null, addPeople?: string[] ≤ 20, locationLabel?: string\|null, note?: string\|null}` → `{updated: uuid[], skipped: uuid[]}` | FR-3.1 batch. One transaction; per id the same upsert as above but `addPeople` is a **union** (`array(SELECT DISTINCT unnest(people \|\| $add))`, capped at 20 ⇒ that id is `skipped`); ids RLS hides or the caller may not edit are `skipped` (no error). Audit `photos.details_batch_updated {count}`. After commit: one `enqueueReindex` per updated id (`reason: 'details'`). |
| `GET /babies/:id/milestones` | `milestones/routes.ts` | → `milestonesListResponse {milestones: milestone[]}` | Presets + the baby's custom ones (RLS), each with `photoCount` (live approved photos of this baby with that milestone; contributors' pending own photos excluded for simplicity: `approval = 'approved' AND deleted_at IS NULL`), `firstTakenAt` (min `COALESCE(taken_at, created_at)` among them), `coverPhoto: photoSummary\|null` (that earliest photo, signed thumb). Sorted: presets by `sort_order`, then custom by `created_at`. |
| `POST /babies/:id/milestones` | `milestones/routes.ts` | `milestoneCreate {name 1..80 trim, category? default custom}` → 201 `milestone` | Admin (RLS INSERT policy; 42501 ⇒ 403). Name unique per baby case-insensitively (23505 ⇒ 409 `conflict` "A milestone with that name already exists"); a name equal to a preset's is allowed by the DB but the API rejects it with the same 409 (D7). Audit `milestone.created {milestone_id}`. |
| `PATCH /milestones/:id` | `milestones/routes.ts` | `milestoneUpdate {name?, category?}` → `milestone` | Admin, custom only: 0 rows ⇒ 404 if invisible, 403 "Preset milestones can't be changed" if `baby_id IS NULL`, else 403 admin-only. Audit `milestone.updated {milestone_id}`. After commit: `enqueueReindex` for every live photo with that milestone (`reason: 'milestone'`, ≤ 500; above that log a warning — step 7's reconcile covers the rest). |
| `DELETE /milestones/:id` | `milestones/routes.ts` | → 204 | Admin, custom only (same 403s). `photo_details.milestone_id` goes NULL by FK. Audit `milestone.deleted {milestone_id}`; reindex as for PATCH (ids collected before the delete). |
| `GET /babies/:id/measurements` | `measurements/routes.ts` | `measurementsListQuery {kind?}` → `measurementsListResponse {measurements: measurement[]}` | Members (RLS). Ordered by `measured_at ASC`. ≤ 2,000 rows (no paging; a baby has dozens). |
| `POST /babies/:id/measurements` | `measurements/routes.ts` | `measurementCreate {kind, value, unit, measuredAt, photoId?, note?}` → 201 `measurement` | Admin (RLS). Server normalizes with `toMetric(kind, value, unit)` (2.7); `unit` must be valid for `kind` (`weight`: g/kg/oz/lb; `height`/`head`: mm/cm/in) and `value_metric` within `MEASUREMENT_LIMITS[kind]` (else 400 `validation_failed`, field path only). `photoId` must be a visible photo of the baby (trigger 2.3.5 ⇒ 409). Audit `measurement.created {measurement_id, kind}`. If `photoId`: `enqueueReindex(reason: 'measurement')`. |
| `PATCH /measurements/:id` | `measurements/routes.ts` | `measurementUpdate` (any subset) → `measurement` | Admin. Re-normalizes when `value`/`unit` change. Audit `measurement.updated`. Reindex the old and new `photoId` when either is set. |
| `DELETE /measurements/:id` | `measurements/routes.ts` | → 204 | Admin. Audit `measurement.deleted`. Reindex its photo if any. |

**2.4a Caption read path (FR-5.6 slot, alt text).** `caption = COALESCE(ov.value #>> '{}',
ai.description ->> 'caption')` with `LEFT JOIN photo_ai_overrides ov ON ov.photo_id = p.id AND
ov.field_path = 'caption'` and `LEFT JOIN photo_ai ai ON ai.photo_id = p.id`. Both tables are
readable by `authenticated` through `photo_visible`; viewers get nothing (step 8 decides). This is
the only AI-related read in step 5; no write path, no model.

**Existing routes unchanged**: `DELETE /photos/:id`, `POST /photos/:id/restore`, approve/reject,
`GET /photos/:id/original` (admins only), uploads.

### 2.5 Jobs (`@littlelight/shared` `src/jobs.ts`)

| Job | Payload (zod, strict) | Producer | Options | Handler |
| --- | --- | --- | --- | --- |
| `photo.reindex` | `reindexJobSchema {photoId: uuid, babyId: uuid, reason: enum('details','milestone','measurement','ai_override','backfill')}` | api (after commit of any 2.4 write that changes the search document); step 6/7 producers later | `singletonKey = photoId`, queue policy `exclusive`, `retryLimit 3`, `retryDelay 15`, `retryBackoff`, `expireInSeconds 300`; worker handler concurrency 4 | **Step 5**: `apps/worker/src/reindex.ts` `handleReindexJob` validates the payload and returns (debug log `reindex: no-op until step 7`). **Step 7** replaces the body with: assemble the search document, embed, upsert `photo_search` (ai-engineer, `apps/worker/src/ai/**`). |

Semantics step 7 must honour (documented in `jobs.ts` now): the handler re-reads everything at
run time (payload carries ids only); an edit that lands while a job for the same photo is
`active` is dropped by the exclusive policy, so step 7 adds a reconcile that re-embeds rows where
`photo_search.updated_at < GREATEST(photo_details.updated_at, max(measurements.updated_at),
milestones.updated_at)` — the three `updated_at` columns are the durable "stale" signal (D5).
Free-tier babies: the step-7 handler must check `baby_ai_enabled` and return (no embedding call);
this step's no-op handler trivially complies. `JobQueue` (`apps/api/src/plugins/jobs.ts`) gains
`enqueueReindex(job): Promise<boolean>` with the same retry-once/never-throw behaviour as
`enqueueIngest`. The worker's `QUEUES`/`startWorkers` register the queue (`queues ready` log
line becomes `queues: 5`).

### 2.6 Shared contracts (`@littlelight/shared`, architect-defined; backend-engineer writes them in 5.2)

`src/age.ts` additions: 2.2 (`ageGroupKey`, `ageGroupLabel`, `ageGroupSortValue`, `formatAge`,
constants). Pure, no zod.

`src/units.ts` (new): `MEASUREMENT_UNITS_FOR_KIND = {weight: ['g','kg','oz','lb'], height:
['mm','cm','in'], head: ['mm','cm','in']}`, `MEASUREMENT_LIMITS = {weight: {min: 200, max: 50000}
(g), height: {min: 200, max: 1500} (mm), head: {min: 200, max: 700} (mm)}`, `G_PER_LB =
453.59237`, `G_PER_OZ = 28.349523125`, `MM_PER_IN = 25.4`; `toMetric(kind, value, unit): number`
(grams or millimetres, rounded to 3 decimals), `fromMetric(kind, metric, units: Units): {value,
unit}` (metric: `kg` 2 dp / `cm` 1 dp; imperial: `lb` 2 dp / `in` 1 dp), `splitLbOz(grams):
{lb, oz}` (oz 1 dp) and `lbOzToGrams(lb, oz)`, `formatMeasurement(kind, metric, units): string`
("3.40 kg", "7 lb 8.0 oz", "66.0 cm", "26.0 in"), `unitIsValidForKind(kind, unit)`.

`src/api/photos.ts`: `photoSummarySchema` + `milestoneId: uuid|null`, `caption: string|null`;
`photosListQuerySchema` + `milestoneId?: uuid`, `dir: enum(older,newer) default older`;
`photosListResponseSchema` + `prevCursor: string|null`; `photoSchema` + `measurements:
measurement[]`, `canEdit: boolean`; `photoDetailsPatchSchema {milestoneId?: uuid|null, people?:
array(trim 1..60).max(20), note?: trim max 2000 | null, locationLabel?: trim max 120 | null}`
(at least one key); `photosBatchDetailsRequestSchema`, `photosBatchDetailsResponseSchema`;
`photosSummaryQuerySchema`, `photoGroupSchema {key: string, count: int, cursor: string}`,
`photosSummaryResponseSchema {total, groups}`; `photoUrlsRequestSchema`, `photoUrlsResponseSchema`.

`src/api/milestones.ts` (new): `milestoneSchema {id, babyId: uuid|null, name, category, isPreset,
sortOrder, photoCount, firstTakenAt: isoDateTime|null, coverPhoto: photoSummary|null, createdAt}`,
`milestoneCreateSchema`, `milestoneUpdateSchema` (partial, ≥ 1 key), `milestonesListResponseSchema`,
`milestoneIdParamsSchema`.

`src/api/measurements.ts` (new): `measurementSchema {id, babyId, photoId: uuid|null, kind,
valueMetric: number, valueEntered: number, unitEntered, measuredAt: isoDateTime, note: string|null,
createdAt, updatedAt}`, `measurementCreateSchema {kind, value: number positive, unit, measuredAt:
isoDateTime, photoId?: uuid|null, note?: trim max 2000 | null}` with a `superRefine` using
`unitIsValidForKind` and `MEASUREMENT_LIMITS` (via `toMetric`), `measurementUpdateSchema`
(partial, ≥ 1 key; `value` and `unit` must come together), `measurementsListQuerySchema {kind?}`,
`measurementsListResponseSchema`.

`src/jobs.ts`: `JOBS.reindex = 'photo.reindex'`, `reindexJobSchema`, `REINDEX_REASONS`.
`src/auth.ts` `AUDIT_EVENTS` gains `photo.details_updated`, `photos.details_batch_updated`,
`milestone.created`, `milestone.updated`, `milestone.deleted`, `measurement.created`,
`measurement.updated`, `measurement.deleted`; `auditMetadataSchema` gains `milestone_id: uuid`,
`measurement_id: uuid`, `kind: measurementKind` (still never names, notes, labels, values).
`src/constants.ts`: `MAX_CUSTOM_MILESTONES_PER_BABY = 200`, `PERF_IDS` (2.8 fixed ids),
`TIMELINE_PAGE_SIZE = 200`. `index.ts` re-exports everything. Only `zod`.

### 2.7 Measurement normalization rules

Storage is metric (`value_metric`: grams or millimetres, `numeric(10,3)`); `value_entered` +
`unit_entered` keep what the parent typed (display fidelity and the imperial round-trip). The
**server** normalizes (clients never send `valueMetric`). Display uses `profiles.units`: metric
shows kg/cm, imperial shows lb (+ oz in the entry form) / in; the growth chart's y axis follows
the same. Round-trip contract (unit test + e2e): `7 lb 8 oz` → `3401.943 g` → imperial display
"7 lb 8.0 oz" → metric display "3.40 kg"; `66 cm` → `660 mm` → "26.0 in".

### 2.8 Performance seed (dev only; backend-engineer, `apps/worker/src/tools/perf-seed.ts`)

Why the worker package (D6): it already has `sharp`, `pg`, the S3 client and the exact derivative
renderer (`ingest/derivatives.ts`), so seeded objects are produced by the same code as real ones.
Runs **on the host** like the worker integration tests, never in a container, never in production:

```
pnpm perf:seed            # root script → pnpm --filter @littlelight/worker perf-seed
pnpm perf:seed --remove   # deletes the perf baby's rows and every object version under its prefix
```

Env (same as `pnpm test:integration`): `DATABASE_URL=postgres://postgres:dev@localhost:5432/littlelight`
(superuser; the script refuses any URL whose user is not `postgres`, any host that is not
`localhost`/`127.0.0.1`, and `NODE_ENV=production`), `S3_ENDPOINT=http://localhost:9000`,
`S3_ACCESS_KEY=dev`, `S3_SECRET_KEY=devdevdev` (MinIO root; the bucket-scoped keys cannot
`CopyObject` across prefixes they do not own… they can, but the root key keeps the script
independent of the step-4 policies), `S3_BUCKET=littlelight-dev`, `DATA_ENCRYPTION_KEY` (unused:
the perf baby has no home location and no GPS; the script never calls `encrypt_coord`).

Fixed ids (`PERF_IDS` in shared `constants.ts`): baby `00000000-0000-4000-8000-000000000900`
("Pixel", nickname "Pix", born `2024-10-01`, **plan `free`**, no plan owner), admin members =
demo mom and demo dad (existing demo users; the demo seed must have run — the script checks and
explains otherwise), custom milestones `…-000000000910/911/912` ("First swim", "First snow",
"Met Grandpa Joe"), photos `00000000-0000-4000-8000-01` + 10 zero-padded decimal digits
(`…-010000000000` .. `…-010000009999`), measurements `…-0000000009MM` (MM = 20..61).

Content (deterministic PRNG seeded with the photo index, so every run is identical):
- 10,000 photos, `status = 'ingested'`, `approval = 'approved'`, `uploaded_by` alternating
  mom/dad, `age_days` uniform over `0..730`, `taken_at = birth + age_days + random time` with
  `tz_offset_minutes = -420` in `photo_exif` (no GPS, `raw_json` = `{Make, Model, Orientation}`),
  `taken_at_estimated = false`, `sha256 = sha256('perf-photo-<i>')`, `mime = image/jpeg`, `width
  = 3024`, `height = 4032` (portrait) for 70 %, landscape for 30 %; 50 photos with `created_at`
  newer than `taken_at` by weeks (the sort is by taken_at, so these prove the COALESCE order).
- Derivatives: 24 base images per kind (one per month: a month-hued gradient with a large
  "M<n>" / "W<n>" text block and 8 random circles, so wrong-group placement is visible), rendered
  through `renderDerivative` (thumb 320, display 1600; **no `analysis` row or object**: the baby is
  free tier, nothing will ever be analysed — and it saves 10,000 objects). Base objects uploaded
  once to `babies/<perf>/derivatives/_base/<kind>-<month>.jpg`, then **`CopyObject`** (server-side
  within MinIO, no bytes over the wire) to `derivativeKey(babyId, photoId, kind)` for every
  photo with concurrency 32; `photo_derivatives` rows with the real byte sizes. Idempotent: skip a
  copy when `HeadObject` succeeds (`--force` re-copies). Disk: ≈ 10,000 × (≈8 KB + ≈45 KB) ≈
  0.6 GB (9 GB free; D6).
- Details: every preset milestone on one photo at a plausible age (first smile ~ day 45, first
  steps ~ day 365, first birthday day 365 …) plus 2 more photos each for 4 presets; the 3 custom
  milestones on 1–3 photos each (≈ 25 milestone photos); 300 photos with `people` from a pool of
  8 names; 150 with `note` (lorem-like, no real text); 80 with `location_label` "Riverside Park";
  `edited_by` = mom.
- Measurements: 25 weights (monotone-ish 3.2 kg → 11.5 kg), 13 heights (50 → 86 cm), 7 head
  circumferences (34 → 47 cm), `measured_at` spread over 0–24 months, 6 of them linked to a photo,
  `unit_entered` alternating metric/imperial (so both display paths have data).
- Free-tier cap: the baby is inserted with `plan = 'plus'` for the duration of the photo inserts
  (the `photos_free_tier_cap` trigger counts live photos) and flipped to `plan = 'free',
  plan_owner_user_id = NULL` at the end of the transaction (D6); re-runs do the same. Result: a
  free-tier baby with 10,000 photos — exactly the "photos above the cap stay" state the README
  documents — so **no step-6 batcher can ever pick these up** (`baby_ai_enabled` false; DB
  tripwires back it).
- One transaction for rows (`INSERT … ON CONFLICT DO UPDATE`, ~10 batched multi-row statements of
  1,000), objects outside it; prints counts per table and object count; `--remove` deletes
  `babyPrefix` versions and `DELETE FROM babies WHERE id = perf` (cascade). Never logs notes or
  keys with signatures. Runtime target ≤ 3 min on a laptop.

The demo seed (`packages/db/src/seed.ts`) is **not** changed in this step; its 12 placeholder
keys keep showing the step-4 placeholder (D13 of step 4 is answered by the perf seed, not by
rewriting the demo seed; flagged in 5 as a follow-up option).

### 2.9 Frontend (frontend-engineer, `apps/mobile-web/src/**`)

Dependencies (added by devops in 5.1): `react-virtuoso` (PRD-named; `GroupedVirtuoso` for sticky
age headers + `Virtuoso` rows of N thumbs), `swiper` (Ionic's documented replacement for
`ion-slides`; modules `Zoom` for pinch-zoom/double-tap, `Keyboard`, `Virtual` for 3-slide
windows over 10k items). No chart library (in-house SVG, D8). No persistence library (D9).

**Foundations (`lib/`)**
- `lib/queries/photos.ts`, `lib/queries/milestones.ts`, `lib/queries/measurements.ts` (split of
  `lib/queries.ts`; the old file re-exports for the upload code): `useTimeline(babyId, {view,
  milestoneId, startCursor})` = `useInfiniteQuery` with `limit=200`, `getNextPageParam`
  (`nextCursor`), `getPreviousPageParam` (`prevCursor`, fetched with `dir=newer`), `staleTime:
  Infinity`, `refetchOnWindowFocus: false`, `gcTime: 24 h` (D9); `useTimelineSummary(babyId, view)`;
  `usePhoto(id)` (`staleTime 45 min`); `useUpdatePhotoDetails`, `useBatchDetails`,
  `useRefreshUrls` (batches ids over 250 ms, ≤ 500, patches `thumbUrl`/`urlExpiresAt` into the
  cached pages with `setQueryData`); `useMilestones`, `useCreateMilestone`, `useUpdateMilestone`,
  `useDeleteMilestone`; `useMeasurements`, `useCreateMeasurement`, `useUpdateMeasurement`,
  `useDeleteMeasurement`. Mutations invalidate `photosRoot(babyId)`, the photo detail, milestones
  and measurements keys as appropriate. Keep `usePhotosInvalidation` (upload manager hook).
- `lib/age.ts`: thin wrappers over shared `ageGroupLabel`/`formatAge` with i18n keys.
- `lib/altText.ts`: `photoAltText(photo, baby, milestoneName?)` = `caption ?? "{baby} at {age}, {date}{, milestone}"`
  (PRD: alt text is the AI caption, editable later; the fallback is the sensible stand-in).
- `lib/imageCache.ts` (D9): `cachePhotoImage(photoId, kind, url)` / `cachedPhotoImageUrl(photoId,
  kind)` on the Cache API (`caches.open('ll-photos-v1')`), keyed by the **synthetic request**
  `/_cache/photos/<id>/<kind>` (never by the signed URL); LRU of 50 displays + their thumbs,
  trimmed on insert; no-op where `caches` is undefined. `components/PhotoImage.tsx`: `<img>` that
  tries the cache first (object URL, revoked on unmount), then the signed URL; on error with a
  past `urlExpiresAt` asks `useRefreshUrls` for a fresh one once; `alt` from `photoAltText`;
  `decoding="async"`, `loading="lazy"` for thumbs.
- `lib/features.ts`: `FEATURES = { sharing: false, chat: false, aiEdits: false } as const` (step 8
  flips `sharing`, step 7 `chat`, step 6 `aiEdits`).
- `lib/units.ts`: wrappers over shared `fromMetric`/`formatMeasurement` using `me.profile.units`.
- Dark mode: confirm Ionic's system palette (`@ionic/react/css/palettes/dark.system.css`) is
  imported in `main.tsx`/`styles.css`; add if missing. Dynamic type: no `px` font sizes in new
  code (`rem`/Ionic variables). Targets: every tappable control `min-h-11 min-w-11`.
- i18n: all new strings in `i18n/en.ts` (`timeline.*`, `viewer.*`, `details.*`, `milestones.*`,
  `growth.*`, `measurements.*`, `age.*`, `offline.*`), plural forms where counts appear.

**TimelinePage (`pages/TimelinePage.tsx`, `components/timeline/*`)**
- Header: "{total} photos", view segments as in step 4 (album / needs approval for admins), a
  **scrubber** (`components/timeline/Scrubber.tsx`): a vertical rail on the right (phone) or a
  dropdown (desktop) listing groups from the summary; tapping `timeline-jump-<key>` starts a new
  timeline stream at that group's `cursor` (`startCursor` in the query key), with "newer" pages
  loaded on scroll-up via `fetchPreviousPage` and `Virtuoso`'s `firstItemIndex` prepend pattern.
- Grid: `GroupedVirtuoso` where groups = age groups computed **client-side** from the loaded
  items (`ageGroupKey(photo.ageDays)`, stable because pages arrive in sort order and a group never
  interleaves another), items = rows of `cols` thumbs (`cols` by breakpoint: 3 at < 640 px, 4 at
  640, 5 at 768, 6 at 1024, 8 at 1280; recomputed on resize); `endReached` ⇒ `fetchNextPage`,
  `startReached` ⇒ `fetchPreviousPage` when a `startCursor` is set; `increaseViewportBy: {top: 600,
  bottom: 1200}` for prefetch; `components="Scroller"` bound to the `IonContent` scroll element
  (`scrollEl` from `getScrollElement()`), `data-testid="timeline-scroller"` on it. Sticky group
  header `timeline-group-<key>` shows the label and the group's count (from the summary when
  available). Each thumb: `photo-<id>` button (44 px+), `PhotoImage`, milestone badge
  (`photo-milestone-badge-<id>`, icon + milestone name as `aria-label`), pending badge (step 4),
  `is_sensitive` eye-off badge, selection checkbox in select mode (`select-<id>`). Approve/Reject
  stay in the pending view.
- **Select mode** (`select-mode` toggle): tap toggles selection; bottom action bar: "Add details"
  (`batch-details` ⇒ sheet with milestone picker, add-people chips, location, note ⇒
  `useBatchDetails`), "Delete" (admin; confirm), "Add to shared album" (`batch-share`, rendered
  `disabled` with `aria-disabled` and the note "Coming with sharing" while `!FEATURES.sharing`).
- Offline banner (`offline-banner`) when `navigator.onLine` is false: "You're offline — showing
  photos you've opened recently"; the grid still renders cached pages (TanStack memory) and
  `PhotoImage` serves from the Cache API where present (D9).
- Empty / error states as step 4.

**Viewer (`components/viewer/PhotoViewer.tsx`, opened with `?photo=<id>` on `/timeline` and
`/milestones`; back button / `viewer-close` clears the param; reload reopens)**
- Phone: `IonModal` full screen. Swiper over the loaded timeline items (`Virtual` module, slide =
  `viewer-slide-<id>`, `Zoom` module: pinch and double-tap zoom on the `display` image, `Keyboard`
  module on desktop, `aria-roledescription="carousel"`); reaching the last loaded slide calls
  `fetchNextPage`. Top bar: close, index "n of total", actions menu. Bottom: details toggle
  (`viewer-details-toggle`).
- Details panel (`viewer-details`): caption (AI caption or override; "Description arrives after
  analysis" placeholder when null and the baby is paid; "AI descriptions are part of Plus" link
  when free — no AI call either way), age (`formatAge`), date/time (profile timezone), place label
  (admins only see `exif.placeLabel`; it is only ever "Home" today), camera, milestone, people
  chips, location label, note, linked measurements (`formatMeasurement`), "estimated date" marker
  when `takenAtEstimated`. `viewer-edit` opens the **details form** (`components/viewer/DetailsForm.tsx`):
  milestone `<select>` (`details-milestone`: "None", presets, custom ones, "+ New custom
  milestone…" ⇒ inline input `details-milestone-custom` ⇒ `useCreateMilestone` then select it;
  only admins see the "+ New" option), people chips (`details-people-input` with Enter/comma to
  add, `details-person-chip-<name>` with remove), location (`details-location`), note
  (`details-note`, 2000 max, counter), "Add measurement" shortcut (opens the measurement sheet
  with `photoId` and `measuredAt = takenAt` prefilled), save (`details-save`) ⇒
  `useUpdatePhotoDetails`; shown only when `photo.canEdit`.
- Actions: `viewer-delete` (confirm; soft delete; contributors only on own pending — the button
  is shown only when `canEdit`), `viewer-restore` in the trash view (admin),
  `viewer-download-original` (admin; existing `fetchOriginalUrl`), `viewer-share` ("Add to shared
  album", disabled with the same note as above), `viewer-set-avatar`? **No** (not in the PRD step;
  omit).
- Accessibility: every control has an `aria-label`; the slide image's `alt` is `photoAltText`;
  focus trapped in the modal; Escape closes; VoiceOver announces "Photo n of N".
- After `cachePhotoImage` of the opened display (+ the two neighbours' thumbs) the photo counts as
  "recently opened" (D9).

**MilestonesPage (`pages/MilestonesPage.tsx`)**
- Segments: "Milestones" | "Growth".
- Milestones: `milestones-recorded` cards (`milestone-card-<id>`: cover thumb via `PhotoImage`,
  name, date of `firstTakenAt` and the baby's age then, "{n} photos") ⇒ tap opens the timeline
  filtered by `milestoneId` (`/timeline?milestone=<id>`), `milestones-upcoming` list of presets
  without photos ("Not yet — tag a photo to record it"), custom milestone management for admins:
  `milestone-add` (name + category), `milestone-rename-<id>`, `milestone-delete-<id>` (confirm:
  "Photos keep their details; the milestone tag is removed").
- Growth (`components/growth/GrowthChart.tsx`, `growth-chart`): kind tabs
  (`growth-kind-weight|height|head`), an **in-house SVG line chart** (x = age in months from
  `ageDays(baby.birthDate, measuredAt, tz)`, y = value in the profile's units, points with
  `aria-label` "3.40 kg at 4 months 1 week", no percentiles, no reference curves, no
  interpretation — the subtitle says "Your recorded measurements"), a `growth-table` (`<table>`
  with the same data, the accessible fallback and the e2e's assertion surface), `measurement-add`
  ⇒ measurement sheet (`measurement-form`: `measurement-kind`, `measurement-value` (+
  `measurement-value-oz` when imperial weight), `measurement-unit` (defaults from the profile's
  units), `measurement-date`, optional note, optional photo (from the viewer shortcut only),
  `measurement-save`), rows `measurement-row-<id>` with edit/delete for admins. Contributors see
  the chart and table read-only.

**Responsive layout (`components/layout/Panes.tsx`)** — breakpoints from the PRD:
- `< 640 px` phone: single column; the viewer is a full-screen modal.
- `≥ 768 px` tablet: `/timeline` renders two panes — grid (left, flexible) and the viewer (right,
  `minmax(360px, 45%)`) inline instead of a modal (same component, `inline` prop; Swiper still
  works for swipe/keyboard).
- `≥ 1024 px` desktop: three panes — chat placeholder (left, 280 px, `components/ChatPanePlaceholder.tsx`
  "Chat arrives with search" behind `FEATURES.chat`), grid (middle), details (right, 360 px):
  the selected photo's display image on top and the details panel/form below. Drag-and-drop
  bulk upload on the grid area is already handled by the upload page's dropzone; here a drop
  navigates to `/upload` with the files handed over through the existing upload manager
  (`uploadManager.addFiles(babyId, files)` if the API exists; otherwise a visible "Drop photos on
  the Upload tab" hint — frontend-engineer checks the manager's API and picks the former when it
  is a one-liner).

**Security notes for the frontend**: signed URLs live only in the query cache and the Cache API
entries keyed by id (the cached response body is the image, the key is synthetic); nothing is
written to `localStorage` except the existing session/baby keys; notes are never put in URLs or
logs; `caption` is rendered as text, never HTML; no third-party scripts.

### 2.10 Tests and gate (test-engineer; `**/*.test.ts`, `e2e/**`)

- **Unit, shared**: `age.test.ts` additions (group keys at every boundary: −1, 0, 6, 7, 83, 84,
  729, 730, 1095, 1460; labels; `formatAge` samples; `ageGroupSortValue` monotone),
  `units.test.ts` (conversions, rounding, the 2.7 round-trip, limits), `jobs.test.ts`
  (`reindexJobSchema` strict), audit additions.
- **Unit, api**: `photos/queries.test.ts` (summary cursor uses the `ffff…` id; `dir=newer`
  reversal; `milestoneId` filter SQL), `milestones/*.test.ts`, `measurements/*.test.ts`
  (normalization paths, unit/kind validation), `plugins/jobs.test.ts` (`enqueueReindex` retry
  once, never throws).
- **Unit, worker**: `reindex.test.ts` (invalid payload dropped; valid ⇒ no DB call), `queues.test.ts`
  (5 queues), `tools/perf-seed.test.ts` (refuses non-localhost / non-postgres URLs and
  `NODE_ENV=production`; deterministic content for a fixed index; group spread covers every
  key `w1..w12`, `m3..m24`).
- **Unit, web** (`vitest` + jsdom): `PhotoImage` (cache first, refresh on expired error),
  `DetailsForm` (people chips, limits), `GrowthChart` (points/labels in metric vs imperial),
  grouping helper (loaded pages ⇒ `groupCounts`).
- **Integration, db** (`packages/db/timeline.integration.test.ts` + additions to
  `rls.integration.test.ts` / `triggers.integration.test.ts` / `migrations.integration.test.ts`):
  `age_group()` equals the TS function over `-10..2000`; `EXPLAIN (FORMAT JSON)` of the album
  query (as `authenticated`) contains `photos_baby_id_sort_idx` and no Seq Scan on `photos`;
  contributor can UPDATE `photo_details` of own pending photo, not of an approved one, not of the
  admin's; admin can; viewer: permission denied on `measurements`, `photo_ai_overrides`; preset
  milestone UPDATE/DELETE by an admin affects 0 rows; custom milestone of baby A invisible to an
  admin of baby B; `measurements_photo_same_baby` rejects a photo of another baby; 201st custom
  milestone rejected; `people` of 21 rejected; migration count 12, every table still
  ENABLE+FORCE, types diff clean, down/up round trip.
- **Integration, api** (`apps/api/src/photos/photos.integration.test.ts` additions,
  `milestones/milestones.integration.test.ts`, `measurements/measurements.integration.test.ts`;
  real DB, S3 stub, stubbed jobs capturing `enqueueReindex` calls): list with `milestoneId`;
  summary groups and jumping with a group cursor returns that group's newest item first; `urls`
  batch ignores invisible ids; details PATCH as admin / as the nanny on own pending (200) / on the
  admin's photo (403) / on a trashed photo (403); batch details union of people and `skipped`
  ids; reindex enqueued once per updated photo; milestone create/rename/delete (preset ⇒ 403,
  duplicate name ⇒ 409, contributor ⇒ 403); measurement create normalizes (`7.5 lb` ⇒ `3401.943`),
  rejects `in` for `weight`, out-of-range, photo of another baby ⇒ 409; contributor create ⇒ 403;
  audit rows exist with only the allowed keys; no response ever contains `analysis`, `gps`,
  `raw_json`.
- **e2e `e2e/timeline/edits.spec.ts`** ("edits persist"): fresh user (imperial units) ⇒ baby ⇒
  upload 3 small JPEGs through the API (reuse `e2e/helpers/images.ts`/upload helpers from the
  gate) ⇒ wait for thumbs ⇒ open `/timeline` ⇒ open the first photo ⇒ edit: milestone "First
  smile", people "Grandma Rose" + "Dad", location "Riverside Park", note "three wobbly steps" ⇒
  save ⇒ add measurement weight 7 lb 8 oz dated the photo's date ⇒ **reload** ⇒ reopen the photo
  ⇒ every value is shown, the badge is on the thumb, the Milestones tab shows a "First smile"
  card with the photo and date, Growth shows "7 lb 8.0 oz" ⇒ switch profile units to metric
  (settings) ⇒ Growth shows "3.40 kg" ⇒ DB check via `docker compose exec db psql`:
  `value_metric = 3401.943`, `unit_entered = 'lb'` ⇒ select mode: pick photos 2+3 ⇒ batch "Add
  details" people "Nanny" ⇒ both show the chip after reload ⇒ create custom milestone "First
  swim" from the details form, rename it to "First pool day", see the rename on the card, delete
  it, the photo keeps its other details ⇒ delete photo 3 ⇒ trash view shows it ⇒ restore ⇒ back
  in the album ⇒ `viewer-share` and `batch-share` are disabled.
- **Perf spec `e2e/perf/timeline.perf.spec.ts`** (`pnpm e2e:perf`, own config
  `e2e/playwright.perf.config.ts`: projects `phone` 375×812 and `desktop` 1280×800, 1 worker, no
  retries, 10 min timeout; excluded from `pnpm e2e`): precondition `pnpm perf:seed` has run
  (the spec checks `GET /babies/<perf>/photos/summary` → `total = 10000` as demo mom, else fails
  with "run pnpm perf:seed"). Signs in as `demo-mom@littlelight.local` (OTP via Mailpit),
  selects the perf baby (through the header switcher or `currentBabyStore`'s key — test-engineer
  reads `lib/session.ts`), opens `/timeline`, waits for the first group header. Injects a sampler
  (`page.evaluate`): a `requestAnimationFrame` loop recording frame deltas, a
  `PerformanceObserver({type: 'longtask'})`, a 500 ms interval sampling
  `document.images.length` and `document.querySelectorAll('[data-testid^="photo-"]').length`.
  Drives the scroll **inside the page** (one `setInterval` doing `scroller.scrollBy(0, 1200)`
  every 50 ms; not Playwright round trips) until `scrollTop + clientHeight ≥ scrollHeight − 2`
  **and** no new page has arrived for 3 s (pages load during the scroll), then scrolls back to
  the top the same way. Warm-up: the first 2 s of samples are discarded. Asserts (local /
  `PERF_CI=1`): share of frames > 33 ms ≤ 5 % / ≤ 15 %; p95 frame ≤ 20 ms / ≤ 34 ms; max frame ≤
  250 ms / ≤ 600 ms; long tasks ≥ 100 ms ≤ 10 / ≤ 40; `document.images.length` ≤ 400 at every
  sample; grid item nodes ≤ 600 at every sample (virtualization bound); the last group header
  reached is `timeline-group-pre` or `timeline-group-w1` (no `pre` photos are seeded ⇒ `w1`);
  a scrubber jump to `m12` shows `timeline-group-m12` within 2 s and the first visible thumb's
  group is `m12`; the API `GET …/photos?limit=200` resource timings (from
  `performance.getEntriesByType('resource')`) have p95 ≤ 300 ms / ≤ 800 ms. Prints a table (frames,
  p50/p95/max, jank %, long tasks, max imgs, max nodes, pages fetched, API p95).
- **Smoke additions**: `pgmigrations` count 12; worker log `queues: 5`; `GET /api/babies/<maya>/photos/summary`
  as mom returns `total = 9`-ish (the demo seed's live approved + pending visible count; assert
  `groups.length ≥ 3`).

## 3. Tasks

Owners per `CLAUDE.md`. Lanes: D = devops, B = backend, S = security, F = frontend, T = test.
Same-lane tasks run in sequence unless noted.

### 5.1 Dependencies and root scripts (devops-engineer) — first, alone (the one serial lockfile change)

- Owned: every `package.json`, `pnpm-lock.yaml`, root `vitest.config.ts` (nothing new expected),
  `e2e/playwright.perf.config.ts` is **not** devops (test-engineer, 5.11); root scripts.
- Add, pinned to the latest stable past pnpm 12's release-age gate: `apps/mobile-web`:
  `react-virtuoso`, `swiper`. Root scripts: `"perf:seed": "pnpm --filter @littlelight/worker perf-seed"`,
  `"e2e:perf": "playwright test -c e2e/playwright.perf.config.ts"`. `apps/worker/package.json`:
  `"perf-seed": "tsx src/tools/perf-seed.ts"`. Nothing else (D8, D9: no chart or persistence
  library).
- Done-when: `pnpm install --frozen-lockfile` is a no-op afterwards; `pnpm lint && pnpm typecheck
  && pnpm test` green; `docker compose -f docker-compose.dev.yml build web` succeeds.

### 5.2 Shared contracts (backend-engineer) — lane B, after 5.1 (parallel with 5.3)

- Owned: `packages/shared/src/**` (new `units.ts`, `api/milestones.ts`, `api/measurements.ts`;
  edits to `age.ts`, `jobs.ts`, `api/photos.ts`, `auth.ts`, `constants.ts`, `index.ts`).
- Build 2.2, 2.5 (schema), 2.6, 2.7 literally. Only `zod`. Keep every schema browser-safe.
- Done-when: typecheck passes; `pnpm test` (existing shared tests) green; the new functions are
  unit-testable per 2.10.

### 5.3 Migration, generated types, README (security-engineer) — lane S, after 5.1 (parallel with 5.2)

- Owned: `packages/db/migrations/1791800000100_timeline-and-details.sql`,
  `packages/db/src/generated/**`, `packages/db/README.md`.
- Build 2.3. Write into the SQL comments and enforce: RLS stays ENABLE+FORCE on every touched
  table; no new grant to `viewer` or `pipeline`; presets remain immutable for every user role;
  `measurements` writes stay admin-only; `photo_details` edits stay `photo_editable` (admins, or
  the uploader of a pending photo); `age_group` is IMMUTABLE and matches 2.2 exactly; the sort
  index expression matches the API's SQL textually; down migration is the exact inverse
  (recreate the step-2 index, drop the new ones, drop `updated_at`, drop triggers/functions/CHECKs).
- Done-when: `pnpm db:migrate` applies 12 migrations; second run no-op; `pnpm db:migrate:down 1 &&
  pnpm db:migrate` round-trips; applies on the bare stub too; `pnpm db:types` committed with no
  diff on re-run; the every-table-forced query returns 0; `EXPLAIN` of the album ORDER BY query
  (as `postgres` on the seeded demo baby) shows `photos_baby_id_sort_idx`; README updated.

### 5.4 API: timeline, details, URLs, reindex enqueue (backend-engineer) — lane B, after 5.2 and 5.3

- Owned: `apps/api/src/photos/{routes,queries}.ts`, `apps/api/src/plugins/jobs.ts`,
  `apps/api/src/app.ts` (register the two new modules of 5.5 as well, so 5.5 only adds files),
  `apps/api/src/lib/errors.ts` (CHECK message mappings: "milestone limit reached" ⇒ 409
  `conflict`; "measurement photo must belong to the same baby" ⇒ 409 `conflict`). Not owned:
  `apps/api/src/auth/**`, `apps/api/src/sharing/**`.
- Build the photos rows of 2.4, 2.4a, and the API side of 2.5. Explicit requirements: every
  write under the caller's claims (never `withServiceRole`); `people`/`note`/`locationLabel`
  never logged or audited; `caption` comes only from `photo_ai_overrides` / `photo_ai` reads (no
  model, no write); signed URLs stay thumb/display, ≤ 3600 s, one key, through `signDerivative`;
  `enqueueReindex` after commit and outside `runAs`; the summary's group order uses
  `ageGroupSortValue`; `dir=newer` returns items in the same newest-first order as `older`.
- Done-when: the curl walkthrough in 4.2 steps 1–8 passes against the dev stack; `EXPLAIN` via
  the integration test shows the index; `GET /photos/:id` and the list never contain `gps`,
  `raw_json` or `/analysis.jpg`.

### 5.5 API: milestones and measurements (backend-engineer) — lane B, after 5.4 (same lane; one invocation with 5.4 is fine)

- Owned: `apps/api/src/milestones/{routes,queries}.ts`, `apps/api/src/measurements/{routes,queries}.ts`.
- Build the milestones and measurements rows of 2.4 and 2.7. Explicit requirements: normalization
  server-side with shared `toMetric`; admin-only writes are enforced by RLS and explained as 403;
  presets immutable (403 with the given message); duplicate-of-preset name ⇒ 409 (D7); reindex
  enqueued for affected photos (≤ 500 per rename/delete).
- Done-when: curl walkthrough 4.2 steps 9–12 passes; typecheck green.

### 5.6 Worker: reindex queue stub + perf seed tool (backend-engineer) — lane B (second invocation), after 5.2; parallel with 5.4/5.5 (disjoint: `apps/worker/**`)

- Owned: `apps/worker/src/reindex.ts`, `apps/worker/src/queues.ts`, `apps/worker/src/main.ts`
  (log line), `apps/worker/src/run-job.ts` (accept `photo.reindex`), `apps/worker/src/tools/perf-seed.ts`
  (+ `tools/perf-content.ts` for the deterministic content, `tools/perf-images.ts` for the base
  images), `apps/worker/package.json` script (devops added it in 5.1; keep in sync).
- Build the worker side of 2.5 and all of 2.8. Explicit requirements: the reindex handler makes
  **no** DB or network call in this step; the seed refuses production / non-local / non-superuser
  URLs; the perf baby ends `plan = 'free'` with no owner (so AI can never run on it); no
  `analysis` objects or rows; derivatives through `renderDerivative` (metadata-free by
  construction; the CI grep still applies to `apps/worker/src`); no GPS, no `encrypt_coord`; the
  seed logs counts only; `--remove` deletes every object version under `babyPrefix(perf)` first,
  then the baby row.
- Done-when: on the dev stack `pnpm perf:seed` finishes ≤ 3 min printing `photos=10000
  photo_derivatives=20000 photo_details=… measurements=45 milestones(custom)=3 objects=20000+48`;
  a second run prints the same counts and copies nothing; `mc ls --versions` shows exactly one
  version per key; `psql -c "select plan, plan_owner_user_id from babies where id = '<perf>'"` →
  `free | <null>`; `select count(*) from photos where baby_id = '<perf>' and status <> 'ingested'`
  → 0; signing in as demo mom lists two babies; `pnpm perf:seed --remove` leaves 0 rows and 0
  object versions; worker log on start says `queues: 5`; `pnpm --filter @littlelight/worker
  run-job photo.reindex '{"photoId":"…","babyId":"…","reason":"details"}'` logs the no-op line.

### 5.7 Frontend foundations (frontend-engineer) — lane F, after 5.2 (parallel with B/S; integrates once 5.4–5.6 are up)

- Owned: `apps/mobile-web/src/lib/**` (`queries/*.ts`, `age.ts`, `altText.ts`, `imageCache.ts`,
  `features.ts`, `units.ts`), `apps/mobile-web/src/components/PhotoImage.tsx`,
  `apps/mobile-web/src/i18n/en.ts` (add **all** step-5 keys now, so 5.8/5.9 do not touch it),
  `apps/mobile-web/src/main.tsx` / `styles.css` (dark palette import, if missing).
- Build the "Foundations" block of 2.9. Keep `lib/queries.ts` as a re-export shim so the upload
  code compiles unchanged.
- Done-when: `pnpm --filter @littlelight/mobile-web typecheck && test` green; the step-4 grid
  still works against the dev stack using `PhotoImage`; dark mode follows the OS setting.

### 5.8 Frontend: timeline, viewer, details editing, select mode (frontend-engineer) — lane F, after 5.7

- Owned: `apps/mobile-web/src/pages/TimelinePage.tsx`, `apps/mobile-web/src/components/timeline/**`,
  `apps/mobile-web/src/components/viewer/**`, `apps/mobile-web/src/components/PhotoGrid.tsx`
  (replace or delete), `apps/mobile-web/src/components/layout/Panes.tsx`,
  `apps/mobile-web/src/components/ChatPanePlaceholder.tsx`, `apps/mobile-web/src/App.tsx` (only
  if a route change is unavoidable; `?photo=` needs none).
- Build the TimelinePage, Viewer and Responsive blocks of 2.9 with the listed `data-testid`s.
  Explicit requirements: virtualization bounds (≤ ~400 images mounted at any time); no layout
  work per item beyond the row; thumbs sized by CSS aspect-square so rows have a known height;
  the viewer's share actions are disabled behind `FEATURES.sharing`; contributors see edit/delete
  only when `canEdit`; the original download only for admins; 44 px targets; `aria-label`s;
  Escape/back closes; nothing but ids in the URL.
- Done-when: with the perf seed loaded, a human scrolls `/timeline` of the perf baby smoothly on
  a laptop at 375 px and 1280 px, jumps with the scrubber, opens a photo, swipes, pinch/double-tap
  zooms (Chrome device emulation), edits details and sees them after reload; the tablet/desktop
  layouts match 2.9; `pnpm --filter @littlelight/mobile-web typecheck && test` green.

### 5.9 Frontend: Milestones tab, Growth view, measurements (frontend-engineer) — lane F, after 5.7 (may run in parallel with 5.8 as a second invocation: disjoint paths below)

- Owned: `apps/mobile-web/src/pages/MilestonesPage.tsx`, `apps/mobile-web/src/components/milestones/**`,
  `apps/mobile-web/src/components/growth/**`, `apps/mobile-web/src/components/measurements/**`
  (the measurement sheet is also used by 5.8's details form: 5.8 imports
  `components/measurements/MeasurementSheet.tsx` by the name and props fixed here:
  `{babyId, photoId?, defaultMeasuredAt?, open, onClose}`).
- Build the MilestonesPage block of 2.9. Explicit requirements: chart is data only (no
  percentiles, no reference curves, no "normal" wording; PRD "Non-goals"); units follow
  `me.profile.units`; the table is the accessible twin; contributors read-only.
- Done-when: against the dev stack (demo Maya has 3 measurements and 3 milestone photos) the
  cards, upcoming list, chart and table render; add/edit/delete a measurement in imperial and
  metric; custom milestone add/rename/delete; typecheck/test green.

### 5.10 Unit and integration tests (test-engineer) — lane T, after 5.2–5.6

- Owned: `**/*.test.ts`, `packages/db/test/{harness,fixtures}.ts`, `apps/api/src/testing/*`,
  `apps/worker/src/testing/*`.
- Build the unit and integration rows of 2.10.
- Done-when: `pnpm test` and `pnpm test:integration` green on the dev stack and on bare
  pgvector + standalone MinIO (CI path), none skipped.

### 5.11 e2e edits spec, perf spec, smoke (test-engineer) — lane T, after 5.8, 5.9, 5.10

- Owned: `e2e/timeline/**`, `e2e/perf/**`, `e2e/playwright.perf.config.ts`, `e2e/helpers/**`,
  `e2e/smoke/dev-stack.sh`.
- Build the e2e, perf and smoke rows of 2.10. The perf spec prints its table and exits non-zero
  on any threshold; thresholds switch with `PERF_CI=1`.
- Done-when: `pnpm e2e` green (incl. `timeline/edits.spec.ts`); `pnpm perf:seed && pnpm e2e:perf`
  passes twice in a row on the orchestrator's Mac at the local thresholds; `pnpm smoke` green.

### 5.12 CI (devops-engineer) — lane D, after 5.11

- Owned: `.github/workflows/ci.yml`, `.github/scripts/**`.
- Add `e2e/timeline/*.ts e2e/perf/*.ts e2e/playwright.perf.config.ts` to the e2e typecheck glob;
  in `dev-stack-smoke`, after the upload gate: `pnpm perf:seed` (host, same env as the gate's
  psql/MinIO access: `DATABASE_URL=postgres://postgres:dev@localhost:5432/littlelight S3_ENDPOINT=http://localhost:9000
  S3_ACCESS_KEY=dev S3_SECRET_KEY=devdevdev S3_BUCKET=littlelight-dev`) then `PERF_CI=1 pnpm e2e:perf`
  (15-minute step timeout; upload `e2e/report` and the perf table on failure).
- Done-when: `actionlint` clean; every job's commands pass locally in order.

### Parallelism summary

| Group | Tasks | Notes |
| --- | --- | --- |
| 0 (serial) | 5.1 (D) | lockfile + scripts |
| 1 (parallel) | 5.2 (B, shared) · 5.3 (S) | disjoint paths |
| 2 (parallel) | 5.4→5.5 (B, api, one lane) · 5.6 (B, worker, second invocation) · 5.7 (F) | after 5.2 (and 5.3 for 5.4) |
| 3 (parallel) | 5.8 (F) · 5.9 (F, second invocation) | after 5.7; disjoint component folders |
| 4 (serial) | 5.10 (T) | after 5.4–5.6 |
| 5 (serial) | 5.11 (T) → 5.12 (D) | 5.11 needs 5.8, 5.9 |
| Gate | orchestrator | section 4 |

ai-engineer, mobile-engineer and security-engineer (beyond 5.3) have no further step-5 work.
Seams left for later steps: step 6 — `caption` read path and `FEATURES.aiEdits`; the perf baby is
free tier and must stay out of every batch; step 7 — `photo.reindex` handler body + reconcile
(2.5), `FEATURES.chat` + `ChatPanePlaceholder`; step 8 — `FEATURES.sharing`, `viewer-share` /
`batch-share` buttons, viewers reuse the summary/list shapes with the viewer role; step 9 —
persisted query cache with URL stripping + service worker on top of `imageCache.ts` (D9), native
pinch-zoom is Swiper's (works in WKWebView).

## 4. Acceptance checks

Verbatim, PRD step 5: "Check: 10,000 seeded photos scroll smoothly; edits persist." Run from the
repo root with Docker Desktop running and `pnpm` 12.10.1 on PATH.

### 4.1 The PRD check

```sh
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d --build --wait
pnpm install --frozen-lockfile
# 10,000 seeded photos (dev only, idempotent)
DATABASE_URL=postgres://postgres:dev@localhost:5432/littlelight S3_ENDPOINT=http://localhost:9000 \
S3_ACCESS_KEY=dev S3_SECRET_KEY=devdevdev S3_BUCKET=littlelight-dev pnpm perf:seed
# expected: photos=10000 photo_derivatives=20000 measurements=45 custom milestones=3, objects copied 20000 (+48 base)
# scroll smoothly (Playwright frame timing, long tasks, DOM bounds; phone + desktop projects)
pnpm e2e:perf
# expected table per project: jank(>33ms) <= 5 %, p95 frame <= 20 ms, max frame <= 250 ms, long tasks <= 10,
#   max images <= 400, max grid nodes <= 600, pages fetched = 50, API p95 <= 300 ms, scrubber jump to m12 ok
# edits persist (e2e, incl. the metric/imperial round trip and custom milestones)
bash .github/scripts/restart-api.sh      # resets the in-memory OTP limits between suites
pnpm e2e                                 # includes e2e/timeline/edits.spec.ts
```

### 4.2 API walkthrough (cookie jar `a.jar` from step 3's 4.2 steps 1–5 as `demo-mom@littlelight.local`; `B=http://localhost:8080`, `H='x-littlelight-client: web'`, `MAYA=00000000-0000-4000-8000-000000000100`, `PERF=00000000-0000-4000-8000-000000000900`)

1. `curl -s -b a.jar $B/api/babies/$PERF/photos/summary` → `total = 10000`, `groups[0].key = "m24"` … last `"w1"`, each with `count` and `cursor`; counts sum to 10000.
2. `curl -s -b a.jar "$B/api/babies/$PERF/photos?limit=200"` → 200 items newest first, each with `thumbUrl` (`X-Amz-Expires=3600`), `milestoneId`, `caption: null`, `ageDays`; `nextCursor` set, `prevCursor` set.
3. Jump: `C=$(… groups[] | select(.key=="m12") | .cursor)`; `curl -s -b a.jar "$B/api/babies/$PERF/photos?cursor=$C&limit=5"` → first item's `ageDays` in `[334, 365)` (month 12); then `dir=newer&cursor=<prevCursor>` returns the 200 items just newer, in newest-first order.
4. Timing: `for i in $(seq 1 20); do curl -s -o /dev/null -w '%{time_total}\n' -b a.jar "$B/api/babies/$PERF/photos?limit=200&cursor=$LAST"; done | sort -n | tail -2` → p95 ≤ 0.3 s where `$LAST` is the 49th page's cursor; `docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d littlelight -c "EXPLAIN SELECT id FROM photos p WHERE baby_id='$PERF' AND deleted_at IS NULL ORDER BY COALESCE(taken_at, created_at) DESC, id DESC LIMIT 200"` → `Index Scan using photos_baby_id_sort_idx`.
5. URLs: `curl -s -b a.jar -H "$H" -X POST $B/api/babies/$MAYA/photos/urls -H 'content-type: application/json' -d '{"photoIds":["00000000-0000-4000-8000-000000000302","00000000-0000-4000-8000-000000000311"]}'` → both present for mom; the same as the nanny (`n.jar`) → only `…311` (her own pending) plus approved ones she asked for.
6. Details: `curl … -X PATCH $B/api/photos/00000000-0000-4000-8000-000000000303/details -d '{"milestoneId":"10000000-0000-4000-8000-000000000003","people":["Grandma Rose"],"locationLabel":"Home","note":"rolled!"}'` → `details` echoed, `canEdit: true`; `GET /photos/…303` shows them; `psql -c "select event, metadata from audit_log where event='photo.details_updated' order by created_at desc limit 1"` → metadata has only `photo_id`; `psql -c "select count(*) from pgboss.job where name='photo.reindex' and data->>'photoId'='00000000-0000-4000-8000-000000000303'"` ≥ 1; worker log shows `reindex: no-op until step 7`.
7. Nanny: `curl -b n.jar … -X PATCH $B/api/photos/…303/details -d '{"note":"x"}'` → 403; on her own pending `…311` → 200; after mom approves `…311`, the nanny's PATCH → 403.
8. Batch: `curl … -X POST $B/api/babies/$MAYA/photos/details -d '{"photoIds":["…305","…306","…311"],"addPeople":["Dad"]}'` as mom → `updated` 3; as the nanny → `updated` [`…311`], `skipped` the other two.
9. Milestones: `curl -s -b a.jar $B/api/babies/$MAYA/milestones` → 12 presets (+ customs), "First steps" has `photoCount 1`, `coverPhoto.id = …309`, `firstTakenAt 2026-06-14…`; `POST …/milestones -d '{"name":"First swim"}'` → 201; again → 409; `-d '{"name":"first smile"}'` → 409; `PATCH /milestones/10000000-0000-4000-8000-000000000001 -d '{"name":"x"}'` → 403 "Preset milestones can't be changed"; `PATCH /milestones/<custom> -d '{"name":"First pool day"}'` → 200; as nanny `POST` → 403; `DELETE /milestones/<custom>` → 204.
10. Measurements: `POST $B/api/babies/$MAYA/measurements -d '{"kind":"weight","value":7.5,"unit":"lb","measuredAt":"2025-07-15T12:00:00Z"}'` → 201 `valueMetric 3401.943`; `-d '{"kind":"weight","value":30,"unit":"in",…}'` → 400 `validation_failed`; `-d '{"kind":"height","value":66,"unit":"cm","photoId":"<a perf-baby photo id>",…}'` → 409; `GET …/measurements?kind=weight` → ascending by `measuredAt`; `PATCH /measurements/<id> -d '{"value":3.5,"unit":"kg"}'` → `valueMetric 3500`; as nanny `POST` → 403; `DELETE` → 204.
11. Privacy: `curl -s -b a.jar $B/api/photos/…309 | grep -Ei 'gps|raw_json|analysis|latitude'` → nothing; `placeLabel` is `"Riverside Park"` (seed) for mom; the response's `caption` for `…304` (bath, seeded `photo_ai`) is the seeded caption — read only, no model call: `docker compose -f docker-compose.dev.yml logs api worker | grep -ci 'openai\|anthropic'` → 0.
12. Perf baby stays free: `psql -c "select plan, plan_owner_user_id, free_tier_photo_count(id) from babies where id='$PERF'"` → `free | <null> | 10000`; `psql -c "select baby_ai_enabled('$PERF')"` → `f`.

### 4.3 Suites and hygiene

```sh
pnpm lint && pnpm typecheck && pnpm test
DATABASE_URL=postgres://postgres:dev@localhost:5432/littlelight AUTH_DB_PASSWORD=dev API_DB_PASSWORD=dev \
WORKER_DB_PASSWORD=dev DATA_ENCRYPTION_KEY=dev-only-data-encryption-key-32-chars-min SEED_DEMO_FAMILY=true \
JWT_SECRET=dev-only-jwt-secret-at-least-32-characters PUBLIC_URL=http://localhost:8080 \
MAIL_FROM=noreply@littlelight.local SMTP_HOST=localhost \
S3_ENDPOINT=http://localhost:9000 S3_PUBLIC_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=dev S3_SECRET_KEY=devdevdev \
S3_BUCKET=littlelight-test pnpm test:integration
pnpm smoke
PSQL="docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d littlelight -Atc"
$PSQL "select count(*) from pgmigrations"                # 12
$PSQL "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname<>'pgmigrations' and not (c.relrowsecurity and c.relforcerowsecurity)"   # 0
grep -rnE 'withMetadata|keepExif|keepMetadata|keepIccProfile|withIccProfile|withExif' apps/worker/src ; echo "exit $?"   # exit 1
DATABASE_URL=postgres://postgres:dev@localhost:5432/littlelight pnpm --filter @littlelight/db db:types && git diff --exit-code -- packages/db/src/generated
docker compose -f docker-compose.dev.yml logs api worker | grep -Ei 'X-Amz-Signature|latitude|GPSLatitude|"note"' ; echo "no secrets/GPS/notes in logs: exit $?"   # exit 1
docker compose -f docker-compose.dev.yml exec -T worker printenv NODE_ENV DATABASE_URL | grep -c postgres:dev   # 0 (the perf seed's superuser URL never reaches a container)
grep -rn 'perf-seed\|perf:seed' docker-compose.yml apps/*/Dockerfile ; echo "perf seed absent from production: exit $?"   # exit 1
pnpm perf:seed --remove && $PSQL "select count(*) from photos where baby_id='00000000-0000-4000-8000-000000000900'"   # 0 (then re-seed if you want to keep it)
```

## 5. Risks and decisions (orchestrator to confirm or override)

- **D1 — Keyset pagination stays; groups are computed client-side; a summary endpoint provides
  counts and jump cursors.** Offset paging would make a "jump to Month 4" trivial but shifts under
  inserts and costs O(n) at 50k; keyset with a per-group start cursor (max sort key + `ffff…` id)
  gives O(log n) jumps and the `dir=newer` flag gives bidirectional loading. Group headers are
  derived from `ageDays` in the client with the same function the server uses in SQL; the summary
  endpoint also supplies the "N photos" total and the scrubber. Cost: one extra query per
  timeline open (~5 ms on 10k rows via the age_days index).
- **D2 — Expression index `(baby_id, COALESCE(taken_at, created_at) DESC, id DESC) WHERE
  deleted_at IS NULL`** replaces the step-2 `(baby_id, taken_at DESC)` index. The trash view (few
  rows) and the pending view (filtered further) use the same ordering; the pending view's
  selectivity makes the index still fine. Alternative: a stored `sort_at` column maintained by
  trigger — more moving parts for the same plan.
- **D3 — `swiper` for swipe + pinch-zoom** (Ionic's documented successor to `ion-slides`; its
  `Zoom` module does pinch/double-tap, `Virtual` keeps 3 slides mounted). An in-house pointer-event
  carousel with pinch would be ~400 lines of touch math and the thing most likely to feel wrong
  on iOS. `react-virtuoso` as the PRD suggests. Both are the only new runtime dependencies.
- **D4 — `caption` (override-aware) is read into list and detail now** so alt text and the details
  panel have the slot FR-5.6 needs, with a fallback alt text built from name, age, date and
  milestone. No AI write path, no model call, no edit UI (step 6).
- **D5 — Re-index hook = `photo.reindex` job (sent after commit, exclusive per photo) + the
  existing `updated_at` columns as the durable stale signal.** No `search_dirty` column: a flag
  would need maintenance on three tables, while `GREATEST(updated_at…)` versus
  `photo_search.updated_at` is already there and reconcilable. Step 5's handler is a no-op by
  design (nothing to index without embeddings); "immediately re-indexed" is satisfied the moment
  step 7 fills the handler, with no API change. The exclusive policy can drop an edit that lands
  while a job is active; step 7's reconcile covers it (documented in `jobs.ts`).
- **D6 — Perf seed lives in `apps/worker/src/tools/` and runs on the host** with the superuser URL
  and the MinIO root key (like the worker integration tests), never in a container or image
  (`docker-compose.yml` and the Dockerfiles do not reference it; 4.3 greps). It reuses the real
  derivative renderer, uploads 48 base images and `CopyObject`s them into per-photo keys (the API
  rebuilds keys from ids, so per-photo keys are mandatory; copies cost no bandwidth and ~0.6 GB of
  the 9 GB free). The perf baby ends on the **free** plan with no owner, which is the strongest
  guarantee available that no later step can send a single synthetic image to a model. The demo
  seed's 12 placeholder keys are left as they are (a tiny follow-up would be to reuse the same
  base-image trick there; it is `packages/db`, security-engineer — not needed for this gate).
- **D7 — Custom milestone names may not equal a preset's name** (API 409) even though the DB's
  per-baby unique index allows it, to avoid two "First steps" in the picker. Presets are
  immutable for every user role (DB policies), deleting a custom milestone nulls
  `photo_details.milestone_id` (existing FK) and photos keep their other details. Cap 200 per baby.
- **D8 — Growth chart is an in-house SVG** (3 series, tens of points, a `<table>` twin for
  accessibility). A chart library would add 300–500 KB to a bundle already flagged at 1.5 MB and
  would invite percentiles/reference curves the PRD forbids. Override to `recharts` is a one-task
  change in 5.9 if the orchestrator prefers.
- **D9 — Offline viewing of recently opened photos: minimal, dependency-free scope now, full PWA
  later.** Step 5 caches the display derivative (+ neighbour thumbs) of the last 50 opened photos
  in the Cache API keyed by `photoId/kind` (never by the signed URL) and keeps TanStack's in-memory
  cache for 24 h, so going offline mid-session still shows what was opened. Persisting the query
  cache would write signed URLs (capability tokens) to `localStorage` unless stripped, and offline
  on a cold start needs a service worker — both belong with the PWA/manifest work in step 9. Flag:
  if the orchestrator wants cold-start offline in step 5, add `@tanstack/react-query-persist-client`
  + `@tanstack/query-sync-storage-persister` with a serializer that strips `*Url` fields (two
  TanStack packages, same vendor) to 5.1/5.7.
- **D10 — Viewer state lives in `?photo=<id>`**, not a route, so Ionic's tab outlet and the step-3
  `useRouteActive` guards stay untouched; back closes the viewer, reload reopens it, and
  `/timeline?milestone=<id>` filters the grid. A `/photos/:id` deep link can be added in step 9
  with the other deep links.
- **D11 — Contributors**: edit/delete only their own pending photos (DB `photo_editable`, surfaced
  as `canEdit`), no measurements or custom milestones (DB admin-only policies), growth and
  milestones read-only, no original download. The batch endpoint silently `skips` ids they may
  not edit rather than failing the batch.
- **D12 — Measurement validation bounds** (`MEASUREMENT_LIMITS`: weight 0.2–50 kg, height 20–150 cm,
  head 20–70 cm) are input sanity, not medical ranges; the chart never interprets them.
- **R1 — Frame-timing thresholds in headless Chromium are noisy**; the spec drives the scroll
  in-page, discards warm-up, and has looser `PERF_CI=1` thresholds. If CI still flaps, keep the
  DOM-bound and long-task assertions strict and report frame stats without failing (orchestrator
  decides after the first real run).
- **R2 — `GroupedVirtuoso` with client-side groups and bidirectional loading** (`firstItemIndex`
  prepend after a scrubber jump) is the trickiest UI piece; a fallback that still passes the
  gate is: jump = reset the list at the group's cursor and offer a "Load newer" button at the top
  instead of automatic prepend.
- **R3 — Swiper `Zoom` + Ionic gestures** can fight over horizontal swipes while zoomed; Swiper
  disables slide change while zoomed by default; verify in Chrome device emulation and note any
  WKWebView follow-up for step 9.
- **R4 — Seed runtime/disk**: 20,048 `CopyObject`s at concurrency 32 on local MinIO should take
  well under a minute; if MinIO throttles, lower concurrency (`PERF_SEED_CONCURRENCY`). Disk use
  ≈ 0.6 GB; `--remove` frees it.
- **R5 — The 200-item page × 50 pages during the perf scroll** means 50 signed-URL batches
  (~10,000 HMACs, trivial) and 50 round trips; API p95 is asserted to catch a regression in the
  keyset path.
- **Needs the user (not for the gate):** nothing new. Still open from earlier steps: production
  credentials (tunnel, SMTP, B2), Apple/Google client IDs, Turnstile, legal text, CSAM provider.
