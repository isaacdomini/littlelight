# Tinyglow — Product Requirements Document

Oct 7, 2026 · @Isaac Domini

## Overview

**Tinyglow** is a private, AI-organized photo album built around one baby. Parents upload photos, tag milestones, and then simply ask: "show me her first steps" or "how much did he weigh at 4 months?" The app understands every photo, stores it searchably, and shares a curated album with family through a link.

**Name rationale:** "Tinyglow" is warm, short, brandable, and centers the child. Alternates if trademark search fails: *Tinyframes*, *Babbleroll*, *Firstlings*, *Wee Archive*.

### Problem

Parents take thousands of photos in year one. They live in a camera roll mixed with screenshots and receipts. Finding "the first bath" means scrolling for minutes, milestone details (weight, date, who was there) are lost, and sharing with grandparents happens through scattered group texts.

### Target users

- **Primary:** parents of children aged 0–5 (two admins per baby).
- **Secondary:** invited family and friends who view a shared album.

### Goals (v1)

1. Upload single or bulk photos from phone or web in under 3 taps.
2. Every photo gets an AI-generated, structured description within 24 hours, at under $0.001 per photo in model costs.
3. Natural-language chat finds the right photo in the top 5 results for at least 85% of queries.
4. Two parent admins manage the album; a share link gives family a read-only view with manual or rule-based auto-sharing.
5. Ship to web, iOS App Store and Google Play from one codebase (Capacitor).

### Non-goals (v1)

- Video storage and analysis (planned v2).
- Printing, photo books or physical products.
- Public social feed, likes or comments from non-family.
- Facial recognition across unrelated users or any cross-family identity matching.
- Medical advice: the chat may report recorded weights and dates but never interprets growth or health.

## Personas and user stories

| Persona | Who | Needs | Permissions |
| --- | --- | --- | --- |
| Admin parent (x2) | Mom, dad, or any two co-parents | Fast upload, milestone logging, find photos instantly, control what family sees | Full: upload, edit, delete, tag, invite co-admin, manage share links, chat |
| Family viewer | Grandparents, aunts, close friends | See new photos without an account hassle | View shared album only |
| Contributor | Nanny, grandparent who takes photos | Add photos for parents to approve | Upload to an approval queue; no delete |

### Core user stories

**Upload and capture**

- As a parent, I can select one or hundreds of photos from my camera roll and upload them in the background, so I don't have to keep the app open.
- As a parent, I can optionally add a milestone (first steps, first smile), a measurement (weight, height), people present, and a free-text note to a photo or a batch.
- As a parent, I can turn on auto-backup so new camera-roll photos that contain the baby are suggested for upload.

**Understand and search**

- As a parent, I see each photo enriched within a day with a description, detected scene, activities and mood, without doing anything.
- As a parent, I can ask in chat "photos of her at the beach last summer" and get a grid of matching photos.
- As a parent, I can ask "when did he first crawl?" or "what was her weight at 6 months?" and get an answer with the source photo and date.
- As a parent, I can correct an AI description, and the correction is used in future searches.

**Share**

- As a parent, I can create a share link that expires after 24 hours (renewable in one tap), add an optional passcode, and revoke it at any time.
- As a parent, I can add photos to the shared album manually, or set rules like "auto-share milestone photos" or "auto-share everything except bath time".
- As a family viewer, I open the link on my phone and see a beautiful timeline of the baby, newest first.

**Album management**

- As a parent, I can invite my co-parent as the second admin by email.
- As a parent, I can create albums for more than one child (one baby = one album space).
- As a parent, I can export all originals and metadata at any time.

## Functional requirements

Priority: **P0** = launch blocker, **P1** = launch target, **P2** = fast follow.

### FR-1 Accounts and baby spaces

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-1.1 | Sign up / sign in with email magic link, Apple and Google (Apple Sign-In is required by App Store when other social logins exist). | P0 |
| FR-1.2 | A user can create a **Baby** profile: name, nickname, birth date, birth weight/length, optional avatar. | P0 |
| FR-1.3 | Each Baby has exactly 1–2 **admins**. The creator invites the second admin by email; the invite expires in 7 days. | P0 |
| FR-1.4 | A user may admin multiple babies and switch between them from the header. | P1 |
| FR-1.5 | Removing an admin requires the other admin's confirmation; the last admin cannot leave without deleting or transferring the baby. | P1 |
| FR-1.6 | Admins can invite Contributors (nanny, grandparent) who may upload but not delete, edit others' photos, share, or chat. | P0 |

### FR-2 Upload

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-2.1 | Upload a single photo or a bulk selection (up to 500 per session) from camera roll (mobile) or file picker / drag-and-drop (web). | P0 |
| FR-2.2 | Uploads go **directly from client to object storage** via pre-signed URLs, resumable (tus or S3 multipart), and continue in the background on mobile. | P0 |
| FR-2.3 | Accepted formats: JPEG, PNG, HEIC/HEIF, WebP. HEIC converted server-side to JPEG for derivatives; original kept untouched. | P0 |
| FR-2.4 | Per-photo progress, retry on failure, and a summary ("482 uploaded, 3 failed, 15 duplicates skipped"). | P0 |
| FR-2.5 | **De-duplication**: SHA-256 of original bytes plus perceptual hash (pHash); exact duplicates skipped, near-duplicates flagged. | P1 |
| FR-2.6 | Optional auto-backup: new camera-roll photos are queued for upload on Wi-Fi (user opt-in). | P2 |
| FR-2.7 | Contributor uploads land in an approval queue; nothing enters the album, AI pipeline or shared album until an admin approves. | P0 |

### FR-3 Parent-supplied details (optional)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-3.1 | Before or after upload, a parent can attach details to one photo or a whole batch. | P0 |
| FR-3.2 | **Milestone** picker with a preset list (first smile, first laugh, rolled over, sat up, first food, first tooth, crawled, first steps, first word, first haircut, first birthday, first time with \[person\]) plus custom milestones. | P0 |
| FR-3.3 | **Measurements**: weight (kg/lb), height (cm/in), head circumference; stored with units normalized to metric. | P0 |
| FR-3.4 | **People present** (free-text chips, e.g. "Grandma Rose", "Dad"), location label, and a free-text note. | P0 |
| FR-3.5 | All details are editable later and immediately re-indexed for search. | P0 |

### FR-4 Metadata extraction

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-4.1 | On upload, a worker extracts EXIF: capture date/time, timezone offset, GPS, camera make/model, orientation, dimensions. | P0 |
| FR-4.2 | Compute **baby's age at capture** (days/weeks/months) from birth date and capture date. Fallback to upload time if EXIF is missing, flagged as estimated. | P0 |
| FR-4.3 | Reverse-geocode GPS to a coarse place (city, park, "home" if within 150 m of a saved home location). Raw GPS stored encrypted, never shown to viewers. | P1 |
| FR-4.4 | Strip GPS and device EXIF from every derivative served to share-link viewers. | P0 |

