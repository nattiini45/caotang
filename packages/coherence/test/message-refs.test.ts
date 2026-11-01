/**
 * The additive MessageRef on deterministic findings (i18n.md §3.2, §6.2; I7).
 *
 * The English `message` is the contract for old files, the MCP server, the SDK and the CLI. These
 * tests hold the other half: every deterministic check also emits a stable id and a template whose
 * named placeholders match its values, so the app can render it without a raw `{title}` leak.
 */
import { describe, expect, it } from 'vitest';

import { DETERMINISTIC_CHECK_IDS, assembleInput, emptyCoherenceFile, runChecks, type CoherenceFile, type SceneMeta } from '../src/index.js';

import { buildState, detect } from './fixtures.js';

const meta = (sceneMeta: Record<string, SceneMeta>): CoherenceFile => ({ ...emptyCoherenceFile(), sceneMeta });

function placeholders(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)[,}]/g)) {
    if (match[1] !== undefined && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

describe('deterministic findings carry a message reference beside the English', () => {
  it('names the timeline drift pair and both days as values', () => {
    const state = buildState({
      scenes: [
        { id: 'opening', title: 'Opening', body: 'The ferry was late.' },
        { id: 'prologue', title: 'Prologue', body: 'Long before, the island sank.' },
      ],
    });
    const { input } = assembleInput(state, meta({ opening: { dayOffset: 5 }, prologue: { dayOffset: 1 } }), { detector: detect });
    const { drafts } = runChecks(input, ['timeline.order-drift']);
    expect(drafts).toHaveLength(1);
    const ref = drafts[0]?.messageRef;
    expect(ref?.id).toBe('coherence.timeline.orderDrift');
    expect(ref?.values).toEqual({ lateTitle: 'Opening', earlyTitle: 'Prologue', lateDay: 5, earlyDay: 1 });
    // The English sentence is retained unchanged; the ref is beside it.
    expect(drafts[0]?.message).toContain('"Opening" comes before "Prologue" in the binder');
    expect(ref?.message).toContain('{lateTitle}');
    expect(placeholders(ref?.message ?? '').sort()).toEqual(['earlyDay', 'earlyTitle', 'lateDay', 'lateTitle']);
  });

  it('gives every deterministic draft a ref whose placeholders match its values', () => {
    const state = buildState({
      scenes: [
        { id: 'one', title: 'One', body: 'Mara walked to the harbour.' },
        { id: 'two', title: 'Two', body: 'The ferry was late.' },
      ],
      folders: [{ id: 'chapter', title: 'Chapter' }],
      entries: [],
    });
    const { input } = assembleInput(state, meta({ one: { dayOffset: 5 }, two: { dayOffset: 1 } }), { detector: detect });
    const { drafts } = runChecks(input, DETERMINISTIC_CHECK_IDS);
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(draft.messageRef, `${draft.checkId} has a ref`).toBeDefined();
      expect(draft.messageRef?.id.trim()).not.toBe('');
      expect(draft.messageRef?.message.trim()).not.toBe('');
      const values = Object.keys(draft.messageRef?.values ?? {});
      for (const name of placeholders(draft.messageRef?.message ?? '')) {
        expect(values, `${draft.messageRef?.id} value ${name}`).toContain(name);
      }
      expect(draft.messageRef?.message).not.toContain('${');
    }
  });
});
