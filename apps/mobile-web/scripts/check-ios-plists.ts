// Asserts Info-Debug.plist == Info.plist + the two debug-only keys, and nothing else.
// Run: pnpm --filter @littlelight/mobile-web check:ios-plists (needs macOS plutil)
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "ios", "App", "App");
const load = (name: string): Record<string, unknown> =>
  JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", join(dir, name)], { encoding: "utf8" }),
  );

const release = load("Info.plist");
const debug = load("Info-Debug.plist");
const errors: string[] = [];

for (const k of ["NSAppTransportSecurity", "CFBundleURLTypes"]) {
  if (k in release) errors.push(`Info.plist must not contain ${k}`);
}
const expected = {
  ...release,
  NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
  CFBundleURLTypes: [
    {
      CFBundleURLName: "com.tesarsoft.littlelight.debug-scheme",
      CFBundleURLSchemes: ["littlelight"],
    },
  ],
};
if (!isDeepStrictEqual(debug, expected)) {
  const keys = new Set([...Object.keys(debug), ...Object.keys(expected)]);
  for (const k of keys) {
    if (!isDeepStrictEqual(debug[k], (expected as Record<string, unknown>)[k]))
      errors.push(`Info-Debug.plist differs at ${k}`);
  }
}
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
console.log("ios plists ok: Info-Debug.plist = Info.plist + debug-only keys");
