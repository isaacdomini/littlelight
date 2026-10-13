import { describe, expect, it } from "vitest";
import { passkeyEnvSchema } from "./env";

// `AUTH_PASSKEYS_ENABLED` (docs/plans/step-13.md 2.3, 2.7): off by default and on a blank value,
// so a stack that never heard of passkeys answers 404 `passkey_disabled` everywhere.

describe("passkeyEnvSchema", () => {
  it("defaults to false, and a blank value is unset (false)", () => {
    expect(passkeyEnvSchema.parse({}).AUTH_PASSKEYS_ENABLED).toBe(false);
    expect(passkeyEnvSchema.parse({ AUTH_PASSKEYS_ENABLED: "" }).AUTH_PASSKEYS_ENABLED).toBe(false);
    expect(passkeyEnvSchema.parse({ AUTH_PASSKEYS_ENABLED: undefined }).AUTH_PASSKEYS_ENABLED).toBe(
      false,
    );
  });

  it("parses the usual boolean spellings (zod stringbool)", () => {
    for (const v of ["true", "1", "yes", "on", "TRUE"]) {
      expect(passkeyEnvSchema.parse({ AUTH_PASSKEYS_ENABLED: v }).AUTH_PASSKEYS_ENABLED, v).toBe(
        true,
      );
    }
    for (const v of ["false", "0", "no", "off", "FALSE"]) {
      expect(passkeyEnvSchema.parse({ AUTH_PASSKEYS_ENABLED: v }).AUTH_PASSKEYS_ENABLED, v).toBe(
        false,
      );
    }
  });

  it("rejects anything that is not a boolean word (a typo never turns the feature on)", () => {
    for (const v of ["maybe", "2", "passkeys", "ture"]) {
      expect(passkeyEnvSchema.safeParse({ AUTH_PASSKEYS_ENABLED: v }).success, v).toBe(false);
    }
  });
});
