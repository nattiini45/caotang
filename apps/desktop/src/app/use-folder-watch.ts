/**
 * Watches the project folder the open session lives in, and reports the changes another program made to it (desktop.md
 * §External folder changes, #403). The offer is raised only when the folder's bytes no longer match the copy the session holds,
 * so this tab's own saves, a program rewriting a file with the same bytes and a change to a file the project does not own all
 * pass without a word. Nothing is reloaded or merged: the writer decides.
 */

import { useCallback, useEffect, useState } from 'react';

import { externalChanges } from './folder-watch.js';
import { folderArtifactFs } from './fs-access.js';
import { nativeFolderId, onNativeFolderChange, unwatchNativeFolder, watchNativeFolder } from './native-folders.js';
import type { ProjectSession } from './session.js';
import type { NativeFolderChange } from '../../../desktop-shell/src/folder-contract.cjs';

/** How long a burst of watcher events settles before the folder is read: one save writes several files, one rename reports two events. */
const SETTLE_MS = 150;
/** How long the confirming read waits, so a save of this tab's own that lands mid-read is not mistaken for someone else's edit. */
const CONFIRM_MS = 200;
/** How many paths one burst reads: a bulk edit names files faster than they are worth reading one by one. */
const MAX_READS = 40;

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
    let subscription: string | null = null;

    /** Reads the reported paths twice: the second read decides, once any write of this tab's own has reached the folder. */
    const ask = async (paths: readonly string[]): Promise<void> => {
      const baseline = session.folderBaseline();
      if (baseline === null) return;
      const read = (target: typeof baseline) => (path: string): Promise<Uint8Array | null> =>
        folderArtifactFs(target.folder).readBytes(path).catch(() => null);
      const first = await externalChanges(baseline, paths.slice(0, MAX_READS), read(baseline));
      if (disposed || first.length === 0) return;
      await new Promise((done) => setTimeout(done, CONFIRM_MS));
      const now = session.folderBaseline();
      if (disposed || now === null) return;
      const settled = await externalChanges(now, first, read(now));
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
    void watchNativeFolder(folderId).then(
      (id) => {
        if (disposed) {
          if (id !== null) void unwatchNativeFolder(id);
          return;
        }
        subscription = id;
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      stopListening();
      if (subscription !== null) void unwatchNativeFolder(subscription);
    };
  }, [session, folder, folderId]);

  const dismiss = useCallback(() => setChanged(null), []);
  return { changed, dismiss };
}
