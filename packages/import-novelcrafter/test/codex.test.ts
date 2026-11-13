import { describe, expect, it } from 'vitest';

import { typeFromFolder, typeFromWord, parseRelations, countProgressions } from '../src/codex.js';

describe('the NovelCrafter codex helpers (#292)', () => {
  it('classifies type folders and type words', () => {
    expect(typeFromFolder('characters')).toBe('character');
    expect(typeFromFolder('Locations')).toBe('location');
    expect(typeFromFolder('items')).toBe('object');
    expect(typeFromFolder('lore')).toBe('lore');
    expect(typeFromFolder('subplots')).toBe('subplot');
    expect(typeFromFolder('misc')).toBeNull();
    expect(typeFromWord('person')).toBe('character');
    expect(typeFromWord('setting')).toBe('location');
    expect(typeFromWord('unknown')).toBeNull();
  });

  it('reads relations written as names, objects or a mix', () => {
    expect(parseRelations({ relations: ['Mara'] })).toEqual([{ name: 'Mara', kind: '' }]);
    expect(parseRelations({ relations: [{ name: 'Mara', type: 'ally' }] })).toEqual([{ name: 'Mara', kind: 'ally' }]);
    expect(parseRelations({ relations: [{ entry: 'Mara', relation: 'ally' }, { target: 'The Harbour' }] })).toEqual([
      { name: 'Mara', kind: 'ally' },
      { name: 'The Harbour', kind: '' },
    ]);
  });

  it('skips unreadable relations without throwing', () => {
    expect(parseRelations(null)).toEqual([]);
    expect(parseRelations({})).toEqual([]);
    expect(parseRelations({ relations: 'not a list' })).toEqual([]);
    expect(parseRelations({ relations: [42, null, { noName: true }, '  '] })).toEqual([]);
  });

  it('counts progressions only when they are a list', () => {
    expect(countProgressions({ progressions: [{}, {}] })).toBe(2);
    expect(countProgressions({ progressions: 'no' })).toBe(0);
    expect(countProgressions(null)).toBe(0);
  });
});
