import { randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  babySchema,
  FREE_TIER_VIDEO_LIMIT,
  sessionResponseSchema,
} from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { gotrueSession } from "../testing/support";

// Family start (docs/plans/step-11.md 2.1, 2.4, 2.5, D-B, D-J; task 11.8b): the abuse checks run
// when an account creates its FIRST album (it is a parent nowhere), never at sign-up and never for
// a sibling album. Real database, recording GoTrue stub. Each case uses its own client IP via
// `cf-connecting-ip`, so the network-cap counters of different cases never meet.

// Random per call: ledger rows of earlier runs (24 h window) must never meet this run's counters.
const octet = () => 1 + Math.floor(Math.random() * 250);
const nextIp = () => `198.18.${octet()}.${octet()}`;
const tag = () => randomUUID().slice(0, 8);
const WEB = { "x-tinyglow-client": "web" };

describe.skipIf(!databaseUrl)("family start (POST /babies)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    h.gotrue.calls.adminDeleteUser.length = 0;
  });
  afterAll(async () => {
    await h?.close();
  });

  const create = (u: TestUser, ip: string, name = "Mia", extra: Record<string, string> = {}) =>
    h.inject(
      u,
      "POST",
      "/babies",
      { name, birthDate: "2026-03-01" },
      {
        "cf-connecting-ip": ip,
        ...extra,
      },
    );
  const ledger = async (userId: string) =>
    (
      await h.admin.query(
        `SELECT family_id, user_id, octet_length(ip_hash) AS hash_len, ip_country, client, plus_tag, dots_folded
           FROM public.family_starts WHERE user_id = $1 ORDER BY id`,
        [userId],
      )
    ).rows;
  const familyOf = async (babyId: string) =>
    (await h.admin.query("SELECT family_id FROM public.babies WHERE id = $1", [babyId])).rows[0]
      ?.family_id as string;
  const noGoTrueDelete = () => expect(h.gotrue.calls.adminDeleteUser).toHaveLength(0);

  describe("guards run on the first album only", () => {
    it("the first album records one ledger row; a sibling records none and runs no guard", async () => {
      const u = await h.user();
      const ip = nextIp();
      const first = await create(u, ip, "First", {
        "cf-ipcountry": "de",
        "x-tinyglow-client": "native",
      });
      expect(first.statusCode, first.body).toBe(201);
      const rows = await ledger(u.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        family_id: await familyOf(first.json().id),
        hash_len: 32,
        ip_country: "DE",
        client: "native",
        plus_tag: false,
        dots_folded: false,
      });
      // The row holds no raw IP and no address anywhere.
      expect(JSON.stringify(rows)).not.toContain(ip);
      const sibling = await create(u, ip, "Second");
      expect(sibling.statusCode).toBe(201);
      expect(await familyOf(sibling.json().id)).toBe(await familyOf(first.json().id));
      expect(await ledger(u.id)).toHaveLength(1);
      noGoTrueDelete();
    });

    it("a sibling album passes even when the network cap is exhausted (no guard runs)", async () => {
      const capped = await createHarness({ config: { FAMILIES_PER_IP_PER_DAY: 1 } });
      try {
        const ip = nextIp();
        const u = await capped.user();
        const post = (user: TestUser, name: string) =>
          capped.inject(
            user,
            "POST",
            "/babies",
            { name, birthDate: "2026-03-01" },
            { "cf-connecting-ip": ip },
          );
        expect((await post(u, "One")).statusCode).toBe(201);
        // the cap (1) is now reached for this network: a sibling is not a family start
        expect((await post(u, "Two")).statusCode).toBe(201);
        expect((await post(u, "Three")).statusCode).toBe(201);
        // but another account's first album from the same network is refused
        const other = await capped.user();
        const refused = await post(other, "Nope");
        expect(refused.statusCode).toBe(429);
        expect(apiErrorSchema.parse(refused.json()).error).toBe("family_limited");
      } finally {
        await capped.close();
      }
    });

    it("a guest-only caller (contributor elsewhere) is a family start and runs the guards", async () => {
      const host = await h.user();
      const hostBaby = await h.baby(host);
      const guest = await h.user({ email: `guest-${tag()}@mailinator.com` });
      await h.member(hostBaby, guest, "contributor");
      // joining as a guest was never blocked; starting their own family is
      const res = await create(guest, nextIp(), "Mine");
      expect(res.statusCode).toBe(400);
      expect(apiErrorSchema.parse(res.json()).error).toBe("email_not_allowed");
      // and a guest with an allowed address starts a family of their own, in a different family
      const guest2 = await h.user();
      await h.member(hostBaby, guest2, "contributor");
      const mine = await create(guest2, nextIp(), "Mine");
      expect(mine.statusCode).toBe(201);
      expect(await familyOf(mine.json().id)).not.toBe(await familyOf(hostBaby));
      expect(await ledger(guest2.id)).toHaveLength(1);
      noGoTrueDelete();
    });

    it("ledger flags come from the founder's address: +tag and Gmail dots", async () => {
      const u = await h.user({ email: `fl.ag${tag()}+kids@gmail.com` });
      const res = await create(u, nextIp());
      expect(res.statusCode).toBe(201);
      expect((await ledger(u.id))[0]).toMatchObject({ plus_tag: true, dots_folded: true });
    });
  });

  describe("refusals leave no trace and never touch GoTrue", () => {
    it("disposable domain: 400 email_not_allowed, no album, no family, no ledger row", async () => {
      const u = await h.user({ email: `x${tag()}@mailinator.com` });
      const res = await create(u, nextIp());
      expect(res.statusCode).toBe(400);
      const body = apiErrorSchema.parse(res.json());
      expect(body.error).toBe("email_not_allowed");
      expect(body.message).toMatch(/disposable/i);
      expect(body.message).toMatch(/guest/i);
      expect(
        (await h.admin.query("SELECT 1 FROM public.babies WHERE created_by = $1", [u.id])).rows,
      ).toHaveLength(0);
      expect(
        (await h.admin.query("SELECT 1 FROM public.families WHERE created_by = $1", [u.id])).rows,
      ).toHaveLength(0);
      expect(await ledger(u.id)).toHaveLength(0);
      expect(res.body).not.toContain(u.email);
      noGoTrueDelete();
    });

    it("canonical duplicate of a parent: 409 inbox_has_family with a masked hint only", async () => {
      const t = tag();
      const holder = await h.user({ email: `mom.${t}@gmail.com` });
      const holderBaby = await h.baby(holder);
      const twin = await h.user({ email: `mom.${t}+baby@googlemail.com` });
      const res = await create(twin, nextIp());
      expect(res.statusCode).toBe(409);
      const body = apiErrorSchema.parse(res.json());
      expect(body.error).toBe("inbox_has_family");
      expect(body.details).toEqual({ existingEmailMasked: "m***@gmail.com" });
      expect(res.body).not.toContain(holder.email);
      expect(res.body).not.toContain(twin.email);
      expect(res.body).not.toContain(t);
      // no album, no family, no ledger row for the twin; the holder's family is untouched
      expect(
        (await h.admin.query("SELECT 1 FROM public.babies WHERE created_by = $1", [twin.id])).rows,
      ).toHaveLength(0);
      expect(await ledger(twin.id)).toHaveLength(0);
      expect(
        (await h.admin.query("SELECT 1 FROM public.baby_members WHERE baby_id = $1", [holderBaby]))
          .rows,
      ).toHaveLength(1);
      noGoTrueDelete();
    });

    it("the twin may join the holder's family as a guest, and start their own once the holder is only a guest", async () => {
      const t = tag();
      const holder = await h.user({ email: `dad${t}@outlook.com` });
      const holderBaby = await h.baby(holder);
      const twin = await h.user({ email: `dad${t}+two@outlook.com` });
      await h.member(holderBaby, twin, "contributor"); // a guest join is never blocked
      expect((await create(twin, nextIp())).statusCode).toBe(409); // still a family start: refused
      // a different, unrelated holder who is only a guest does not block
      const t2 = tag();
      const guestHolder = await h.user({ email: `gh${t2}@outlook.com` });
      await h.member(holderBaby, guestHolder, "contributor");
      const twin2 = await h.user({ email: `gh${t2}+z@outlook.com` });
      expect((await create(twin2, nextIp())).statusCode).toBe(201);
    });

    it("network cap: 429 family_limited with Retry-After (1..86400), nothing created", async () => {
      const capped = await createHarness({ config: { FAMILIES_PER_IP_PER_DAY: 2 } });
      capped.gotrue.calls.adminDeleteUser.length = 0;
      try {
        const ip = nextIp();
        const post = (user: TestUser) =>
          capped.inject(
            user,
            "POST",
            "/babies",
            { name: "B", birthDate: "2026-03-01" },
            { "cf-connecting-ip": ip },
          );
        const [a, b, c] = [await capped.user(), await capped.user(), await capped.user()];
        expect((await post(a)).statusCode).toBe(201);
        expect((await post(b)).statusCode).toBe(201);
        const res = await post(c);
        expect(res.statusCode).toBe(429);
        expect(apiErrorSchema.parse(res.json()).error).toBe("family_limited");
        const retry = Number(res.headers["retry-after"]);
        expect(Number.isInteger(retry)).toBe(true);
        expect(retry).toBeGreaterThanOrEqual(1);
        expect(retry).toBeLessThanOrEqual(86_400);
        expect(
          (await capped.admin.query("SELECT 1 FROM public.babies WHERE created_by = $1", [c.id]))
            .rows,
        ).toHaveLength(0);
        // another network is unaffected
        const fresh = await capped.inject(
          c,
          "POST",
          "/babies",
          { name: "B", birthDate: "2026-03-01" },
          { "cf-connecting-ip": nextIp() },
        );
        expect(fresh.statusCode).toBe(201);
        expect(capped.gotrue.calls.adminDeleteUser).toHaveLength(0);
      } finally {
        await capped.close();
      }
    });
  });

  describe("audit and the family pool numbers", () => {
    it("baby.created carries family_start on the first album only", async () => {
      const u = await h.user();
      const first = await create(u, nextIp(), "A");
      const second = await create(u, nextIp(), "B");
      const a = await h.audit({ event: "baby.created", baby: first.json().id });
      const b = await h.audit({ event: "baby.created", baby: second.json().id });
      expect(a[0]?.metadata).toMatchObject({ role: "admin", family_start: true });
      expect(b[0]?.metadata).toEqual({ role: "admin", client: "web" });
      expect(JSON.stringify([a, b])).not.toContain(u.email);
    });

    it("freeTier.familyAlbums counts the family's free, live albums; Plus has none", async () => {
      const u = await h.user();
      const guest = await h.user();
      const one = await create(u, nextIp(), "One");
      const get = async (user: TestUser, id: string) =>
        babySchema.parse((await h.inject(user, "GET", `/babies/${id}`)).json());
      expect((await get(u, one.json().id)).freeTier).toEqual({
        used: 0,
        limit: 1000,
        familyAlbums: 1,
        videos: 0,
        videoLimit: FREE_TIER_VIDEO_LIMIT,
      });
      const two = await create(u, nextIp(), "Two");
      await h.member(one.json().id, guest, "contributor");
      expect((await get(u, one.json().id)).freeTier?.familyAlbums).toBe(2);
      expect((await get(u, two.json().id)).freeTier?.familyAlbums).toBe(2);
      // a guest sees the family's numbers of the album they belong to
      expect((await get(guest, one.json().id)).freeTier).toEqual({
        used: 0,
        limit: 1000,
        familyAlbums: 2,
        videos: 0,
        videoLimit: FREE_TIER_VIDEO_LIMIT,
      });
      // Plus and trashed albums are outside the pool
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [two.json().id]);
      expect((await get(u, two.json().id)).freeTier).toBeNull();
      expect((await get(u, one.json().id)).freeTier?.familyAlbums).toBe(1);
      // approved photos of both free albums count once, pending ones do not
      await h.admin.query(
        `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, approval, approved_by, status)
         SELECT $1::uuid, $2::uuid, 'fs/' || gen_random_uuid()::text, 'approved', $2::uuid, 'ready' FROM generate_series(1, 3)`,
        [one.json().id, u.id],
      );
      await h.admin.query(
        `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, approval, status)
         VALUES ($1, $2, 'fs/' || gen_random_uuid()::text, 'pending', 'ready')`,
        [one.json().id, guest.id],
      );
      expect((await get(u, one.json().id)).freeTier?.used).toBe(3);
    });
  });
});

