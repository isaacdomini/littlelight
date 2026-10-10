import { INSTALL_ID_KEY } from "@tinyglow/shared";
import { type SecureKv, secureKv } from "./secureKv";

// This install's id (`import_sources.device_id`): a random UUID kept in the Keychain, created on
// first use. A reinstall wipes the Keychain (see NATIVE.md, fresh-install wipe), so it becomes a
// new device by design. Never logged.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let memo: string | null = null;

export async function getInstallId(kv: SecureKv = secureKv): Promise<string> {
  if (memo && kv === secureKv) return memo;
  const stored = await kv.get(INSTALL_ID_KEY);
  let id = stored && UUID.test(stored) ? stored : null;
  if (!id) {
    id = crypto.randomUUID();
    try {
      await kv.set(INSTALL_ID_KEY, id);
    } catch {
      // Keychain unavailable: the id lasts for this launch only
    }
  }
  if (kv === secureKv) memo = id;
  return id;
}
