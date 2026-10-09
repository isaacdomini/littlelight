/**
 * The golden set of step 7 (docs/plans/step-7.md 2.12, 4.1; PRD step 7 check: "golden set of 50
 * queries on seed data finds the right photo in the top 5 at least 85% of the time; answers cite
 * photo IDs").
 *
 * One entry per planted target of the search seed (`pnpm search:seed`, the "Golden" baby): the
 * query text comes from `GOLDEN_TARGETS` (absolute dates and ages only, never "last summer", so
 * the set is stable on any day; place names never contain a family word, so a query cannot be
 * read as a people filter) and the expected photo ids are `SEARCH_SEED_IDS.photo(i)`.
 *
 * - `chatQuery`: the natural-language question sent to the chat endpoint.
 * - `searchQuery`: what the classic search bar gets. For `keyword` / `filter` targets it is the
 *   same sentence (the search tokenises it and the filters are the seed's own people / dates /
 *   milestones inside the text legs). The two fact targets and the comparison group have no
 *   searchable question ("what did she weigh at 6 months" is a measurement lookup, not a photo
 *   search), so the classic search uses the target's planted signature word instead.
 * - `expectedPhotoIds`: the target photo; it must be within the first 5 results. The three
 *   "hammock" targets (ages 1, 6, 12 months) share one comparison question, which the chat gate
 *   asks once and scores for all three.
 * - `expectedMeasurementId` (fact): the answer must cite this measurement.
 */
import {
  GOLDEN_TARGETS,
  type GoldenKind,
  searchSeedMeasurements,
} from "../../apps/worker/src/ai/search-content";
import { SEARCH_SEED_IDS } from "../../packages/shared/src/constants";

export const GOLDEN_BABY = SEARCH_SEED_IDS.baby;

export interface GoldenQuery {
  index: number;
  kind: GoldenKind;
  chatQuery: string;
  searchQuery: string;
  expectedPhotoIds: string[];
  expectedMeasurementId?: string;
  notes: string;
}

const FAMILY = /grandma|grandpa|mom|dad|nanny|aunt|uncle|cousin/i;

function build(): GoldenQuery[] {
  const measurements = searchSeedMeasurements();
  const out: GoldenQuery[] = [];
  for (const t of GOLDEN_TARGETS) {
    // A family word in the question must be the target's tagged person, never a place name
    // ("Grandma's house" would read as a people filter and match the wrong photos).
    for (const w of t.query.match(new RegExp(FAMILY.source, "gi")) ?? []) {
      if (!t.people.some((p) => p.toLowerCase().includes(w.toLowerCase()))) {
        throw new Error(
          `golden target ${t.index}: "${w}" in "${t.query}" is not one of its people`,
        );
      }
    }
    const base = {
      index: t.index,
      kind: t.kind,
      chatQuery: t.query,
      expectedPhotoIds: [SEARCH_SEED_IDS.photo(t.index)],
    };
    if (t.kind === "fact") {
      const m = measurements.find((x) => x.photoIndex === t.index);
      if (!m) throw new Error(`golden target ${t.index}: no linked measurement in the seed`);
      out.push({
        ...base,
        searchQuery: t.signature,
        expectedMeasurementId: SEARCH_SEED_IDS.measurement(m.index),
        notes: `${m.kind} at ${m.ageDays} days; the answer must cite the measurement and its photo`,
      });
    } else if (t.kind === "comparison") {
      out.push({
        ...base,
        searchQuery: t.signature,
        notes: `comparison "${t.group}": one question, one expected photo per age (1, 6, 12 months); the chat answer is asked once`,
      });
    } else {
      out.push({
        ...base,
        searchQuery: t.query,
        notes: `${t.kind}; signature "${t.signature}"${t.milestone ? `, milestone ${t.milestone}` : ""}`,
      });
    }
  }
  return out;
}

export const GOLDEN_QUERIES: readonly GoldenQuery[] = build();

/** Queries that must find nothing (the relevance floor): no photos, chat says it found nothing. */
export const NOTHING_QUERIES = ["zebra submarine"] as const;
