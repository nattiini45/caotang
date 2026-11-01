/**
 * The Node host's copy of `coherence.json` (coherence.md §3, §7 tool 15; extensibility.md §9), held by the MCP server and by the SDK.
 *
 * The file is read when the project opens, on either posture, so a scan upserts against the findings the app saved and its run
 * joins the app's run history. The read writes nothing (`loadCoherence` with `readOnly`): a corrupt file is not repaired by a
 * host that was opened read-only. Every write goes through the coherence module's own `saveCoherence`, so the rotation and the
 * atomic write are the module's, never this file's.
 *
 * A `coherence.json` that cannot be read never stops the host from opening the project. It is held as an empty file that is
 * not written, and the notice says so.
 */

import {
  COHERENCE_FILE,
  CoherenceError,
  RUN_HISTORY_LIMIT,
  emptyCoherenceFile,
  loadCoherence,
  reconcileCoherence,
  saveCoherence,
  serializeCoherenceFile,
  type CoherenceFile,
  type LoadResult,
} from '@caotang/coherence';
import type { ArtifactFs, LoadNotice, ProjectState } from '@caotang/store';

import type { FolderVoice } from './voice.js';

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
 * Reads `coherence.json` without writing, reconciles it with the project the host holds, and sets `state.coherence`. A failure of the
 * port itself holds an empty file that is not writable, so the file on disk is never replaced by one this host could not read.
 */
