/**
 * The server's copy of `coherence.json` (coherence.md §3, §7 tool 15; extensibility.md §9).
 *
 * The file is read when the project opens, on either posture, so a scan upserts against the findings the app saved and its run
 * joins the app's run history. The read writes nothing (`loadCoherence` with `readOnly`): a corrupt file is not repaired by a
 * server that was started read-only. Every write goes through the coherence module's own `saveCoherence`, so the rotation and the
 * atomic write are the module's, never this file's.
 *
 * A `coherence.json` that cannot be read never stops the server from opening the project. It is held as an empty file that is
 * not written, and the notice says so.
 */

import { COHERENCE_FILE, emptyCoherenceFile, loadCoherence, reconcileCoherence, type LoadResult } from '@caotang/coherence';
import type { ArtifactFs, LoadNotice, ProjectState } from '@caotang/store';

/** The file as it was read at open, and what the read had to say. */
export interface OpenedCoherence {
  readonly load: LoadResult;
  readonly notices: LoadNotice[];
}

/** One load notice in the shape the session reports: the file it is about, and the sentence. */
function noticeOf(message: string): LoadNotice {
  return { path: COHERENCE_FILE, message };
}

/**
 * Reads `coherence.json` without writing, reconciles it with the project the server holds, and sets `state.coherence`. A failure of the
 * port itself holds an empty file that is not writable, so the file on disk is never replaced by one this server could not read.
 */
export async function openCoherence(fs: ArtifactFs, state: ProjectState): Promise<OpenedCoherence> {
  let load: LoadResult;
  try {
    load = await loadCoherence(fs, { readOnly: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    load = {
      status: 'read-only',
      file: emptyCoherenceFile(),
      notices: [{ code: 'corrupt-file', message: `coherence.json could not be read (${reason}). It is not changed, and this server does not write it.` }],
      writable: false,
    };
  }
  const reconciled = reconcileCoherence(load.file, state);
  state.coherence = reconciled.file;
  return { load, notices: [...load.notices, ...reconciled.notices].map((notice) => noticeOf(notice.message)) };
}
