import { resetDevState } from "./helpers/reset";

/**
 * The web e2e assumes the seeded dev state, but the gates (push/share) leave Maya analysed and the
 * api's sign-in throttle spent. Reset first, on the dev stack only; aborts if it is not the dev DB.
 * E2E_SKIP_RESET=1 skips it (a harness that already did).
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.E2E_SKIP_RESET === "1") return;
  const { babies } = await resetDevState();
  console.log(`e2e reset: Maya restored to seed, ${babies} leftover babies removed, api restarted`);
}
