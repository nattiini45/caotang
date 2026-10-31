/**
 * Windows-1252 decoding through the explicit table (windows-1252.ts), not the runtime's TextDecoder: Node 22.13.0 to 22.22.0
 * decode `windows-1252` as ISO-8859-1 (nodejs/node#60888), and the Node 22 floor sits inside that range.
 */
import { describe, expect, it } from 'vitest';
import { decodeAs, decodeStrict, decodeWindows1252, WINDOWS_1252_HIGH } from '../src/index.js';

/** WHATWG index-windows-1252 for 0x80 to 0x9F, written out so the test does not ask the runtime what it is. */
const HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

describe('decodeWindows1252', () => {
  it('maps 0x80 to 0x9F through the Windows-1252 table, the five empty codes to their C1 controls', () => {
    expect(String.fromCharCode(...WINDOWS_1252_HIGH)).toBe(HIGH);
    const bytes = Uint8Array.from({ length: 0x20 }, (_, i) => 0x80 + i);
    expect(decodeWindows1252(bytes)).toBe(HIGH);
  });

  it('decodes every other byte to the code point of the same number', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = decodeWindows1252(bytes);
    expect(text).toHaveLength(256);
    for (let byte = 0; byte < 256; byte += 1) {
      if (byte >= 0x80 && byte <= 0x9f) expect(text[byte]).toBe(HIGH[byte - 0x80]);
      else expect(text.charCodeAt(byte)).toBe(byte);
    }
  });

  it('decodes a file larger than one chunk without dropping or repeating a byte', () => {
    const bytes = Uint8Array.from({ length: 20_001 }, (_, i) => (i % 3 === 0 ? 0x93 : i % 3 === 1 ? 0x61 : 0x94));
    const text = decodeWindows1252(bytes);
    expect(text).toHaveLength(20_001);
    expect(text.slice(0, 6)).toBe('“a”“a”');
    expect(text.at(-1)).toBe('”'); // byte 20,000 is 0x94
  });

  it('is what decodeAs and decodeStrict return for windows-1252, and decodeStrict never refuses it', () => {
    const bytes = Uint8Array.from([0x80, 0x81, 0x9f, 0xe9]);
    expect(decodeAs(bytes, 'windows-1252')).toEqual({ encoding: 'windows-1252', text: '€\u0081Ÿé' });
    expect(decodeStrict(bytes, 'windows-1252')).toBe('€\u0081Ÿé');
  });
});
