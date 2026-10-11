// Makes the demo family presentable for store screenshots, through the public API as demo-mom:
// approves the seed's two pending photos (a "Pending" badge on tiles looks unfinished) and clears
// the chat thread. Harmless; `pnpm db:seed` restores the original state.
//
//   pnpm exec tsx apps/mobile-web/scripts/store-prep.ts
import type { ApiClient } from "../../../e2e/helpers/api";
import { demoClient, MAYA } from "../../../e2e/helpers/demo";

export async function prepDemo(mom: ApiClient): Promise<void> {
  const list = await mom.call<{ photos: { id: string; approval: string }[] }>(
    "GET",
    `/babies/${MAYA}/photos?limit=50`,
  );
  for (const p of list.body.photos.filter((x) => x.approval === "pending")) {
    const r = await mom.call("POST", `/photos/${p.id}/approve`, {});
    if (r.status !== 200) throw new Error(`approve answered ${r.status}`);
  }
  await mom.call("DELETE", `/babies/${MAYA}/chat/thread`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await prepDemo(await demoClient("demo-mom"));
  console.log("demo family prepared");
}
