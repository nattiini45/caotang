/**
 * `coherence.json` on disk — [coherence.md §3 recovery posture](../../../docs/architecture/coherence.md),
 * [project-format §1, §4, §5](../../../docs/architecture/project-format.md).
 *
 * Every write goes through the {@link ArtifactFs} port's `writeAtomic`, the only
 * mutation entry point the port has, so the torn-write class cannot occur here.
 *
 * Recovery. Before a changed save replaces the file, the previous file rotates into
 * `coherence.json.bak.1`, and down to `.bak.3` (project-format §4, the same depth as
 * `caotang.json`). A load that finds the live file unreadable keeps the damaged copy
 * under a timestamped name and restores the newest snapshot that reads. Only when no
 * snapshot reads are the writer's parts of the file lost: dismissals, scene declarations
 * manual world rules and knowledge facts. Findings are always recomputable. The load says exactly which.
 */

import { isBodyType, type ArtifactFs, type ProjectState } from '@caotang/store';

import { parseCoherenceFile, serializeCoherenceFile, type LoadNotice } from './codec.js';
import { CoherenceError } from './errors.js';
import { COHERENCE_FILE, COHERENCE_SNAPSHOT_COUNT, emptyCoherenceFile, type CoherenceFile } from './model.js';
import { sourceHolds } from './world-rules.js';

/** §5.3's pattern for a kept corrupt file: `coherence.json.corrupt-<timestamp>`, colons replaced for paths. */
export function corruptCoherenceFile(when: Date): string {
  return `${COHERENCE_FILE}.corrupt-${when.toISOString().replace(/[:.]/g, '-')}`;
}

/** project-format §4's pattern applied to coherence.json: generation `n` is `coherence.json.bak.<n>`. */
export function coherenceSnapshotFile(n: number): string {
  return `${COHERENCE_FILE}.bak.${n}`;
}

export type LoadStatus =
  /** No file yet. The first save creates it. */
  | 'absent'
  /** Read as written. */
  | 'loaded'
  /** Unreadable; the original is kept and the file was restored from a snapshot, or started empty. */
  | 'recovered'
  /** Written by a newer Caotang. Shown, never overwritten. */
  | 'read-only';

export interface LoadResult {
  readonly status: LoadStatus;
  readonly file: CoherenceFile;
  readonly notices: LoadNotice[];
  /** False only for `read-only`: a save would destroy a newer format. */
  readonly writable: boolean;
  /** Set on `recovered`: the name the unreadable file was kept under. */
  readonly preservedAs?: string;
}

/** Said when no snapshot reads: the writer-authored parts of the file are gone, and the kept copy is the only record. */
const LOSS_NOTICE =
  'Findings were recomputed, and no earlier version of the file could be read. Dismissal decisions are lost, and the kept copy is the only record of them. ' +
  'Scene declarations, manual world rules and knowledge facts were in that file too; they are in the kept copy and nowhere else.';

/** The newest snapshot that reads, in ladder order (`.bak.1` first). A newer-format or damaged one is skipped. */
async function newestReadableSnapshot(fs: ArtifactFs): Promise<{ path: string; file: CoherenceFile; notices: LoadNotice[] } | undefined> {
  for (let n = 1; n <= COHERENCE_SNAPSHOT_COUNT; n += 1) {
    const path = coherenceSnapshotFile(n);
    if (!(await fs.exists(path))) continue;
    let text: string;
    try {
      text = await fs.read(path);
    } catch {
      continue;
    }
    const outcome = parseCoherenceFile(text);
    if (outcome.kind === 'ok') return { path, file: outcome.file, notices: outcome.notices };
  }
  return undefined;
}

export interface LoadOptions {
  readonly now?: Date;
  /**
   * Writes nothing. An unreadable file is not kept under a corrupt name and not restored: the newest snapshot that reads, or an
   * empty file, is what the load returns, and the notice says the file on disk is as it was. The result stays writable, because
   * a later save rotates the unreadable live file under its corrupt name before it replaces it (`rotateCoherence`).
   * For a reader that must not change the folder (the MCP server on either posture, extensibility.md §9).
   */
  readonly readOnly?: boolean;
}

/**
 * Reads the project's coherence file. Never throws on content. It throws only
 * when the port itself fails, because a port failure is not a file problem.
 */
