/** The line kind in the read-only comparison shown before a confirmed folder overwrite. */
export type FolderDiffLineKind = 'context' | 'folder' | 'tab' | 'note';

/** One visible line of a folder-save comparison. */
export interface FolderDiffLine {
  readonly kind: FolderDiffLineKind;
  readonly text: string;
}

const CONTEXT_LINES = 2;
const MAX_CHANGED_LINES = 300;
const MAX_EDIT_DISTANCE = 700;
const MAX_INPUT_CHARS = 128_000;
const MAX_INPUT_LINES = 4_000;
const MAX_LINE_CHARS = 2_000;
const MAX_PREVIEW_CHARS = 24_000;
const TOO_LARGE_NOTE = 'The content is too large for a safe line comparison in the question. If you choose to replace it, the full folder version is kept in .caotang-backup.';
const TOO_LARGE_NEW_FILE_NOTE = 'The tab content is too large for a safe line comparison in the question; this file has no folder version to back up.';

/**
 * A bounded Myers line diff of the folder's current text and the text this tab would write. It
 * shows changed lines plus nearby context, and never labels an unchanged middle section as changed.
 * Input size, line count, line length, edit distance, and rendered preview size are capped so a
 * large folder file cannot make the overwrite question allocate or render unbounded text.
 */
export function folderFileDiff(folderText: string | null | undefined, tabText: string | null | undefined): FolderDiffLine[] {
  if (folderText === null && tabText === null) return [{ kind: 'note', text: 'Neither version could be read as text; neither is known to be missing.' }];
  if (folderText === null) return [{ kind: 'note', text: 'The folder version could not be read as text; it is not known to be missing.' }, ...(tabText === null || tabText === undefined ? [] : limitedLines(tabText, 'tab'))];
  if (tabText === null) return [...(folderText === undefined ? [] : limitedLines(folderText, 'folder')), { kind: 'note', text: 'This tab version could not be read as text; it is not known to be missing.' }];
  if (folderText === undefined && tabText === undefined) return [{ kind: 'note', text: 'Neither version is present for comparison.' }];
  if (folderText === undefined) return [{ kind: 'note', text: 'No matching file is in the folder.' }, ...limitedLines(tabText ?? '', 'tab', false)];
  if (tabText === undefined) return [...limitedLines(folderText, 'folder'), { kind: 'note', text: 'This tab has no matching file.' }];

  const folderLines = boundedLines(folderText);
  const tabLines = boundedLines(tabText);
  if (folderLines === null || tabLines === null) return tooLargePreview();
  if (folderLines.length === tabLines.length && folderLines.every((line, index) => line === tabLines[index])) {
    return [{ kind: 'note', text: 'The visible text is the same; only the file bytes or line endings differ.' }];
  }

  const diff = myersDiff(folderLines, tabLines);
  if (diff === null) return tooLargePreview();
  return boundedPreview(compactDiff(diff));
}

function linesOf(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/u);
  if (text.endsWith('\n') || text.endsWith('\r')) lines.pop();
  return lines;
}

/** Split only after the source-size cap; then bound the arrays and individual strings we diff. */
function boundedLines(text: string): string[] | null {
  if (text.length > MAX_INPUT_CHARS) return null;
  const lines = linesOf(text);
  if (lines.length > MAX_INPUT_LINES || lines.some((line) => line.length > MAX_LINE_CHARS)) return null;
  return lines;
}

function tooLargePreview(hasFolderVersion = true): FolderDiffLine[] {
  return [{ kind: 'note', text: hasFolderVersion ? TOO_LARGE_NOTE : TOO_LARGE_NEW_FILE_NOTE }];
}

/** Keep the DOM payload bounded even when many changed lines are individually within the limit. */
function boundedPreview(lines: FolderDiffLine[]): FolderDiffLine[] {
  let characters = 0;
  for (const line of lines) {
    characters += line.text.length + 1;
    if (characters > MAX_PREVIEW_CHARS) return tooLargePreview();
  }
  return lines;
}