describe.skipIf(!databaseUrl)("family start: the hard per-network cap and its reservations", () => {
  const body = { name: "R", birthDate: "2026-03-01" };
  const rows = async (h: Harness, ids: string[]) =>
    (
      await h.admin.query(
        "SELECT user_id, family_id FROM public.family_starts WHERE user_id = ANY($1::uuid[]) ORDER BY id",
        [ids],
      )
    ).rows as { user_id: string; family_id: string | null }[];

  it("N parallel first albums from one network admit exactly the remaining count", async () => {
    const h = await createHarness({ config: { FAMILIES_PER_IP_PER_DAY: 3 } });
    try {
      const ip = nextIp();
      const users = await Promise.all(Array.from({ length: 7 }, () => h.user()));
      const res = await Promise.all(
        users.map((u) => h.inject(u, "POST", "/babies", body, { "cf-connecting-ip": ip })),
      );
      const codes = res.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 201)).toHaveLength(3);
      expect(codes.filter((c) => c === 429)).toHaveLength(4);
      for (const r of res.filter((r) => r.statusCode === 429))
        expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      const ledger = await rows(
        h,
        users.map((u) => u.id),
      );
      expect(ledger).toHaveLength(3); // refused attempts leave no reservation
      expect(ledger.every((r) => r.family_id !== null)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("an inbox 409 releases its reservation: the cap is untouched", async () => {
    const h = await createHarness({ config: { FAMILIES_PER_IP_PER_DAY: 2 } });
    try {
      const t = tag();
      const holder = await h.user({ email: `hold${t}@gmail.com` });
      expect(
        (await h.inject(holder, "POST", "/babies", body, { "cf-connecting-ip": nextIp() }))
          .statusCode,
      ).toBe(201);
      const twin = await h.user({ email: `hold${t}+x@gmail.com` });
      const ip = nextIp();
      const post = (u: TestUser) =>
        h.inject(u, "POST", "/babies", body, { "cf-connecting-ip": ip });
      expect((await post(twin)).statusCode).toBe(409);
      expect(await rows(h, [twin.id])).toHaveLength(0);
      expect((await post(await h.user())).statusCode).toBe(201);
      expect((await post(await h.user())).statusCode).toBe(201);
      expect((await post(await h.user())).statusCode).toBe(429);
    } finally {
      await h.close();
    }
  });

  it("two first albums of one account at once: one family, one ledger row, no leftover reservation", async () => {
    const h = await createHarness({ config: { FAMILIES_PER_IP_PER_DAY: 50 } });
    try {
      for (let round = 0; round < 4; round++) {
        const u = await h.user();
        const ip = nextIp();
        const res = await Promise.all([
          h.inject(u, "POST", "/babies", body, { "cf-connecting-ip": ip }),
          h.inject(u, "POST", "/babies", body, { "cf-connecting-ip": ip }),
        ]);
        expect(res.map((r) => r.statusCode)).toEqual([201, 201]);
        const fams = await h.admin.query(
          "SELECT DISTINCT family_id FROM public.babies WHERE created_by = $1",
          [u.id],
        );
        expect(fams.rows).toHaveLength(1);
        const ledger = await rows(h, [u.id]);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]?.family_id).toBe(fams.rows[0].family_id);
      }
    } finally {
      await h.close();
    }
  });

  it("a founder who handed over admin and left is still in the family: the next album is not a family start", async () => {
    const h = await createHarness({ config: { FAMILIES_PER_IP_PER_DAY: 1 } });
    try {
      const ip = nextIp();
      const post = (u: TestUser, name = "F") =>
        h.inject(u, "POST", "/babies", { ...body, name }, { "cf-connecting-ip": ip });
      const founder = await h.user();
      const co = await h.user();
      const first = await post(founder);
      expect(first.statusCode).toBe(201);
      const babyId = first.json().id as string;
      await h.member(babyId, co, "admin");
      await h.admin.query("DELETE FROM public.baby_members WHERE baby_id = $1 AND user_id = $2", [
        babyId,
        founder.id,
      ]);
      const second = await post(founder, "Again");
      expect(second.statusCode, second.body).toBe(201);
      const fam = (id: string) =>
        h.admin
          .query("SELECT family_id FROM public.babies WHERE id = $1", [id])
          .then((r) => r.rows[0].family_id);
      expect(await fam(second.json().id)).toBe(await fam(babyId));
      expect(await rows(h, [founder.id])).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("a guest's GET /babies/:id shows the family-wide pool (both free albums)", async () => {
    const h = await createHarness();
    try {
      const mom = await h.user();
      const guest = await h.user();
      const a = await h.baby(mom, "A");
      const b = await h.baby(mom, "B");
      await h.member(a, guest, "contributor");
      for (const baby of [a, b])
        await h.admin.query(
          `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, approval, approved_by, status)
           SELECT $1::uuid, $2::uuid, 'fs/' || gen_random_uuid()::text, 'approved', $2::uuid, 'ready' FROM generate_series(1, 4)`,
          [baby, mom.id],
        );
      const got = babySchema.parse((await h.inject(guest, "GET", `/babies/${a}`)).json());
      expect(got.role).toBe("contributor");
      expect(got.freeTier).toEqual({
        used: 8,
        limit: 1000,
        familyAlbums: 2,
        videos: 0,
        videoLimit: FREE_TIER_VIDEO_LIMIT,
      });
    } finally {
      await h.close();
    }
  });
});

describe.skipIf(!databaseUrl)(
  "sign-in is never refused for abuse reasons (step 11, amended)",
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await createHarness();
    });
    afterAll(async () => {
      await h?.close();
    });

    async function signIn(u: TestUser, ip = nextIp()) {
      const session = await gotrueSession({ sub: u.id, email: u.email, sessionId: u.sessionId });
      h.gotrue.impl.verify = async () => session;
      return h.app.inject({
        method: "POST",
        url: "/auth/verify",
        headers: { ...WEB, "cf-connecting-ip": ip },
        payload: { email: u.email, code: "123456" },
      });
    }
    const profileCount = async (id: string) =>
      (await h.admin.query("SELECT 1 FROM public.profiles WHERE user_id = $1", [id])).rows.length;
    const startsFor = async (id: string) =>
      (await h.admin.query("SELECT 1 FROM public.family_starts WHERE user_id = $1", [id])).rows
        .length;

    it("a brand-new account on a disposable domain and a +tag twin of an existing parent both sign in", async () => {
      const t = tag();
      const holder = await h.user({ email: `parent${t}@gmail.com` });
      await h.baby(holder);
      h.gotrue.calls.adminDeleteUser.length = 0;
      const cases = [
        await h.user({ email: `x${t}@mailinator.com`, profile: false }),
        await h.user({ email: `parent${t}+twin@gmail.com`, profile: false }),
        await h.user({ email: `p.arent${t}@googlemail.com`, profile: false }),
      ];
      for (const u of cases) {
        const res = await signIn(u);
        expect(res.statusCode, u.email).toBe(200);
        sessionResponseSchema.parse(res.json());
        expect(await profileCount(u.id)).toBe(1);
        expect(await startsFor(u.id)).toBe(0); // no family_starts row at sign-in
        expect(
          (await h.admin.query("SELECT 1 FROM public.families WHERE created_by = $1", [u.id])).rows,
        ).toHaveLength(0);
      }
      expect(h.gotrue.calls.adminDeleteUser).toHaveLength(0);
      // nothing in the audit trail of the sign-in names a refusal
      for (const u of cases) {
        for (const row of await h.audit({ event: "auth.sign_in", actor: u.id }))
          expect(JSON.stringify(row.metadata)).not.toMatch(/refus|blocked|disposable/i);
      }
    });

    it("a suspended account: POST /auth/otp answers the usual 202 and sends nothing to GoTrue", async () => {
      const u = await h.user();
      const active = await h.user();
      await h.admin.query(
        "UPDATE public.profiles SET suspended_at = now(), suspended_reason = 'abuse' WHERE user_id = $1",
        [u.id],
      );
      h.gotrue.calls.sendOtp.length = 0;
      const post = (email: string) =>
        h.app.inject({
          method: "POST",
          url: "/auth/otp",
          headers: { ...WEB, "cf-connecting-ip": nextIp() },
          payload: { email },
        });
      const susp = await post(u.email);
      expect(susp.statusCode).toBe(202);
      expect(susp.json()).toEqual({ ok: true });
      expect(h.gotrue.calls.sendOtp).toHaveLength(0);
      // an active account (and an unknown address) get the same answer, and GoTrue is asked
      const ok = await post(active.email);
      expect(ok.statusCode).toBe(202);
      expect(ok.json()).toEqual(susp.json());
      expect(ok.body).toBe(susp.body);
      expect(h.gotrue.calls.sendOtp).toHaveLength(1);
      expect((await post(`nobody-${tag()}@example.test`)).statusCode).toBe(202);
    });

    it("a suspended account: POST /auth/verify is 403 account_suspended, ends the GoTrue session, sets no cookie", async () => {
      const u = await h.user();
      await h.admin.query(
        "UPDATE public.profiles SET suspended_at = now(), suspended_reason = 'abuse' WHERE user_id = $1",
        [u.id],
      );
      h.gotrue.calls.logout.length = 0;
      const res = await signIn(u);
      expect(res.statusCode).toBe(403);
      const body = apiErrorSchema.parse(res.json());
      expect(body.error).toBe("account_suspended");
      expect(body.message).toContain("support@tinyglow.app");
      expect(h.gotrue.calls.logout).toHaveLength(1);
      const cookies = [res.headers["set-cookie"]].flat().filter(Boolean).map(String);
      expect(
        cookies.filter(
          (c) => /ll_access=[^;]+/.test(c) && !/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c),
        ),
      ).toHaveLength(0);
      // and an existing token of the suspended account fails every request
      const me = await h.inject(u, "GET", "/me");
      expect(me.statusCode).toBe(403);
      expect(me.json().error).toBe("account_suspended");
      // lifting the suspension restores access
      await h.admin.query(
        "UPDATE public.profiles SET suspended_at = NULL, suspended_reason = NULL WHERE user_id = $1",
        [u.id],
      );
      expect((await h.inject(u, "GET", "/me")).statusCode).toBe(200);
    });
  },
);
