/** Lowercase hex SHA-256 of the whole file, or null when WebCrypto is unavailable (insecure
 * context) or the file can't be read. The value is only a duplicate pre-check hint. */
export async function sha256Hex(file: Blob): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}
