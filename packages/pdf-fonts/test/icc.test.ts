/**
 * The sRGB ICC profile the PDF/A output intent embeds (screenplay.md §5.3): a complete
 * ICC v4.3 profile written byte for byte. These tests check the header's own numbers — its
 * declared size, signature and version — and the tag table's bookkeeping: every tag offset
 * is 4-aligned and every tag body lands inside the file.
 */

import { describe, expect, it } from 'vitest';
import { srgbIccProfile } from '../src/index.js';

const u32 = (bytes: Uint8Array, at: number): number =>
  (bytes[at]! << 24 | bytes[at + 1]! << 16 | bytes[at + 2]! << 8 | bytes[at + 3]!) >>> 0;

const text = (bytes: Uint8Array, at: number, length = 4): string =>
  String.fromCharCode(...bytes.slice(at, at + length));

describe('srgbIccProfile', () => {
  const profile = srgbIccProfile();

  it('is a complete ICC v4.3 profile: acsp signature, its declared size its real size', () => {
    expect(profile.length).toBe(532);
    expect(u32(profile, 0)).toBe(profile.length);
    expect(text(profile, 36)).toBe('acsp');
    expect(profile[8]).toBe(0x04);
    expect(profile[9]).toBe(0x30);
    // An RGB matrix/TRC display profile: 'mntr' 'RGB ' 'XYZ '.
    expect(text(profile, 12)).toBe('mntr');
    expect(text(profile, 16)).toBe('RGB ');
    expect(text(profile, 20)).toBe('XYZ ');
  });

  it('names the nine tags a conforming reader wants, each body aligned and inside the file', () => {
    const count = u32(profile, 128);
    expect(count).toBe(9);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const entry = 132 + i * 12;
      names.push(text(profile, entry));
      const offset = u32(profile, entry + 4);
      const length = u32(profile, entry + 8);
      expect(offset % 4).toBe(0);
      expect(offset + length).toBeLessThanOrEqual(profile.length);
    }
    expect(names.sort()).toEqual(['bTRC', 'bXYZ', 'cprt', 'desc', 'gTRC', 'gXYZ', 'rTRC', 'rXYZ', 'wtpt'].sort());
  });

  it('carries well-formed mluc records: two-byte language and country, UTF-16BE text', () => {
    // The desc tag's body: 'mluc', reserved, record count, then 12-byte records (lang, country, length, offset).
    const desc = u32(profile, 132 + 4);
    expect(text(profile, desc)).toBe('mluc');
    expect(u32(profile, desc + 8)).toBe(1);
    expect(u32(profile, desc + 12)).toBe(12);
    const record = desc + 16;
    expect(text(profile, record, 2)).toBe('en');
    expect(text(profile, record + 2, 2)).toBe('US');
    const length = u32(profile, record + 4);
    const offset = u32(profile, record + 8);
    expect(offset).toBe(28);
    expect(length % 2).toBe(0);
    const units: number[] = [];
    for (let i = 0; i < length; i += 2) units.push((profile[desc + offset + i]! << 8) | profile[desc + offset + i + 1]!);
    expect(String.fromCharCode(...units)).toBe('sRGB IEC61966-2.1');
  });
});