/** Myers' shortest-edit-script algorithm, stopped at a bounded edit distance. */
function myersDiff(before: readonly string[], after: readonly string[]): FolderDiffLine[] | null {
  const trace: Map<number, number>[] = [];
  const furthest = new Map<number, number>([[1, 0]]);
  const limit = Math.min(before.length + after.length, MAX_EDIT_DISTANCE);

  for (let distance = 0; distance <= limit; distance += 1) {
    trace.push(new Map(furthest));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const fromBelow = diagonal === -distance || (diagonal !== distance && (furthest.get(diagonal - 1) ?? -Infinity) < (furthest.get(diagonal + 1) ?? -Infinity));
      let x = fromBelow ? (furthest.get(diagonal + 1) ?? 0) : (furthest.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      furthest.set(diagonal, x);
      if (x >= before.length && y >= after.length) return backtrack(trace, before, after);
    }
  }
  return null;
}

function backtrack(trace: readonly Map<number, number>[], before: readonly string[], after: readonly string[]): FolderDiffLine[] {
  let x = before.length;
  let y = after.length;
  const reversed: FolderDiffLine[] = [];

  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const furthest = trace[distance] ?? new Map<number, number>();
    const diagonal = x - y;
    const fromBelow = diagonal === -distance || (diagonal !== distance && (furthest.get(diagonal - 1) ?? -Infinity) < (furthest.get(diagonal + 1) ?? -Infinity));
    const previousDiagonal = fromBelow ? diagonal + 1 : diagonal - 1;
    const previousX = furthest.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      reversed.push({ kind: 'context', text: before[x - 1] ?? '' });
      x -= 1;
      y -= 1;
    }
    if (distance === 0) break;
    if (x === previousX) {
      reversed.push({ kind: 'tab', text: after[y - 1] ?? '' });
      y -= 1;
    } else {
      reversed.push({ kind: 'folder', text: before[x - 1] ?? '' });
      x -= 1;
    }
  }
  return reversed.reverse();
}

/** Keep a little context around changed lines and cap long diffs without hiding that anything was omitted. */
function compactDiff(diff: readonly FolderDiffLine[]): FolderDiffLine[] {
  const changed = diff.flatMap((line, index) => (line.kind === 'context' ? [] : [index]));
  if (changed.length === 0) return [{ kind: 'note', text: 'The visible text is the same; only the file bytes or line endings differ.' }];
  const visibleContext = new Set<number>();
  for (const index of changed) {
    for (let near = Math.max(0, index - CONTEXT_LINES); near <= Math.min(diff.length - 1, index + CONTEXT_LINES); near += 1) {
      if (diff[near]?.kind === 'context') visibleContext.add(near);
    }
  }

  const output: FolderDiffLine[] = [];
  let omittedContext = 0;
  let folderLines = 0;
  let tabLines = 0;
  let omittedFolderLines = 0;
  let omittedTabLines = 0;
  for (let index = 0; index < diff.length; index += 1) {
    const line = diff[index];
    if (line === undefined) continue;
    if (line.kind === 'context' && !visibleContext.has(index)) {
      omittedContext += 1;
      continue;
    }
    if (line.kind === 'folder' && folderLines >= MAX_CHANGED_LINES) {
      omittedFolderLines += 1;
      continue;
    }
    if (line.kind === 'tab' && tabLines >= MAX_CHANGED_LINES) {
      omittedTabLines += 1;
      continue;
    }
    if (omittedContext > 0) {
      output.push({ kind: 'note', text: `${omittedContext} unchanged lines omitted.` });
      omittedContext = 0;
    }
    if (line.kind === 'folder') folderLines += 1;
    if (line.kind === 'tab') tabLines += 1;
    output.push(line);
  }
  if (omittedContext > 0) output.push({ kind: 'note', text: `${omittedContext} unchanged lines omitted.` });
  if (omittedFolderLines > 0 || omittedTabLines > 0) {
    output.push({
      kind: 'note',
      text: `${omittedFolderLines} folder and ${omittedTabLines} tab diff lines omitted; if you choose to replace the file, the full folder version is kept in .caotang-backup.`,
    });
  }
  return output;
}

function limitedLines(text: string, kind: 'folder' | 'tab', hasFolderVersion = true): FolderDiffLine[] {
  const all = boundedLines(text);
  if (all === null) return tooLargePreview(hasFolderVersion);
  const lines: FolderDiffLine[] = all.slice(0, MAX_CHANGED_LINES).map((line) => ({ kind, text: line }));
  if (all.length > MAX_CHANGED_LINES) {
    const backupNote = hasFolderVersion ? 'the backup keeps the full file.' : 'this file has no folder version to back up.';
    lines.push({ kind: 'note', text: `${all.length - MAX_CHANGED_LINES} more ${kind} lines omitted; ${backupNote}` });
  }
  return boundedPreview(lines);
}
