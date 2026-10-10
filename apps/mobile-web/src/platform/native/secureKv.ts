// Small string key-value store over the Keychain (iOS) / Keystore (Android), for the install id
// and the album-sync config. `afterFirstUnlockThisDeviceOnly`: readable by a background refresh
// while the phone is locked, never synced to iCloud Keychain or restored onto another device.
// Failures degrade to "nothing stored" (callers treat that as unconfigured), never to
// localStorage.

export interface SecureKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

async function plugin() {
  return await import("@aparajita/capacitor-secure-storage");
}

export const secureKv: SecureKv = {
  async get(key) {
    try {
      const { SecureStorage } = await plugin();
      const v = await SecureStorage.get(key, false, false);
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    const { SecureStorage, KeychainAccess } = await plugin();
    await SecureStorage.set(
      key,
      value,
      false,
      false,
      KeychainAccess.afterFirstUnlockThisDeviceOnly,
    );
  },
  async remove(key) {
    try {
      const { SecureStorage } = await plugin();
      await SecureStorage.remove(key, false);
    } catch {
      // nothing stored, or plugin unavailable
    }
  },
};
