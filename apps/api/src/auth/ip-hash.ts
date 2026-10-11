import { createHash, createHmac, hkdfSync } from "node:crypto";
import type { ApiConfig } from "../config";

// Keyed hash of the client IP for `family_starts.ip_hash` (docs/plans/step-11.md 2.2 E, 2.4).
// Key: HKDF-SHA256(JWT_SECRET, salt "tinyglow", info "family-ip-v1"), deliberately a different
// `info` from the share ledgers' "share-ip-v1" (sharing/crypto.ts) so the two tables can never be
// joined on the hash. The IP itself is never stored or logged; neither is this hash.

const HKDF_SALT = "tinyglow";
const FAMILY_IP_KEY_INFO = "family-ip-v1";

type SecretConfig = Pick<ApiConfig, "JWT_SECRET">;

let cached: { fingerprint: string; key: Uint8Array } | null = null;

function familyIpKey(config: SecretConfig): Uint8Array {
  const fingerprint = createHash("sha256").update(config.JWT_SECRET).digest("base64url");
  if (cached?.fingerprint === fingerprint) return cached.key;
  const key = new Uint8Array(
    hkdfSync("sha256", config.JWT_SECRET, HKDF_SALT, FAMILY_IP_KEY_INFO, 32),
  );
  cached = { fingerprint, key };
  return key;
}

/** HMAC-SHA256 of the client IP (32 bytes) under the family-start ledger key. */
export function hashFamilyIp(config: SecretConfig, ip: string): Buffer {
  return createHmac("sha256", familyIpKey(config)).update(ip, "utf8").digest();
}