### FR-5 AI photo understanding (batch)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-5.1 | Each photo gets a compressed **analysis copy** (long edge 768 px, JPEG/WebP quality \~75, typically 60–120 KB) used only for the model. | P0 |
| FR-5.2 | Photos are accumulated into **batch jobs** sent to the model provider's Batch API (≈50% cheaper, results within 24 h). A batch is flushed every 30 minutes or at 1,000 photos, whichever first. | P0 |
| FR-5.3 | The model returns a **structured JSON description** that validates against a fixed schema (see AI pipeline). Invalid output is retried once, then marked for re-run. | P0 |
| FR-5.4 | Parent-supplied details and EXIF facts are passed into the prompt as context so the model does not contradict them. | P0 |
| FR-5.5 | "Priority" path: photos tagged with a milestone, or uploaded when the user is actively waiting, can use the real-time API (user-visible "analyzing..." state). | P1 |
| FR-5.6 | Parents can edit any AI field; edits are stored as overrides and win at search time. | P1 |
| FR-5.7 | Re-processing when prompt/schema version changes is supported as a backfill batch job. | P1 |
| FR-5.8 | AI description, search and chat run only for paid-tier babies. The free tier (up to 1,000 photos) gets upload, timeline, milestones and sharing; upgrading triggers one backfill batch for existing photos. | P0 |

### FR-6 Storage and indexing

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-6.1 | Originals stored in object storage, never modified. Derivatives: thumbnail (320 px), display (1600 px), analysis (768 px). | P0 |
| FR-6.2 | Structured data (EXIF, parent details, AI JSON) stored in Postgres. | P0 |
| FR-6.3 | A **search document** per photo (AI description + parent notes + milestone + people + place + age) is embedded and stored in the vector index with the photo ID and storage key. | P0 |
| FR-6.4 | Full-text index (Postgres tsvector) on the same search document for hybrid search. | P0 |

### FR-7 Chat and search

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-7.1 | Chat screen is the app's home tab: a text box, suggested prompts ("Show first steps", "Photos with Grandma"), and photo grids inline in answers. | P0 |
| FR-7.2 | Intents supported: **find photos**, **answer facts about the baby** (weights, dates, milestones), **summaries** ("what happened in month 3?"), **comparisons** ("show her at 1, 6 and 12 months"). | P0 |
| FR-7.3 | Retrieval is **hybrid**: structured filters (date range, age range, milestone, people) + vector similarity + keyword, merged and re-ranked. | P0 |
| FR-7.4 | Every answer cites the photos it used; tapping a photo opens the viewer. Answers never state a fact not found in stored data. | P0 |
| FR-7.5 | Classic search bar and filter chips (date, milestone, person, place) for users who don't want chat. | P0 |
| FR-7.6 | Conversation history kept per user per baby; can be cleared. | P1 |
| FR-7.7 | Chat is scoped to the current baby, available to admins only (viewers and contributors get no chat), and requires the paid tier. | P0 |

### FR-8 Browsing

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-8.1 | Timeline view grouped by baby's age ("Week 3", "Month 4"), with milestone badges. | P0 |
| FR-8.2 | Milestones view: a card per milestone with its photo and date. | P1 |
| FR-8.3 | Growth view: chart of recorded weights/heights over age (data display only, no percentiles or medical interpretation). | P1 |
| FR-8.4 | Photo viewer: swipe, pinch-zoom, details panel (AI description, parent details, age, date), edit, delete, add to shared album. | P0 |

### FR-9 Sharing

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-9.1 | Admins create one or more **share links** per baby (e.g. "Grandparents", "Close friends"). Each link maps to a **shared album**. | P0 |
| FR-9.2 | Link options: unguessable token (≥128-bit), optional 6-digit passcode, 24-hour expiry by default (admins renew or regenerate), allow downloads on/off. | P0 |
| FR-9.3 | Admins add photos manually (multi-select "Add to shared album"). | P0 |
| FR-9.4 | **Auto-share rules** per album: all new photos / only milestone photos / photos containing selected tags / exclude tags (e.g. bath, nudity-risk). Rules run after AI analysis. | P1 |
| FR-9.5 | **Safety gate**: photos where AI flags `sensitive_content` (bath, diaper, partial nudity) are never auto-shared; they require manual action. | P0 |
| FR-9.6 | Viewers open the link in a browser with no account; an expired link shows a friendly "ask the parents for a new link" page. | P1 |
| FR-9.7 | Revoking a link invalidates it immediately and purges CDN cache for its signed URLs. | P0 |
| FR-9.8 | Admin activity log: views per link, last visit. | P2 |

### FR-10 Data rights

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-10.1 | Export all originals + a JSON/CSV of metadata as a ZIP. | P1 |
| FR-10.2 | Delete a photo: removes original, derivatives, DB rows and vector entries within 24 h (hard delete after 30-day trash). | P0 |
| FR-10.3 | Delete account / baby: full purge within 30 days, including provider-side batch files. | P0 |

## Accounts and authentication

Auth runs on **Supabase Auth** with passwordless sign-in only: email one-time code, Sign in with Apple, and Google. No passwords means no reset flow, no credential stuffing, and less support. Family viewers never create an account.

### Sign-in methods

| Method | iOS app | Android app | Web | Priority |
| --- | --- | --- | --- | --- |
| Email 6-digit code (OTP) | Yes, primary | Yes, primary | Yes, primary | P0 |
| Email magic link | No (code avoids deep-link fragility) | No | Yes, as fallback in the same email | P1 |
| Sign in with Apple | Native sheet (required by App Store when Google is offered) | Web OAuth | Web OAuth | P0 |
| Google | Native SDK | Native Credential Manager | Web OAuth (PKCE) | P0 |
| Passkeys |  |  |  | P2 |
| Optional TOTP two-factor |  |  |  | P2 |

One email = one account. A social login whose **verified** email matches an existing account links to it automatically; unverified emails never auto-link. Apple "Hide My Email" relay addresses are stored as-is and work as the account email.

### Sign-up flow

1. **Welcome:** "Continue with Apple", "Continue with Google", or email field.
2. **Verify:** email path sends a 6-digit code (valid 10 min, 5 attempts). Code screen supports paste and iOS/Android one-time-code autofill.
3. **Consent:** checkbox "I'm 18 or older and agree to the Terms and Privacy Policy". Store `terms_version`, `privacy_version`, `accepted_at`, IP country. Block under-18 sign-ups.
4. **Profile:** display name (prefilled from Apple/Google), relationship label (Mom, Dad, Parent, Grandparent…), timezone (auto-detected), units (metric/imperial).
5. **Fork:** if the user arrived through an invite link, accept it and land in that baby's album. Otherwise **Create your baby**: name, birth date (or due date), optional birth weight/length and photo.
6. **Invite co-parent** (skippable): email field, sends the second-admin invite.
7. **Plan:** free tier by default; upgrade prompt explains AI search and chat. Payments via App Store / Play Billing on mobile, Stripe on web (RevenueCat keeps entitlements in sync).
8. **First upload:** permission primer screen, then the system photo picker.

### Roles and permissions

| Action | Admin (max 2) | Contributor | Share-link viewer |
| --- | --- | --- | --- |
| View all photos | Yes | Own uploads + approved album | Shared photos only |
| Upload | Yes | Yes, to approval queue | No |
| Edit details, delete photos | Yes | Own pending uploads only | No |
| Approve contributor uploads | Yes | No | No |
| Chat / AI search (paid tier) | Yes | No | No |
| Create, renew, revoke share links | Yes | No | No |
| Invite / remove members | Yes | No | No |
| Delete baby, export data, manage plan | Yes | No | No |

Permissions are enforced in Postgres with RLS helper functions (`is_baby_member(baby_id)`, `is_baby_admin(baby_id)`) that read `baby_members`, never trusted claims from the client. The plan entitlement lives on the baby (`babies.plan`), so either admin's subscription unlocks AI for both.

