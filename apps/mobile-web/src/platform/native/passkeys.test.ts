import { beforeEach, describe, expect, it, vi } from "vitest";

// The native passkey seam over the in-house `TinyglowPasskeys` plugin (docs/plans/step-13.md 2.6,
// NATIVE.md "Passkeys"): options and credentials pass through verbatim, the plugin's four codes map
// to `PasskeyError`, an absent plugin is `not_available`, and no OS message is ever forwarded.

const plugin = vi.hoisted(() => ({
  available: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
}));
const registerPlugin = vi.hoisted(() => vi.fn(() => plugin));
vi.mock("@capacitor/core", () => ({ registerPlugin }));

import { PasskeyError } from "../passkeys";
import { nativePasskeys } from "./passkeys";

const credential = {
  id: "AQIDBA",
  rawId: "AQIDBA",
  type: "public-key",
  response: { clientDataJSON: "e30", attestationObject: "o2M" },
  clientExtensionResults: {},
};
const options = {
  challenge: "dGVzdA",
  rp: { id: "tinyglow.app", name: "Tinyglow" },
  // GoTrue: base64url of the 36-char uuid string, opaque to the client
  user: { id: "MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTEx", name: "p@example.com" },
};

beforeEach(() => {
  plugin.available.mockReset().mockResolvedValue({ available: true });
  plugin.create.mockReset().mockResolvedValue({ credential });
  plugin.get.mockReset().mockResolvedValue({ credential });
});

describe("nativePasskeys", () => {
  it("registers the plugin by its JS name once", async () => {
    await nativePasskeys.supported();
    await nativePasskeys.supported();
    expect(registerPlugin).toHaveBeenCalledWith("TinyglowPasskeys");
    expect(registerPlugin.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("supported mirrors available(); a throwing or missing plugin is false", async () => {
    expect(await nativePasskeys.supported()).toBe(true);
    plugin.available.mockResolvedValueOnce({ available: false });
    expect(await nativePasskeys.supported()).toBe(false);
    plugin.available.mockRejectedValueOnce(
      new Error('"TinyglowPasskeys" plugin is not implemented on ios'),
    );
    expect(await nativePasskeys.supported()).toBe(false);
    plugin.available.mockResolvedValueOnce({});
    expect(await nativePasskeys.supported()).toBe(false);
  });

  it("never offers conditional UI", async () => {
    expect(await nativePasskeys.conditionalUiSupported()).toBe(false);
  });

  it("create passes the options through verbatim and returns the plugin's credential JSON untouched", async () => {
    const out = await nativePasskeys.create(options);
    expect(plugin.create).toHaveBeenCalledWith({ options });
    expect(out).toBe(credential);
    // the user id is never decoded or rewritten on this side
    const sent = plugin.create.mock.calls[0]?.[0] as { options: typeof options } | undefined;
    expect(sent?.options.user.id).toBe(options.user.id);
  });

  it("get asks for immediately available credentials (explicit button) and returns the assertion verbatim", async () => {
    const out = await nativePasskeys.get(options, { conditional: true });
    expect(plugin.get).toHaveBeenCalledWith({ options, preferImmediatelyAvailable: true });
    expect(out).toBe(credential);
  });

  it.each(["cancelled", "not_available", "not_configured", "failed"] as const)(
    "maps the plugin code %s (as code or as message) to PasskeyError",
    async (code) => {
      plugin.get.mockRejectedValueOnce({ code, message: "something from the OS" });
      let err = await nativePasskeys.get(options).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PasskeyError);
      expect((err as PasskeyError).code).toBe(code);
      expect((err as Error).message).not.toContain("something from the OS");
      plugin.create.mockRejectedValueOnce({ message: code });
      err = await nativePasskeys.create(options).catch((e: unknown) => e);
      expect((err as PasskeyError).code).toBe(code);
    },
  );

  it("an unimplemented plugin (web build, old native shell) is not_available; anything else is failed", async () => {
    plugin.create.mockRejectedValueOnce(
      new Error('"TinyglowPasskeys.create()" is not implemented on web'),
    );
    await expect(nativePasskeys.create(options)).rejects.toMatchObject({ code: "not_available" });
    plugin.get.mockRejectedValueOnce({ code: "UNIMPLEMENTED", message: "UNIMPLEMENTED" });
    await expect(nativePasskeys.get(options)).rejects.toMatchObject({ code: "not_available" });
    plugin.get.mockRejectedValueOnce(new Error("ASAuthorizationError Code=1004 user detail"));
    const err = await nativePasskeys.get(options).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "failed" });
    expect((err as Error).message).not.toContain("ASAuthorizationError");
    plugin.get.mockRejectedValueOnce(null);
    await expect(nativePasskeys.get(options)).rejects.toMatchObject({ code: "failed" });
  });
});
