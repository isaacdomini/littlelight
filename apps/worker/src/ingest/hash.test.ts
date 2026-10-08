import { describe, expect, it } from "vitest";
import { sha256 } from "./hash";

describe("sha256", () => {
  it("matches the FIPS 180-2 test vectors", () => {
    expect(sha256(Buffer.from("abc")).toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256(Buffer.alloc(0)).toString("hex")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(
      sha256(Buffer.from("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toString(
        "hex",
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("returns 32 raw bytes (photos.sha256 bytea) for Uint8Array input too", () => {
    const d = sha256(new Uint8Array([1, 2, 3]));
    expect(Buffer.isBuffer(d)).toBe(true);
    expect(d.byteLength).toBe(32);
  });

  it("differs for a single flipped bit", () => {
    const a = Buffer.alloc(100, 7);
    const b = Buffer.from(a);
    b[50] = (b[50] ?? 0) ^ 1;
    expect(sha256(a).equals(sha256(b))).toBe(false);
  });
});
