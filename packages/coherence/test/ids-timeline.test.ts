import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  TIMELINE_MODES,
  isCoherenceId,
  mintCoherenceId,
  treatmentOf,
  windowInside,
  windowOf,
  windowsOverlap,
  type TimelineCheck,
  type TimelineMode,
} from '../src/index.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SPEC = join(REPO_ROOT, 'docs', 'architecture', 'coherence.md');

describe('ids', () => {
  it('accepts the three coherence prefixes with ten Crockford characters', () => {
    expect(isCoherenceId('f', 'f_7K2QX9M4A1')).toBe(true);
    expect(isCoherenceId('r', 'r_3W8RN2TQ6C')).toBe(true);
    expect(isCoherenceId('w', 'w_5H8QK2M9RT')).toBe(true);
  });

  it('refuses the wrong prefix, a wrong length, and the letters Crockford leaves out', () => {
    expect(isCoherenceId('f', 'r_7K2QX9M4A1')).toBe(false);
    expect(isCoherenceId('f', 'f_7K2QX9M4A')).toBe(false);
    expect(isCoherenceId('f', 'f_7K2QX9M4AI')).toBe(false);
    expect(isCoherenceId('f', 'f_7K2QX9M4AU')).toBe(false);
    expect(isCoherenceId('f', 42)).toBe(false);
  });

  it('mints a prefixed id and re-rolls past a taken one', () => {
    const first = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const second = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
    let call = 0;
    const randomBytes = (n: number): Uint8Array => {
      call += 1;
      const source = call === 1 ? first : second;
      return source.slice(0, n);
    };
    const takenFirst = mintCoherenceId('f', new Set(), randomBytes);
    expect(takenFirst).toMatch(/^f_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    call = 0;
    const reminted = mintCoherenceId('f', new Set([takenFirst]), randomBytes);
    expect(reminted).not.toBe(takenFirst);
    expect(isCoherenceId('f', reminted)).toBe(true);
  });

  it('throws rather than return a duplicate when randomness keeps repeating', () => {
    const fixed = (n: number): Uint8Array => new Uint8Array(n).fill(9);
    const only = mintCoherenceId('r', new Set(), fixed);
    expect(() => mintCoherenceId('r', new Set([only]), fixed)).toThrow(/could not mint a unique r_ id/);
  });
});

describe('timeline exemption table (§5.2.1)', () => {
  it('leaves linear scenes checked on every timeline check', () => {
    for (const check of ['timeline.order-drift', 'timeline.window', 'timeline.overlap', 'timeline.gap'] as const) {
      expect(treatmentOf('linear', check)).toBe('checked');
    }
  });

  it('exempts flashback and circular scenes from order drift', () => {
    expect(treatmentOf('flashback', 'timeline.order-drift')).toBe('exempt');
    expect(treatmentOf('flash-forward', 'timeline.order-drift')).toBe('exempt');
    expect(treatmentOf('circular', 'timeline.order-drift')).toBe('exempt');
  });

  it('exempts dream, mythic and backstory scenes from order drift and window', () => {
    for (const mode of ['dream', 'mythic', 'backstory'] as const) {
      expect(treatmentOf(mode, 'timeline.order-drift')).toBe('exempt');
      expect(treatmentOf(mode, 'timeline.window')).toBe('exempt');
      expect(treatmentOf(mode, 'timeline.overlap')).toBe('checked');
    }
  });

  it('compares parallel and frame scenes per strand, never across the whole manuscript', () => {
    expect(treatmentOf('parallel', 'timeline.order-drift')).toBe('per-strand');
    expect(treatmentOf('frame', 'timeline.order-drift')).toBe('per-strand');
  });

  it('exempts dream, mythic and time-skip scenes from the gap check, and no other mode', () => {
    for (const mode of ['dream', 'mythic', 'time-skip'] as const) expect(treatmentOf(mode, 'timeline.gap')).toBe('exempt');
    for (const mode of TIMELINE_MODES.filter((candidate) => !['dream', 'mythic', 'time-skip'].includes(candidate))) {
      expect(treatmentOf(mode, 'timeline.gap'), mode).toBe('checked');
    }
  });

  it('keeps a time-skip scene in the date-order group: its one exempt cell is the gap', () => {
    for (const check of ['timeline.order-drift', 'timeline.window', 'timeline.overlap'] as const) {
      expect(treatmentOf('time-skip', check), check).toBe('checked');
    }
  });

  it('exempts simultaneous scenes from overlap only', () => {
    expect(treatmentOf('simultaneous', 'timeline.overlap')).toBe('exempt');
    expect(treatmentOf('simultaneous', 'timeline.order-drift')).toBe('checked');
  });

  it('agrees with the spec table cell by cell', () => {
    const lines = readFileSync(SPEC, 'utf8').split('\n');
    const header = lines.findIndex((line) => line.startsWith('| `timelineMode` | `timeline.order-drift`'));
    expect(header).toBeGreaterThan(-1);
    // Cell positions after the mode column: order-drift, relation, window, overlap, gap, pov/presence.
    const columns: readonly (readonly [TimelineCheck, number])[] = [
      ['timeline.order-drift', 1],
      ['timeline.window', 3],
      ['timeline.overlap', 4],
      ['timeline.gap', 5],
    ];
    const seen = new Set<TimelineMode>();
    for (let row = header + 2; row < lines.length && lines[row]?.startsWith('|'); row += 1) {
      const cells = (lines[row] ?? '').split('|').slice(1, -1).map((cell) => cell.trim());
      // A row can name several modes ("`dream` / `mythic` / `backstory`"); each shares the row's cells.
      const modes = [...(cells[0] ?? '').matchAll(/`([a-z-]+)`/g)].map((match) => match[1] as TimelineMode);
      for (const mode of modes) {
        seen.add(mode);
        for (const [check, index] of columns) {
          const specExempt = (cells[index] ?? '').startsWith('**exempt**');
          expect(treatmentOf(mode, check) !== 'checked', `${mode} × ${check}`).toBe(specExempt);
        }
      }
    }
    expect([...seen].sort()).toEqual([...TIMELINE_MODES].sort());
  });
});

describe('day windows', () => {
  it('gives a moment one day and a declared duration its full length', () => {
    expect(windowOf(4, undefined)).toEqual({ start: 4, end: 5 });
    expect(windowOf(4, 0)).toEqual({ start: 4, end: 5 });
    expect(windowOf(4, 3)).toEqual({ start: 4, end: 7 });
  });

  it('overlaps only when the half-open windows share a day', () => {
    expect(windowsOverlap(windowOf(4, 0), windowOf(4, 0))).toBe(true);
    expect(windowsOverlap(windowOf(4, 0), windowOf(5, 0))).toBe(false);
    expect(windowsOverlap(windowOf(3, 2), windowOf(4, 0))).toBe(true);
  });

  it('is inside a span only when it lies wholly within it', () => {
    const span = windowOf(10, 5);
    expect(windowInside(windowOf(12, 0), span)).toBe(true);
    expect(windowInside(windowOf(14, 0), span)).toBe(true);
    expect(windowInside(windowOf(15, 0), span)).toBe(false);
    expect(windowInside(windowOf(9, 0), span)).toBe(false);
  });
});
