import { describe, expect, it } from 'vitest';
import { decodePlacementTitle, encodePlacementTitle, placementCaptionOf } from '../src/index.js';

const placement = (title: string | null) => {
  const decoded = decodePlacementTitle(title);
  if (decoded.kind !== 'placement') throw new Error('expected a placement');
  return decoded;
};

describe('the placement title codec (pictures.md §2.2.1)', () => {
  it('reads a caption-only title as the caption with the defaults, and writes it back unchanged', () => {
    const decoded = placement('The lighthouse, 1891');
    expect(decoded).toMatchObject({ caption: 'The lighthouse, 1891', size: 'full', decorative: false, extras: [], notes: [] });
    expect(encodePlacementTitle(decoded)).toBe('The lighthouse, 1891');
  });

  it('reads a size and a decoration flag, and writes the canonical order', () => {
    const title = 'The lighthouse [caotang-image v1;size=half;decorative]';
    const decoded = placement(title);
    expect(decoded).toMatchObject({ caption: 'The lighthouse', size: 'half', decorative: true });
    expect(encodePlacementTitle(decoded)).toBe(title);
    expect(encodePlacementTitle({ caption: 'x', decorative: true, size: 'inline' })).toBe('x [caotang-image v1;size=inline;decorative]');
  });

  it('writes an empty caption as the suffix alone, with no leading space', () => {
    expect(encodePlacementTitle({ caption: '', decorative: true })).toBe('[caotang-image v1;decorative]');
    expect(placement('[caotang-image v1;decorative]')).toMatchObject({ caption: '', decorative: true });
  });

  it('writes nothing for an empty default placement', () => {
    expect(encodePlacementTitle({ caption: '' })).toBeNull();
    expect(encodePlacementTitle({ caption: 'c', size: 'full', decorative: false })).toBe('c');
  });

  it('escapes quotes, backslashes and a literal marker in the caption, so none becomes metadata', () => {
    const caption = 'say "hi" \\ then [caotang-image v1;size=half]';
    const title = encodePlacementTitle({ caption });
    expect(title).toBe('say \\"hi\\" \\\\ then \\[caotang-image v1;size=half]');
    expect(placement(title)).toMatchObject({ caption, size: 'full', decorative: false });
    const both = encodePlacementTitle({ caption, size: 'half' });
    expect(placement(both)).toMatchObject({ caption, size: 'half' });
  });

  it('keeps an unknown key, an unknown value and an out-of-domain value after the known entries, in order', () => {
    const decoded = placement('c [caotang-image v1;future=1;size=huge;decorative]');
    expect(decoded).toMatchObject({ size: 'full', decorative: true, extras: ['future=1', 'size=huge'] });
    expect(decoded.notes).toEqual([{ kind: 'out-of-domain', entry: 'size=huge' }]);
    expect(encodePlacementTitle(decoded)).toBe('c [caotang-image v1;decorative;future=1;size=huge]');
  });

  it('preserves an unknown version whole, for every format', () => {
    const decoded = decodePlacementTitle('c [caotang-image v2;mode=wide]');
    expect(decoded).toEqual({ kind: 'opaque-version', raw: 'c [caotang-image v2;mode=wide]', version: 'v2' });
    expect(encodePlacementTitle(decoded as never)).toBe('c [caotang-image v2;mode=wide]');
    expect(placementCaptionOf('c [caotang-image v2;mode=wide]')).toBe('c [caotang-image v2;mode=wide]');
  });

  it('leaves an unbalanced suffix or escape whole as the caption, with a note', () => {
    expect(placement('c [caotang-image v1;size=half')).toMatchObject({ caption: 'c [caotang-image v1;size=half', size: 'full' });
    const slash = placement('C:\\dir');
    expect(slash).toMatchObject({ caption: 'C:\\dir' });
    expect(slash.notes).toEqual([{ kind: 'unbalanced' }]);
    expect(placement('c [caotang-image v1;bare]').notes).toEqual([{ kind: 'unbalanced' }]);
  });

  it('decodes an absent title as an empty caption', () => {
    expect(placement(null)).toMatchObject({ caption: '', size: 'full' });
    expect(placementCaptionOf(undefined)).toBe('');
  });
});
