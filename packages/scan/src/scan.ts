/**
 * A headless continuity scan — [coherence.md §10](../../../docs/architecture/coherence.md).
 *
 * `runScan` opens a project folder through the `ArtifactFs` port, reads `coherence.json`, runs the deterministic checks and
 * says which findings are open and where they sit. It calls no model and reads no key, and it writes nothing unless `write` is
 * set: the file is read so a finding the writer dismissed or marked fixed in the app neither prints nor fails the run.
 *
 * The dialogue branch checks need the dialogue module's facts, which the coherence module cannot compute (run.ts). A caller that
 * has them passes `deps.dialogueFacts`; without them the run says those checks did not run and the result is `partial`.
 */

import { compileCodex, countMentions } from '@caotang/codex';
import {
  DETERMINISTIC_CHECK_IDS,
  FINDING_SEVERITIES,
  loadCoherence,
  reconcileCoherence,
  runDeterministic,
  saveCoherence,
  type CoherenceFile,
  type DeterministicCheckId,
  type DialogueFacts,
  type Finding,
  type FindingSeverity,
  type MentionDetector,
} from '@caotang/coherence';
import type { CoherenceReportInput } from '@caotang/exporter/coherence-report';
import { DOCS_DIR, bodyNamesOf, readProject, type ArtifactFs, type ProjectState } from '@caotang/store';

import { DEFAULT_FAIL_ON, exitCodeFor, severityRank, type FailOn, type ScanExitCode } from './exit.js';
import { bodyStartOf, placeFinding } from './place.js';
import { reportInputOf } from './state.js';

export interface ScanOptions {
  /** `full` reads every document; `changed` only those edited since the last saved run. Default `full`: without `write`, `changed` never advances. */
  readonly scope?: 'full' | 'changed';
  /** The checks to run. Default: all of them. */
  readonly checks?: readonly DeterministicCheckId[];
  /** The severity at which an open finding fails the run. Default `error`. */
  readonly failOn?: FailOn;
  /** Saves `coherence.json` with this run in it. Default: the folder is not written. */
  readonly write?: boolean;
  /** The run's clock. Default: now. */
  readonly now?: Date;
}

export interface ScanDeps {
  /** The dialogue module's facts for a project (`dialogueFactsOf`), so the branch checks and speaker parity run. */
  readonly dialogueFacts?: (state: ProjectState) => DialogueFacts;
}

/** One open finding, placed in the file the folder holds. `file` and `line` are absent when the finding names no readable document. */
export interface PlacedFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly checkId: string;
  readonly message: string;
  /** Project-relative, POSIX-separated. */
  readonly file?: string;
  /** 1-based, in the file as stored. */
  readonly line?: number;
  readonly endLine?: number;
  /** The title of the document the finding is placed in. */
  readonly docTitle?: string;
}

export interface ScanResult {
  readonly project: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** `partial` when a check did not run, a document could not be counted or a file was not UTF-8 text: the scan is then not a full one. */
  readonly status: 'complete' | 'partial';
  /** The checks that ran. */
  readonly checks: readonly string[];
  /** The checks asked for that did not run. */
  readonly skipped: readonly DeterministicCheckId[];
  /** The documents the run read. */
  readonly documents: number;
  /** The run's own notes (coherence.md §6.2): what was skipped and why. */
  readonly notes: readonly string[];
  /** What loading the project and reading `coherence.json` had to say: a body held back, dismissals that could not be read. */
  readonly notices: readonly string[];
  /** The documents and codex files whose bytes are not UTF-8 text, project-relative. They open empty, so no check saw them. */
  readonly unread: readonly string[];
  /** Open findings only: a dismissed or fixed finding is not counted. */
  readonly counts: Readonly<Record<FindingSeverity, number>>;
  /** The open findings, most severe first. */
  readonly findings: readonly PlacedFinding[];
  readonly exitCode: ScanExitCode;
  /** Whether `coherence.json` was saved. */
  readonly written: boolean;
  /** The file after the run, which is what the exporter's report reads. */
  readonly file: CoherenceFile;
  readonly report: CoherenceReportInput;
}

/** A project-relative path that cannot leave the folder: no absolute path, drive, backslash, NUL, empty segment or `..`. */
export function isContainedPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  if (path.length > 1 && path.charCodeAt(1) === 58) return false;
  return !path.split('/').some((segment) => segment === '..' || segment === '');
}

/** The codex's detector, with the codex compiled again only when the entries change. */
function mentionDetector(): MentionDetector {
  let held: unknown;
  let compiled: ReturnType<typeof compileCodex> | undefined;
  return (body, entries, terms) => {
    if (compiled === undefined || held !== entries) {
      held = entries;
      compiled = compileCodex(entries);
    }
    return countMentions(body, compiled, terms);
  };
}

