import type { MilestoneCategory } from "./db-enums";

// Shared constants (docs/plans/step-1.md 2.10, docs/plans/step-2.md 2.11, docs/plans/step-5.md 2.6). Model names are config defaults, not code paths:
// every model call goes through packages/ai adapters, which read these as fallbacks.

export const APP_NAME = "Littlelight";

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

/** Share links expire after 24 hours by default. */
export const SHARE_LINK_DEFAULT_TTL_HOURS = 24;

/** Free-tier photo cap per baby space. */
export const FREE_TIER_PHOTO_LIMIT = 1000;

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
    /** demo-mom@littlelight.local, admin, "Maria" (Mom), plan owner. */
    mom: "00000000-0000-4000-8000-000000000001",
    /** demo-dad@littlelight.local, admin, "Dad". */
    dad: "00000000-0000-4000-8000-000000000002",
    /** demo-nanny@littlelight.local, contributor, "Nanny". */
    nanny: "00000000-0000-4000-8000-000000000003",
  },
  /** "Maya" (nickname "Mimi"), plan `plus`. */
  baby: "00000000-0000-4000-8000-000000000100",
  /** "Grandparents" share link. */
  shareLink: "00000000-0000-4000-8000-000000000200",
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