export async function openCoherence(fs: ArtifactFs, state: ProjectState, voice: FolderVoice): Promise<OpenedCoherence> {
  let load: LoadResult;
  try {
    load = await loadCoherence(fs, { readOnly: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    load = {
      status: 'read-only',
      file: emptyCoherenceFile(),
      notices: [{ code: 'corrupt-file', message: `coherence.json could not be read (${reason}). It is not changed, and ${voice.holder} does not write it.` }],
      writable: false,
    };
  }
  const reconciled = reconcileCoherence(load.file, state);
  state.coherence = reconciled.file;
  return { load, notices: [...load.notices, ...reconciled.notices].map((notice) => noticeOf(notice.message)) };
}

/**
 * The file `mine` (what this server holds now) put onto `disk` (what another program left in the folder), by the server's own delta since
 * `base` (what it loaded or saved last), and nothing else. The disk copy wins everywhere the server did not act:
 * - a run the server recorded is appended, matched by run id, and the history keeps its cap;
 * - a finding the server created is added when the disk copy lacks it, matched by id;
 * - a finding the server moved from open to fixed is moved on the disk copy only if the disk copy still has it open.
 * A disk-side dismissal is never changed and nothing is ever reopened. Scene declarations, world rules and review state are the disk's
 * (coherence.md §6.3: an agent may only set `fixed`, so the server holds no other change to them). Pure: returns a new file.
 */
export function mergeServerDelta(disk: CoherenceFile, base: CoherenceFile, mine: CoherenceFile): CoherenceFile {
  const merged = structuredClone(disk);
  const baseRuns = new Set(base.runs.map((run) => run.id));
  const heldRuns = new Set(merged.runs.map((run) => run.id));
  for (const run of mine.runs) {
    if (!baseRuns.has(run.id) && !heldRuns.has(run.id)) merged.runs.push(structuredClone(run));
  }
  if (merged.runs.length > RUN_HISTORY_LIMIT) merged.runs.splice(0, merged.runs.length - RUN_HISTORY_LIMIT);

  const baseFindings = new Map(base.findings.map((finding) => [finding.id, finding]));
  const heldFindings = new Map(merged.findings.map((finding) => [finding.id, finding]));
  for (const finding of mine.findings) {
    const before = baseFindings.get(finding.id);
    const onDisk = heldFindings.get(finding.id);
    if (before === undefined) {
      if (onDisk === undefined) merged.findings.push(structuredClone(finding));
    } else if (onDisk !== undefined && before.status === 'open' && finding.status === 'fixed' && onDisk.status === 'open') {
      onDisk.status = 'fixed';
      onDisk.updatedAt = finding.updatedAt;
      if (finding.touchedAt !== undefined) onDisk.touchedAt = finding.touchedAt;
      if (finding.note !== undefined) onDisk.note = finding.note;
    }
  }
  return merged;
}

export interface CoherenceHold {
  /**
   * Saves `coherence.json` when the file the server holds differs from the one it last loaded or saved, and only if writes are on and
   * the file may be written. Never throws: a refusal or a failure is said on stderr and in the session notices, naming the file.
   * Call it on the session's queue, after any project save in flight.
   */
  save(): Promise<void>;
  /**
   * `disk` with this host's own delta since its baseline put onto it, by {@link mergeServerDelta}'s rules, and nothing else: the
   * runs it recorded and the findings it made or fixed. A writer that must start from another program's file — the timeline's
   * two-file save, whose `coherence.json` holds scene declarations the app also edits — starts here, so its own unsaved findings
   * are not lost when the disk copy wins.
   */
  mergeInto(disk: CoherenceFile): CoherenceFile;
}

export interface HoldOptions {
  readonly fs: ArtifactFs;
  readonly state: ProjectState;
  readonly opened: OpenedCoherence;
  readonly allowWrites: boolean;
  /** The digest of `coherence.json` as it was before the read at open, or `undefined` when the folder held none. */
  readonly digestAtOpen: string | undefined;
  /** The digest of `coherence.json` now. */
  readonly digest: () => Promise<string | undefined>;
  /** The session's notices, which a refusal or failure joins. */
  readonly notices: LoadNotice[];
  /** One line for the operator (stderr). */
  readonly report: (line: string) => void;
  readonly voice: FolderVoice;
}

/**
 * The single writer of `coherence.json` for a server started with `--allow-writes`. The server adds no writer of its own: it serialises
 * `state.coherence` through the coherence module's `saveCoherence`. Before it writes, the file is digested against the digest held since
 * the last load or save. If another program wrote it meanwhile, the disk copy is read again and the server's own additions are put onto it
 * ({@link mergeServerDelta}). That narrows the window in which two writers lose each other's work, and it does not close it: the check and the
 * write are two steps (extensibility.md §9). A merge that cannot be made cleanly, or a disk file from a newer Caotang, refuses the write
 * and stops coherence writes until the server restarts.
 */
export function holdCoherence(options: HoldOptions): CoherenceHold {
  const { fs, state, allowWrites, notices, report, voice } = options;
  let load = options.opened.load;
  let base = structuredClone(state.coherence as CoherenceFile);
  let savedText = serializeCoherenceFile(base);
  let heldDigest = options.digestAtOpen;
  let stopped = false;

  const say = (message: string): void => {
    notices.push(noticeOf(message));
    report(`${voice.program}: notice: ${COHERENCE_FILE}: ${message}`);
  };
  const refuse = (reason: string): void => {
    stopped = true;
    say(`${reason} Nothing was written to ${COHERENCE_FILE}, and writes to it are stopped until ${voice.reopened}. The scan runs and finding changes made since the last save stay in ${voice.holder}'s memory.`);
  };

  return {
    mergeInto(disk) {
      const mine = state.coherence as CoherenceFile | undefined;
      return mine === undefined ? structuredClone(disk) : mergeServerDelta(disk, base, mine);
    },
    async save() {
      if (!allowWrites || stopped || !load.writable) return;
      const mine = state.coherence as CoherenceFile | undefined;
      if (mine === undefined || serializeCoherenceFile(mine) === savedText) return;
      try {
        let target = mine;
        let using = load;
        if ((await options.digest()) !== heldDigest) {
          const reread = await loadCoherence(fs, { readOnly: true });
          if (reread.status === 'read-only') return refuse(`${COHERENCE_FILE} was changed by another program to a format from a newer Caotang, which ${voice.holder} cannot save over.`);
          if (reread.status === 'recovered') return refuse(`${COHERENCE_FILE} was changed by another program and cannot be read, so the changes could not be merged with it.`);
          target = mergeServerDelta(reconcileCoherence(reread.file, state).file, base, mine);
          using = reread;
          state.coherence = target;
        }
        await saveCoherence(fs, using, target);
        load = using;
        base = structuredClone(target);
        savedText = serializeCoherenceFile(target);
        heldDigest = await options.digest();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof CoherenceError && error.code === 'read-only') return refuse(reason);
        say(`${COHERENCE_FILE} could not be saved: ${reason}. It is tried again at the next scan or finding change.`);
      }
    },
  };
}
