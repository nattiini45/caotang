import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';

import { stepFolderSave, type FolderSaveEvent, type FolderSaveState } from '../app/folder-save-model.js';
import { folderIsEmpty, pickDirectory, type DirectoryHandleLike } from '../app/fs-access.js';
import { folderOverwriteSnapshotFor, previewFolderChanges, saveFolder, type FolderSaveAnswers } from '../app/lifecycle.js';
import type { ProjectSession } from '../app/session.js';
import type { StatusMessage } from './shared.js';

export function useFolderSave(session: ProjectSession, report: (message: StatusMessage) => void, pendingFolder: DirectoryHandleLike | null) {
  const [state, setState] = useState<FolderSaveState>({ kind: 'idle' });
  const current = useRef(state);
  const send = useCallback((event: FolderSaveEvent): boolean => {
    const next = stepFolderSave(current.current, event);
    if (next === current.current) return false;
    current.current = next;
    setState(next);
    return true;
  }, []);

  const failed = (error: unknown): void => {
    send({ type: 'fail' });
    report({ text: t`The folder could not be saved: ${{ error: error instanceof Error ? error.message : String(error) }}`, tone: 'error' });
  };

  const write = async (folder: DirectoryHandleLike, answers: FolderSaveAnswers): Promise<void> => {
    if (!send({ type: 'save' })) return;
    try {
      const outcome = await saveFolder(session, folder, answers);
      if (outcome.kind === 'refused') {
        const overwriteSnapshot = folderOverwriteSnapshotFor(outcome);
        if (overwriteSnapshot === undefined) throw new Error('The folder save question no longer matches the folder state. Save again to review it.');
        const previewBatch = await previewFolderChanges(session, folder, outcome.previewFiles ?? [], outcome.omittedPreviewFiles ?? 0);
        send({ type: 'ask', question: { kind: 'overwrite', offer: {
          folder, reason: outcome.reason, overwriteSnapshot, files: outcome.files,
          previews: previewBatch.previews, omittedPreviews: previewBatch.omitted,
          partial: outcome.partial === true, after: outcome.after === true, removed: outcome.removed === true, answers,
        } } });
        return;
      }
      await session.attachFolder(folder);
      send({ type: 'saved' });
      report({
        text: [
          outcome.backup === undefined
            ? t`Saved the project to the folder “${{ folder: isolate(folder.name) }}”. Exports go there from now on.`
            : t`Saved the project to the folder “${{ folder: isolate(folder.name) }}”. What it replaced is kept in ${{ backup: outcome.backup }}. Exports go there from now on.`,
          ...(outcome.warnings ?? []),
        ].join(' '),
        tone: 'info',
      });
    } catch (error) {
      failed(error);
    }
  };

  const pick = (empty = false): void => {
    if (!send({ type: 'pick' })) return;
    void (async () => {
      try {
        const folder = await pickDirectory('readwrite');
        if (folder === null) {
          send({ type: 'cancel' });
          return;
        }
        if (empty && !(await folderIsEmpty(folder))) {
          send({ type: 'ask', question: { kind: 'not-empty', name: folder.name } });
          return;
        }
        await write(folder, {});
      } catch (error) {
        failed(error);
      }
    })();
  };

  const answer = (): void => {
    const now = current.current;
    if (now.kind !== 'asking' || now.question.kind !== 'overwrite') return;
    const { folder, reason, answers, overwriteSnapshot } = now.question.offer;
    void write(folder, reason === 'locked'
      ? { ...answers, lockConfirmed: true }
      : { ...answers, overwriteConfirmed: true, overwriteSnapshot });
  };

  const writeNow = useRef(write);
  useEffect(() => { writeNow.current = write; });
  const pendingSaved = useRef<DirectoryHandleLike | null>(null);
  useEffect(() => {
    if (pendingFolder === null || pendingSaved.current === pendingFolder) return;
    pendingSaved.current = pendingFolder;
    void writeNow.current(pendingFolder, {});
  }, [pendingFolder]);

  return { state, pick, answer, cancel: () => { send({ type: 'cancel' }); } };
}