export async function loadCoherence(fs: ArtifactFs, options: LoadOptions = {}): Promise<LoadResult> {
  if (!(await fs.exists(COHERENCE_FILE))) {
    return { status: 'absent', file: emptyCoherenceFile(), notices: [], writable: true };
  }
  const text = await fs.read(COHERENCE_FILE);
  const outcome = parseCoherenceFile(text);

  if (outcome.kind === 'ok') {
    return { status: 'loaded', file: outcome.file, notices: outcome.notices, writable: true };
  }

  if (outcome.kind === 'newer') {
    return {
      status: 'read-only',
      file: emptyCoherenceFile(),
      notices: [
        {
          code: 'newer-format',
          message: `coherence.json was written by a newer Caotang (format ${outcome.formatVersion}). Findings are not shown and the file is not changed.`,
        },
      ],
      writable: false,
    };
  }

  if (options.readOnly === true) return readOnlyRecovery(fs, outcome.reason);

  const preservedAs = corruptCoherenceFile(options.now ?? new Date());
  await fs.writeAtomic(preservedAs, text);
  const snapshot = await newestReadableSnapshot(fs);
  if (snapshot !== undefined) {
    await fs.writeAtomic(COHERENCE_FILE, serializeCoherenceFile(snapshot.file));
    return {
      status: 'recovered',
      file: snapshot.file,
      notices: [
        ...snapshot.notices,
        {
          code: 'restored-from-snapshot',
          message:
            `coherence.json could not be read (${outcome.reason}). The unreadable file is kept as ${preservedAs}, and the file was restored from ` +
            `${snapshot.path}, the newest earlier version that reads. Changes made after that version was saved are not in it; a scan recomputes the findings.`,
        },
      ],
      writable: true,
      preservedAs,
    };
  }

  const file = emptyCoherenceFile();
  await fs.writeAtomic(COHERENCE_FILE, serializeCoherenceFile(file));
  return {
    status: 'recovered',
    file,
    notices: [
      {
        code: 'corrupt-file',
        message: `coherence.json could not be read (${outcome.reason}). The unreadable file is kept as ${preservedAs}. ${LOSS_NOTICE}`,
      },
    ],
    writable: true,
    preservedAs,
  };
}

/** The result of a read-only load of an unreadable file: what a recovery would hold, with nothing written and nothing kept. */
async function readOnlyRecovery(fs: ArtifactFs, reason: string): Promise<LoadResult> {
  const snapshot = await newestReadableSnapshot(fs);
  if (snapshot !== undefined) {
    return {
      status: 'recovered',
      file: snapshot.file,
      notices: [
        ...snapshot.notices,
        {
          code: 'restored-from-snapshot',
          message:
            `coherence.json could not be read (${reason}). It is not changed, and ${snapshot.path}, the newest earlier version that reads, is used instead. ` +
            'Changes made after that version was saved are not in it; a scan recomputes the findings.',
        },
      ],
      writable: true,
    };
  }
  return {
    status: 'recovered',
    file: emptyCoherenceFile(),
    notices: [
      {
        code: 'corrupt-file',
        message: `coherence.json could not be read (${reason}). It is not changed, and no earlier version of it reads, so an empty file is used. ${LOSS_NOTICE}`,
      },
    ],
    writable: true,
  };
}

/**
 * Moves the live file one generation down before a changed save. A save that changes
 * nothing makes no generation. A live file that does not read is kept under its corrupt
 * name and never enters the ladder, so a snapshot is always a file that reads.
 */
async function rotateCoherence(fs: ArtifactFs, next: string, now: Date): Promise<void> {
  if (!(await fs.exists(COHERENCE_FILE))) return;
  const current = await fs.read(COHERENCE_FILE);
  if (current === next) return;
  const outcome = parseCoherenceFile(current);
  if (outcome.kind === 'newer') {
    throw new CoherenceError('read-only', 'coherence.json was written by a newer Caotang while this one was open, and it cannot be saved over.');
  }
  if (outcome.kind === 'corrupt') {
    await fs.writeAtomic(corruptCoherenceFile(now), current);
    return;
  }
  const oldest = coherenceSnapshotFile(COHERENCE_SNAPSHOT_COUNT);
  if (await fs.exists(oldest)) await fs.remove(oldest);
  for (let n = COHERENCE_SNAPSHOT_COUNT - 1; n >= 1; n -= 1) {
    const from = coherenceSnapshotFile(n);
    if (!(await fs.exists(from))) continue;
    await fs.writeAtomic(coherenceSnapshotFile(n + 1), await fs.read(from));
  }
  await fs.writeAtomic(coherenceSnapshotFile(1), current);
}

/** Writes the file atomically, after rotating the previous generation. Refuses a read-only load, so a newer file is never overwritten. */
export async function saveCoherence(fs: ArtifactFs, load: LoadResult, file: CoherenceFile, options: { now?: Date } = {}): Promise<void> {
  if (!load.writable) {
    throw new CoherenceError('read-only', 'coherence.json was written by a newer Caotang and cannot be saved by this one.');
  }
  const text = serializeCoherenceFile(file);
  await rotateCoherence(fs, text, options.now ?? new Date());
  await fs.writeAtomic(COHERENCE_FILE, text);
}

/**
 * §4.4: a `learns` or `knows` pair whose codex entry or fact is gone is dropped, and a fact whose world rule or codex entry
 * is gone keeps its text and loses the link. Each is named in a notice, so a writer who deleted a character sees what went.
 */
