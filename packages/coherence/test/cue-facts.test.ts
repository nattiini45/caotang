/**
 * The screenplay read a run shares between the three script checks (screenplay.md §4).
 *
 * The three script checks read the same screenplay bodies, so a run parses each body once and shares the read. The
 * facts carry what a check reads and nothing else.
 */

import { describe, expect, it, vi } from 'vitest';

import type * as Screenplay from '@caotang/screenplay';

const counted = vi.hoisted(() => ({ parses: 0 }));
vi.mock('@caotang/screenplay', async (importOriginal) => {
  const actual = await importOriginal<typeof Screenplay>();
  return {
    ...actual,
    parseFountain: (text: string) => {
      counted.parses += 1;
      return actual.parseFountain(text);
    },
  };
});

import { assembleInput, cueFactsOf, emptyCoherenceFile, runChecks } from '../src/index.js';
import type { ProjectState } from '@caotang/store';

import { buildState, detect, entry } from './fixtures.js';

const SCRIPT_IDS = ['script.cue-collision', 'script.cue-consistency', 'script.shot-coverage'] as const;

/** A screenplay document: the node is marked with the screenplay kind, which is how the parse is chosen (screenplay.md §2.1). */
function screenplayState(docs: readonly { readonly id: string; readonly body: string }[]): ProjectState {
  const state = buildState({
    scenes: docs.map((doc) => ({ id: doc.id, title: doc.id, body: doc.body })),
    entries: [entry('c_ALICE00001', 'Alice')],
  });
  for (const doc of docs) {
    const node = state.manifest.tree.find((candidate) => candidate.id === doc.id);
    if (node !== undefined) Object.assign(node, { kind: 'screenplay' });
  }
  return state;
}

const TWO_SCENES = [
  { id: 'sOne', body: 'INT. HALL - DAY\n\nBOB\nWhere were you?\n' },
  { id: 'sTwo', body: 'INT. YARD - DAY\n\n@Bob\nHey.\n' },
];

describe('the cue facts a run shares', () => {
  it('parses each screenplay body once for the three script checks', () => {
    const { input } = assembleInput(screenplayState(TWO_SCENES), emptyCoherenceFile(), { detector: detect });
    counted.parses = 0;
    runChecks(input, [...SCRIPT_IDS]);
    expect(counted.parses).toBe(TWO_SCENES.length);
  });

  it('finds what the checks find when each of them runs on its own', () => {
    const { input } = assembleInput(screenplayState(TWO_SCENES), emptyCoherenceFile(), { detector: detect });
    const together = runChecks(input, [...SCRIPT_IDS]);
    const apart = SCRIPT_IDS.flatMap((id) => runChecks(input, [id]).drafts);
    expect(together.drafts).toEqual(apart);
  });

  it('carries no spelling groups, because no check reads them', () => {
    expect('spellingGroups' in cueFactsOf(TWO_SCENES[0]?.body ?? '')).toBe(false);
  });
});
