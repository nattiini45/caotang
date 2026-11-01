/**
 * `renderRef` (i18n.md §3.2; I7): the active catalogue wins, an unknown id compiles its own English
 * template, and a writer title inside the message is isolated exactly once.
 */
import { i18n } from '@lingui/core';
import { compileMessage } from '@lingui/message-utils/compileMessage';
import { describe, expect, it } from 'vitest';

import { renderRef, titleValues, WRITER_VALUE_KEYS } from '../src/i18n/render-ref.js';

const FSI = '\u2068';
const PDI = '\u2069';

describe('renderRef', () => {
  it('compiles an unknown id’s English template with its values, never showing a placeholder', () => {
    const text = renderRef({
      id: 'test.unknown.ref',
      message: '"{lateTitle}" comes before "{earlyTitle}" (day {lateDay} against day {earlyDay})',
      values: { lateTitle: 'Opening', earlyTitle: 'Prologue', lateDay: 5, earlyDay: 1 },
    });
    expect(text).toBe('"Opening" comes before "Prologue" (day 5 against day 1)');
    expect(text).not.toMatch(/\{[a-zA-Z]/);
  });

  it('isolates each title value exactly once when the caller names it', () => {
    const ref = {
      id: 'test.isolated.ref',
      message: '"{lateTitle}" comes before "{earlyTitle}"',
      values: { lateTitle: 'Opening', earlyTitle: 'Prologue', lateDay: 5 },
    };
    expect(titleValues(ref)).toEqual(['lateTitle', 'earlyTitle']);
    const text = renderRef(ref, { userValues: titleValues(ref) });
    expect(text).toBe(`"${FSI}Opening${PDI}" comes before "${FSI}Prologue${PDI}"`);
    expect(text.split(FSI)).toHaveLength(3);
    expect(text.split(PDI)).toHaveLength(3);
    expect(text).not.toContain(`${FSI}${FSI}`);
    expect(text).not.toContain(`${PDI}${PDI}`);
  });

  it('isolates a recovered codex name and a dialogue branch’s label and knot id once', () => {
    const ref = {
      id: 'test.branch.ref',
      message: '{where} runs out; "{knot}" is never diverted to; {name} was recovered.',
      values: { where: 'the flow in “The Lake”', knot: 'lake_end', name: 'Mara' },
    };
    expect(titleValues(ref)).toEqual(['where', 'knot', 'name']);
    const text = renderRef(ref, { userValues: titleValues(ref) });
    expect(text).toBe(
      `${FSI}the flow in “The Lake”${PDI} runs out; "${FSI}lake_end${PDI}" is never diverted to; ${FSI}Mara${PDI} was recovered.`,
    );
    expect(text.split(FSI)).toHaveLength(4);
    expect(text.split(PDI)).toHaveLength(4);
  });

  it('keeps one writer-key list for the task checklist and the findings path', () => {
    // The checklist passes this list; `titleValues` reads it too. A key added for either surface is
    // added once, so the two cannot drift (I7).
    for (const key of ['doc', 'target', 'query', 'title', 'name', 'node', 'scene', 'where', 'knot']) {
      expect(WRITER_VALUE_KEYS, key).toContain(key);
    }
  });

  it('renders the active catalogue’s translation when it has the id', () => {
    i18n.load('probe', { 'test.translated.ref': compileMessage('Bonjour {name}, {count} pages') });
    i18n.activate('probe');
    expect(renderRef({ id: 'test.translated.ref', message: 'Hello {name}, {count} pages', values: { name: 'Ada', count: 3 } })).toBe(
      'Bonjour Ada, 3 pages',
    );
  });
});
