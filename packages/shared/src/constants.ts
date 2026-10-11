import type { MilestoneCategory } from "./db-enums";

// Shared constants (docs/plans/step-1.md 2.10, docs/plans/step-2.md 2.11, docs/plans/step-5.md 2.6). Model names are config defaults, not code paths:
// every model call goes through packages/ai adapters, which read these as fallbacks.

export const APP_NAME = "Tinyglow";

/** Browser path prefix proxied to the API (Vite dev proxy and production nginx strip it). */
export const API_PREFIX = "/api";
/** Browser path prefix proxied to self-hosted GoTrue. */
export const AUTH_PREFIX = "/auth";

/** Embedding dimensions (text-embedding-3-small truncated to 1024). */
export const EMBED_DIMS = 1024;

export const DEFAULT_VISION_PROVIDER = "openai";
export const DEFAULT_VISION_MODEL = "gpt-6-luna";
export const DEFAULT_VISION_REASONING_EFFORT = "none";
export const DEFAULT_CHAT_MODEL = "gpt-6-luna";
export const DEFAULT_CHAT_REASONING_EFFORT = "low";
export const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

/**
 * Estimated cost of describing one photo on the default model (gpt-6-luna, Batch API: ~1,400
 * input tokens with the cached prefix, ~400 output). UI copy, the usage endpoint and the flush's
 * per-photo budget check use it; recorded costs always come from the price table in
 * `packages/ai`. Budgets and flush thresholds are env settings (`AI_PIPELINE_DEFAULTS`).
 */
export const AI_COST_PER_PHOTO_ESTIMATE_USD = 0.00017;

/** Share links expire after 24 hours by default (`share_links.expires_at` default, CLAUDE.md). */
export const SHARE_LINK_DEFAULT_TTL_HOURS = 24;

/**
 * Free-tier photo cap, per family (step 11): the approved photos of all free, live albums of one
 * family (`babies.family_id`) share it; pending photos, Plus albums and trashed albums do not
 * count. Mirrored by the hard-coded 1000 in the SQL `photos_free_tier_cap()` trigger.
 */
export const FREE_TIER_PHOTO_LIMIT = 1000;

/**
 * Default most live pending (unapproved) photos one uploader may have across one family, every
 * plan (step 11, D-C, D-D). Mirror of the SQL default in `public.pending_photo_limit()`; the
 * operator overrides the database value with `ALTER DATABASE … SET app.pending_photo_limit`, so
 * the API reads the effective limit from the database, never from this constant.
 */
export const PENDING_PHOTOS_PER_GUEST_PER_FAMILY = 200;

/** At most two admins per baby (enforced by the `baby_members_max_two_admins` trigger). */
export const MAX_ADMINS_PER_BABY = 2;

/** Invites expire after 7 days (`invites.expires_at` default). */
export const INVITE_TTL_DAYS = 7;

/** Invite rate limit per baby per rolling 24 hours (`invites_rate_limit` trigger). */
export const INVITES_PER_BABY_PER_DAY = 20;

/** Soft-deleted photos and babies are purged after this many days (FR-10.2, FR-10.3). */
export const PHOTO_TRASH_DAYS = 30;

/** Radius around the encrypted home location treated as "home" (place labels). */
export const HOME_RADIUS_M = 150;

/** Custom milestones per baby (`milestones_cap` trigger: "milestone limit reached"). */
export const MAX_CUSTOM_MILESTONES_PER_BABY = 200;

/** Photos per timeline page (`GET /babies/:id/photos?limit=`; also the endpoint's max). */
export const TIMELINE_PAGE_SIZE = 200;

export interface MilestonePreset {
  readonly id: string;
  readonly name: string;
  readonly category: MilestoneCategory;
  readonly sortOrder: number;
}

/**
 * Global milestone presets (`milestones` rows with `baby_id IS NULL`), inserted by the photos
 * migration with these fixed ids (docs/plans/step-2.md 2.8). Must match the migration exactly;
 * an integration test asserts it. `sortOrder` = NN x 10.
 */
