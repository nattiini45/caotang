import { expect, test } from '@playwright/test';

import { folderFileDiff } from '../../apps/desktop/src/app/folder-diff.js';

test('a folder overwrite comparison shows removed and added lines with nearby context', () => {
  expect(folderFileDiff('Title\nFolder words.\nEnd', 'Title\nTab words.\nEnd')).toEqual([
    { kind: 'context', text: 'Title' },
    { kind: 'folder', text: 'Folder words.' },
    { kind: 'tab', text: 'Tab words.' },
    { kind: 'context', text: 'End' },
  ]);
});

test('separate edits leave the unchanged text between them marked as context', () => {
  expect(folderFileDiff('Start\nold one\nStill here\nold two\nEnd', 'Start\nnew one\nStill here\nnew two\nEnd')).toEqual([
    { kind: 'context', text: 'Start' },
    { kind: 'folder', text: 'old one' },
    { kind: 'tab', text: 'new one' },
    { kind: 'context', text: 'Still here' },
    { kind: 'folder', text: 'old two' },
    { kind: 'tab', text: 'new two' },
    { kind: 'context', text: 'End' },
  ]);
});

test('a byte-only or line-ending difference does not pretend the visible text changed', () => {
  expect(folderFileDiff('one\r\ntwo\r\n', 'one\ntwo')).toEqual([
    { kind: 'note', text: 'The visible text is the same; only the file bytes or line endings differ.' },
  ]);
});

test('an absent folder file is distinct from a folder file that could not be read', () => {
  expect(folderFileDiff(undefined, 'tab text')).toContainEqual({ kind: 'note', text: 'No matching file is in the folder.' });
  expect(folderFileDiff(null, 'tab text')).toContainEqual({
    kind: 'note',
    text: 'The folder version could not be read as text; it is not known to be missing.',
  });
  expect(folderFileDiff(null, 'tab text')).not.toContainEqual({ kind: 'note', text: 'No matching file is in the folder.' });
});

test('an absent tab file is distinct from tab text that could not be read', () => {
  expect(folderFileDiff('folder text', undefined)).toContainEqual({ kind: 'note', text: 'This tab has no matching file.' });
  expect(folderFileDiff('folder text', null)).toContainEqual({
    kind: 'note',
    text: 'This tab version could not be read as text; it is not known to be missing.',
  });
});

test('a very large changed block is capped and says the backup keeps the full file', () => {
  const folder = Array.from({ length: 305 }, (_, index) => `folder ${index}`).join('\n');
  const tab = Array.from({ length: 305 }, (_, index) => `tab ${index}`).join('\n');
  const diff = folderFileDiff(folder, tab);
  expect(diff.filter((line) => line.kind === 'folder')).toHaveLength(300);
  expect(diff.filter((line) => line.kind === 'tab')).toHaveLength(300);
  expect(diff).toContainEqual({
    kind: 'note',
    text: '5 folder and 5 tab diff lines omitted; if you choose to replace the file, the full folder version is kept in .caotang-backup.',
  });
});

test('a large new file preview does not promise a folder backup', () => {
  const tooManyLines = Array.from({ length: 305 }, (_, index) => `tab ${index}`).join('\n');
  const preview = folderFileDiff(undefined, tooManyLines);

  expect(preview[0]).toEqual({ kind: 'note', text: 'No matching file is in the folder.' });
  expect(preview.at(-1)?.text).toContain('this file has no folder version to back up');
  expect(preview.some((line) => line.text.includes('.caotang-backup'))).toBe(false);
});

test('large input, very long lines, and verbose diffs stay bounded in the preview', () => {
  const tooManyLines = Array.from({ length: 5_000 }, () => 'x').join('\n');
  const longLine = 'y'.repeat(5_000);
  const verboseFolder = Array.from({ length: 305 }, (_, index) => `folder ${index} ${'f'.repeat(120)}`).join('\n');
  const verboseTab = Array.from({ length: 305 }, (_, index) => `tab ${index} ${'t'.repeat(120)}`).join('\n');

  for (const preview of [
    folderFileDiff(tooManyLines, 'short'),
    folderFileDiff(longLine, 'short'),
    folderFileDiff('x'.repeat(128_001), 'short'),
    folderFileDiff(verboseFolder, verboseTab),
  ]) {
    expect(preview).toHaveLength(1);
    expect(preview[0]?.kind).toBe('note');
    expect(preview[0]?.text).toContain('backup');
    expect(preview[0]?.text.length).toBeLessThan(500);
  }
});
