# Roadmap after step 11: candidate features and recommended order

Status: proposed (architect, 2026-10-11) for the user's "start working on video uploads, passkey
auth, etc." Steps 12 (video, `docs/plans/step-12.md`) and 13 (passkeys, `docs/plans/step-13.md`)
are planned; this file ranks the "etc." Sizes: S ≈ 1–2 agent-days of build + test, M ≈ 3–5,
L ≈ 6+. Everything here keeps the PRD-wide rules (RLS on every table, no GPS in derivatives,
sensitive gate, no model calls for free albums) and the step-11 family model.

## Decisions (user, 2026-10-11; all questions closed)

| # | Decision | Value |
| --- | --- | --- |
| R1 | Next step after passkeys | **Billing before any public release** (step-9 decision: billing is a separate step; until then Plus is granted by hand with `db:plan`). Renumbered 2026-10-11: the user's live-updates request became **step 14** (`docs/plans/step-14.md`), so billing is **step 15** |
| R2 | Plus scope when billing lands | **Per family** (one subscription covers twins/siblings; `families.id` exists; the pool already excludes Plus albums). Price stays $3.99/month |
| R3 | Web checkout | **Stripe on web too** (PRD "Payments"; RevenueCat keeps entitlements in sync); native apps keep no purchase prompts until store review passes |
| R4 | Android album sync (needs `READ_MEDIA_*` full-library permission and Play policy review) | **Deferred** until iOS sync has real users; Photo Picker path only |
| R5 | Languages at launch | **English only**; keys are i18n-ready; first two languages picked later (Spanish, German likely) |
| R6 | Printing / photo books | **Not before public launch** (PRD non-goal; needs a print partner, payments, address data) |
| Order | 12 video → 13 passkeys → 14 live updates (OTA web bundle; user request 2026-10-11) → 15 billing + family-level Plus → 16 step-9 Part B + hardening → 17 Live Photos + real-time AI → 18 languages → 19 Android sync → printing later | **Accepted** (14 inserted by the user's request; the rest shifts by one) |

## Candidates

### A. Billing: RevenueCat (App Store / Play) + Stripe (web) — **M–L**, step 15

Entitlement webhooks (`REVENUECAT_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET` already in the env
table) → a `subscriptions` table (FORCE RLS) → `babies.plan` / per-family plan (R2) with
`entitlement_expires_at`, grace periods, downgrade → `baby_members_release_plan` behaviour kept
(plan reverts when the paying parent leaves), upgrade → `ai.backfill {reason: upgrade}` and
`search.backfill` (exist). Web: Stripe Checkout + Customer Portal links from Settings; native:
RevenueCat SDK plugin (`@revenuecat/purchases-capacitor`) with the paywall in Settings and the
existing upsell spots; store products ($3.99/month, one SKU). Operator: `db:plan` stays as the
manual override, audited. Depends on: store accounts (step-9 Part B U3/U5/U9), Stripe account,
RevenueCat project, terms/privacy text. Risk: Apple's rule that digital goods bought in-app go
through IAP — web checkout is fine as long as the app never links to it (keep "Plus on the web"
copy out of native, as today).

### B. Family-level Plus — **S** when done inside A, **M** alone

Move `plan`, `plan_owner_user_id`, `entitlement_expires_at` from `babies` to `families` (or add
`families.plan` and make `baby_ai_enabled()` read the family), update the paid-tier helpers
(`baby_ai_enabled`, `ai_eligible_photos`, search policies, `shared_photos_gate`), the pool (free
families only), `db:plan` (per family), and the usage lines. Depends on: R2, step 11 committed.
Do it as part of A so the subscription key is created once.

### C. Step 9 Part B: store release, Android runtime gate, go-live hardening — **M**, step 16

Everything in `docs/plans/step-9.md` 5.2 (Team ID, signing, APNs, Play Console, Firebase, AASA/
assetlinks deploy, review account on production, listings), plus the open ops items: Android
runtime gate on a real phone or newer emulator, CSP enforcing (`WEB_CSP_HEADER`), Sentry DSNs,
SMTP/Turnstile/CSAM provider, real GitHub CI run, third-party pen test (PRD "Security"), and the
pre-launch model bake-off. Depends on: the user's accounts; nothing in code. Passkeys Part B (step
13, 5.3) rides along.

### D. Live Photos — **S**, after step 12