export const MILESTONE_PRESETS: readonly MilestonePreset[] = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    name: "First smile",
    category: "social",
    sortOrder: 10,
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    name: "First laugh",
    category: "social",
    sortOrder: 20,
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    name: "Rolled over",
    category: "motor",
    sortOrder: 30,
  },
  { id: "10000000-0000-4000-8000-000000000004", name: "Sat up", category: "motor", sortOrder: 40 },
  {
    id: "10000000-0000-4000-8000-000000000005",
    name: "First food",
    category: "feeding",
    sortOrder: 50,
  },
  {
    id: "10000000-0000-4000-8000-000000000006",
    name: "First tooth",
    category: "growth",
    sortOrder: 60,
  },
  { id: "10000000-0000-4000-8000-000000000007", name: "Crawled", category: "motor", sortOrder: 70 },
  {
    id: "10000000-0000-4000-8000-000000000008",
    name: "First steps",
    category: "motor",
    sortOrder: 80,
  },
  {
    id: "10000000-0000-4000-8000-000000000009",
    name: "First word",
    category: "speech",
    sortOrder: 90,
  },
  {
    id: "10000000-0000-4000-8000-000000000010",
    name: "First haircut",
    category: "event",
    sortOrder: 100,
  },
  {
    id: "10000000-0000-4000-8000-000000000011",
    name: "First birthday",
    category: "event",
    sortOrder: 110,
  },
  {
    id: "10000000-0000-4000-8000-000000000012",
    name: "First time with [person]",
    category: "social",
    sortOrder: 120,
  },
];

/**
 * Fixed ids of the dev-only demo family seed (docs/plans/step-2.md 2.9), so tests and later
 * steps reference one source. These rows exist only where `SEED_DEMO_FAMILY=true` (never in
 * production).
 */
export const DEMO_IDS = {
  users: {
    /** demo-mom@tinyglow.local, admin, "Maria" (Mom), plan owner. */
    mom: "00000000-0000-4000-8000-000000000001",
    /** demo-dad@tinyglow.local, admin, "Dad". */
    dad: "00000000-0000-4000-8000-000000000002",
    /** demo-nanny@tinyglow.local, contributor, "Nanny". */
    nanny: "00000000-0000-4000-8000-000000000003",
  },
  /** "Maya" (nickname "Mimi"), plan `plus`. */
  baby: "00000000-0000-4000-8000-000000000100",
  /** "Grandparents" share link. */
  shareLink: "00000000-0000-4000-8000-000000000200",
  /**
   * Plaintext token of the "Grandparents" link (dev seed only; the database stores only its
   * SHA-256). Real tokens are 22 base64url chars; this one is longer but fits `shareTokenSchema`.
   */
  shareToken: "demo-grandparents-share-token",
  /** The 12 seeded photos, `…-000000000301` through `…-000000000312`. */
  photos: [
    "00000000-0000-4000-8000-000000000301",
    "00000000-0000-4000-8000-000000000302",
    "00000000-0000-4000-8000-000000000303",
    "00000000-0000-4000-8000-000000000304",
    "00000000-0000-4000-8000-000000000305",
    "00000000-0000-4000-8000-000000000306",
    "00000000-0000-4000-8000-000000000307",
    "00000000-0000-4000-8000-000000000308",
    "00000000-0000-4000-8000-000000000309",
    "00000000-0000-4000-8000-000000000310",
    "00000000-0000-4000-8000-000000000311",
    "00000000-0000-4000-8000-000000000312",
  ],
} as const;

/** Number of photos the perf seed creates (`PERF_IDS.photo(0)` .. `PERF_IDS.photo(9999)`). */
export const PERF_PHOTO_COUNT = 10_000;
/** Number of measurements the perf seed creates (25 weights, 13 heights, 7 head). */
export const PERF_MEASUREMENT_COUNT = 45;

function perfIndex(i: number, count: number, what: string): number {
  if (!Number.isInteger(i) || i < 0 || i >= count) {
    throw new RangeError(`${what} index must be an integer in 0..${count - 1}`);
  }
  return i;
}

/**
 * Fixed ids of the dev-only performance seed (`pnpm perf:seed`, docs/plans/step-5.md 2.8): a
 * free-tier baby "Pixel" with 10,000 photos whose admins are the demo mom and dad. These rows
 * exist only where the seed was run by hand on a dev machine (never in a container or
 * production).
 */
export const PERF_IDS = {
  /** "Pixel" (nickname "Pix"), born 2024-10-01, plan `free`, no plan owner. */
  baby: "00000000-0000-4000-8000-000000000900",
  /** Custom milestones "First swim", "First snow", "Met Grandpa Joe". */
  milestones: [
    "00000000-0000-4000-8000-000000000910",
    "00000000-0000-4000-8000-000000000911",
    "00000000-0000-4000-8000-000000000912",
  ],
  /** Photo `i` (0..9999): `00000000-0000-4000-8000-01` + `i` as 10 zero-padded digits. */
  photo(i: number): string {
    const n = perfIndex(i, PERF_PHOTO_COUNT, "photo");
    return `00000000-0000-4000-8000-01${String(n).padStart(10, "0")}`;
  },
  /** Measurement `i` (0..44): `00000000-0000-4000-8000-0000000009` + (20 + `i`), i.e. `…920`..`…964`. */
  measurement(i: number): string {
    const n = perfIndex(i, PERF_MEASUREMENT_COUNT, "measurement");
    return `00000000-0000-4000-8000-0000000009${String(20 + n)}`;
  },
} as const;

