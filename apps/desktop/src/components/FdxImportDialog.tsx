/**
 * What a Final Draft import will do, shown before anything is written (issue #264): the scenes and sections it makes, the script
 * notes and dual-dialogue pairs it keeps (counted even when there are none, so the writer can see nothing was lost), and every
 * notice about what it could not keep. **Import** writes it in one undo step; **Cancel** changes nothing.
 */

import type { ReactNode } from 'react';

import { describeFdxImport, type FdxImportedScript } from '@caotang/screenplay';

import { ChoiceDialog } from './shared.js';

export function FdxImportDialog({
  fileName,
  script,
  warnings,
  onImport,
  onCancel,
}: {
  /** The file being read, or null while no file is waiting on an answer. */
  fileName: string | null;
  script: FdxImportedScript | null;
  /** The import scan's sentence about instruction-like passages, notes included, when it found any. */
  warnings: readonly string[];
  onImport: () => void;
  onCancel: () => void;
}): ReactNode {
  const open = fileName !== null && script !== null;
  const notices = open ? script.notices : [];
  return (
    <ChoiceDialog open={open} title="Import this Final Draft script?" choices={[{ label: 'Import', onChoose: onImport }]} onCancel={onCancel}>
      {open ? (
        <div className="twee-report">
          <p>
            <strong>{fileName}</strong> will become screenplay scenes. Read what the import keeps first.
          </p>
          <ul aria-label="What the import does">
            {describeFdxImport(script).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {notices.length + warnings.length > 0 ? (
            <>
              <h3>Notices</h3>
              <ul aria-label="Notices">
                {[...notices, ...warnings].map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </ChoiceDialog>
  );
}
