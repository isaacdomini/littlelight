import type { MilestoneCategory } from "./db-enums";

// Shared constants (docs/plans/step-1.md 2.10, docs/plans/step-2.md 2.11). Model names are config defaults, not code paths:
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
