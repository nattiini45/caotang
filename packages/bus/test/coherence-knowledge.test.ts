/**
 * The rule for who learns and who knows a fact (coherence.md §4.4), and the text rule a fact shares with the store. Pure:
 * each assertion is over the rule, with no store behind it.
 */

import { describe, expect, it } from 'vitest';

import {
  KNOWLEDGE_TEXT_LIMIT,
  SCENE_PATCH_KEYS,
  applySceneMetaPatch,
  inverseScenePatch,
  knowledgeTextProblem,
  type SceneMetaContext,
} from '../src/index.js';

const SCENE = 'n_SCENE00001';
const ANNA = { entryId: 'c_ANNA000001', factId: 'k_SECRET0001' };
const BEN = { entryId: 'c_BEN0000001', factId: 'k_SECRET0001' };

const context: SceneMetaContext = {
  entries: [
    { id: 'c_ANNA000001', name: 'Anna', type: 'character' },
    { id: 'c_BEN0000001', name: 'Ben', type: 'character' },
    { id: 'c_PLACE00001', name: 'The Lighthouse', type: 'location' },
  ],
  facts: [{ id: 'k_SECRET0001', text: 'Mara is the heir' }],
  documentIds: new Set([SCENE]),
};

describe('learns and knows in the scene-metadata patch (coherence.md §4.4)', () => {
  it('names the four keys in the closed set', () => {
    expect(SCENE_PATCH_KEYS).toEqual(expect.arrayContaining(['learns_add', 'learns_remove', 'knows_add', 'knows_remove']));
  });

  it('adds pairs in the order declared, leaves a repeated pair as it is, and drops an emptied list', () => {
    const added = applySceneMetaPatch(SCENE, undefined, { learns_add: [BEN, ANNA, BEN] }, context);
    expect(added).toEqual({ ok: true, meta: { learns: [BEN, ANNA] } });
    const removed = applySceneMetaPatch(SCENE, added.ok ? added.meta : undefined, { learns_remove: [BEN, ANNA] }, context);
    expect(removed).toEqual({ ok: true, meta: {} });
  });

  it('removes first and adds second, so one patch moves a character from learning to knowing', () => {
    const start = { learns: [ANNA] };
    const moved = applySceneMetaPatch(SCENE, start, { learns_remove: [ANNA], knows_add: [ANNA] }, context);
    expect(moved).toEqual({ ok: true, meta: { knows: [ANNA] } });
    const swapped = applySceneMetaPatch(SCENE, start, { learns_remove: [ANNA], learns_add: [BEN] }, context);
    expect(swapped).toEqual({ ok: true, meta: { learns: [BEN] } });
  });

  it('does not check a removal against the codex, so a pair whose character is gone can still be taken off', () => {
    const gone = { entryId: 'c_GONE000001', factId: 'k_GONE000001' };
    const out = applySceneMetaPatch(SCENE, { knows: [gone] }, { knows_remove: [gone] }, context);
    expect(out).toEqual({ ok: true, meta: {} });
  });

  it('names the field and lists the valid characters or facts when it refuses', () => {
    const place = applySceneMetaPatch(SCENE, undefined, { knows_add: [{ entryId: 'c_PLACE00001', factId: 'k_SECRET0001' }] }, context);
    expect(place).toEqual({
      ok: false,
      error: 'knows_add[0].entryId names The Lighthouse, which is not a character; valid characters are Anna (c_ANNA000001), Ben (c_BEN0000001)',
    });
    const fact = applySceneMetaPatch(SCENE, undefined, { learns_add: [ANNA, { entryId: ANNA.entryId, factId: 'k_NOPE000001' }] }, context);
    expect(fact).toEqual({
      ok: false,
      error: 'learns_add[1].factId "k_NOPE000001" is not a knowledge fact; valid facts are "Mara is the heir" (k_SECRET0001)',
    });
    const none = applySceneMetaPatch(SCENE, undefined, { learns_add: [ANNA] }, { entries: context.entries });
    expect(none.ok).toBe(false);
    expect(!none.ok && none.error).toContain('there is no knowledge fact; add one first');
  });

  it('refuses a pair that is not a pair, naming its index', () => {
    const cases: [unknown, string][] = [
      ['anna', 'learns_add[0] must be an object with an entryId and a factId'],
      [{ factId: 'k_SECRET0001' }, 'learns_add[0].entryId must be the id of a character in the codex'],
      [{ entryId: 'c_ANNA000001', factId: ' ' }, 'learns_add[0].factId must be the id of a knowledge fact'],
    ];
    for (const [pair, error] of cases) {
      expect(applySceneMetaPatch(SCENE, undefined, { learns_add: [pair as never] }, context)).toEqual({ ok: false, error });
    }
  });

  it('inverts an add, a removal and a move by membership', () => {
    const before = { knows: [BEN] };
    const forward = { knows_remove: [BEN], knows_add: [ANNA], learns_add: [BEN] };
    const after = applySceneMetaPatch(SCENE, before, forward, context);
    if (!after.ok) throw new Error(after.error);
    expect(after.meta).toEqual({ knows: [ANNA], learns: [BEN] });
    const undone = applySceneMetaPatch(SCENE, after.meta, inverseScenePatch(before, forward, after.meta), context);
    expect(undone).toEqual({ ok: true, meta: before });
  });
});

describe('the text of a knowledge fact', () => {
  it('is one non-blank sentence of at most 300 code points, counted after the trim', () => {
    expect(KNOWLEDGE_TEXT_LIMIT).toBe(300);
    expect(knowledgeTextProblem('Mara is the heir')).toBeUndefined();
    expect(knowledgeTextProblem('  ')).toBe('a knowledge fact needs some text');
    expect(knowledgeTextProblem(`  ${'x'.repeat(300)}  `)).toBeUndefined();
    expect(knowledgeTextProblem('x'.repeat(301))).toBe('a knowledge fact is at most 300 characters; this one is 301');
    expect(knowledgeTextProblem('😀'.repeat(300))).toBeUndefined();
  });
});