function reconcileKnowledge(next: CoherenceFile, state: ProjectState, notices: LoadNotice[]): void {
  const entries = new Map((state.manifest.codex ?? []).map((entry) => [entry.id, entry.name] as const));
  const facts = new Map(next.knowledge.map((fact) => [fact.id, fact.text] as const));
  const rules = new Set(next.worldRules.map((rule) => rule.id));
  for (const fact of next.knowledge) {
    if (fact.entryId !== undefined && !entries.has(fact.entryId)) {
      delete fact.entryId;
      notices.push({ code: 'dangling-knowledge', message: `The codex entry a knowledge fact is about no longer exists, so "${fact.text}" lost that link and stays.` });
    }
    if (fact.ruleId !== undefined && !rules.has(fact.ruleId)) {
      delete fact.ruleId;
      notices.push({ code: 'dangling-knowledge', message: `The world rule a knowledge fact restates no longer exists, so "${fact.text}" lost that link and stays.` });
    }
  }
  for (const [key, meta] of Object.entries(next.sceneMeta)) {
    for (const field of ['learns', 'knows'] as const) {
      const links = meta[field];
      if (links === undefined) continue;
      const kept = links.filter((link) => {
        const entryName = entries.get(link.entryId);
        const factText = facts.get(link.factId);
        if (entryName !== undefined && factText !== undefined) return true;
        const who = entryName === undefined ? 'a character that no longer exists' : entryName;
        const what = factText === undefined ? 'a knowledge fact that no longer exists' : `"${factText}"`;
        notices.push({ code: 'dangling-knowledge', message: `A "${field}" declaration on "${state.manifest.tree.find((node) => node.id === key)?.title ?? key}" named ${who} and ${what}, and was dropped.` });
        return false;
      });
      if (kept.length === links.length) continue;
      if (kept.length > 0) meta[field] = kept;
      else delete meta[field];
    }
    if (Object.keys(meta).length === 0) delete next.sceneMeta[key];
  }
}

/**
 * Brings a loaded file into line with the project it is attached to. A
 * declaration on a deleted node is dropped, and so is a finding that quotes a
 * deleted body: its quote is no longer in the project. A body is a document or a
 * dialogue container (both hold text a finding can quote, dialogue-narrative.md §2.1),
 * so a branch finding on a container survives a reopen with its dismissal. A found rule
 * loses its source and drops out of canon, which §4.3 requires. A verified rule
 * whose passage has changed in the text is checked again here, against the body as it
 * now stands: a found rule goes back to review, and a manual rule stays canon.
 *
 * Pure: returns a new file. The caller decides whether to save it.
 */
export function reconcileCoherence(file: CoherenceFile, state: ProjectState): { file: CoherenceFile; notices: LoadNotice[] } {
  const nodeIds = new Set(state.manifest.tree.map((node) => node.id));
  const documentIds = new Set(state.manifest.tree.filter((node) => isBodyType(node.type)).map((node) => node.id));
  const notices: LoadNotice[] = [];
  const next = structuredClone(file);

  for (const key of Object.keys(next.sceneMeta)) {
    if (!nodeIds.has(key)) {
      delete next.sceneMeta[key];
      notices.push({ code: 'dangling-scene-meta', message: 'Scene declarations for a scene that no longer exists were dropped.' });
    }
  }

  reconcileKnowledge(next, state, notices);

  next.findings = next.findings.filter((finding) => {
    const dangling = finding.evidence.some((passage) => !documentIds.has(passage.docId));
    if (dangling) {
      // The load notice is shown as it is, so the finding is named by its statement, never by its id.
      notices.push({ code: 'dangling-finding', message: `A finding quotes a document that no longer exists and was removed: “${finding.message}”.` });
    }
    return !dangling;
  });

  for (const rule of next.worldRules) {
    const label = `"${rule.text}"`;
    if (rule.source !== undefined && !documentIds.has(rule.source.docId)) {
      delete rule.source;
      if (rule.origin === 'found') {
        delete rule.verified;
        notices.push({ code: 'dangling-world-rule-source', message: `The source document of an extracted world rule (${label}) no longer exists, so the rule is back in review.` });
      } else {
        rule.verified = false;
        notices.push({ code: 'dangling-world-rule-source', message: `The source document of a manual world rule (${label}) no longer exists. The rule stays canon.` });
      }
      continue;
    }
    if (rule.verified === true && rule.source !== undefined && !sourceHolds(state, rule.source)) {
      if (rule.origin === 'found') {
        delete rule.source;
        delete rule.verified;
        notices.push({ code: 'world-rule-source-changed', message: `An extracted world rule (${label}) is back in review: its source passage no longer matches the text.` });
      } else {
        rule.verified = false;
        notices.push({ code: 'world-rule-source-changed', message: `A manual world rule (${label}) stays canon, but its source passage no longer matches the text.` });
      }
    }
  }

  for (const key of Object.keys(next.reviewState)) {
    if (!documentIds.has(key)) delete next.reviewState[key];
  }

  return { file: next, notices };
}
