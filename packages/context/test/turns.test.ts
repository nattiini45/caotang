/**
 * L6 when the writer has rewound the conversation or restored a turn's project changes (context-assembly §2).
 * The turns block is a pure function of the turns, so these read its rendered items.
 */
import { describe, expect, it } from 'vitest';

import { assemble, type AgentTask, type RecentTurn } from '../src/index.js';
import { turnsBlock } from '../src/layers/turns.js';
import { buildApp } from './fixtures.js';

const CONTINUE: AgentTask = { tool: 'scene.draft', instruction: 'Write the next scene.', mode: 'continue', focus: 'n_ch3' };

const turn = (n: number, extra: Partial<RecentTurn> = {}): RecentTurn => ({ turnId: `t_${n}`, intent: `Intent ${n}.`, outcome: `did ${n}`, ...extra });

const turnsOf = (turns: readonly RecentTurn[]): string => {
  const text = assemble(CONTINUE, { ...buildApp(), turns, activity: [] }).messages[1]?.content ?? '';
  return text.slice(text.indexOf('# Recent turns'), text.indexOf('# Task'));
};

describe('rewound turns', () => {
  it('leave L6 before the turn limit applies, so a rewind never shrinks the window', () => {
    const turns = [turn(1), turn(2), turn(3), turn(4, { rewound: true }), turn(5, { rewound: true })];
    const text = turnsOf(turns);
    expect(text).toContain('- Turn t_2');
    expect(text).toContain('- Turn t_3');
    expect(text).not.toContain('t_4');
    expect(text).not.toContain('t_5');
    expect(text).not.toContain('- Turn t_1');
  });

  it('are not counted among the earlier turns that are not sent', () => {
    expect(turnsBlock([turn(1), turn(2), turn(3, { rewound: true }), turn(4, { rewound: true })], []).notes).toEqual([]);
    expect(turnsBlock([turn(1), turn(2), turn(3), turn(4, { rewound: true })], []).notes).toEqual([
      "1 earlier turn is not sent; the agent's tools can read them back.",
    ]);
  });

  it('leave an empty block when every turn was rewound', () => {
    expect(turnsOf([turn(1, { rewound: true })])).toContain('(no earlier agent turns in this session)');
  });
});

describe('restored turns', () => {
  const at = Date.UTC(2026, 9, 22, 14, 2, 30);

  it('carry the fixed restored note, with the clock time from the injected formatter', () => {
    const block = turnsBlock([turn(1, { restoredAt: at })], [], () => '14:02');
    expect(block.block.items[0]?.body).toContain('  Outcome: did 1 - restored by the writer at 14:02; these changes are no longer in the project\n');
  });

  it('name the step a partial restore began at', () => {
    const block = turnsBlock([turn(1, { restoredAt: at, restoredFromStep: 3 })], [], () => '14:02');
    expect(block.block.items[0]?.body).toContain('  Outcome: did 1 - steps 3 onward restored by the writer at 14:02; those changes are no longer in the project\n');
  });

  it('format the time as UTC by default, so a golden does not depend on the machine', () => {
    expect(turnsOf([turn(1, { restoredAt: at })])).toContain('restored by the writer at 14:02;');
  });

  it('keep the note when a long outcome is clipped', () => {
    const long = turn(1, { outcome: 'x'.repeat(500), restoredAt: at });
    const body = turnsBlock([long], [], () => '09:15').block.items[0]?.body ?? '';
    expect(body).toMatch(/Outcome: x+… - restored by the writer at 09:15; these changes are no longer in the project\n/);
  });

  it('leave an unrestored turn without a note', () => {
    expect(turnsOf([turn(1)])).not.toContain('restored');
  });
});
