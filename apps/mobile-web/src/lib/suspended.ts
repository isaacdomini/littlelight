import { useSyncExternalStore } from "react";

// A suspended account gets `account_suspended` (403) from every call and from sign-in. The API
// layer flags it here once; <SuspendedGate> then replaces the app with the suspended screen.
let suspended = false;
const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}

export function markSuspended(): void {
  if (suspended) return;
  suspended = true;
  emit();
}

export function clearSuspended(): void {
  if (!suspended) return;
  suspended = false;
  emit();
}

export function useSuspended(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => suspended,
    () => false,
  );
}
