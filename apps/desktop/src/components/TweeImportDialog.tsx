/**
 * The report a Twee import shows before anything is written (dialogue-narrative.md §4), on the shared import preview (issue #267).
 * A Twine story format is a programming environment, so what the import strips is counted first: the writer confirms having read it,
 * or cancels and nothing changes. The preview is the shared one (`import-preview/`); this component opens it over the Twee plan when
 * a file is waiting on an answer, and hands the answer back to the import action as before.
 */

import { useEffect, useRef, type ReactNode } from 'react';

import type { TweeImportPlan } from '@caotang/dialogue';

import { closeImportPreview, currentImportPreview, openImportPreview } from '../import-preview/requests.js';
import { tweePreviewSource } from '../import-preview/twee-source.js';

export function TweeImportDialog({
  fileName,
  plan,
  onImport,
  onCancel,
}: {
  /** The file being read, or null while no file is waiting on an answer. */
  fileName: string | null;
  plan: TweeImportPlan | null;
  onImport: () => void;
  onCancel: () => void;
}): ReactNode {
  // The latest answers, read when the preview closes: the action's callbacks change identity on every render.
  const answers = useRef({ onImport, onCancel });
  useEffect(() => {
    answers.current = { onImport, onCancel };
  }, [onImport, onCancel]);

  useEffect(() => {
    if (fileName === null || plan === null) return;
    let imported = false;
    const source = tweePreviewSource({
      fileName,
      plan,
      write: () => {
        imported = true;
        answers.current.onImport();
      },
    });
    openImportPreview({
      source,
      onClose: () => {
        if (!imported) answers.current.onCancel();
      },
    });
    return () => {
      // The action dropped its file (a newer one, or the workspace closed): the preview over it goes too.
      if (currentImportPreview()?.source === source) closeImportPreview(false);
    };
  }, [fileName, plan]);

  return null;
}
