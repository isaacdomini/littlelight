// SQL of the auto-sharer (docs/plans/step-8.md 2.7). Every statement runs as `pipeline` inside
// `runAsPipeline(pool, {}, …)` — never with an encryption key bound. No statement selects a GPS
// column, `raw_json`, a parent's free text, the people list, a link name, a token or a hash: rule
// facts need only `photos` flags, the parent-tagged milestone (id and name), the stored AI
// description and its overrides. Exported as consts so unit tests can answer them by exact text.

/** Babies of the given photos that have at least one auto-share rule (any link state). */
export const BABIES_WITH_RULES_SQL = `
SELECT DISTINCT l.baby_id
FROM share_rules r
JOIN share_links l ON l.id = r.share_link_id
WHERE l.baby_id IN (SELECT p.baby_id FROM photos p WHERE p.id = ANY($1::uuid[]))`;

/**
 * Every rule (or one baby's, or one link's). `ai_enabled` is the paid-tier gate: rules of a baby
 * that is no longer on Plus add nothing (D3) but still drop rows that stop matching. `db_now` is
 * the database clock at read time, used as the sync watermark (never the worker's clock: the
 * watermark is compared with `updated_at` columns written by the database).
 */
const RULES_SELECT = `
SELECT r.share_link_id,
       l.baby_id,
       r.mode,
       r.include_tags,
       r.exclude_tags,
       r.updated_at,
       r.updated_at::text AS rule_version,
       r.evaluated_at,
       (r.evaluated_at IS NULL OR r.evaluated_at < r.updated_at) AS needs_full,
       public.baby_ai_enabled(l.baby_id) AS ai_enabled,
       now() AS db_now
FROM share_rules r
JOIN share_links l ON l.id = r.share_link_id`;

export const RULES_FOR_BABY_SQL = `${RULES_SELECT}
WHERE l.baby_id = $1
ORDER BY r.share_link_id`;

export const RULE_FOR_LINK_SQL = `${RULES_SELECT}
WHERE r.share_link_id = $1`;

export const ALL_RULES_SQL = `${RULES_SELECT}
ORDER BY l.baby_id, r.share_link_id`;

/**
 * Rule facts for a set of photos of one baby. `eligible` mirrors the gate's state rules (approved,
 * not trashed, not quarantined) plus "ingested" (the search index's liveness). `analyzed` = a
 * `photo_ai` row exists. Overrides come aggregated as JSON (FR-5.6: they win).
 */
export const FACTS_SQL = `
SELECT p.id AS photo_id,
       (p.deleted_at IS NOT NULL) AS trashed,
       (p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
        AND p.status NOT IN ('uploaded', 'failed', 'duplicate')) AS eligible,
       p.is_sensitive,
       (a.photo_id IS NOT NULL) AS analyzed,
       (d.milestone_id IS NOT NULL) AS has_milestone,
       m.name AS milestone_name,
       a.description,
       (SELECT jsonb_object_agg(o.field_path, o.value)
          FROM photo_ai_overrides o WHERE o.photo_id = p.id) AS overrides
FROM photos p
LEFT JOIN photo_details d ON d.photo_id = p.id
LEFT JOIN milestones m ON m.id = d.milestone_id
LEFT JOIN photo_ai a ON a.photo_id = p.id
WHERE p.baby_id = $1 AND p.id = ANY($2::uuid[])
ORDER BY p.id`;

/** Existing album rows of the given links for the given photos (rule and hand-added). */
export const EXISTING_SQL = `
SELECT sp.share_link_id, sp.photo_id, sp.added_by
FROM shared_photos sp
WHERE sp.share_link_id = ANY($1::uuid[]) AND sp.photo_id = ANY($2::uuid[])`;

/** Admin removals ("never re-add") of the given links for the given photos. */
export const EXCLUSIONS_SQL = `
SELECT x.share_link_id, x.photo_id
FROM shared_photo_exclusions x
WHERE x.share_link_id = ANY($1::uuid[]) AND x.photo_id = ANY($2::uuid[])`;

