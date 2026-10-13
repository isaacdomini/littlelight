import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { APP_UPDATE_PUBLIC_KEYS, APP_UPDATE_SIGNATURE_MAX_CHARS } from "@tinyglow/shared";
import { describe, expect, it } from "vitest";
import { DEV_APP_UPDATE_KEY, foreignP256Key, p384Key, rsaKey } from "../testing/app-update";
import {
  AppUpdateKeyError,
  createAppUpdateSigner,
  loadSigningKey,
  publicSpkiBase64,
  signManifestJson,
  verifyManifestJson,
} from "./signer";

// Live-update signer (docs/plans/step-14.md 2.6, D6).

const DEV_SPKI = APP_UPDATE_PUBLIC_KEYS.dev.spkiBase64;

describe("loadSigningKey / publicSpkiBase64", () => {
  it("the .env.dev key is P-256 and its public half is APP_UPDATE_PUBLIC_KEYS.dev", () => {
    expect(publicSpkiBase64(loadSigningKey(DEV_APP_UPDATE_KEY))).toBe(DEV_SPKI);
    expect(publicSpkiBase64(loadSigningKey(`  ${DEV_APP_UPDATE_KEY}\n`))).toBe(DEV_SPKI);
  });

  it.each([
    ["empty", ""],
    ["junk", "not-a-key"],
    ["junk base64", Buffer.from("hello world, not DER").toString("base64")],
    [
      "base64 with junk inside",
      `${DEV_APP_UPDATE_KEY.slice(0, 20)}!!${DEV_APP_UPDATE_KEY.slice(22)}`,
    ],
    ["RSA", rsaKey()],
    ["P-384", p384Key()],
  ])("refuses %s with a fixed message (no key material)", (_n, value) => {
    let err: unknown;
    try {
      loadSigningKey(value);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppUpdateKeyError);
    const msg = String((err as Error).message);
    if (value.length > 8) expect(msg).not.toContain(value.slice(0, 8));
  });
});

describe("createAppUpdateSigner", () => {
  it("dev key: trusted outside production, keyId dev", () => {
    const r = createAppUpdateSigner(DEV_APP_UPDATE_KEY, { production: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signer.keyId).toBe("dev");
  });

  it("dev key: refused in production (key_untrusted)", () => {
    expect(createAppUpdateSigner(DEV_APP_UPDATE_KEY, { production: true })).toEqual({
      ok: false,
      outcome: "key_untrusted",
    });
  });

  it("a foreign P-256 key is key_untrusted in every environment", () => {
    const k = foreignP256Key();
    expect(createAppUpdateSigner(k, { production: false })).toEqual({
      ok: false,
      outcome: "key_untrusted",
    });
    expect(createAppUpdateSigner(k, { production: true })).toEqual({
      ok: false,
      outcome: "key_untrusted",
    });
  });

  it.each([
    ["RSA", rsaKey()],
    ["P-384", p384Key()],
    ["junk", "abc$"],
  ])("%s is key_invalid", (_n, k) => {
    expect(createAppUpdateSigner(k, { production: false })).toEqual({
      ok: false,
      outcome: "key_invalid",
    });
  });

  it.each([undefined, "", "   "])("%j is no_key", (k) => {
    expect(createAppUpdateSigner(k, { production: false })).toEqual({
      ok: false,
      outcome: "no_key",
    });
  });

  it("the signer object exposes no key material", () => {
    const r = createAppUpdateSigner(DEV_APP_UPDATE_KEY, { production: false });
    if (!r.ok) throw new Error("expected ok");
    expect(Object.keys(r.signer).sort()).toEqual(["keyId", "sign"]);
    expect(JSON.stringify(r.signer)).not.toContain(DEV_APP_UPDATE_KEY.slice(40, 70));
  });
});

describe("sign / verify", () => {
  const r = createAppUpdateSigner(DEV_APP_UPDATE_KEY, { production: false });
  if (!r.ok) throw new Error("dev key must load");
  const signer = r.signer;
  const json = JSON.stringify({ schema: 1, version: "0123456789abcdef", note: "héllo ✓" });

  it("signs the exact UTF-8 bytes; verifies with the dev SPKI; DER <= 72 bytes", () => {
    for (let i = 0; i < 20; i++) {
      const sig = signer.sign(json);
      expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(sig.length).toBeLessThanOrEqual(APP_UPDATE_SIGNATURE_MAX_CHARS);
      const der = Buffer.from(sig, "base64");
      expect(der[0]).toBe(0x30);
      expect(der.length).toBeLessThanOrEqual(72);
      expect(verifyManifestJson(DEV_SPKI, json, sig)).toBe(true);
    }
  });

  it("tampering with the text, the signature or the key fails", () => {
    const sig = signer.sign(json);
    expect(verifyManifestJson(DEV_SPKI, json.replace("0123", "0124"), sig)).toBe(false);
    expect(verifyManifestJson(DEV_SPKI, `${json} `, sig)).toBe(false);
    const der = Buffer.from(sig, "base64");
    der[der.length - 1] = (der[der.length - 1] as number) ^ 0x01;
    expect(verifyManifestJson(DEV_SPKI, json, der.toString("base64"))).toBe(false);
    expect(verifyManifestJson(APP_UPDATE_PUBLIC_KEYS.prod.spkiBase64, json, sig)).toBe(false);
    expect(verifyManifestJson("garbage", json, sig)).toBe(false);
    expect(verifyManifestJson(DEV_SPKI, json, "")).toBe(false);
  });

  it("signManifestJson matches a key generated here (round trip, independent of the dev key)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const pk = createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }));
    expect(verifyManifestJson(spki, "x", signManifestJson(pk, "x"))).toBe(true);
  });
});
