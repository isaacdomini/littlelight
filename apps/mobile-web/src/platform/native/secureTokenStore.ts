import type { StoredTokens, TokenStore } from "../tokenStore";

// Keychain (iOS) / Keystore-wrapped storage (Android) token store (docs/plans/step-9.md 2.5).
// One entry holds `{accessToken, refreshToken}`. iOS accessibility is
// `afterFirstUnlockThisDeviceOnly`: no iCloud Keychain sync, not restored onto another device.
// If the plugin is missing or throws, the store degrades to memory for this launch (the user
// signs in again); it never falls back to localStorage/sessionStorage/Preferences.

const KEY = "ll.session.v1";

function parse(raw: unknown): StoredTokens | null {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      v &&
      typeof v === "object" &&
      typeof (v as StoredTokens).accessToken === "string" &&
      typeof (v as StoredTokens).refreshToken === "string"
    ) {
      const { accessToken, refreshToken } = v as StoredTokens;
      return { accessToken, refreshToken };
    }
  } catch {
    // corrupt entry: treated as signed out
  }
  return null;
}

export function createSecureTokenStore(): TokenStore {
  let memory: StoredTokens | null = null;
  let loaded = false;
  let pluginBroken = false;

  async function plugin() {
    return await import("@aparajita/capacitor-secure-storage");
  }

  return {
    async get() {
      if (loaded || pluginBroken) return memory;
      try {
        const { SecureStorage } = await plugin();
        memory = parse(await SecureStorage.get(KEY, false, false));
        loaded = true;
      } catch {
        pluginBroken = true;
      }
      return memory;
    },
    async set(tokens) {
      memory = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
      loaded = true;
      if (pluginBroken) return;
      try {
        const { SecureStorage, KeychainAccess } = await plugin();
        await SecureStorage.set(
          KEY,
          JSON.stringify(memory),
          false,
          false,
          KeychainAccess.afterFirstUnlockThisDeviceOnly,
        );
      } catch {
        pluginBroken = true;
      }
    },
    async clear() {
      memory = null;
      loaded = true;
      try {
        const { SecureStorage } = await plugin();
        await SecureStorage.remove(KEY, false);
      } catch {
        // nothing stored, or plugin unavailable
      }
    },
  };
}
