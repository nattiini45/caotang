import { describe, expect, it } from 'vitest';

import { printChanges, unifiedDiff } from '../src/diff-print.js';

const lines = (count: number, from = 1): string => `${Array.from({ length: count }, (_, i) => `line ${from + i}`).join('\n')}\n`;
const hunks = (diff: string): number => diff.split('\n').filter((line) => line.startsWith('@@')).length;

describe('unifiedDiff', () => {
  it('shows a changed line with three lines of context on each side', () => {
    const before = lines(20);
    const after = before.replace('line 10\n', 'line ten\n');
    expect(unifiedDiff({ path: 'docs/a.md', kind: 'changed', before, after })).toBe(
      ['--- a/docs/a.md', '+++ b/docs/a.md', '@@ -7,7 +7,7 @@', ' line 7', ' line 8', ' line 9', '-line 10', '+line ten', ' line 11', ' line 12', ' line 13', ''].join('\n'),
    );
  });

  it('joins changes closer than two contexts into one hunk, and splits those further apart', () => {
    const before = lines(30);
    expect(hunks(unifiedDiff({ path: 'p', kind: 'changed', before, after: before.replace('line 5\n', 'five\n').replace('line 9\n', 'nine\n') }))).toBe(1);
    expect(hunks(unifiedDiff({ path: 'p', kind: 'changed', before, after: before.replace('line 3\n', 'three\n').replace('line 25\n', 'twenty-five\n') }))).toBe(2);
  });

  it('shows an added file against /dev/null and a removed file the other way', () => {
    expect(unifiedDiff({ path: 'docs/new.md', kind: 'added', after: 'one\ntwo\n' })).toBe(
      ['--- /dev/null', '+++ b/docs/new.md', '@@ -0,0 +1,2 @@', '+one', '+two', ''].join('\n'),
    );
    expect(unifiedDiff({ path: 'docs/old.md', kind: 'removed', before: 'one\n' })).toBe(['--- a/docs/old.md', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-one', ''].join('\n'));
  });

  it('aligns an inserted line instead of rewriting what follows it', () => {
    const body = unifiedDiff({ path: 'p', kind: 'changed', before: 'a\nb\nc\nd\n', after: 'a\nb\nnew\nc\nd\n' })
      .split('\n')
      .slice(2);
    expect(body.filter((line) => line.startsWith('-'))).toEqual([]);
    expect(body.filter((line) => line.startsWith('+'))).toEqual(['+new']);
  });

  it('prints a text that holds a NUL as a binary difference, never as text', () => {
    const nul = String.fromCharCode(0);
    const diff = unifiedDiff({ path: 'exports/book.pdf', kind: 'changed', before: `%PDF-1.7\n${nul}${nul}`, after: `%PDF-1.7\n${nul}A` });
    expect(diff).toBe('Binary files a/exports/book.pdf and b/exports/book.pdf differ\n');
  });

  it('shows a very large change as one replaced block rather than aligning it', () => {
    const diff = unifiedDiff({ path: 'p', kind: 'changed', before: lines(3000), after: lines(3000, 5000) });
    expect(diff).toContain('@@ -1,3000 +1,3000 @@');
  });
});

describe('printChanges', () => {
  it('is empty for no change, and joins the files in the order given', () => {
    expect(printChanges([])).toBe('');
    const text = printChanges([
      { path: 'a', kind: 'added', after: 'x\n' },
      { path: 'b', kind: 'added', after: 'y\n' },
    ]);
    expect(text.indexOf('+++ b/a')).toBeLessThan(text.indexOf('+++ b/b'));
  });
});
