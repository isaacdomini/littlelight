import { assertDevStack, deleteLeftoverBabies } from "./helpers/reset";

/** Removes the babies the specs created (the 0-photo Hazel/Ivy/... families). Best effort. */
export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_SKIP_RESET === "1") return;
  try {
    await assertDevStack();
    const n = await deleteLeftoverBabies();
    console.log(`e2e teardown: ${n} spec-created babies removed`);
  } catch (e) {
    console.warn(`e2e teardown skipped: ${e}`);
  }
}