interface HeldFile {
  readonly path: string;
  readonly text: string;
  readonly bodyStart: number;
}

/**
 * The file a body is stored in, as the loader reads it: the node's own name, then the legacy `.md` (`bodyNamesOf`). Never a path
 * built from the id alone, and never one that leaves the folder.
 */
async function heldFileOf(fs: ArtifactFs, state: ProjectState, docId: string, cache: Map<string, HeldFile | null>): Promise<HeldFile | null> {
  const known = cache.get(docId);
  if (known !== undefined) return known;
  let held: HeldFile | null = null;
  const node = state.manifest.tree.find((candidate) => candidate.id === docId);
  for (const name of node === undefined ? [] : bodyNamesOf(node)) {
    const path = `${DOCS_DIR}/${name}`;
    if (!isContainedPath(path)) continue;
    try {
      if (!(await fs.exists(path))) continue;
      // As the loader decodes it (read.ts readUtf8): strict UTF-8, which drops a leading BOM, so the offsets agree with its text.
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readBytes(path));
      held = { path, text, bodyStart: bodyStartOf(text, path) };
      break;
    } catch {
      // A file that is not UTF-8 leaves the finding unplaced; it is still reported.
    }
  }
  cache.set(docId, held);
  return held;
}

async function placeAll(fs: ArtifactFs, state: ProjectState, open: readonly Finding[]): Promise<PlacedFinding[]> {
  const cache = new Map<string, HeldFile | null>();
  const placed: PlacedFinding[] = [];
  for (const finding of open) {
    const base = { id: finding.id, severity: finding.severity, checkId: finding.checkId, message: finding.message };
    const evidence = finding.evidence[0];
    const held = evidence === undefined ? null : await heldFileOf(fs, state, evidence.docId, cache);
    if (evidence === undefined || held === null) {
      placed.push(base);
      continue;
    }
    const docTitle = state.manifest.tree.find((node) => node.id === evidence.docId)?.title;
    placed.push({ ...base, file: held.path, ...placeFinding(evidence, held.text, held.bodyStart), ...(docTitle !== undefined ? { docTitle } : {}) });
  }
  return placed.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

export async function runScan(fs: ArtifactFs, options: ScanOptions = {}, deps: ScanDeps = {}): Promise<ScanResult> {
  const now = options.now ?? new Date();
  const requested = [...new Set(options.checks ?? DETERMINISTIC_CHECK_IDS)];

  const { state, notices: loaded, encodingIssues } = await readProject(fs, { now });
  const unread = encodingIssues.filter((issue) => issue.kind === 'document' || issue.kind === 'codex').map((issue) => issue.path);
  // Read-only: an unreadable file is neither kept under a corrupt name nor restored here, and the load says what it fell back to.
  const load = await loadCoherence(fs, { readOnly: true });
  const reconciled = reconcileCoherence(load.file, state);
  const dialogue = deps.dialogueFacts?.(state);

  const { file, run } = runDeterministic(state, reconciled.file, {
    scope: { mode: options.scope ?? 'full' },
    checks: requested,
    now,
    detector: mentionDetector(),
    ...(dialogue !== undefined ? { dialogue } : {}),
  });

  const open = file.findings.filter((finding) => finding.status === 'open');
  const counts = Object.fromEntries(
    FINDING_SEVERITIES.map((severity) => [severity, open.filter((finding) => finding.severity === severity).length]),
  ) as Record<FindingSeverity, number>;
  const findings = await placeAll(fs, state, open);

  const ran = new Set(run.checkIds);
  const skipped = requested.filter((id) => !ran.has(id));
  const date = now.toISOString().slice(0, 10);

  if (options.write === true) await saveCoherence(fs, load, file, { now });

  return {
    project: state.manifest.project.name,
    date,
    status: run.status === 'partial' || skipped.length > 0 || unread.length > 0 ? 'partial' : 'complete',
    checks: run.checkIds,
    skipped,
    documents: run.scope.docIds.length,
    notes: run.notes ?? [],
    // What the load would drop on a save (`droppedField`) is not a fact about this read-only run.
    notices: [...loaded.filter((notice) => notice.droppedField === undefined), ...load.notices, ...reconciled.notices].map((notice) => notice.message),
    unread,
    counts,
    findings,
    exitCode: exitCodeFor(counts, options.failOn ?? DEFAULT_FAIL_ON, unread.length),
    written: options.write === true,
    file,
    report: reportInputOf(state, file, date),
  };
}