Upload the paired MOV of a Live Photo as a derivative of the photo row (`photo_derivatives.kind
= 'live'`, ≤ 3 s, remuxed H.264/AAC, metadata stripped), never as a second item; viewer plays it
on long-press; share viewer the same; export includes it next to the HEIC. Native picker already
keeps originals (`PHAssetResourceType.pairedVideo` on iOS; Android Motion Photos embed the MP4 in
the JPEG — detect the `MotionPhoto` XMP and split). Depends on: step 12's ffmpeg worker and
`derivativeKey` extension. Decision Q5 of step 12 defers it here.

### E. Android album sync — **M**

Mirror of the iOS `TinyglowPhotoSync`: `MediaStore` query of one album (bucket) with
`READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO` (or `READ_MEDIA_VISUAL_USER_SELECTED` for a partial
grant), WorkManager periodic job on unmetered network, same on-device ledger and server status
rows (`import_sources.kind = 'android_media_store'`). Depends on: R4, Play Data Safety and
permission-policy declarations (photo/video permission review), Android runtime gate (C). Note
Android strips nothing itself, so GPS handling matches iOS.

### F. Real-time AI priority path (FR-5.5) — **S–M**

`describeOne` exists in `packages/ai` but is unwired. Trigger: a milestone-tagged upload or a user
waiting on the viewer of a paid album → `ai.describe-now` job (standard tier, ~2× batch price,
same schema/validation/sensitive sync, same budget ledger), with a per-baby cap (e.g. 20/day) so
the batch path stays the default. Depends on: nothing new; small `ai_batch_items` extension
(`tier` column). Good value for the "analyzing…" UX the PRD worries about.

### G. Multiple languages — **M**

UI: the i18n keys exist (`i18n/en.ts`); add a locale switch (profile `locale`), date/number
formatting via `Intl` (already), store listings per locale. AI: captions/descriptions are
generated in English today — add `language` to the per-item context (not the cached system
prompt) so new descriptions come out in the family's language, and a `version` backfill for
existing ones (costly: re-describes everything, so offer it as an opt-in button); search works
cross-lingual with `text-embedding-3-small` but the full-text leg needs the right `regconfig`
(`photo_search.tsv` per language). Chat answers follow the user's locale via the prompt. Depends
on: R5. Reviewer should check copy length in the design system at 375 px.

### H. Printing / photo books — **L**

Order prints or a yearly book from selected photos through a print-on-demand API (Prodigi/
Pwinty-class partner), with payments (A), shipping addresses (new PII: encrypt, purge with the
account), and a layout tool. PRD non-goal for v1; only after A and C. Depends on: R6, a partner
account, tax handling.

### I. Smaller follow-ups worth a half-step each — **S**

- Reverse geocoding to a coarse place (FR-4.3 "city, park") once a geocoder that may receive GPS
  is approved (open since step 4; candidates: self-hosted Nominatim/Photon to keep coordinates
  in-house).
- `?photo=` deep link with `around=<photoId>` listing; viewer restores grid scroll (step-5 notes).
- Anthropic chat adapter (fallback parity with vision).
- Operator dashboard for the abuse/storage report (today a CLI); `log_error_verbosity = terse` on
  the production database.
- Biometric app lock on native (PRD P2), TOTP second factor (PRD P2) — after passkeys land, low
  demand.

## Order (accepted by the user, 2026-10-11)

| Step | Feature | Size | Why here |
| --- | --- | --- | --- |
| 12 | Video uploads | L | user request; drives storage planning before pricing |
| 13 | Passkeys | M | user request; GoTrue-native, mostly web + API; native verification waits for Part B |
| 14 | Live updates: OTA web bundle (`docs/plans/step-14.md`) | M | user request 2026-10-11; a web deploy reaches the installed apps without a store release; in-house signed updater, no third-party service |
| 15 | Billing (A) with family-level Plus (B) | M–L | required before any public release; one subscription key for families |
| 16 | Step 9 Part B + go-live hardening (C) | M | needs the user's accounts; unblocks native passkeys, real push, store review |
| 17 | Live Photos (D) + real-time AI path (F) | S + S–M | small, user-visible polish on top of 12 and the AI pipeline |
| 18 | Languages (G) | M | after launch feedback decides the first locales |
| 19 | Android album sync (E) | M | only if iOS sync usage justifies the permission-policy review |
| later | Printing (H), follow-ups (I) | L / S | post-launch |

Step 14 (live updates) is planned (`docs/plans/step-14.md`) and starts after the step-13 commit.
Step 15 (billing + family-level Plus) is planned when step 14 is committed, on R1–R3 as decided
above; steps 12 and 13 proceed on the decisions recorded in their plans. Step 12's build starts
only after the step-11 commit.
