import { isNative } from "../platform/platform";

/** Success tap in the app (upload complete, link created, milestone saved); no-op on the web. */
export function hapticSuccess(): void {
  if (!isNative()) return;
  void import("../platform/native/ui").then((m) => m.hapticSuccess()).catch(() => undefined);
}
