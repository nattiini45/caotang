/**
 * The vocabulary, checked against [storyboard.md §2.2](../../../docs/architecture/storyboard.md). The enum
 * lists and the field list are read back out of the spec, so a list in the code cannot drift from the file
 * that defines it, the same discipline the harness's spec-parity test applies to its table.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TreeNode } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import {
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  SHOT_ENUM_FIELDS,
  SHOT_ENUM_LABELS,
  SHOT_ENUMS,
  SHOT_META_KEYS,
  SHOT_SIZES,
  TRANSITIONS,
  cardSpecRowOf,
  durationText,
  enumLabelOf,
  isScreenplayDocument,
  isShotNode,
  isStoryboardFolder,
  kindOf,
  specRowOf,
} from '../src/index.js';

const specPath = resolve(__dirname, '../../../docs/architecture/storyboard.md');
const spec = readFileSync(specPath, 'utf8');

/** The `'x'|'y'|…` literal on the spec line that declares `field`, before its trailing comment. */
function literalValuesOf(field: string): string[] {
  const line = spec.split('\n').find((text) => text.includes(`${field}?: '`));
  expect(line, `${field} not found in storyboard.md §2.2`).toBeDefined();
  const declared = (line ?? '').split('//')[0] ?? '';
  return [...declared.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** The field names declared inside `interface ShotMeta { … }` in the spec. */
function shotMetaFieldsInSpec(): string[] {
  const start = spec.indexOf('interface ShotMeta {');
  expect(start, 'interface ShotMeta not found in storyboard.md').toBeGreaterThanOrEqual(0);
  const end = spec.indexOf('\n}', start);
  const body = spec.slice(start, end);
  return [...body.matchAll(/^\s+(\w+)\?:/gm)].map((match) => match[1] ?? '');
}

function node(overrides: Partial<TreeNode> & { id: string }): TreeNode {
  return {
    parentId: 'manuscript',
    type: 'document',
    title: overrides.id,
    order: 10,
    status: null,
    label: null,
    keywords: [],
    synopsis: '',
    notes: '',
    ...overrides,
  };
}

describe('the closed v1 enums are the spec’s lists', () => {
  it('shotSize matches storyboard.md §2.2', () => {
    expect([...SHOT_SIZES]).toEqual(literalValuesOf('shotSize'));
  });

  it('cameraAngle matches storyboard.md §2.2', () => {
    expect([...CAMERA_ANGLES]).toEqual(literalValuesOf('cameraAngle'));
  });

  it('cameraMovement matches storyboard.md §2.2', () => {
    expect([...CAMERA_MOVEMENTS]).toEqual(literalValuesOf('cameraMovement'));
  });

  it('transition matches storyboard.md §2.2', () => {
    expect([...TRANSITIONS]).toEqual(literalValuesOf('transition'));
  });

  it('the enum fields are the four the spec closes', () => {
    expect([...SHOT_ENUM_FIELDS].sort()).toEqual(['cameraAngle', 'cameraMovement', 'shotSize', 'transition']);
  });
});

describe('the ShotMeta fields are the spec’s fields', () => {
  it('SHOT_META_KEYS names every field the spec declares, and no other', () => {
    expect([...SHOT_META_KEYS].sort()).toEqual(shotMetaFieldsInSpec().sort());
  });
});

describe('spec row and duration text', () => {
  it('joins the present parts with a middle dot, in the spec order, each value as the shot editor words it', () => {
    expect(specRowOf({ shotSize: 'WS', cameraAngle: 'low', cameraMovement: 'dolly-in', durationSec: 2.5 })).toBe(
      'Wide shot (WS) · Low angle · Dolly in · 2.5 s',
    );
    expect(specRowOf({ shotSize: 'MCU', cameraAngle: 'birds', cameraMovement: 'dolly-in', durationSec: 4 })).toBe(
      'Medium close-up (MCU) · Bird’s-eye view · Dolly in · 4 s',
    );
  });

  it('leaves an absent part out rather than leaving a gap', () => {
    expect(specRowOf({ cameraAngle: 'eye' })).toBe('Eye level');
    expect(specRowOf({ shotSize: 'CU', durationSec: 3 })).toBe('Close-up (CU) · 3 s');
    expect(specRowOf({ shotSize: '', cameraMovement: 7 })).toBe('');
    expect(specRowOf({})).toBe('');
  });

  it('shows a value the load kept as unknown as it is, because the writer needs to see what they typed', () => {
    expect(specRowOf({ shotSize: 'XYZ' })).toBe('XYZ');
    expect(specRowOf({ cameraAngle: 'constructor', cameraMovement: 'toString' })).toBe('constructor · toString');
  });

  it('adds the lens and the transition after the duration, the transition in words too, and leaves out a blank lens', () => {
    expect(
      cardSpecRowOf({ shotSize: 'MCU', cameraAngle: 'birds', cameraMovement: 'dolly-in', durationSec: 4, lens: ' 35mm ', transition: 'match-on-action' }),
    ).toBe('Medium close-up (MCU) · Bird’s-eye view · Dolly in · 4 s · 35mm · Match on action');
    expect(cardSpecRowOf({ lens: '  ' })).toBe('');
    expect(cardSpecRowOf({ transition: 'dissolve' })).toBe('Dissolve');
    expect(cardSpecRowOf({ transition: 'wobble' })).toBe('wobble');
    expect(cardSpecRowOf({ shotSize: 'CU' })).toBe(specRowOf({ shotSize: 'CU' }));
  });

  it('words a closed-list value as the editor’s label, and an unlisted one, including an inherited name, as it is', () => {
    expect(enumLabelOf('cameraAngle', 'birds')).toBe('Bird’s-eye view');
    expect(enumLabelOf('cameraMovement', 'dolly-in')).toBe('Dolly in');
    expect(enumLabelOf('transition', 'match-on-action')).toBe('Match on action');
    expect(enumLabelOf('shotSize', 'MCU')).toBe('Medium close-up (MCU)');
    expect(enumLabelOf('cameraAngle', 'tilted-sideways')).toBe('tilted-sideways');
    expect(enumLabelOf('cameraAngle', 'constructor')).toBe('constructor');
    expect(enumLabelOf('transition', 'toString')).toBe('toString');
  });

  it('ignores a non-numeric duration rather than printing it', () => {
    expect(specRowOf({ durationSec: '2' })).toBe('');
    expect(specRowOf({ durationSec: Number.NaN })).toBe('');
  });

  it('prints a duration with at most two places and no trailing zeros', () => {
    expect(durationText(2.5)).toBe('2.5');
    expect(durationText(3)).toBe('3');
    expect(durationText(2.349)).toBe('2.35');
    expect(durationText(0.1 + 0.2)).toBe('0.3');
  });
});

/**
 * The writer-facing labels (F-08). The type already makes every list value a key of its label map; these checks hold at run time too,
 * and that a label is words the writer reads, not the stored token. The stored value is never changed by a label.
 */
describe('the labels the shot editor shows for each enum value', () => {
  for (const field of SHOT_ENUM_FIELDS) {
    it(`${field} has one label for each value of its list, and no value is left raw`, () => {
      const values = [...SHOT_ENUMS[field]];
      expect(Object.keys(SHOT_ENUM_LABELS[field]).sort()).toEqual([...values].sort());
      for (const value of values) {
        const label = (SHOT_ENUM_LABELS[field] as Readonly<Record<string, string>>)[value] ?? '';
        expect(label.trim()).not.toBe('');
        expect(label).not.toBe(value);
      }
    });
  }

  it('names the three values the audit found raw, in the words the film trade uses', () => {
    expect(SHOT_ENUM_LABELS.cameraAngle.birds).toBe('Bird’s-eye view');
    expect(SHOT_ENUM_LABELS.cameraMovement['dolly-in']).toBe('Dolly in');
    expect(SHOT_ENUM_LABELS.transition['match-on-action']).toBe('Match on action');
  });
});

describe('node predicates', () => {
  it('reads the kind marker only when it is a string', () => {
    expect(kindOf(node({ id: 'a' }))).toBeUndefined();
    expect(kindOf(Object.assign(node({ id: 'a' }), { kind: 'storyboard' }))).toBe('storyboard');
    expect(kindOf(Object.assign(node({ id: 'a' }), { kind: 7 }))).toBeUndefined();
  });

  it('a shot is a node of type shot', () => {
    expect(isShotNode(node({ id: 'a', type: 'shot' }))).toBe(true);
    expect(isShotNode(node({ id: 'a', type: 'document' }))).toBe(false);
  });

  it('a storyboard is a folder marked storyboard, and nothing else', () => {
    expect(isStoryboardFolder(Object.assign(node({ id: 'f', type: 'folder' }), { kind: 'storyboard' }))).toBe(true);
    expect(isStoryboardFolder(node({ id: 'f', type: 'folder' }))).toBe(false);
    expect(isStoryboardFolder(Object.assign(node({ id: 'd', type: 'document' }), { kind: 'storyboard' }))).toBe(false);
  });

  it('a screenplay scene is a document marked screenplay, and an unmarked document is prose', () => {
    expect(isScreenplayDocument(Object.assign(node({ id: 'd' }), { kind: 'screenplay' }))).toBe(true);
    expect(isScreenplayDocument(node({ id: 'd' }))).toBe(false);
  });
});