// ---------------------------------------------------------------------------------------------
// Search and chat (docs/plans/step-7.md 2.4, 2.8; PRD "Chat and RAG pipeline": "SQL filters → top
// 50 by vector cosine + top 50 by full-text → merged by Reciprocal Rank Fusion → optional re-rank
// of top 30 by the LLM reading captions → top 12 returned"). Env-tunable settings live in
// `SEARCH_DEFAULTS` / `CHAT_DEFAULTS` (env.ts); these are fixed.
// ---------------------------------------------------------------------------------------------

/** Reciprocal Rank Fusion constant: `score = Σ 1 / (SEARCH_RRF_K + rank)`, rank from 1. */
export const SEARCH_RRF_K = 60;
/** Candidates per ranked leg (vector, full-text, tag/people boost). */
export const SEARCH_CANDIDATES = 50;
/** Fused candidates the optional LLM re-rank reads (captions only). */
export const SEARCH_RERANK_CANDIDATES = 30;
/** Results returned by `search_photos` when the model passes `limit: null`. */
export const SEARCH_RESULT_LIMIT = 12;
/** Most results `search_photos` may return (its `limit` maximum). */
export const SEARCH_TOOL_MAX_RESULTS = 24;
/** Default and maximum `limit` of `GET /babies/:id/search`. */
export const SEARCH_PAGE_DEFAULT = 24;
export const SEARCH_PAGE_MAX = 50;
/** Tags listed by `GET /babies/:id/search/facets` (most frequent first). */
export const SEARCH_FACET_TAGS_MAX = 30;

/** PRD "Cost controls": chat turns per user per rolling 24 hours (default of `CHAT_TURNS_PER_DAY`). */
export const CHAT_TURNS_PER_DAY = 100;

/**
 * Estimated cost of one chat turn on the default model (gpt-6-luna standard tier, ~2 calls of
 * ~1,500 input / ~150 output tokens). The pre-turn budget check uses it; recorded costs come from
 * the price table in `packages/ai`.
 */
export const CHAT_COST_PER_TURN_ESTIMATE_USD = 0.001;
/**
 * Estimated cost of embedding one search document (~250 tokens × $0.02 / 1M). The indexer's
 * budget check uses it; recorded costs come from the provider's usage.
 */
export const EMBED_COST_PER_DOC_ESTIMATE_USD = 0.000005;

/** Upper bound of `SEARCH_SEED_IDS.photo(i)` (the gate uses 2,000; the perf target is 50,000). */
export const SEARCH_SEED_MAX_PHOTOS = 100_000;
/** Measurements the search seed creates (`SEARCH_SEED_IDS.measurement(0..59)`). */
export const SEARCH_SEED_MEASUREMENT_COUNT = 60;

/**
 * Fixed ids of the dev-only search seed (`pnpm search:seed`, docs/plans/step-7.md 2.6): the
 * "Golden" baby (plan `plus`, no plan owner, admins = the demo mom and dad, born 2025-03-15) with
 * up to `SEARCH_SEED_MAX_PHOTOS` photos and 60 measurements. Photo indices `0..49` are the golden
 * targets. These rows exist only where the seed was run by hand or by the search gate on a dev
 * machine / CI (never in production).
 */
export const SEARCH_SEED_IDS = {
  /** "Golden". */
  baby: "00000000-0000-4000-8000-000000000a00",
  /** Photo `i`: `00000000-0000-4000-8000-02` + `i` as 10 zero-padded digits. */
  photo(i: number): string {
    const n = perfIndex(i, SEARCH_SEED_MAX_PHOTOS, "photo");
    return `00000000-0000-4000-8000-02${String(n).padStart(10, "0")}`;
  },
  /** Measurement `i` (0..59): `00000000-0000-4000-8000-03` + `i` as 10 zero-padded digits. */
  measurement(i: number): string {
    const n = perfIndex(i, SEARCH_SEED_MEASUREMENT_COUNT, "measurement");
    return `00000000-0000-4000-8000-03${String(n).padStart(10, "0")}`;
  },
} as const;

// ---------------------------------------------------------------------------------------------
// Sharing (docs/plans/step-8.md 2.2, 2.4; PRD "FR-9 Sharing", "Accounts and authentication →
// Share-link viewers (no account)", "Security": tokens ≥ 128-bit random and stored hashed,
// passcode attempts 5 / 15 min per IP + token). Env-tunable settings live in `SHARE_DEFAULTS`
// (env.ts); these are fixed. Several are mirrored by database triggers (`share_links_shape`,
// `share_links_cap`, `share_rules_shape`): change both together.
// ---------------------------------------------------------------------------------------------

