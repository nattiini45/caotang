/**
 * Watches the project folder the open session lives in, and reports the changes another program made to it (desktop.md
 * §External folder changes, #403). The offer is raised only when the folder's bytes no longer match the copy the session holds,
 * so this tab's own saves, a program rewriting a file with the same bytes and a change to a file the project does not own all
 * pass without a word. Nothing is reloaded or merged: the writer decides.
 */

import { useCallback, useEffect, useState } from 'react';

import { folderArtifactFs } from './fs-access.js';
import { holdNativeFolderWatch, nativeFolderId, onNativeFolderChange } from './native-folders.js';
import type { DirectoryHandleLike } from './fs-access.js';
import type { ProjectSession } from './session.js';
import type { NativeFolderChange } from '../../../desktop-shell/src/folder-contract.cjs';

/** How long a burst of watcher events settles before the folder is read: one save writes several files, one rename reports two events. */
const SETTLE_MS = 150;

export interface FolderWatch {
  /** The folder files that changed outside Caotang, or `null` when there is nothing to offer. */
  readonly changed: readonly string[] | null;
  /** The writer kept their own version: the offer goes and comes back only when the folder changes again. */
  readonly dismiss: () => void;
}

export function useFolderWatch(session: ProjectSession): FolderWatch {
  const [changed, setChanged] = useState<readonly string[] | null>(null);
  const folder = session.folderBaseline()?.folder ?? null;
  const folderId = folder === null ? undefined : nativeFolderId(folder);

  useEffect(() => {
    if (folder === null || folderId === undefined) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: string[] = [];

    /**
     * Judges every reported path in passes and confirms the differences once this session has no write of its own into the folder
     * outstanding: a save of this tab advances the copy only as it ends, however long it takes, so its own files are never offered
     * as another program's edit. The comparison loads on the first change, so the website — which has no native folder and no
     * watcher — never fetches it.
     */
    const ask = async (paths: readonly string[]): Promise<void> => {
      if (session.folderBaseline() === null) return;
      const { confirmedChanges, folderReader } = await import('./folder-watch.js');
      // A file the folder no longer holds is an answer; a read that fails for any other reason is a question, and the offer
      // does not answer questions by guessing that the file is gone.
      const read = (target: { folder: DirectoryHandleLike }) =>
        folderReader((path: string) => folderArtifactFs(target.folder).readBytes(path));
      const settled = await confirmedChanges(
        paths,
        () => session.folderBaseline(),
        read,
        () => session.folderWritesSettled(),
      );
      if (disposed || settled.length === 0) return;
      setChanged((prior) => [...new Set([...(prior ?? []), ...settled])]);
    };

    const onChange = (change: NativeFolderChange): void => {
      if (change.folderId !== folderId) return;
      pending = [...pending, ...change.paths];
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = pending;
        pending = [];
        timer = undefined;
        void ask(paths);
      }, SETTLE_MS);
    };

    const stopListening = onNativeFolderChange(onChange);
    const release = holdNativeFolderWatch(folderId);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      stopListening();
      release();
    };
  }, [session, folder, folderId]);

  const dismiss = useCallback(() => setChanged(null), []);
  return { changed, dismiss };
}