/**
 * Insert rule rows for (link, photo) pairs. The predicates repeat the gate at statement time, so
 * a photo that changed since the facts were read is filtered out instead of raising; the gate
 * (`shared_photos_gate`, photo row locked FOR SHARE) still has the last word on a concurrent
 * sensitive flag. `ON CONFLICT DO NOTHING`: a hand-added row stays hand-added.
 */
export const INSERT_RULE_ROWS_SQL = `
INSERT INTO shared_photos (share_link_id, photo_id, added_by)
SELECT x.share_link_id, x.photo_id, 'rule'
FROM unnest($1::uuid[], $2::uuid[]) AS x(share_link_id, photo_id)
JOIN share_links l ON l.id = x.share_link_id
JOIN photos p ON p.id = x.photo_id AND p.baby_id = l.baby_id
WHERE p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
  AND NOT p.is_sensitive
  AND public.baby_ai_enabled(l.baby_id)
  AND EXISTS (SELECT 1 FROM photo_ai a WHERE a.photo_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM shared_photo_exclusions e
                  WHERE e.share_link_id = x.share_link_id AND e.photo_id = x.photo_id)
ON CONFLICT (share_link_id, photo_id) DO NOTHING
RETURNING photo_id`;

/**
 * Remove rule rows for (link, photo) pairs. `added_by = 'rule'` is re-checked after any row lock
 * wait, so a row an admin converted to hand-picked in the meantime is never removed (the
 * `shared_photos_pipeline_delete` policy enforces the same).
 */
export const DELETE_RULE_ROWS_SQL = `
DELETE FROM shared_photos sp
USING unnest($1::uuid[], $2::uuid[]) AS x(share_link_id, photo_id)
WHERE sp.share_link_id = x.share_link_id AND sp.photo_id = x.photo_id AND sp.added_by = 'rule'
RETURNING sp.photo_id`;

/** One page (keyset on id) of a baby's photos that are not trashed: a full sync. */
export const BABY_PHOTOS_PAGE_SQL = `
SELECT p.id
FROM photos p
WHERE p.baby_id = $1 AND p.deleted_at IS NULL AND p.id > $2::uuid
ORDER BY p.id
LIMIT $3`;

/**
 * One page (keyset on id) of a baby's photos whose rule facts may have changed since `$2`: the
 * photo row, its AI row, its details, the tagged milestone or any of its AI overrides moved.
 * `GREATEST` ignores NULLs. Removed overrides do not show here; the API's `photo.reindex
 * {ai_override}` covers them.
 */
export const CHANGED_PHOTOS_PAGE_SQL = `
SELECT p.id
FROM photos p
LEFT JOIN photo_ai a ON a.photo_id = p.id
LEFT JOIN photo_details d ON d.photo_id = p.id
LEFT JOIN milestones m ON m.id = d.milestone_id
WHERE p.baby_id = $1 AND p.deleted_at IS NULL AND p.id > $3::uuid
  AND GREATEST(p.updated_at, a.updated_at, d.updated_at, m.updated_at,
               (SELECT max(o.updated_at) FROM photo_ai_overrides o WHERE o.photo_id = p.id)) > $2
ORDER BY p.id
LIMIT $4`;

/**
 * Advance the watermark, only if the rule did not change since it was read (`$3` = the
 * `rule_version` read with it): a rule edited during the sync keeps `evaluated_at < updated_at`, so
 * the next `share.reconcile` re-syncs it in full even if its `share.apply` was dropped by the
 * exclusive queue policy.
 */
export const MARK_EVALUATED_SQL = `
UPDATE share_rules
SET evaluated_at = $2
WHERE share_link_id = $1 AND updated_at = $3::timestamptz
  AND (evaluated_at IS NULL OR evaluated_at < $2)`;
