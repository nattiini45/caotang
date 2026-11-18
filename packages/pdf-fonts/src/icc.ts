/**
 * The sRGB ICC profile a PDF/A output intent names (screenplay.md §5.3): the standard profile, written byte for byte
 * rather than vendored, so the file carries the 532 bytes a conforming reader needs and nothing else. ICC v4.3
 * (ISO 15076-1): a matrix/TRC display profile with the sRGB colorants adapted to the D50 connection space and the
 * sRGB tone curve as a parametric type-4 curve in each channel.
 */

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function fourcc(text: string): number[] {
  return [text.charCodeAt(0) & 0xff, text.charCodeAt(1) & 0xff, text.charCodeAt(2) & 0xff, text.charCodeAt(3) & 0xff];
}

/** A signed 15.16 fixed-point number. */
function s15(value: number): number[] {
  return u32(Math.round(value * 65536));
}

/** An `XYZ ` tag body: the signature, reserved word, then three fixed-point numbers. */
function xyzTag(x: number, y: number, z: number): number[] {
  return [...fourcc('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)];
}

/** A `para` tag body of type 4 (g, a, b, c, d, e, f): Y = (aX + b)^g + e for X ≥ d, else cX + f. */
function para4Tag(g: number, a: number, b: number, c: number, d: number, e: number, f: number): number[] {
  return [...fourcc('para'), 0, 0, 0, 0, ...u16(4), 0, 0, ...s15(g), ...s15(a), ...s15(b), ...s15(c), ...s15(d), ...s15(e), ...s15(f)];
}

/** An `mluc` tag body: one US-English record holding UTF-16BE text. */
function mlucTag(text: string): number[] {
  const utf16: number[] = [];
  for (const ch of text) utf16.push(...u16(ch.charCodeAt(0)));
  return [...fourcc('mluc'), 0, 0, 0, 0, ...u32(1), ...u32(12), ...'enUS'.split('').map((ch) => ch.charCodeAt(0)), ...u32(utf16.length), ...u32(28), ...utf16];
}

/**
 * The sRGB profile's bytes. The colorants are the standard D50-adapted sRGB primaries every reader knows; the curve is
 * the sRGB transfer function — (X/1.055 + 0.055/1.055)^2.4 − 0.055 above 0.04045, X/12.92 below it — in parametric
 * type-4 form (g, a, b, c, d, e, f = 2.4, 1/1.055, 0.055/1.055, 1/12.92, 0.04045, −0.055, 0).
 */
export function srgbIccProfile(): Uint8Array {
  const trc = para4Tag(2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045, -0.055, 0);
  const tags: readonly [string, number[]][] = [
    ['desc', mlucTag('sRGB')],
    ['cprt', mlucTag('Public domain')],
    ['wtpt', xyzTag(0.9642, 1, 0.8249)],
    ['rXYZ', xyzTag(0.4361, 0.2225, 0.0139)],
    ['gXYZ', xyzTag(0.3851, 0.7169, 0.0971)],
    ['bXYZ', xyzTag(0.1431, 0.0606, 0.7141)],
    ['rTRC', trc],
    ['gTRC', trc],
    ['bTRC', trc],
  ];
  // Tag data sits after the 128-byte header and the table (a count plus 12 bytes a tag), each block 4-aligned.
  let at = 128 + 4 + tags.length * 12;
  const table: number[] = [...u32(tags.length)];
  const data: number[] = [];
  for (const [signature, body] of tags) {
    table.push(...fourcc(signature), ...u32(at), ...u32(body.length));
    data.push(...body);
    while ((at + data.length) % 4 !== 0) data.push(0);
    at += body.length + ((4 - (body.length % 4)) % 4);
  }
  const header = [
    ...u32(at), // profile size
    ...fourcc('caot'), // preferred CMM
    0x04, 0x30, 0, 0, // version 4.3
    ...fourcc('mntr'), // device class: display
    ...fourcc('RGB '), // colour space
    ...fourcc('XYZ '), // PCS
    ...u16(2026), ...u16(1), ...u16(1), ...u16(0), ...u16(0), ...u16(0), // created
    ...fourcc('acsp'),
    ...fourcc('APPL'), // platform
    0, 0, 0, 0, // flags
    ...fourcc('caot'), // manufacturer
    0, 0, 0, 0, // model
    0, 0, 0, 0, 0, 0, 0, 0, // attributes
    0, 0, 0, 0, // rendering intent: perceptual
    ...s15(0.9642), ...s15(1), ...s15(0.8249), // PCS illuminant D50
    ...fourcc('caot'), // creator
    ...new Array<number>(16).fill(0), // profile ID
    ...new Array<number>(28).fill(0), // reserved
  ];
  return new Uint8Array([...header, ...table, ...data]);
}
