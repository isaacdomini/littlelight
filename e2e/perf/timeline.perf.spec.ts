import { expect, type Page, test } from "@playwright/test";
import { demoClient, PERF_BABY } from "../helpers/demo";

// Step 5 gate, "10,000 seeded photos scroll smoothly" (docs/plans/step-5.md 2.10). Needs
// `pnpm perf:seed`. The scroll is driven inside the page (no Playwright round trips) while a
// rAF sampler records frame deltas, a PerformanceObserver records long tasks and an interval
// samples the mounted thumbnail/image counts. Thresholds: local / PERF_CI=1.

const CI = process.env.PERF_CI === "1";
const T = CI
  ? { jank: 15, p95: 34, max: 600, longTasks: 40, images: 400, nodes: 600, api: 800 }
  : { jank: 5, p95: 20, max: 250, longTasks: 10, images: 400, nodes: 600, api: 300 };
const TOTAL = 10_000;

interface Sample {
  frames: number[];
  longTasks: number;
  maxImages: number;
  maxThumbs: number;
  groupsSeen: string[];
  scrollMs: number;
}

const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 8080}`;

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};

async function scrollAll(page: Page): Promise<Sample> {
  return page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="timeline-scroller"]');
    if (!scroller) throw new Error("timeline-scroller not found");
    const thumbRe = /^photo-[0-9a-f-]{36}$/;
    const out = {
      frames: [] as number[],
      longTasks: 0,
      maxImages: 0,
      maxThumbs: 0,
      groupsSeen: [] as string[],
      scrollMs: 0,
    };
    let driving = true;
    let start = performance.now();
    let prev = 0;
    let rafOn = true;
    const tick = (now: number) => {
      if (!rafOn) return;
      if (prev && driving && now - start > 2000) out.frames.push(now - prev);
      prev = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (driving && e.startTime - start > 2000 && e.duration >= 100) out.longTasks++;
      }
    });
    po.observe({ type: "longtask", buffered: false });
    const sampler = setInterval(() => {
      out.maxImages = Math.max(out.maxImages, document.images.length);
      let n = 0;
      for (const el of document.querySelectorAll('[data-testid^="photo-"]')) {
        if (thumbRe.test(el.getAttribute("data-testid") ?? "")) n++;
      }
      out.maxThumbs = Math.max(out.maxThumbs, n);
      for (const g of document.querySelectorAll('[data-testid^="timeline-group-"]')) {
        const key = (g.getAttribute("data-testid") ?? "").replace("timeline-group-", "");
        if (!out.groupsSeen.includes(key)) out.groupsSeen.push(key);
      }
    }, 500);

    const pagesSeen = () =>
      performance.getEntriesByType("resource").filter((r) => /\/photos\?/.test(r.name)).length;

    const sweep = (dir: 1 | -1) =>
      new Promise<void>((resolve) => {
        let lastPages = pagesSeen();
        let lastNew = performance.now();
        driving = true;
        const iv = setInterval(() => {
          scroller.scrollBy(0, 1200 * dir);
          const atEnd =
            dir === 1
              ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
              : scroller.scrollTop <= 0;
          const p = pagesSeen();
          if (p !== lastPages) {
            lastPages = p;
            lastNew = performance.now();
          }
          if (atEnd && performance.now() - lastNew > 3000) {
            clearInterval(iv);
            resolve();
          }
        }, 50);
      });

    start = performance.now();
    await sweep(1);
    out.scrollMs = performance.now() - start;
    // Sample the bottom group header before scrolling back.
    await new Promise((r) => setTimeout(r, 700));
    await sweep(-1);
    driving = false;
    rafOn = false;
    po.disconnect();
    clearInterval(sampler);
    return out;
  });
}

test("timeline scrolls smoothly over 10,000 photos", async ({ browser }, testInfo) => {
  const mom = await demoClient("demo-mom");
  const summary = await mom.call<{ total: number }>("GET", `/babies/${PERF_BABY}/photos/summary`);
  expect(
    summary.body.total,
    "perf baby not seeded (or not visible to demo-mom): run `pnpm perf:seed`",
  ).toBe(TOTAL);

  const viewport = testInfo.project.use.viewport ?? { width: 375, height: 812 };
  const ctx = await browser.newContext({
    baseURL: BASE,
    viewport,
    storageState: await mom.storageState(),
  });
  await ctx.addInitScript((id) => localStorage.setItem("ll_current_baby", id), PERF_BABY);
  // ~10k thumbnail requests would overflow the default 250-entry resource timing buffer.
  await ctx.addInitScript(() => performance.setResourceTimingBufferSize(200_000));
  const page = await ctx.newPage();
  try {
    await page.goto("/timeline");
    await expect(page.locator('[data-testid^="timeline-group-"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("timeline-total").first()).toContainText("10000");
    // Let the first images settle before sampling.
    await page.waitForLoadState("networkidle");

    const s = await scrollAll(page);

    // Pages fetched and API timings (same-origin resource timing).
    const timings = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((r) => /\/photos\?/.test(r.name) && r.name.includes("limit=200"))
        .map((r) => r.duration),
    );

    // Scrubber jump to a deep group.
    await page
      .getByTestId("timeline-scroller")
      .first()
      .evaluate((el) => {
        el.scrollTo(0, 0);
      });
    await page.getByTestId("timeline-jump-m12").first().click();
    const header = page.getByTestId("timeline-group-m12").first();
    await expect(header).toBeVisible({ timeout: 2_000 });
    const jumpGroup = await page.evaluate(() => {
      const sc = document.querySelector('[data-testid="timeline-scroller"]');
      if (!sc) return null;
      const top = sc.getBoundingClientRect().top;
      const re = /^photo-[0-9a-f-]{36}$/;
      for (const el of sc.querySelectorAll('[data-testid^="photo-"]')) {
        if (!re.test(el.getAttribute("data-testid") ?? "")) continue;
        if (el.getBoundingClientRect().bottom > top + 40) {
          return el.closest("[data-group]")?.getAttribute("data-group") ?? null;
        }
      }
      return null;
    });

    const warm = s.frames;
    const jank = (warm.filter((f) => f > 33).length / Math.max(1, warm.length)) * 100;
    const row = {
      frames: warm.length,
      "jank >33ms %": +jank.toFixed(2),
      "p95 frame ms": +pct(warm, 95).toFixed(1),
      "max frame ms": +Math.max(0, ...warm).toFixed(1),
      "long tasks": s.longTasks,
      "max images": s.maxImages,
      "max thumbs": s.maxThumbs,
      "pages (limit=200)": timings.length,
      "API p95 ms": +pct(timings, 95).toFixed(0),
      "scroll down s": +(s.scrollMs / 1000).toFixed(1),
      "w1 reached": s.groupsSeen.includes("w1") || s.groupsSeen.includes("pre"),
      "groups seen": s.groupsSeen.length,
      "m12 jump group": jumpGroup,
    };
    const limits = CI ? "PERF_CI thresholds" : "local thresholds";
    console.log(
      `\nTimeline perf [${testInfo.project.name} ${viewport.width}x${viewport.height}] (${limits}: ` +
        `jank<=${T.jank}% p95<=${T.p95}ms max<=${T.max}ms longtasks<=${T.longTasks} images<=${T.images} nodes<=${T.nodes} api<=${T.api}ms)`,
    );
    for (const [k, v] of Object.entries(row)) console.log(`  ${k.padEnd(20)} ${v}`);

    expect(warm.length, "frames sampled").toBeGreaterThan(200);
    expect(jank, "share of frames > 33 ms (%)").toBeLessThanOrEqual(T.jank);
    expect(pct(warm, 95), "p95 frame ms").toBeLessThanOrEqual(T.p95);
    expect(Math.max(...warm), "max frame ms").toBeLessThanOrEqual(T.max);
    expect(s.longTasks, "long tasks >= 100 ms").toBeLessThanOrEqual(T.longTasks);
    expect(s.maxImages, "mounted images").toBeLessThanOrEqual(T.images);
    expect(s.maxThumbs, "mounted thumbs").toBeLessThanOrEqual(T.nodes);
    expect(
      s.groupsSeen.includes("w1") || s.groupsSeen.includes("pre"),
      `bottom group header reached (saw ${s.groupsSeen.join(",")})`,
    ).toBe(true);
    expect(timings.length, "all pages fetched").toBeGreaterThanOrEqual(TOTAL / 200 - 1);
    expect(pct(timings, 95), "API p95 ms").toBeLessThanOrEqual(T.api);
    expect(jumpGroup, "first visible thumb after the m12 jump").toBe("m12");
  } finally {
    await ctx.close();
  }
});
