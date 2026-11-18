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
    expect(profile.length).toBe(540);
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
});