### Invites

- Admin enters an email and role (co-admin or contributor). Server creates an `invites` row with a 256-bit random token (stored hashed), expiry 7 days, and emails a link `https://tinyglow.app/invite/{token}`.
- The link opens the app if installed (Universal Links / App Links), otherwise the web app.
- Accepting requires signing in **with the invited email** (case-insensitive match). Mismatch shows "This invite was sent to m\*\*\*@gmail.com".
- Invites can be resent or revoked; accepting a co-admin invite when 2 admins already exist fails with a clear message.
- Rate limit: 20 invites per baby per day.

### Share-link viewers (no account)

- Link format `https://tinyglow.app/s/{token}`; token is 128-bit random, stored hashed, valid 24 h by default.
- If a passcode is set, the viewer enters it (5 attempts / 15 min per IP + token).
- Server exchanges a valid token for a **viewer session**: an httpOnly, Secure, SameSite=Lax cookie holding a short JWT with `role=viewer`, `share_link_id`, and `exp` = the link's expiry. All viewer queries use a Postgres role that can only read `shared_photos` for that link.
- Revoking or expiring the link invalidates viewer sessions immediately (server checks `share_links.revoked_at` and `expires_at` on every request).

### Sessions and tokens

- Supabase access JWT: 1 hour. Refresh tokens rotate on every use; reuse of an old refresh token revokes the whole session family.
- **Mobile:** tokens stored in iOS Keychain / Android Keystore through a secure-storage plugin, never in WebView localStorage. Sessions last 90 days of inactivity.
- **Web:** PKCE flow with tokens in httpOnly cookies (`@supabase/ssr` pattern); 30-day inactivity timeout.
- Settings screen lists active devices with "Sign out" per device and "Sign out everywhere".
- Optional biometric app lock (Face ID / fingerprint) on mobile, P2.

### Account deletion and recovery

- In-app "Delete account" (required by both app stores): re-verify by email code, then show consequences.
- If the user is the **only admin** of a baby, they must delete that baby's album or promote a co-admin first. If a co-admin exists, the album stays with them.
- Deletion signs out all sessions immediately, removes the user from `baby_members`, and purges personal data within 30 days (FR-10.3). Photos the user uploaded to a shared album remain only if a remaining admin keeps them.
- **Lost access** (e.g. lost Apple ID): email-code sign-in to the same address recovers the account; support can re-link providers after verifying ownership of the email.

### Auth security requirements

- Email code requests: 5 per hour per email, 30 per hour per IP. Cloudflare Turnstile on the web sign-up form after 3 attempts.
- Generic responses ("If this email is valid, we sent a code") to avoid revealing which emails have accounts.
- Transactional email via Postmark or Resend with SPF, DKIM, DMARC; branded templates for code, invite, and new-device sign-in alert.
- Audit log events: sign-in, sign-out, new device, invite sent/accepted/revoked, role change, share link created/renewed/revoked, account deletion.
- Admin actions that are destructive (delete baby, remove co-admin) require a fresh sign-in within the last 10 minutes.

### Auth data model additions

| Table | Columns |
| --- | --- |
| `profiles` | user\_id (FK auth.users), display\_name, relationship\_label, timezone, units, terms\_version, privacy\_version, accepted\_at, deleted\_at |
| `babies` (add) | plan (`free` / `plus`), plan\_owner\_user\_id, entitlement\_expires\_at |
| `viewer_sessions` | id, share\_link\_id, created\_at, expires\_at, ip\_hash, user\_agent\_hash |
| `audit_log` | id, baby\_id, actor\_user\_id or share\_link\_id, event, metadata jsonb, created\_at |

## Architecture and tech stack

A single Postgres database (with pgvector) is the system of record for metadata, AI descriptions and vectors; photos live in object storage and never pass through the API server.

&#91;embedded content: system architecture · clients, API, storage, workers, AI providers\]

Uploads go straight from the device to storage; the ingest worker prepares each photo, the batcher groups them into Batch API jobs, and results flow back into Postgres for search and chat.

| Layer | Choice | Why |
| --- | --- | --- |
| Client | React + Vite + Ionic + Capacitor | One codebase for web, iOS, Android |
| Auth | Supabase Auth (GoTrue), self-hosted in Docker Compose | Built-in RLS integration |
| Database + vectors | Postgres 17 + pgvector (HNSW), in Docker Compose | Filters, permissions and similarity in one query; no separate vector DB to sync. Move to Qdrant/Turbopuffer only past \~20M vectors |
| Object storage | MinIO on the on-prem server, photos stored as files on a mounted host folder | S3 API for pre-signed URLs, no per-GB fees, data stays on your hardware |
| API | Node + TypeScript (Fastify), a container in the same Docker Compose stack | Simple, typed, close to the DB |
| Jobs | pg-boss (queue inside Postgres) | No extra infrastructure; transactional enqueue |
| Image processing | sharp (libvips) + heic-decode + exifr | Fast resize, HEIC support, EXIF parsing |
| Vision model | GPT-6 Luna via Batch API, reasoning off (Claude Haiku 5.5 as tested fallback) | Tied lowest price; picked on bake-off results (see cost section) |
| Chat model | GPT-6 Luna with function calling; GPT-6.1 Sol for long summaries | Fast, cheap, reliable tool calls |
| Embeddings | OpenAI text-embedding-3-small (1024 dims), same vendor and DPA as the LLM | \~$0.02 / 1M tokens |
| Observability | Sentry + OpenTelemetry + Postgres cost tables | Errors, traces, per-batch cost |
| Payments | RevenueCat (IAP) + Stripe (web) | Store-compliant subscriptions |

## Data model

One Postgres database holds relational data **and** vectors (pgvector), so every search can join filters, permissions and similarity in a single query. Row-level security scopes every table by `baby_id`.

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | id, email, display\_name, created\_at | Auth-managed |
| `babies` | id, name, nickname, birth\_date, birth\_weight\_g, birth\_length\_mm, avatar\_photo\_id, home\_lat/lng (encrypted) | One album space per baby |
| `baby_members` | baby\_id, user\_id, role (`admin` / `contributor`), invited\_by, joined\_at | Max 2 admins enforced by constraint + trigger |
| `invites` | id, baby\_id, email, role, token\_hash, expires\_at, accepted\_at | 7-day expiry |
| `photos` | id, baby\_id, uploaded\_by, storage\_key\_original, sha256, phash, width, height, bytes, mime, status (`uploaded` / `queued` / `analyzing` / `ready` / `failed`), created\_at, deleted\_at | Soft delete, 30-day trash |
| `photo_derivatives` | photo\_id, kind (`thumb` / `display` / `analysis`), storage\_key, width, height, bytes |  |
| `photo_exif` | photo\_id, taken\_at, tz\_offset, gps\_lat/lng (encrypted), place\_label, camera\_make, camera\_model, raw\_json |  |
| `photo_details` | photo\_id, milestone\_id, note, people text\[\], location\_label, edited\_by, updated\_at | Parent-supplied |
| `measurements` | id, baby\_id, photo\_id (nullable), kind (`weight` / `height` / `head`), value\_metric, unit\_entered, measured\_at | Also usable without a photo |
| `milestones` | id, baby\_id (null = global preset), name, category | Presets + custom |
| `photo_ai` | photo\_id, model, prompt\_version, schema\_version, description jsonb, sensitive\_flags text\[\], confidence, batch\_id, created\_at | Full structured JSON |
| `photo_ai_overrides` | photo\_id, field\_path, value, edited\_by | Parent corrections win |
| `photo_search` | photo\_id, baby\_id, search\_text, tsv tsvector, embedding vector(1024), embed\_model, taken\_at, age\_days, milestone\_ids int\[\], people text\[\], tags text\[\], is\_sensitive | Denormalized search row; HNSW index on `embedding`, GIN on `tsv` and `tags` |
| `ai_batches` | id, provider, provider\_batch\_id, status, photo\_count, submitted\_at, completed\_at, input\_tokens, output\_tokens, cost\_usd | Cost tracking per batch |
| `share_links` | id, baby\_id, name, token\_hash, passcode\_hash, expires\_at, allow\_download, revoked\_at |  |
| `share_rules` | share\_link\_id, mode (`all` / `milestones` / `tags`), include\_tags\[\], exclude\_tags\[\] | Auto-share |
| `shared_photos` | share\_link\_id, photo\_id, added\_by (`user` / `rule`), added\_at |  |
| `chat_threads` / `chat_messages` | thread\_id, baby\_id, user\_id, role, content, cited\_photo\_ids\[\], tokens\_in/out, model |  |

