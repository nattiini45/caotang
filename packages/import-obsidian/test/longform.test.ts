import { describe, expect, it } from 'vitest';

import { chooseDraft, parseLongformIndex } from '../src/longform.js';

const INDEX = [
  'longform:',
  '  format: scenes',
  '  title: The Landing',
  '  draftNumber: 2',
  '  sceneFolder: Scenes',
  '  scenes:',
  '    - The Ferry',
  '    - The Letter',
  '    - Part Two:',
  '      - The Storm',
  '      - The Return',
  '  ignoredFiles:',
  '    - Research Notes',
];

describe('the Longform index reader (#281)', () => {
  it('reads the format, title, draft, scene folder and ordered scenes', () => {
    const index = parseLongformIndex(INDEX);
    expect(index).not.toBeNull();
    expect(index?.format).toBe('scenes');
    expect(index?.title).toBe('The Landing');
    expect(index?.draftNumber).toBe(2);
    expect(index?.sceneFolder).toBe('Scenes');
    expect(index?.scenes.map((scene) => scene.title)).toEqual(['The Ferry', 'The Letter', 'Part Two']);
    expect(index?.ignoredFiles).toEqual(['Research Notes']);
  });

  it('keeps a Part’s nesting as children (decision 2)', () => {
    const index = parseLongformIndex(INDEX);
    const part = index?.scenes[2];
    expect(part?.children?.map((scene) => scene.title)).toEqual(['The Storm', 'The Return']);
  });

  it('returns null for a note without a longform block', () => {
    expect(parseLongformIndex(['title: A normal note', 'tags:', '  - sea'])).toBeNull();
  });

  it('reads format single', () => {
    const index = parseLongformIndex(['longform:', '  format: single', '  title: One Piece']);
    expect(index?.format).toBe('single');
    expect(index?.scenes).toEqual([]);
  });

  it('chooses the highest draft number', () => {
    const one = parseLongformIndex(['longform:', '  draftNumber: 1', '  title: First']);
    const two = parseLongformIndex(['longform:', '  draftNumber: 3', '  title: Third']);
    const three = parseLongformIndex(['longform:', '  draftNumber: 2', '  title: Second']);
    expect(chooseDraft([one!, three!, two!])?.title).toBe('Third');
    expect(chooseDraft([])).toBeNull();
  });
});
