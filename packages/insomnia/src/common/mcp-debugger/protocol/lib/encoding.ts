/** Base64-encode a UTF-8 string (browser btoa over the raw bytes). */
export function base64Utf8(input: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(input)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Decode base64 to a UTF-8 string (inverse of `base64Utf8`). atob yields
 * Latin-1 code points, one per byte — those bytes must be decoded as UTF-8 or
 * any non-ASCII payload (accents, CJK, emoji) arrives as mojibake. Throws on
 * invalid base64.
 */
export function utf8FromBase64(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
