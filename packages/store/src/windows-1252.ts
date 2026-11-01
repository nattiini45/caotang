/**
 * Windows-1252 decoding that does not depend on the runtime's `TextDecoder`.
 *
 * Windows-1252 is ISO-8859-1 except for 0x80 to 0x9F, where it holds 27 printable characters (the euro sign, the curly quotes,
 * the dashes) and leaves five codes empty (WHATWG Encoding Standard, index-windows-1252). Node 20.18.3 to 20.19.x and 22.13.0
 * to 22.22.0 decode `windows-1252` (and its `latin1` / `iso-8859-1` labels) as ISO-8859-1, so 0x93 comes out as the C1 control
 * U+0093 instead of “ (nodejs/node#60888, fixed in 22.22.1). The Node 22 floor (22.19) is inside that range, so every
 * Windows-1252 decode in this package goes through the explicit table below and reads the same in Node, Electron and browsers.
 */

/**
 * What 0x80 to 0x9F decode to, in byte order. The five empty codes (0x81, 0x8D, 0x8F, 0x90, 0x9D) decode to the C1 control of
 * the same number, as the WHATWG index does, so a decode never throws and never yields U+FFFD.
 */
export const WINDOWS_1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** Code units per `String.fromCharCode` call, well under every engine's argument limit. */
const CHUNK = 8192;

/** Decodes bytes as Windows-1252. Every byte maps to one character, so this never throws (a `fatal` decoder would not either). */
export function decodeWindows1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  const units = new Uint16Array(Math.min(bytes.length, CHUNK));
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK);
    for (let i = start; i < end; i += 1) {
      const byte = bytes[i]!;
      units[i - start] = byte >= 0x80 && byte <= 0x9f ? WINDOWS_1252_HIGH[byte - 0x80]! : byte;
    }
    parts.push(String.fromCharCode(...units.subarray(0, end - start)));
  }
  return parts.join('');
}