### Search document (what gets embedded)

A short, natural-language string is assembled per photo and embedded. Example:

> "Maya, 11 months 2 weeks (2026-06-14), Saturday afternoon at Riverside Park. Milestone: first steps. With Dad. Maya walks barefoot on grass toward Dad, arms out, smiling broadly; wearing a yellow sundress and white sun hat; sunny, outdoor. Note from Mom: 'three wobbly steps then a fall into Dad's arms.'"

Structured facts (date, age, milestone, people, tags, sensitivity) are also stored as columns, so the retriever can **filter first, then rank by similarity**. Vector dimension: 1024 (truncated Matryoshka embedding) to cut index size \~3x with minimal recall loss.

## AI pipeline

Every photo passes through six stages; only stage 3 touches a multimodal model, and it runs through the provider's Batch API at half price.

1. **Ingest** (seconds): upload completes → `photos.status = uploaded` → worker extracts EXIF, computes SHA-256/pHash, generates thumb/display/analysis derivatives, computes baby's age.
2. **Queue** (≤30 min): photo joins the pending batch. The batcher flushes every 30 min or at 1,000 photos.
3. **Describe** (typically minutes, ≤24 h SLA): one Batch API job; each request = analysis image + cached system prompt + per-photo context (age, date, place, parent details).
4. **Validate & store**: JSON validated against the schema; stored in `photo_ai`; sensitive flags set.
5. **Embed**: search document assembled and embedded (batched, \~250 tokens/photo); upserted into `photo_search`.
6. **Post-process**: auto-share rules run; milestone/measurement candidates suggested to parents ("Looks like a first bath. Tag it?").

### Image compression for the model

- Resize long edge to **768 px** (aspect preserved), strip all EXIF, encode JPEG q75 or WebP q70. Typical 60–120 KB vs 3–6 MB originals.
- At 768×576 an image costs a few hundred input tokens on budget vision models (roughly 600 on the providers we priced) instead of \~1,600 or more near full resolution, cutting image tokens \~60% with no meaningful loss for scene-level description. Measure real billed image tokens per provider in the bake-off.
- Never send the original; never send GPS.

### Structured description schema (v1)

```json
{
  "caption": "one sentence, <= 30 words",
  "detailed_description": "2-4 sentences",
  "subjects": [{"who": "baby | adult | child | pet", "relation_hint": "string|null", "is_target_baby": true}],
  "baby_present": true,
  "baby_state": {"pose": "lying | sitting | crawling | standing | walking | held", "expression": "smiling | crying | neutral | sleeping | surprised", "activity": "string"},
  "setting": {"indoor_outdoor": "indoor | outdoor", "place_type": "bedroom | kitchen | park | beach | car | hospital | ...", "weather": "string|null", "time_of_day": "string|null"},
  "objects": ["crib", "teddy bear"],
  "clothing": ["yellow sundress", "sun hat"],
  "activities": ["bath", "feeding", "tummy time", "playing"],
  "possible_milestones": [{"name": "first steps", "confidence": 0.0}],
  "occasion": "birthday | holiday | first day of daycare | null",
  "mood": ["joyful", "calm"],
  "colors": ["yellow", "green"],
  "text_in_image": "string|null",
  "photo_quality": {"blurry": false, "is_screenshot": false, "is_duplicate_like": false},
  "sensitive_content": ["bath", "diaper", "partial_nudity", "medical"],
  "search_tags": ["10-15 short lowercase tags"]
}
```

Rules in the prompt: never guess identities (names come only from parent-supplied `people`); never infer health conditions; report `possible_milestones` only as suggestions; output JSON only. Use the provider's structured-output / tool-schema mode so output is schema-valid by construction.

### Batch flow

- Batcher builds a JSONL of requests with `custom_id = photo_id`; images are sent base64-inline (≈100 KB each, so \~1,000 per batch stays well under request-size limits) or via provider file upload.
- System prompt + schema (\~700 tokens) is marked cacheable; caching discounts stack with the batch discount.
- A poller (or webhook) checks status every 5 min, streams results, writes rows, and records `input_tokens`, `output_tokens`, `cost_usd` per batch.
- Failures (refusals, invalid JSON, expired) are re-queued once into the next batch, then marked `failed` with a manual "retry" button.

### Chat and RAG pipeline

The chat is an **agentic RAG** loop: a small model plans, calls retrieval tools, and answers only from what the tools return.

