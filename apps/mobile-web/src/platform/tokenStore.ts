// Step-9 seam: native builds store tokens in Keychain/Keystore. On the web the session lives in
// httpOnly cookies managed by the API, so this store is a deliberate no-op: tokens must never be
// written to localStorage/sessionStorage.
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStore {
  get(): Promise<StoredTokens | null>;
  set(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

export const webTokenStore: TokenStore = {
  get: async () => null,
  set: async () => {},
  clear: async () => {},
};

let current: TokenStore = webTokenStore;

export function getTokenStore(): TokenStore {
  return current;
}

/** Step 9 calls this once at startup with the secure-storage implementation. */
export function setTokenStore(store: TokenStore): void {
  current = store;
}
