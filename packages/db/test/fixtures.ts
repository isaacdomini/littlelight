/**
 * Two-baby fixture world for the RLS / trigger tests (docs/plans/step-2.md 2.8). Created once per
 * test file as superuser with fixed ids in a private range (`f<k>...`), removed again afterwards.
 * Independent of the demo seed (ids `0000...`), so both can live in the same database.
 */

import type pg from "pg";
import { DATA_KEY } from "./harness";

/** `f1000000-0000-4000-8000-<n>`: stable, readable, and clearly not seed ids. */
const id = (kind: number, n: number) =>
  `f${kind}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const U = {
  adminA1: id(1, 1),
  adminA2: id(1, 2),
  contribA: id(1, 3),
  adminB: id(1, 4),
  stranger: id(1, 5),
} as const;
export const EMAIL = {
  adminA1: "fx-admin-a1@tinyglow.test",
  adminA2: "fx-admin-a2@tinyglow.test",
  contribA: "fx-contrib-a@tinyglow.test",
  adminB: "fx-admin-b@tinyglow.test",
  stranger: "fx-stranger@tinyglow.test",
} as const;

export const BABY = {
  A: id(2, 1),
  B: id(2, 2),
  /** Soft-deleted 31 days ago (purgeable by `pipeline`). */
  oldTrash: id(2, 3),
  /** Soft-deleted yesterday. */
  recentTrash: id(2, 4),
} as const;

export const P = {
  /** Approved, by adminA1, shared on LA/LA-expired/LA-revoked, has derivatives/exif/ai/search. */
  approved1: id(3, 1),
  /** Approved, by adminA1, shared on LA. */
  approved2: id(3, 2),
  /** Pending, uploaded by contribA. */
  pendingContrib: id(3, 3),
  /** Pending, uploaded by adminA2 (not visible to contribA). */
  pendingOther: id(3, 4),
  /** Approved + is_sensitive. */
  sensitive: id(3, 5),
  /** Approved and trashed. */
  trashed: id(3, 6),
  /** Approved, uploaded by contribA and then approved by an admin. */
  contribApproved: id(3, 7),
  /** Approved photo in baby B. */
  b1: id(3, 8),
  /** Trashed 31 days ago: the only photo `pipeline` may hard-delete. */
  trashedOld: id(3, 9),
  /** Trashed yesterday: still inside the 30-day window. */
  trashedRecent: id(3, 10),
} as const;

/** Every photo of baby A (all states). */
export const A_PHOTOS = [
  P.approved1,
  P.approved2,
  P.pendingContrib,
  P.pendingOther,
  P.sensitive,
  P.trashed,
  P.contribApproved,
  P.trashedOld,
  P.trashedRecent,
] as const;

export const LINK = {
  LA: id(4, 1),
  LAexpired: id(4, 2),
  LArevoked: id(4, 3),
  LB: id(4, 4),
} as const;

export const A_LINKS = [LINK.LA, LINK.LAexpired, LINK.LArevoked] as const;

export const MILESTONE_FIRST_SMILE = "10000000-0000-4000-8000-000000000001";
export const AI_BATCH = id(5, 1);
export const THREAD_A = id(6, 1);
export const THREAD_B = id(6, 2);
export const INVITE_A = id(7, 1);
export const INVITE_B = id(7, 2);
export const MEASUREMENT_A = id(8, 1);
export const MEASUREMENT_B = id(8, 2);
export const VIEWER_SESSION_A = id(9, 1);

/** Baby-scoped tables that carry a `baby_id` (directly or via photo / link) for isolation checks. */
export const FIXTURE_USER_IDS = Object.values(U);
export const FIXTURE_BABY_IDS = Object.values(BABY);

const hash = (seed: string) => `decode(md5('${seed}') || md5('${seed}x'), 'hex')`; // 32 bytes

export async function dropFixtures(admin: pg.Client): Promise<void> {
  await admin.query("DELETE FROM public.audit_log WHERE metadata ->> 'fixture' = 'true'");
  await admin.query("DELETE FROM public.ai_batches WHERE id = $1", [AI_BATCH]);
  await admin.query("DELETE FROM public.babies WHERE id = ANY($1::uuid[])", [FIXTURE_BABY_IDS]);
  await admin.query("DELETE FROM public.milestones WHERE name LIKE 'fx-%'");
  await admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [FIXTURE_USER_IDS]);
}

export async function createFixtures(admin: pg.Client): Promise<void> {
  await dropFixtures(admin);
  await admin.query("BEGIN");
  try {
    for (const [key, uid] of Object.entries(U)) {
      const email = EMAIL[key as keyof typeof EMAIL];
      await admin.query(
        `INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
         VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())`,
        [uid, email],
      );
      await admin.query("INSERT INTO public.profiles (user_id, display_name) VALUES ($1, $2)", [
        uid,
        key,
      ]);
    }
    for (const [b, name] of [
      [BABY.A, "Baby A"],
      [BABY.B, "Baby B"],
    ] as const) {
      // created_by NULL: no creator trigger; memberships are explicit below. Paid tier so AI/search
      // policies are exercised; the free-tier cases create their own baby inside a transaction.
      await admin.query(
        "INSERT INTO public.babies (id, name, birth_date, plan) VALUES ($1, $2, '2025-06-30', 'plus')",
        [b, name],
      );
    }
    for (const [b, ago] of [
      [BABY.oldTrash, "31 days"],
      [BABY.recentTrash, "1 day"],
    ] as const) {
      await admin.query(
        `INSERT INTO public.babies (id, name, birth_date, plan, deleted_at)
         VALUES ($1, 'Trashed baby', '2025-06-30', 'plus', now() - interval '${ago}')`,
        [b],
      );
    }
    const members: [string, string, string][] = [
      [BABY.A, U.adminA1, "admin"],
      [BABY.A, U.adminA2, "admin"],
      [BABY.A, U.contribA, "contributor"],
      [BABY.B, U.adminB, "admin"],
    ];
    for (const [b, u, role] of members) {
      await admin.query(
        "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1,$2,$3)",
        [b, u, role],
      );
    }

    type PhotoFx = {
      id: string;
      baby: string;
      by: string;
      approval?: string;
      sensitive?: boolean;
      trashed?: boolean;
      /** SQL interval string for `deleted_at = now() - interval`. */
      trashedAgo?: string;
    };
    const photos: PhotoFx[] = [
      { id: P.approved1, baby: BABY.A, by: U.adminA1 },
      { id: P.approved2, baby: BABY.A, by: U.adminA1 },
      { id: P.pendingContrib, baby: BABY.A, by: U.contribA, approval: "pending" },
      { id: P.pendingOther, baby: BABY.A, by: U.adminA2, approval: "pending" },
      { id: P.sensitive, baby: BABY.A, by: U.adminA1, sensitive: true },
      { id: P.trashed, baby: BABY.A, by: U.adminA1, trashed: true },
      { id: P.contribApproved, baby: BABY.A, by: U.contribA },
      { id: P.b1, baby: BABY.B, by: U.adminB },
      { id: P.trashedOld, baby: BABY.A, by: U.adminA1, trashed: true, trashedAgo: "31 days" },
      { id: P.trashedRecent, baby: BABY.A, by: U.adminA1, trashed: true, trashedAgo: "1 day" },
    ];
    for (const p of photos) {
      await admin.query(
        `INSERT INTO public.photos
           (id, baby_id, uploaded_by, storage_key_original, sha256, width, height, bytes, mime,
            approval, taken_at, is_sensitive, deleted_at, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, ${hash(p.id)}, 100, 100, 1234, 'image/jpeg',
                 $5, '2026-01-02T03:04:05Z', $6, ${p.trashed ? `now() - interval '${p.trashedAgo ?? "0 seconds"}'` : "NULL"},
                 ${p.approval === "pending" ? "NULL" : "$3"},
                 ${p.approval === "pending" ? "NULL" : "now()"})`,
        [
          p.id,
          p.baby,
          p.by,
          `fx/${p.id}/original.jpg`,
          p.approval ?? "approved",
          p.sensitive ?? false,
        ],
      );
    }

    // Derivatives: approved1 has all three kinds, approved2 only a thumb.
    for (const [photo, kind] of [
      [P.approved1, "thumb"],
      [P.approved1, "display"],
      [P.approved1, "analysis"],
      [P.approved2, "thumb"],
      [P.b1, "thumb"],
    ] as const) {
      await admin.query(
        `INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes)
         VALUES ($1, $2, $3, 10, 10, 10)`,
        [photo, kind, `fx/${photo}/${kind}.jpg`],
      );
    }

    // EXIF with encrypted GPS (key bound as a parameter, as in production code).
    await admin.query("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
    for (const photo of [P.approved1, P.b1]) {
      await admin.query(
        `INSERT INTO public.photo_exif (photo_id, taken_at, gps_lat_enc, gps_lng_enc, place_label, camera_make)
         VALUES ($1, '2026-01-02T03:04:05Z', public.encrypt_coord(47.6062), public.encrypt_coord(-122.3321), 'Home', 'Acme')`,
        [photo],
      );
    }
    await admin.query(
      `INSERT INTO public.photo_details (photo_id, milestone_id, note, people, edited_by)
       VALUES ($1, $2, 'private parent note', '{Dad}', $3)`,
      [P.approved1, MILESTONE_FIRST_SMILE, U.adminA1],
    );
    await admin.query(
      `INSERT INTO public.ai_batches (id, provider, model) VALUES ($1, 'openai', 'gpt-6-luna')`,
      [AI_BATCH],
    );
    await admin.query(
      `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description, batch_id)
       VALUES ($1, 'gpt-6-luna', 'v1', 'v1', '{"caption":"baby smiling"}'::jsonb, $2)`,
      [P.approved1, AI_BATCH],
    );
    await admin.query(
      `INSERT INTO public.photo_ai_overrides (photo_id, field_path, value, edited_by)
       VALUES ($1, 'caption', '"edited"'::jsonb, $2)`,
      [P.approved1, U.adminA1],
    );
    for (const [photo, baby] of [
      [P.approved1, BABY.A],
      [P.b1, BABY.B],
    ] as const) {
      await admin.query(
        `INSERT INTO public.photo_search (photo_id, baby_id, search_text) VALUES ($1, $2, 'smiling baby')`,
        [photo, baby],
      );
    }
    for (const [mid, baby, by] of [
      [MEASUREMENT_A, BABY.A, U.adminA1],
      [MEASUREMENT_B, BABY.B, U.adminB],
    ] as const) {
      await admin.query(
        `INSERT INTO public.measurements (id, baby_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by)
         VALUES ($1, $2, 'weight', 3400, 3400, 'g', now(), $3)`,
        [mid, baby, by],
      );
    }
    await admin.query(
      `INSERT INTO public.invites (id, baby_id, email, role, token_hash, invited_by)
       VALUES ($1, $2, 'fx-invitee-a@tinyglow.test', 'contributor', ${hash("inviteA")}, $3),
              ($4, $5, 'fx-invitee-b@tinyglow.test', 'contributor', ${hash("inviteB")}, $6)`,
      [INVITE_A, BABY.A, U.adminA1, INVITE_B, BABY.B, U.adminB],
    );

    // Share links: active, expired, revoked (all baby A), and one for baby B.
    const links: [string, string, string, string][] = [
      [LINK.LA, BABY.A, "LA", "now() + interval '24 hours'"],
      [LINK.LAexpired, BABY.A, "LA-expired", "now() - interval '1 hour'"],
      [LINK.LArevoked, BABY.A, "LA-revoked", "now() + interval '24 hours'"],
      [LINK.LB, BABY.B, "LB", "now() + interval '24 hours'"],
    ];
    for (const [lid, baby, name, expires] of links) {
      await admin.query(
        `INSERT INTO public.share_links (id, baby_id, name, token_hash, passcode_hash, expires_at, created_by, revoked_at)
         VALUES ($1, $2, $3, ${hash(name)}, 'argon2id$fixture-passcode-hash', ${expires},
                 $4, ${lid === LINK.LArevoked ? "now()" : "NULL"})`,
        [lid, baby, name, baby === BABY.A ? U.adminA1 : U.adminB],
      );
    }
    await admin.query(`INSERT INTO public.share_rules (share_link_id, mode) VALUES ($1, 'all')`, [
      LINK.LA,
    ]);
    for (const lid of [LINK.LA, LINK.LAexpired, LINK.LArevoked]) {
      for (const photo of [P.approved1, P.approved2]) {
        await admin.query(
          `INSERT INTO public.shared_photos (share_link_id, photo_id, added_by, added_by_user_id)
           VALUES ($1, $2, 'user', $3)`,
          [lid, photo, U.adminA1],
        );
      }
    }
    await admin.query(
      `INSERT INTO public.shared_photos (share_link_id, photo_id, added_by, added_by_user_id)
       VALUES ($1, $2, 'user', $3)`,
      [LINK.LB, P.b1, U.adminB],
    );
    await admin.query(
      `INSERT INTO public.viewer_sessions (id, share_link_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [VIEWER_SESSION_A, LINK.LA],
    );

    for (const [tid, baby, user] of [
      [THREAD_A, BABY.A, U.adminA1],
      [THREAD_B, BABY.B, U.adminB],
    ] as const) {
      await admin.query(
        "INSERT INTO public.chat_threads (id, baby_id, user_id, title) VALUES ($1,$2,$3,'t')",
        [tid, baby, user],
      );
      await admin.query(
        `INSERT INTO public.chat_messages (thread_id, baby_id, user_id, role, content)
         VALUES ($1, $2, $3, 'user', 'private question')`,
        [tid, baby, user],
      );
    }
    for (const [baby, actor] of [
      [BABY.A, U.adminA1],
      [BABY.B, U.adminB],
    ] as const) {
      await admin.query(
        `INSERT INTO public.audit_log (baby_id, actor_user_id, event, metadata)
         VALUES ($1, $2, 'fixture.event', '{"fixture": "true"}'::jsonb)`,
        [baby, actor],
      );
    }
    await admin.query("COMMIT");
  } catch (e) {
    await admin.query("ROLLBACK");
    throw e;
  }
}
