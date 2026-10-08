import { createHash } from "node:crypto";

// Exact-duplicate hash (docs/plans/step-4.md 2.7 step 4; PRD FR-2.5). The server re-hash of the
// stored original is the source of truth; the client's `clientSha256` is only a pre-check.

/** SHA-256 digest (32 bytes) of `buf`, for `photos.sha256 bytea`. */
export function sha256(buf: Uint8Array): Buffer {
  return createHash("sha256").update(buf).digest();
}
