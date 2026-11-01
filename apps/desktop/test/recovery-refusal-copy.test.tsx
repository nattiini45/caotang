/**
 * A refusal that names the files another program changed lists them as `name: kind` lines after the frame's colon, so no
 * per-file verb is spliced into the outer sentence (i18n.md §6.3; the L6-approved shape in Workspace.tsx `changedFilesList`).
 * The words are the dialog's own copy, so the test drives `refusalText` directly.
 */
import { describe, expect, it } from 'vitest';

import { refusalText } from '../src/components/RecoveryDialog.js';

/** The visible string without the isolate marks writer text carries. */
function plain(value: string): string {
  return value.replace(/[\u2066-\u2069]/g, '');
}

describe('a refused recovery names the files another program changed', () => {
  it('lists each file as "name: kind", so the outer sentence carries no per-file verb', () => {
    const refusal = plain(
      refusalText('files', [
        { change: 'changed', label: 'notes.md' },
        { change: 'removed', label: 'Anna' },
      ]),
    );
    expect(refusal).toContain('Another program changed this folder after Caotang read it, so nothing was written: ');
    expect(refusal).toContain('notes.md: changed');
    expect(refusal).toContain('Anna: removed');
    expect(refusal).toContain('Close this, then open the folder again to see its current copy.');
    // The frame never takes a per-file verb: the old splice read "Another program changed notes.md after …".
    expect(refusal).not.toContain('changed notes.md');
    expect(refusal).not.toContain('removed Anna');
  });

  it('a refusal with no named file is one whole sentence', () => {
    expect(plain(refusalText('files', []))).toBe(
      'Another program changed a file in this folder after Caotang read the folder, so nothing was written. Close this, then open the folder again to see its current copy.',
    );
  });
});
