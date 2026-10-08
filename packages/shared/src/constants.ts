// Shared constants (docs/plans/step-1.md 2.10). Model names are config defaults, not code paths:
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
