import { z } from "zod";
import { SHARE_RULE_TAG_MAX_CHARS } from "./constants";
import type { ShareRuleMode } from "./db-enums";

// Auto-share rule matching (PRD FR-9.4 "all new photos / only milestone photos / photos
// containing selected tags / exclude tags", FR-9.5 safety gate; docs/plans/step-8.md 2.4, D3, D5).
// Browser-safe: `zod` and this package only. The worker decides with `shareRuleMatches`; the UI
// previews with it. It is never the only guard: `shared_photos_gate` refuses a `rule` row for a
// sensitive, unanalysed, excluded or released photo in the database whatever this returns.

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;

/**
 * Canonical form of a rule tag and of a photo tag before comparing them: NFC, control
 * characters removed, inner whitespace collapsed to one space, trimmed, lower-cased. The same
 * cleaning `photo_search.tags` gets (`searchTagsFor`), so "  Outdoor\tPlay " matches "outdoor play".
 */
export function normalizeShareTag(s: string): string {
  return s
    .normalize("NFC")
    .replace(CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFC");
}

/** A rule tag as accepted in request bodies: normalized, then 1..`SHARE_RULE_TAG_MAX_CHARS` chars. */
export const shareTagSchema = z
  .string()
  .max(SHARE_RULE_TAG_MAX_CHARS * 4)
  .transform(normalizeShareTag)
  .pipe(z.string().min(1).max(SHARE_RULE_TAG_MAX_CHARS));

/** What a rule may know about one photo. No caption, note, people, place or GPS. */
export interface ShareRuleFacts {
  /** A `photo_ai` row exists (the photo went through the paid AI pipeline). */
  analyzed: boolean;
  /** `photos.is_sensitive` (AI `sensitive_content` flags: bath, diaper, nudity, medical). */
  isSensitive: boolean;
  /** The parent-tagged `photo_details.milestone_id` is set (never the AI's `possible_milestones`). */
  hasMilestone: boolean;
  /** `searchTagsFor(applyAiOverrides(description, overrides), milestoneName)`. */
  tags: readonly string[];
}

/** The rule fields `shareRuleMatches` reads (a `ShareRuleInput` or a stored rule). */
export interface ShareRuleLike {
  mode: ShareRuleMode;
  includeTags: readonly string[];
  excludeTags: readonly string[];
}

/**
 * Whether an auto-share rule shares this photo. Always false for an unanalysed or sensitive
 * photo (FR-9.5: sensitive photos are never auto-shared; free-tier photos are never analysed, D3).
 * Then false when any exclude tag is on the photo; then `all` ⇒ true, `milestones` ⇒ the photo has
 * a parent-tagged milestone, `tags` ⇒ any include tag is on the photo. Tags compare after
 * `normalizeShareTag`. An unknown mode never matches.
 */
export function shareRuleMatches(rule: ShareRuleLike, facts: ShareRuleFacts): boolean {
  if (facts.analyzed !== true || facts.isSensitive !== false) return false;
  const tags = new Set(facts.tags.map(normalizeShareTag));
  if (rule.excludeTags.some((t) => tags.has(normalizeShareTag(t)))) return false;
  switch (rule.mode) {
    case "all":
      return true;
    case "milestones":
      return facts.hasMilestone === true;
    case "tags":
      return rule.includeTags.some((t) => {
        const n = normalizeShareTag(t);
        return n !== "" && tags.has(n);
      });
    default:
      return false;
  }
}
