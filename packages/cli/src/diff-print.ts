/**
 * The files a turn changed, as one unified diff for a person or a pipe.
 *
 * Only the files a save owns are in a `FileChange` (the manifest, the documents and the codex files: UTF-8 text), never an export.
 * A text that holds a NUL is printed as "Binary files differ" all the same, so a PDF can never reach a terminal as text.
 */

import type { FileChange } from '@caotang/sdk';

const CONTEXT = 3;
/** A middle section bigger than this many line pairs is shown as one replaced block rather than aligned: the table would not fit in memory. */
const ALIGN_LIMIT = 4_000_000;

type Op = { readonly kind: ' ' | '-' | '+'; readonly line: string };

function linesOf(text: string | undefined): string[] {
  if (text === undefined || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The line-by-line edit script from `a` to `b`: the common head and tail are trimmed, and the middle is aligned by its longest common subsequence. */
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const ops: Op[] = a.slice(0, head).map((line) => ({ kind: ' ', line }));
  if (midA.length * midB.length > ALIGN_LIMIT) {
    ops.push(...midA.map((line): Op => ({ kind: '-', line })), ...midB.map((line): Op => ({ kind: '+', line })));
  } else {
    const rows = midA.length + 1;
    const cols = midB.length + 1;
    const lcs = new Uint32Array(rows * cols);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        lcs[i * cols + j] = midA[i] === midB[j] ? (lcs[(i + 1) * cols + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * cols + j] ?? 0, lcs[i * cols + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        ops.push({ kind: ' ', line: midA[i] ?? '' });
        i += 1;
        j += 1;
      } else if (i < midA.length && (j === midB.length || (lcs[(i + 1) * cols + j] ?? 0) >= (lcs[i * cols + j + 1] ?? 0))) {
        ops.push({ kind: '-', line: midA[i] ?? '' });
        i += 1;
      } else {
        ops.push({ kind: '+', line: midB[j] ?? '' });
        j += 1;
      }
    }
  }
  ops.push(...a.slice(a.length - tail).map((line): Op => ({ kind: ' ', line })));
  return ops;
}

/** The hunks of an edit script, with {@link CONTEXT} unchanged lines around each change; changes closer than two contexts share a hunk. */
function hunksOf(ops: readonly Op[]): string[] {
  const changed = ops.flatMap((op, index) => (op.kind === ' ' ? [] : [index]));
  const out: string[] = [];
  let from = 0;
  while (from < changed.length) {
    let to = from;
    while (to + 1 < changed.length && (changed[to + 1] ?? 0) - (changed[to] ?? 0) - 1 <= 2 * CONTEXT) to += 1;
    const start = Math.max(0, (changed[from] ?? 0) - CONTEXT);
    const end = Math.min(ops.length, (changed[to] ?? 0) + CONTEXT + 1);
    const slice = ops.slice(start, end);
    const oldBefore = ops.slice(0, start).filter((op) => op.kind !== '+').length;
    const newBefore = ops.slice(0, start).filter((op) => op.kind !== '-').length;
    const oldCount = slice.filter((op) => op.kind !== '+').length;
    const newCount = slice.filter((op) => op.kind !== '-').length;
    out.push(`@@ -${oldCount === 0 ? oldBefore : oldBefore + 1},${oldCount} +${newCount === 0 ? newBefore : newBefore + 1},${newCount} @@`);
    for (const op of slice) out.push(`${op.kind}${op.line}`);
    from = to + 1;
  }
  return out;
}

const hasNul = (text: string | undefined): boolean => text?.includes(String.fromCharCode(0)) === true;

/** One file's change as unified diff text, ending in a newline. */
export function unifiedDiff(change: FileChange): string {
  const label = (side: 'a' | 'b', present: boolean): string => (present ? `${side}/${change.path}` : '/dev/null');
  const a = label('a', change.kind !== 'added');
  const b = label('b', change.kind !== 'removed');
  if (hasNul(change.before) || hasNul(change.after)) return `Binary files ${a} and ${b} differ\n`;
  return `${[`--- ${a}`, `+++ ${b}`, ...hunksOf(editScript(linesOf(change.before), linesOf(change.after)))].join('\n')}\n`;
}

/** Every change, in path order, as one text. Empty when nothing changed. */
export function printChanges(changes: readonly FileChange[]): string {
  return changes.map(unifiedDiff).join('');
}
