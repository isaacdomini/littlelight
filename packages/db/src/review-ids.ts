/**
 * Deterministic ids of the store-review family (docs/plans/step-9.md 2.9 item 6, 2.5; D4).
 *
 * Dependency-free on purpose (only `node:crypto`): the api imports this module through the
 * `@littlelight/db/review` subpath to check, at review sign-in, that the account belongs to no
 * baby other than `reviewBabyId(userId)`. The package root pulls in `pg` and `node-pg-migrate`,
 * which the api's production bundle must not reference. `review-family.ts` re-exports these.
 */

import { createHash } from "node:crypto";

/**
 * Deterministic id for one review-family row: the first 16 bytes of
 * sha256("littlelight:review-family:v1:<userId>:<label>") as an RFC 9562 version-8 UUID.
 */
export function reviewId(userId: string, label: string): string {
  const h = createHash("sha256")
    .update(`littlelight:review-family:v1:${userId.toLowerCase()}:${label}`, "utf8")
    .digest()
    .subarray(0, 16);
  h.writeUInt8((h.readUInt8(6) & 0x0f) | 0x80, 6);
  h.writeUInt8((h.readUInt8(8) & 0x3f) | 0x80, 8);
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The review baby id for a user (the api's review sign-in guard uses the same rule). */
export function reviewBabyId(userId: string): string {
  return reviewId(userId, "baby");
}

export function reviewPhotoId(userId: string, nn: number): string {
  return reviewId(userId, `photo:${nn}`);
}
