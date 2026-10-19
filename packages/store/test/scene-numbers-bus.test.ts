/**
 * The screenplay PDF's scene-number placements are the bus's (`SCENE_NUMBER_OPTIONS`, screenplay.md §5.3). The load and the
 * write read that export rather than a copy of it, so a placement the bus gains survives a write and a load, and a recipe
 * holding it keeps all its options. The bus is mocked here with a fifth placement to prove it.
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Bus from '@caotang/bus';
import { createEmptyManifest, serializeManifest, validateManifest, type Manifest } from '../src/index.js';

// Hoisted above the imports by vitest, so the store reads the mocked bus.
vi.mock('@caotang/bus', async (importOriginal) => {
  const bus = await importOriginal<typeof Bus>();
  return { ...bus, SCENE_NUMBER_OPTIONS: [...bus.SCENE_NUMBER_OPTIONS, 'centre'] };
});

const T = new Date(Date.UTC(2026, 9, 18, 15));

describe('scene-number placements come from the bus', () => {
  it('writes and keeps a placement the bus accepts, with the rest of the recipe options', () => {
    const m = createEmptyManifest('Script', T);
    const options = { titlePage: false, author: 'A', sceneNumbers: 'centre' as unknown as 'left', continued: false };
    m.recipes = [{ name: 'shoot', includeRootIds: ['manuscript'], format: 'pdf', options }];
    const text = serializeManifest(m);
    expect(text).toContain('"sceneNumbers": "centre"');
    const r = validateManifest(JSON.parse(text) as Manifest, { docFiles: [] });
    expect(r.warnings.map((w) => w.path)).not.toContain('recipes[0].options');
    expect((r.manifest as Manifest).recipes?.[0]?.options).toEqual(options);
  });

  it('still drops a placement the bus does not accept', () => {
    const m = createEmptyManifest('Script', T);
    m.recipes = [{ name: 'shoot', includeRootIds: ['manuscript'], format: 'pdf', options: { sceneNumbers: 'middle' as unknown as 'left' } }];
    expect(serializeManifest(m)).not.toContain('middle');
    const r = validateManifest(m, { docFiles: [] });
    expect(r.warnings.map((w) => w.path)).toContain('recipes[0].options');
  });
});
