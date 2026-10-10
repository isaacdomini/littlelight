// A non-sensitive "album sync is set up on this phone" marker (no ids, no titles). It lets the
// rest of the app skip loading the sync code (and reading the Keychain) for everyone who never
// turned sync on. The real config lives in the Keychain (`ll.sync.v1`).
const KEY = "ll.sync.on";

export function syncMayBeOn(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setSyncFlag(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: sync still works, it just loads its code on every launch
  }
}