1. **Understand**: the model receives the question plus baby context (name, birth date, today's date, age) and decides which tools to call.
2. **Tools** (server-side, permission-scoped):
   - `search_photos(query, date_from, date_to, age_from_days, age_to_days, milestones[], people[], tags[], limit)`: hybrid search.
   - `get_measurements(kind, date_from, date_to)`: exact numbers from `measurements`.
   - `get_milestones()`: list of recorded milestones with dates and photo IDs.
   - `get_photo(photo_id)`: full details for one photo.
3. **Hybrid retrieval** inside `search_photos`: SQL filters → top 50 by vector cosine + top 50 by full-text → merged by Reciprocal Rank Fusion → optional re-rank of top 30 by the LLM reading captions → top 12 returned with captions, dates and IDs.
4. **Answer**: short text plus a `photos[]` array the UI renders as a grid. Every fact must cite a photo or measurement ID; if nothing matches, say so and suggest a broader search.
5. **Guardrails**: no medical interpretation; prompt-injection text inside photos (`text_in_image`) is treated as data.

Temporal phrases ("last summer", "when she was 6 months") are resolved by the model into explicit date or age ranges before the tool call; the system prompt includes today's date and the birth date to make this reliable.

## LLM selection and cost

**Recommendation: GPT-6 Luna on the Batch API for photo descriptions and chat, with Claude Haiku 5.5 as the tested fallback.** The two tie on list price ($0.05 input / $0.25 output per 1M tokens on batch, about **$0.00017 per photo**). Luna wins the tiebreakers that lower real billed cost and risk; a 200-photo bake-off makes the final call.

&#91;embedded content: Published batch prices from Anthropic, OpenAI and Google pricing pages, as of Oct 7, 2026 · 1,400 in / 400 out tokens per photo assumed\]

Per-photo assumption: \~600 image tokens (768 px analysis copy) + \~700 cached prompt/schema tokens + \~100 context tokens ≈ 1,400 input; \~400 output tokens of JSON. Batch API halves standard prices on all three providers.

### Head-to-head: the two cheapest options

| Factor | GPT-6 Luna | Claude Haiku 5.5 | Edge |
| --- | --- | --- | --- |
| Batch price, in / out per 1M tokens | $0.05 / $0.25 | $0.05 / $0.25 (prompts up to 100K) | Tie |
| Image input, structured output, tool calling | Yes | Yes | Tie |
| Reasoning cost control | `reasoning.effort: none` turns reasoning tokens off entirely | Adaptive thinking on by default; can be lowered with `effort` | Luna |
| Tokens per text | Not published relative to peers | Newer tokenizer, \~30% more tokens than Haiku 4.5 for the same text | Measure; likely Luna |
| Price jump for long prompts | Above 272K tokens | Above 100K tokens | None (our prompts are \~1.4K) |
| Time in production | Available since May 2026 | Released Oct 7, 2026 | Luna |
| Embeddings from same vendor | Yes (text-embedding-3-small) | No; needs a second vendor | Luna (one DPA, one bill) |

**Biggest hidden cost on both: reasoning tokens.** Both default to medium reasoning, and reasoning tokens bill as output. Left on, they could multiply output cost several times. Set reasoning to none (Luna) or the lowest effort (Haiku) for photo descriptions, and low for chat.

### Options ruled out

- **Gemini 3.1 / 3.5 Flash-Lite:** \~2.8–4x the cost here because output tokens dominate and their output price is 3–5x higher. Fewer image tokens per photo would not close that gap.
- **Gemini free-tier batch:** listed as free for Flash-Lite, but free-tier data may be used to improve Google's products. Not acceptable for children's photos.
- **Self-hosted open-weight vision model:** GPU time and ops work cost more than \~$0.17 per 1,000 photos at our volume (estimate). Revisit above roughly 10M photos a month.
- **Mid-tier models (GPT-6.1 Sol, Claude Sonnet 5.5, Gemini 3.7 Flash):** 7–20x the cost; used only for escalation.

### Bake-off before launch

Run the same 200 photos through GPT-6 Luna, Claude Haiku 5.5 and Gemini 3.1 Flash-Lite. Score schema validity, caption accuracy, milestone detection, sensitive-content recall (most important) and **actual billed cost**, including image and reasoning tokens. Pick the lowest cost per correct description; if quality ties, keep Luna. The pipeline's `VisionDescriber` interface makes switching a config change.

**Escalation tier:** milestone photos, or descriptions with low confidence, can be re-run on GPT-6.1 Sol on Batch ($1 / $5 per 1M, about $0.0034 each; Claude Sonnet 5.5 costs the same). At \~5% of photos this adds about $0.16 per 1,000.

Model facts: [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna) · [Claude Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview)

### Chat cost

| Item | Assumption | Cost |
| --- | --- | --- |
| Chat turn (GPT-6 Luna, standard, low reasoning) | \~2 model calls, \~4,000 input tokens (prompt mostly cached) + \~400 output | \~$0.0005–0.001 |
| Embedding a photo (OpenAI text-embedding-3-small) | \~250 tokens at \~$0.02 / 1M | \~$0.000005 |
| Embedding a query | \~30 tokens | negligible |

### Cost per family (year 1)

Assumes 3,000 photos and 40 chat turns per month for one baby.

| Line | Annual | Notes |
| --- | --- | --- |
| Photo descriptions (GPT-6 Luna batch) | \~$0.51 | 3,000 × $0.00017 |
| Milestone escalation (GPT-6.1 Sol batch, 5%) | \~$0.51 | 150 × $0.0034 |
| Embeddings | \~$0.02 |  |
| Chat | \~$0.25–0.50 | 480 turns |
| **Total AI** | **\~$1.30–1.55** | ≈ $0.12 / month |
| Storage (on-prem disk) | Disk only | \~13.5 GB per family per year (originals + derivatives), plus the same again for off-site backup |

**Takeaway:** AI is not the cost driver; **storage is**, and it grows every year. Price plans by storage (decided: the free tier holds 1,000 photos with no AI; the paid tier at $3.99/month unlocks AI descriptions, search and chat), and plan disk capacity at roughly 13.5 GB per active family per year.

### Cost controls

- Hard per-baby monthly AI budget with alerting; `ai_batches.cost_usd` tracked per batch.
- Skip AI for exact duplicates and screenshots (detected locally before batching). Free-tier photos are never sent to a model; they are described in one backfill batch on upgrade.
- Never re-describe a photo unless the prompt/schema version changes.
- Chat rate limit: 100 turns/day per user.

Sources: [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing) · [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) · [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) · [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) · [OpenAI embeddings pricing (third-party summary)](https://www.costbench.com/software/embedding-apis/openai-embeddings/)

## Non-functional requirements

### Privacy and child safety (highest priority)

- **Private by default.** No photo is ever public; every media URL is a signed URL valid ≤ 1 hour, scoped to one object.
- **No training on customer data.** Use only provider tiers whose terms exclude API data from training; sign each provider's DPA. Batch input files are deleted from the provider after results are retrieved.
- **No face recognition / biometric templates** in v1 (avoids BIPA/GDPR special-category exposure). People are identified only by parent-entered names.
- **Sensitive-content gate**: bath, diaper, nudity and medical photos are never auto-shared, never shown in viewer chat, and are blurred in the share-link grid until an admin explicitly shares them.
- **Location privacy**: GPS encrypted at rest (pgcrypto / KMS), stripped from all served derivatives, shown to admins only as a coarse place label.
- **Abuse safeguards**: hash-match uploads against known-CSAM hash lists (e.g. PhotoDNA or equivalent) as required by app-store and legal expectations for photo-hosting services; report flow per NCMEC obligations.

### Compliance

- Users are adults (parents); the app is not directed at children, but it processes children's data, so treat it under **GDPR Art. 8 / UK Age Appropriate Design Code** principles and **COPPA-adjacent** caution (no ads, no tracking SDKs, no data sale).
- Privacy policy, data map, DPA list, deletion SLAs (FR-10) and a records-of-processing doc before launch. EU data residency is not required at launch; GDPR still applies to any EU families who sign up.
- App Store privacy "nutrition label" and Google Play Data Safety form completed accurately.

### Security

- Postgres row-level security on every table keyed by `baby_id` membership; share-link access via a separate, narrowly scoped role.
- Share tokens ≥ 128-bit random, stored hashed; passcode attempts rate-limited (5 / 15 min).
- Secrets in a managed vault; least-privilege keys for workers; audit log for admin actions.
- OWASP ASVS L2 as the baseline; third-party penetration test before public launch.

### Performance

| Metric | Target |
| --- | --- |
| Upload throughput | 500 photos over Wi-Fi in < 5 min (background) |
| Thumbnail visible after upload | < 5 s (p95) |
| AI description available | p50 < 1 h, p99 < 24 h |
| Chat first token | < 2 s (p95) |
| Chat full answer with photo grid | < 5 s (p95) |
| Timeline scroll | 60 fps with 10,000 photos (virtualized grid) |
| Search query (hybrid) | < 300 ms DB time at 50k photos / baby |

### Reliability and operations

- 99.9% monthly availability for API and media.
- Originals: files on the mounted storage folder (ideally a RAID or ZFS mirror) with MinIO versioning, plus a nightly encrypted off-site copy; Postgres nightly pg\_dump kept 35 days and copied off-site too. Restore tested monthly. A UPS and auto-restart (restart: unless-stopped) cover on-prem power blips.
- Batch pipeline is idempotent (`custom_id = photo_id`); reprocessing safe.
- Observability: structured logs, traces, per-batch cost and failure dashboards, alert if queue age > 2 h.

### Accessibility and UX

- WCAG 2.2 AA: alt text for every photo is the AI caption (editable); dynamic type; VoiceOver/TalkBack labels; 44 px touch targets.
- Dark mode; works one-handed; offline viewing of recently opened photos.
- Localization-ready (i18n keys); English at launch; metric/imperial toggle.

## Mobile and Capacitor

One React + TypeScript codebase ships as a responsive web app (PWA) and as native iOS and Android apps through **Capacitor**. Mobile is the primary surface: every screen is designed at 375 px width first.

### Frontend stack

- **React + Vite + TypeScript**, **Ionic React** components for native-feeling navigation (tabs, swipe-back, pull-to-refresh), **Tailwind** for custom styling.
- **TanStack Query** for server state and offline cache; **virtualized photo grid** (e.g. `react-virtuoso`) for 10k+ photos.
- Bottom tab bar: **Chat** (home) · **Timeline** · **Upload (+)** · **Milestones** · **Family** (sharing).
- Safe-area insets, haptics on key actions, native share sheet, splash screen and adaptive icons.

### Capacitor plugins

| Need | Plugin | Notes |
| --- | --- | --- |
| Pick many photos from library | `@capacitor/camera` (`pickImages`) or a multi-picker community plugin | Request limited/full Photos access; handle iOS "Selected Photos" mode |
| Take a photo in-app | `@capacitor/camera` |  |
| Background, resumable upload | Native background upload plugin (URLSession / WorkManager) | Uploads continue when app is backgrounded |
| Read EXIF before upload | Read file via `@capacitor/filesystem` + `exifr` in JS | Server re-extracts as source of truth |
| Push notifications ("23 photos analyzed", "Grandma viewed the album") | `@capacitor/push-notifications` + FCM/APNs | Opt-in |
| Share link to family | `@capacitor/share` |  |
| Secure token storage | Keychain/Keystore secure-storage plugin | Never localStorage for refresh tokens |
| Deep links to share albums | `@capacitor/app` + Universal Links / App Links | `tinyglow.app/s/{token}` opens app if installed, web otherwise |
| Sign in with Apple / Google | Native auth plugins | Apple Sign-In mandatory on iOS when Google login exists |
| Biometric app lock (optional) | Biometric auth plugin | P2 |

### App store requirements

- **iOS**: `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`, `NSCameraUsageDescription` strings in plain language; privacy manifest (`PrivacyInfo.xcprivacy`) declaring required-reason APIs; account deletion available in-app; Sign in with Apple.
- **Android**: Android 13+ granular media permission (`READ_MEDIA_IMAGES`) or the system Photo Picker (preferred, needs no permission); target the current required API level; Data Safety form.
- **Both**: in-app account deletion, privacy policy URL, AI-feature disclosure in the listing, age rating 4+ / Everyone, review notes with a demo account preloaded with sample (non-real) baby photos.
- **Payments**: subscriptions sold in-app must use Apple IAP / Google Play Billing (e.g. via RevenueCat); web checkout via Stripe for the web app.
- **Release**: Fastlane or Appflow for builds; OTA web-layer updates (Capgo / Appflow Live Updates) for JS-only fixes within store policy.

### Responsive web

- Breakpoints: phone (<640 px) single column; tablet 2-pane (timeline + viewer); desktop 3-pane (chat · grid · details) with drag-and-drop bulk upload.
- Installable PWA for family viewers who won't download an app; share links always work in any mobile browser with no install.

## Launch plan, metrics and risks

### Release roadmap

&#91;embedded content: release roadmap · 4 phases, 3 gates\]

A private beta with \~50 families runs during the last phase; the web app can open to beta users at the end of Chat + sharing.

### Success metrics

| Metric | Target (90 days post-launch) |
| --- | --- |
| New families uploading ≥ 50 photos in week 1 | 60% |
| Chat searches where the user opens a returned photo | ≥ 70% |
| Golden-set retrieval: right photo in top 5 (200 queries) | ≥ 85% |
| Photos whose AI description a parent corrects | < 5% |
| Families with an active share link within 30 days | 50% |
| Week-4 retention | 40% |
| All-in AI cost per photo | ≤ $0.0005 |

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Sensitive photo reaches a share link | Severe trust and safety harm | AI sensitive flags, never auto-share, blur by default, admin-only release, audit log |
| AI invents a milestone or names a person | Loss of trust | Milestones are suggestions; names only from parents; edits override AI |
| Batch turnaround up to 24 h feels slow | Users think search is broken | "Analyzing" state, push when done, real-time path for milestone photos |
| Model prices or versions change | Cost or quality drift | `VisionDescriber` abstraction, re-run bake-off each quarter, budget alerts |
| App-store rejection (photo permissions, AI disclosure) | Launch slip | System photo picker, clear usage strings, demo account, AI disclosure in listing |
| Storage cost compounds yearly | Margin squeeze | Storage-based plans; disk alerts at 80% full; add disks before they are needed |
| Data breach | Catastrophic | RLS, signed URLs, encryption, pen test, minimal data collection |

### Decisions

- [ ] Free tier size: 1,000 photos, or unlimited photos with paid AI search?
  - [ ] Free tier size: 1,000 photos, with paid AI search
- [ ] Ship the Contributor role (nanny, grandparent uploads) in v1 or v1.1?
  - [ ] v1
- [ ] Should share-link viewers get chat at all, or only a browsable album?
  - [ ] only browsable album
- [ ] Is EU data residency needed at launch?
  - [ ] no
- [ ] Video support timing (v2) and whether to describe short clips via keyframes.
  - [ ] v2
- [ ] Sharelinks should have a 1 day expiration date.

## Build handoff for Claude Code

Build in the order below; each step ends with acceptance checks that must pass before the next starts. Everything above this section is the spec; where this section and the spec disagree, the spec wins.

### Repo layout (pnpm monorepo, TypeScript everywhere)

```text
tinyglow/
  apps/
    mobile-web/        React + Vite + Ionic; Capacitor ios/ and android/ projects
    api/               Fastify API (REST + SSE for chat streaming)
    worker/            pg-boss workers: ingest, batcher, poller, embedder, auto-share
  packages/
    db/                SQL migrations, RLS policies, seed data, generated types
    shared/            zod schemas (AI description schema v1, API DTOs), constants
    ai/                VisionDescriber + ChatModel interfaces, OpenAI and Anthropic adapters
  docker/              nginx and GoTrue config, email templates
  docker-compose.yml
  docker-compose.dev.yml
  .env.dev
  .env.example
```

### Environment variables

| Variable | Used by | Notes |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | app, api | Public anon key in the client only |
| `SUPABASE_SERVICE_ROLE_KEY` | api, worker | Server only, never shipped to the client |
| `DATABASE_URL` | api, worker, db | Direct Postgres connection for pg-boss and migrations |
| `S3_ENDPOINT, S3_PUBLIC_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, STORAGE_PATH, BACKUP_PATH` | api, worker | Pre-signed upload/download URLs; MinIO in every environment; the two paths are production host folders |
| `OPENAI_API_KEY` | worker, api | Vision batch, chat, embeddings |
| `ANTHROPIC_API_KEY` | worker | Fallback / bake-off adapter only |
| `VISION_PROVIDER`, `VISION_MODEL`, `CHAT_MODEL`, `EMBED_MODEL` | worker, api | Defaults: `openai`, `gpt-6-luna`, `gpt-6-luna`, `text-embedding-3-small` |
| `APPLE_*`, `GOOGLE_*` OAuth client IDs | supabase, app | Per platform |
| `POSTMARK_TOKEN` (or `RESEND_API_KEY`) | supabase, api | Auth and invite emails |
| `REVENUECAT_*`, `STRIPE_*` | api | Entitlement webhooks |
| `SENTRY_DSN` | all | Errors and traces |

### Build order

1. **Scaffold:** monorepo, lint/format, CI (typecheck + tests), Dockerfiles, docker-compose.yml (production) and docker-compose.dev.yml (local), per Docker Compose setup, `.env.example`.
   - Check: `docker compose up` -f docker-compose.dev.yml up starts every service healthy from a clean clone with no folders or env files to create; the web app loads at http://localhost:8080; an OTP email arrives in Mailpit; CI builds every image.
2. **Database:** all tables from Data model and Auth data model, RLS policies, helper functions, seed with one demo family.
   - Check: RLS tests prove a user cannot read another baby's rows; a contributor cannot delete; a viewer role sees only `shared_photos`.
3. **Auth and onboarding:** email OTP, Apple, Google; sign-up flow steps 1–8; invites; account deletion.
   - Check: e2e test signs up, creates a baby, invites a co-admin, and the invitee accepts with the matching email; mismatched email is rejected.
4. **Upload and ingest:** pre-signed multipart upload, background upload on mobile, EXIF, hashes, derivatives, age calculation, dedupe, contributor approval queue.
   - Check: 200-photo bulk upload completes; duplicates skipped; HEIC converts; thumbnails visible within 5 s; GPS absent from served derivatives.
5. **Timeline and viewer:** age-grouped timeline, photo viewer, details editing, milestones and measurements.
   - Check: 10,000 seeded photos scroll smoothly; edits persist.
6. **AI batch pipeline:** analysis copies, batcher, Batch API submit/poll, schema validation, sensitive flags, cost tracking, paid-tier gate and upgrade backfill.
   - Check: 50 sample photos produce schema-valid JSON; `ai_batches.cost_usd` recorded; free-tier photos are never submitted.
7. **Search and chat:** search document + embeddings, hybrid retrieval (filters + vector + full-text + RRF), chat tools, streaming answers with photo grids.
   - Check: golden set of 50 queries on seed data finds the right photo in the top 5 at least 85% of the time; answers cite photo IDs.
8. **Sharing:** share links (24 h default, renew, passcode, revoke), viewer sessions, manual add, auto-share rules, sensitive-photo gate.
   - Check: expired or revoked link returns the expired page; sensitive photos never auto-share.
9. **Mobile release:** Capacitor iOS/Android builds, push, deep links (`/invite`, `/s`, auth callback), store metadata, privacy manifest.
   - Check: TestFlight and Play internal builds install; invite and share links open the app.

### Conventions

- Validate every API input and every model output with the zod schemas in `packages/shared`.
- Model calls go only through `packages/ai` adapters so the vision and chat models are config, not code.
- Never log photo bytes, GPS, or full AI prompts containing parent notes.
- Each migration is reversible; RLS policy changes need a test.

### Docker Compose setup

Two Compose files share the same Dockerfiles. Production runs on an on-prem server reached only through Cloudflare Tunnel, with photos on a mounted folder. Development runs on any laptop with nothing to create but Docker.

|  | `docker-compose.dev.yml` (local) | `docker-compose.yml` (on-prem production) |
| --- | --- | --- |
| Start | `docker compose -f docker-compose.dev.yml up` | `docker compose up -d` |
| Folders to create | None (named Docker volumes only) | `STORAGE_PATH` (mounted photo folder), `BACKUP_PATH` |
| Config | `.env.dev` committed with safe dev defaults | `.env` on the server, never committed |
| Photo storage | MinIO on named volume `dev-s3` | MinIO with `${STORAGE_PATH}` bind-mounted at `/data` |
| Database | Named volume `dev-db` | Named volume `db-data` + nightly `pg_dump` to `BACKUP_PATH` |
| Email | Mailpit catches all mail (UI on port 8025) | Postmark or Resend over SMTP |
| How it is reached | `localhost` ports | Cloudflare Tunnel; no ports open on the server |
| Code | Source bind-mounted, hot reload (`tsx watch`, `vite dev`) | Built images |
| Seed data | Demo family seeded on first start | None |
| AI | Runs if `OPENAI_API_KEY` is set in `.env.local`, otherwise skipped with a log line | Required |

### Routing through Cloudflare Tunnel

`cloudflared` runs as a Compose service with a tunnel token; the server opens no inbound ports. Configure two public hostnames on the tunnel:

| Public hostname | Service | Notes |
| --- | --- | --- |
| `tinyglow.app` | `http://web:80` | nginx serves the app and proxies `/api/` → `api:3000` and `/auth/` → `auth:9999`, stripping the prefix |
| `files.tinyglow.app` | `http://storage:9000` | MinIO for pre-signed upload/download URLs; keep the original Host header so signatures validate |

- Sending everything for the main hostname to nginx keeps one origin (no CORS) and handles prefix stripping, which Tunnel routes cannot do.
- Cloudflare caps request bodies at 100 MB on Free and Pro plans, so multipart upload parts must stay at or under 50 MB.
- Photo traffic goes through Cloudflare; review Cloudflare's terms on media-heavy sites before launch.
- Optional: put Cloudflare Access in front of the MinIO console (`:9001`) if it is ever exposed; by default it is not routed.

### Production: `docker-compose.yml`

```yaml
name: tinyglow
x-app: &app
  restart: unless-stopped
  env_file: .env

services:
  db:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: tinyglow
    volumes: [db-data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 10

  migrate:
    build: { context: ., dockerfile: packages/db/Dockerfile }
    env_file: .env
    depends_on: { db: { condition: service_healthy } }

  auth:
    image: supabase/auth            # pin a release tag
    restart: unless-stopped
    depends_on: { migrate: { condition: service_completed_successfully } }
    environment:
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:${AUTH_DB_PASSWORD}@db:5432/tinyglow
      GOTRUE_JWT_SECRET: ${JWT_SECRET}
      GOTRUE_SITE_URL: https://tinyglow.app
      API_EXTERNAL_URL: https://tinyglow.app/auth
      GOTRUE_MAILER_OTP_EXP: "600"
      GOTRUE_SMTP_HOST: ${SMTP_HOST}
      GOTRUE_SMTP_PORT: ${SMTP_PORT}
      GOTRUE_SMTP_USER: ${SMTP_USER}
      GOTRUE_SMTP_PASS: ${SMTP_PASS}
      GOTRUE_EXTERNAL_APPLE_ENABLED: "true"
      GOTRUE_EXTERNAL_GOOGLE_ENABLED: "true"

  storage:
    image: minio/minio               # pin a release tag
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${S3_ACCESS_KEY}
      MINIO_ROOT_PASSWORD: ${S3_SECRET_KEY}
      MINIO_SERVER_URL: https://files.tinyglow.app
    volumes:
      - ${STORAGE_PATH:?Set STORAGE_PATH to the mounted photo folder}:/data

  storage-init:
    image: minio/mc
    depends_on: [storage]
    env_file: .env
    entrypoint: >
      sh -c "mc alias set local http://storage:9000 $$S3_ACCESS_KEY $$S3_SECRET_KEY &&
             mc mb -p local/$$S3_BUCKET && mc version enable local/$$S3_BUCKET"

  api:
    <<: *app
    build: { context: ., dockerfile: apps/api/Dockerfile }
    depends_on:
      migrate: { condition: service_completed_successfully }
      storage: { condition: service_started }

  worker:
    <<: *app
    build: { context: ., dockerfile: apps/worker/Dockerfile }
    depends_on: { migrate: { condition: service_completed_successfully } }

  web:
    <<: *app
    build: { context: ., dockerfile: apps/mobile-web/Dockerfile }
    depends_on: [api, auth]

  cloudflared:
    image: cloudflare/cloudflared    # pin a release tag
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on: [web, storage]

  backup:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      PGHOST: db
      PGUSER: postgres
      PGPASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - ${BACKUP_PATH:?Set BACKUP_PATH to a backup folder}:/backups
    entrypoint: >
      sh -c "while true; do
               pg_dump tinyglow | gzip > /backups/tinyglow-$$(date +%F).sql.gz;
               find /backups -name '*.sql.gz' -mtime +35 -delete;
               sleep 86400; done"

volumes:
  db-data:
```

### Development: `docker-compose.dev.yml`

```yaml
name: tinyglow-dev
x-dev: &dev
  env_file: [.env.dev, { path: .env.local, required: false }]

services:
  db:
    image: pgvector/pgvector:pg17
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: tinyglow }
    volumes: [dev-db:/var/lib/postgresql/data]
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 10

  migrate:
    <<: *dev
    build: { context: ., dockerfile: packages/db/Dockerfile }
    command: pnpm db:migrate && pnpm db:seed   # seed is idempotent
    depends_on: { db: { condition: service_healthy } }

  auth:
    image: supabase/auth            # same tag as production
    depends_on: { migrate: { condition: service_completed_successfully } }
    environment:
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:dev@db:5432/tinyglow
      GOTRUE_JWT_SECRET: dev-only-jwt-secret-at-least-32-characters
      GOTRUE_SITE_URL: http://localhost:8080
      API_EXTERNAL_URL: http://localhost:8080/auth
      GOTRUE_MAILER_OTP_EXP: "600"
      GOTRUE_SMTP_HOST: mail
      GOTRUE_SMTP_PORT: "1025"
      GOTRUE_MAILER_AUTOCONFIRM: "false"
    ports: ["9999:9999"]

  storage:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: dev, MINIO_ROOT_PASSWORD: devdevdev }
    volumes: [dev-s3:/data]
    ports: ["9000:9000", "9001:9001"]

  storage-init:
    image: minio/mc
    depends_on: [storage]
    entrypoint: >
      sh -c "mc alias set local http://storage:9000 dev devdevdev &&
             mc mb -p local/tinyglow-dev"

  mail:
    image: axllent/mailpit
    ports: ["8025:8025"]

  api:
    <<: *dev
    build: { context: ., dockerfile: apps/api/Dockerfile, target: dev }
    command: pnpm --filter @tinyglow/api dev        # tsx watch
    volumes:
      - ./apps/api/src:/repo/apps/api/src
      - ./packages/shared/src:/repo/packages/shared/src
      - ./packages/ai/src:/repo/packages/ai/src
    depends_on: { migrate: { condition: service_completed_successfully } }
    ports: ["3000:3000"]

  worker:
    <<: *dev
    build: { context: ., dockerfile: apps/worker/Dockerfile, target: dev }
    command: pnpm --filter @tinyglow/worker dev
    volumes:
      - ./apps/worker/src:/repo/apps/worker/src
      - ./packages/shared/src:/repo/packages/shared/src
      - ./packages/ai/src:/repo/packages/ai/src
    depends_on: { migrate: { condition: service_completed_successfully } }

  web:
    <<: *dev
    build: { context: ., dockerfile: apps/mobile-web/Dockerfile, target: dev }
    command: pnpm --filter @tinyglow/mobile-web dev --host 0.0.0.0 --port 8080
    volumes:
      - ./apps/mobile-web/src:/repo/apps/mobile-web/src
      - ./packages/shared/src:/repo/packages/shared/src
    depends_on: [api, auth]
    ports: ["8080:8080"]

volumes:
  dev-db:
  dev-s3:
```

### Compose requirements

- **Zero-setup dev:** a fresh clone runs `docker compose -f docker-compose.dev.yml up` with no folders to create and no `.env` to write. `.env.dev` (committed) holds dev-only defaults; personal secrets like `OPENAI_API_KEY` go in an optional, git-ignored `.env.local`.
- **Same routes in both:** the Vite dev server proxies `/api` and `/auth` exactly like production nginx, so the app always calls relative URLs.
- **Storage:** code reads `S3_ENDPOINT` (internal, e.g. `http://storage:9000`) for server-side access and signs URLs with `S3_PUBLIC_ENDPOINT` (`http://localhost:9000` in dev, `https://files.tinyglow.app` in production). In production the photos live as files under `STORAGE_PATH`; MinIO versioning is on.
- **Mounted folder checks:** the `api` and `worker` healthchecks fail if storage is unreachable, and the worker raises an alert when the storage disk passes 80% full.
- **Off-site copy:** a nightly encrypted copy of `STORAGE_PATH` and `BACKUP_PATH` to off-site storage (for example restic to Backblaze B2), run by host cron or an added Compose service. Test a restore monthly.
- **Dockerfiles:** multi-stage with a `dev` target (deps installed, source mounted) and a slim `node:22-alpine` production target running as a non-root user; healthchecks on `api` (`/healthz`) and `worker` (heartbeat row).
- **Migrations:** the `migrate` job also creates the `supabase_auth_admin` role and `auth` schema GoTrue needs, before GoTrue's own migrations run.
- **Scaling:** `worker` scales with `--scale worker=3`; pg-boss runs each job once.
- **Phones in dev:** set `VITE_API_URL` and `S3_PUBLIC_ENDPOINT` to the laptop's LAN IP, or use a temporary Cloudflare Tunnel, so a physical phone can reach the dev stack.
- **Reset:** `pnpm dev:reset` runs `docker compose -f docker-compose.dev.yml down -v` and starts fresh with the demo family.

### Decisions to confirm before step 1

- **Domain (decided):** `tinyglow.app` serves the web app, `/api` and `/auth` from one origin; `files.tinyglow.app` serves photo storage for pre-signed URLs. The web container also serves `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` for invite and share deep links.
- **Hosting (decided):** the API, worker, auth, database, storage and web app all run in the one Docker Compose stack on an on-prem server, reached only through Cloudflare Tunnel, with photos on a mounted folder. No separate API host.
- **Paid-tier price point:** decided, $3.99/month.