/** SPA route prefix of share links: `${PUBLIC_URL}${SHARE_PATH}/${token}`. */
export const SHARE_PATH = "/s";
/** Random bytes per share token (128 bits, PRD "token is 128-bit random"). */
export const SHARE_TOKEN_BYTES = 16;
/** Length of a freshly minted token: 16 bytes base64url without padding. */
export const SHARE_TOKEN_LENGTH = 22;
/** Longest token accepted on input (the dev seed token is 29 chars). */
export const SHARE_TOKEN_MAX_LENGTH = 64;

/** Expiry choices offered by the UI, in hours: 24 h (default), 3 days, 7 days, 30 days (D2). */
export const SHARE_LINK_TTL_CHOICES_HOURS = [24, 72, 168, 720] as const;
export type ShareLinkTtlChoiceHours = (typeof SHARE_LINK_TTL_CHOICES_HOURS)[number];
/** Longest expiry: 30 days (`share_links.ttl_hours` 1..720; `expires_at <= now() + 721 h`). */
export const SHARE_LINK_MAX_TTL_HOURS = 720;
/** Links per baby (`share_links_cap` trigger: "share link limit reached" ⇒ 409). */
export const SHARE_LINKS_PER_BABY_MAX = 20;
/** `share_links.name` length (trimmed). */
export const SHARE_LINK_NAME_MAX_CHARS = 80;

/** Optional passcode: exactly this many ASCII digits. */
export const SHARE_PASSCODE_LENGTH = 6;
/** PRD: failed passcode attempts per (IP, link) per `SHARE_PASSCODE_IP_WINDOW_MIN` ⇒ 429 `rate_limited`. */
export const SHARE_PASSCODE_FAILURES_PER_IP = 5;
export const SHARE_PASSCODE_IP_WINDOW_MIN = 15;
/** Failed attempts per link (any IP) per `SHARE_PASSCODE_LINK_WINDOW_MIN` ⇒ 429 `passcode_locked` (D8). */
export const SHARE_PASSCODE_FAILURES_PER_LINK = 20;
export const SHARE_PASSCODE_LINK_WINDOW_MIN = 60;
/** Token exchanges (`POST /share/session`) per IP per hour (in-memory throttle). */
export const SHARE_EXCHANGES_PER_IP_PER_HOUR = 120;

/** A viewer session idle this long starts a new "visit" (`share_links.view_count`, FR-9.8). */
export const SHARE_VISIT_GAP_MIN = 30;

/** Include / exclude tags per auto-share rule (`share_rules_shape`). */
export const SHARE_RULE_TAGS_MAX = 20;
/** Characters per rule tag (equals the longest tag `photo_search.tags` keeps). */
export const SHARE_RULE_TAG_MAX_CHARS = 60;

/** Default and maximum `limit` of `GET /share/photos`. */
export const SHARE_VIEWER_PAGE_SIZE = 100;
export const SHARE_VIEWER_PAGE_MAX = 200;
/** Ids per `POST /share/photos/urls`. */
export const SHARE_VIEWER_URLS_MAX = 200;
/** Lifetime of a viewer download URL (the `display` derivative as an attachment). */
export const SHARE_DOWNLOAD_URL_TTL_SEC = 60;
/**
 * The only derivative kinds a viewer is ever handed a URL for. Downloads are `display` (1600 px,
 * metadata-free), never the original (D9).
 */
export const SHARE_VIEWER_MEDIA_KINDS = ["thumb", "display"] as const;

// ---------------------------------------------------------------------------------------------
// Data export (docs/plans/review-fixes.md 2.2, 2.3, 2.5; PRD FR-10.1 "Export all originals + a
// JSON/CSV of metadata as a ZIP", "Roles and permissions": export data is Admin only). Several
// are mirrored by the `data_exports` table defaults and triggers (`expires_at` default,
// `data_exports_rate_limit`): change both together.
// ---------------------------------------------------------------------------------------------

/** A finished export stays downloadable this many days (`data_exports.expires_at` default, D5). */
export const EXPORT_TTL_DAYS = 7;
/** Export requests per baby per rolling 24 hours (`data_exports_rate_limit` trigger ⇒ 429). */
export const EXPORTS_PER_BABY_PER_DAY = 3;
/** Lifetime of an export download URL (presigned GET of the ZIP, requester only). */
export const EXPORT_URL_TTL_SEC = 600;
/** Exports listed by `GET /babies/:id/exports` (newest first). */
export const EXPORT_LIST_LIMIT = 10;
/** `formatVersion` of the ZIP layout (`album.json`, `README.txt`). */
export const EXPORT_FORMAT_VERSION = "1";
/** Default of `EXPORT_MAX_BYTES` (100 GiB): larger albums fail with `too_large`. */
export const EXPORT_MAX_BYTES_DEFAULT = 107_374_182_400;
/** The worker updates `data_exports.photos_done` every this many photos. */
export const EXPORT_PROGRESS_EVERY = 50;
