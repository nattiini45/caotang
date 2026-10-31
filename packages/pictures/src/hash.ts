/**
 * The dedup key (pictures.md §6.2): SHA-256 of the bytes as stored, in lower-case hex. WebCrypto's `crypto.subtle.digest`,
 * which every supported browser and Node 22 have; the CSP forbids WASM, and a hash in script would be slow on a 16 MB photo.
 */

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
