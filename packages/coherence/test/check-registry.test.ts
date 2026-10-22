/**
 * The package header and the check registry (coherence.md §5.4).
 *
 * The header counted the checks once, and the registry grew without it: the count drifted and nothing failed. The
 * header now points at the registry, and this test holds it to that.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DETERMINISTIC_CHECKS, DETERMINISTIC_CHECK_IDS, DETERMINISTIC_CHECK_LABELS } from '../src/index.js';

const HEADER = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').split('*/')[0] ?? '';

describe('the package header', () => {
  it('points at the check registry instead of counting the checks', () => {
    expect(HEADER).toContain('checks/index.ts');
    expect(HEADER).not.toMatch(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+deterministic\s+checks/i);
  });
});

describe('the check registry', () => {
  it('holds exactly the checks the closed id list names, in its order', () => {
    expect(Object.keys(DETERMINISTIC_CHECKS)).toEqual([...DETERMINISTIC_CHECK_IDS]);
  });

  it('holds eighteen checks, the last of them medium.speaker-parity, and gives each a label', () => {
    expect(DETERMINISTIC_CHECK_IDS).toHaveLength(18);
    expect(DETERMINISTIC_CHECK_IDS.at(-1)).toBe('medium.speaker-parity');
    for (const id of DETERMINISTIC_CHECK_IDS) expect(DETERMINISTIC_CHECK_LABELS[id], id).not.toBe('');
    expect(DETERMINISTIC_CHECK_LABELS['plot.unresolved-thread']).toBe('A thread’s declared payoff is not in the manuscript');
    expect(DETERMINISTIC_CHECK_LABELS['knowledge.leak']).toBe('A character knows something before they learn it');
    expect(DETERMINISTIC_CHECK_LABELS['medium.speaker-parity']).toBe('The screenplay and its dialogue name different speakers');
  });
});
