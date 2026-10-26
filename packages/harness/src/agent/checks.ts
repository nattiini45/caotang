/**
 * Acceptance checks for a goal run (agent-harness §7.2): what "done" means, as pure functions of the project.
 *
 * Every kind is deterministic: the same project gives the same result, nothing is written, and no model is asked. `coherence.clean`
 * runs the coherence module's deterministic checks on a copy of the held file and discards the copy, so no run is recorded per
 * evaluation and the writer's `changed` scope and run history stay as they were. Words are counted by the counter the inspector and
 * the goals use (`derived.wordCounts`, else `countBody`), so a goal run and the panel agree.
 *
 * `distance` is how far a check is from passing (open findings, documents out of range, unfilled synopses): lower is better, and a run
 * that stops lowering it has stalled.
 */

import {
  BRANCH_CHECK_IDS,
  DETERMINISTIC_CHECK_IDS,
  SCAN_DOC_GUARD,
  resolveScope,
  runDeterministic,
  snapshotManuscript,
  type DeterministicCheckId,
  type DialogueFacts,
  type FindingSeverity,
  type ScopeSpec,
} from '@caotang/coherence';
import { withheldState } from '@caotang/context';
import { countBody, getRevision, type ProjectState, type TreeNode } from '@caotang/store';

import { descendantsOf } from '../resolve.js';
import { countIn, excludedBy, heldFile } from '../tools/coherence.js';

// The scan's own exclusion (archived or withheld), so a goal's coherence.clean check and the agent's scan leave out the same documents.
export { excludedBy };
import { wordsOfDocument } from '../tools/common.js';
import { canonicalJson } from '../util.js';

export type CheckSpec =
  /** No open finding at or above `minSeverity` from the named checks (default: all of them) in the scope. A dismissed finding is clean. */
  | { readonly kind: 'coherence.clean'; readonly scope: ScopeSpec; readonly checks?: readonly DeterministicCheckId[]; readonly minSeverity?: FindingSeverity }
  /** Every document in the scope has a word count in `[min, max]`; either end may be left open. */
  | { readonly kind: 'words.between'; readonly scope: ScopeSpec; readonly min?: number; readonly max?: number }
  /** Every document in the scope has this status (a vocabulary id). */
  | { readonly kind: 'status.all'; readonly scope: ScopeSpec; readonly status: string }
  /** Every document in the scope has a synopsis, of at most `maxWords` words when given. */
  | { readonly kind: 'synopsis.filled'; readonly scope: ScopeSpec; readonly maxWords?: number };

export type CheckKind = CheckSpec['kind'];

/** One document (or codex-level finding) that keeps a check from passing. `weight` orders them, worst first. */
export interface CheckFailure {
  readonly docId?: string;
  readonly title: string;
  readonly detail: string;
  readonly weight: number;
}

export interface CheckResult {
  readonly spec: CheckSpec;
  /** The spec as canonical JSON: the identity a run compares results by. */
  readonly key: string;
  readonly label: string;
  readonly pass: boolean;
  /** Lower is better: open findings, documents out of range, unfilled synopses. Zero exactly when the check passes. */
  readonly distance: number;
  readonly failures: readonly CheckFailure[];
  /**
   * Checks left out of this evaluation: those the writer turned off in Settings › Coherence, and those the scan itself dropped (the dialogue
   * branch checks and speaker parity need a full scan with the app's dialogue facts; never-mentioned needs every count), which did not look at the project.
   */
  readonly skipped: readonly DeterministicCheckId[];
  /**
   * Set when no work can make this check pass because of a setting or its scope, not the manuscript: every check it names is turned off in
   * Settings › Coherence, or is one the scan runs only on a full scan (the dialogue branch checks, speaker parity) over a scope that is not full.
   */
  readonly unmeetable?: true;
  readonly notes: readonly string[];
}

export interface CheckOptions {
  /** The stamp of the discarded coherence run. */
  readonly now: Date;
  /** The deterministic checks the writer has turned on (Settings › Coherence), as `CoherenceSource.checks` gives them. Absent: all. */
  readonly enabled?: readonly DeterministicCheckId[];
  /** The dialogue module's findings, as `CoherenceSource.dialogue` gives them. */
  readonly dialogue?: (state: ProjectState) => DialogueFacts | undefined;
  /**
   * The nodes a read rule keeps from the agent (agent-harness §4). They are not measured, scanned or named: they are left out like
   * archived documents, so no failure carries their title, id or text, and the dialogue facts are read from the project as the agent
   * may read it. Absent, nothing is withheld.
   */
  readonly withheld?: ReadonlySet<string>;
}

const SPEAKER_PARITY = 'medium.speaker-parity';

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { error: 3, warning: 2, info: 1 };

/** The words a writer reads a scope in. */
function scopeWords(scope: ScopeSpec | undefined): string {
  if (scope?.mode === 'full') return 'the whole manuscript';
  if (scope?.mode === 'changed') return 'the documents changed since the last review';
  if (scope?.mode === 'doc' && Array.isArray(scope.docIds)) return scope.docIds.length === 1 ? 'one named document' : `${scope.docIds.length} named documents`;
  return 'a scope it cannot name';
}

/** Defensive: a spec arrives from a model or a saved file, so a malformed one still gets a label (an unmet result must be buildable for it). */
export function checkLabel(spec: CheckSpec): string {
  const where = scopeWords((spec as Partial<CheckSpec> | null | undefined)?.scope);
  switch (spec?.kind) {
    case 'coherence.clean':
      return `no open continuity findings in ${where}`;
    case 'words.between':
      return spec.min !== undefined && spec.max !== undefined
        ? `${spec.min} to ${spec.max} words per document in ${where}`
        : spec.min !== undefined
          ? `at least ${spec.min} words per document in ${where}`
          : `at most ${spec.max} words per document in ${where}`;
    case 'status.all':
      return `every document in ${where} has status "${spec.status}"`;
    case 'synopsis.filled':
      return `every document in ${where} has a synopsis${spec.maxWords === undefined ? '' : ` of at most ${spec.maxWords} words`}`;
    default:
      return 'a check it cannot name';
  }
}

/** The identity of a spec, for comparing results across evaluations. */
export const checkKey = (spec: CheckSpec): string => canonicalJson(spec);

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Why a spec cannot be evaluated, or undefined when it can. Checked before a goal starts and again by `evaluateCheck`. */
export function checkSpecProblem(spec: CheckSpec): string | undefined {
  if (typeof spec !== 'object' || spec === null) return 'it is not a check';
  const scope = spec.scope as ScopeSpec | undefined;
  if (scope === undefined || (scope.mode !== 'full' && scope.mode !== 'changed' && scope.mode !== 'doc')) return 'it names no scope';
  if (scope.mode === 'doc' && (!Array.isArray(scope.docIds) || scope.docIds.length === 0)) return 'its document scope names no document';
  if (spec.kind === 'coherence.clean') {
    if (scope.mode === 'doc' && scope.docIds.length !== 1) return 'a coherence scope over documents names exactly one document';
    if (spec.checks !== undefined && spec.checks.length === 0) return 'it names no checks';
    if (spec.checks !== undefined && spec.checks.some((id) => !(DETERMINISTIC_CHECK_IDS as readonly string[]).includes(id))) return 'it names a check that does not exist';
    if (spec.minSeverity !== undefined && SEVERITY_RANK[spec.minSeverity] === undefined) return 'its minimum severity is not error, warning or info';
    return undefined;
  }
  if (spec.kind === 'words.between') {
    if (spec.min === undefined && spec.max === undefined) return 'it gives neither a minimum nor a maximum';
    if ((spec.min !== undefined && !isCount(spec.min)) || (spec.max !== undefined && !isCount(spec.max))) return 'its limits are not whole numbers of words';
    if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) return 'its minimum is above its maximum';
    return undefined;
  }
  if (spec.kind === 'status.all') return typeof spec.status === 'string' && spec.status.trim() !== '' ? undefined : 'it names no status';
  if (spec.kind === 'synopsis.filled') return spec.maxWords === undefined || (isCount(spec.maxWords) && spec.maxWords > 0) ? undefined : 'its word limit is not a positive whole number';
  return 'its kind is not one of coherence.clean, words.between, status.all and synopsis.filled';
}

const unmet = (spec: CheckSpec, detail: string, skipped: readonly DeterministicCheckId[] = [], unmeetable = false): CheckResult => ({
  spec,
  key: checkKey(spec),
  label: checkLabel(spec),
  pass: false,
  distance: 1,
  failures: [{ title: 'This check', detail, weight: 1 }],
  skipped,
  ...(unmeetable ? { unmeetable: true as const } : {}),
  notes: [],
});

/** The binder's order of every node, depth first, so a result lists documents as the writer sees them. */
function binderOrder(state: ProjectState): ReadonlyMap<string, number> {
  const order = new Map<string, number>();
  for (const node of descendantsOf(state, 'root')) order.set(node.id, order.size);
  return order;
}

/**
 * The live documents a scope reads, in binder order (words, status and synopsis checks read these; coherence.clean uses only the count).
 * Also returned: the references that name nothing a goal can read (`missing`), the titles of named archived documents (`archived`), and
 * how many distinct documents of the scope a read rule withholds from the agent (`withheld`, a count, never a title or id).
 */
export function documentsInScope(
  state: ProjectState,
  scope: ScopeSpec,
  withheld?: ReadonlySet<string>,
): { readonly nodes: readonly TreeNode[]; readonly missing: readonly string[]; readonly archived: readonly string[]; readonly withheld: number } {
  const file = heldFile(state);
  const hidden = withheld ?? new Set<string>();
  const dropped = new Set<string>();
  const byId = new Map(state.manifest.tree.map((node) => [node.id, node]));
  const order = binderOrder(state);
  const live = (node: TreeNode): boolean => node.type === 'document' && node.status !== 'archived';
  let ids: string[];
  const missing: string[] = [];
  const archived: string[] = [];
  if (scope.mode === 'doc') {
    const picked = new Set<string>();
    for (const ref of scope.docIds) {
      const node = byId.get(ref);
      // A withheld reference is neither read nor reported as unknown (a failure naming it would name it): it is only counted, once per
      // document, so a folder stands for the documents under it and a document named twice is one.
      if (hidden.has(ref)) {
        if (node?.type === 'folder') for (const below of descendantsOf(state, node.id)) if (live(below)) dropped.add(below.id);
        if (node !== undefined && live(node)) dropped.add(node.id);
      } else if (node === undefined || (node.type !== 'document' && node.type !== 'folder')) missing.push(ref);
      else if (live(node)) picked.add(node.id);
      else if (node.type === 'document') archived.push(node.title);
      else for (const below of descendantsOf(state, node.id)) if (live(below)) picked.add(below.id);
    }
    // A document reached through a folder may be withheld too: it is the same document as one named directly.
    for (const id of picked) if (hidden.has(id)) dropped.add(id);
    ids = [...picked];
  } else {
    const excluded = excludedBy(hidden);
    const snapshot = snapshotManuscript(state, file, excluded === undefined ? {} : { isExcluded: excluded });
    ids = [...snapshot.scanned.map((scene) => scene.docId), ...snapshot.emptyDocIds];
    const inScope = (id: string): boolean => scope.mode !== 'changed' || file.reviewState[id]?.lastReviewedRevision !== getRevision(state, id);
    ids = ids.filter(inScope);
    // Only a withheld document the scope would have read: not an archived one, and under `changed` not one reviewed at its current revision.
    for (const id of snapshot.excludedDocIds) if (hidden.has(id) && byId.get(id)?.status !== 'archived' && inScope(id)) dropped.add(id);
  }
  const nodes = ids
    .map((id) => byId.get(id))
    .filter((node): node is TreeNode => node !== undefined && !hidden.has(node.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  // Counted, never named: how many documents of the scope a rule keeps from the agent.
  return { nodes, missing, archived, withheld: dropped.size };
}

/** How many documents a coherence scope reads: what the large-scope guard counts. Zero for a scope that names nothing it can read. */
export function coherenceScopeSize(state: ProjectState, scope: ScopeSpec, withheld?: ReadonlySet<string>): number {
  const file = heldFile(state);
  const excluded = excludedBy(withheld);
  try {
    return resolveScope(snapshotManuscript(state, file, excluded === undefined ? {} : { isExcluded: excluded }), file, scope).length;
  } catch {
    return 0;
  }
}

/** The note a result carries when a rule left documents out: their number, never a title or an id. */
const withheldNote = (count: number): readonly string[] =>
  count === 0 ? [] : [`${count} ${count === 1 ? 'document is' : 'documents are'} withheld from the agent by a rule and not checked.`];

function perDocument(
  spec: CheckSpec,
  state: ProjectState,
  withheld: ReadonlySet<string> | undefined,
  judge: (node: TreeNode) => { readonly detail: string; readonly weight: number } | undefined,
): CheckResult {
  const { nodes, missing, archived, withheld: held } = documentsInScope(state, spec.scope, withheld);
  const failures: CheckFailure[] = missing.map((ref) => ({ title: ref, detail: 'is not a document or folder in this project', weight: 1 }));
  for (const node of nodes) {
    const verdict = judge(node);
    if (verdict !== undefined) failures.push({ docId: node.id, title: node.title, ...verdict });
  }
  // A scope that holds nothing the agent may read measures nothing, so the check is not met (the writer or the agent can restore a
  // document). It names no title or id: a withheld document must not leak through it. The `changed` scope is empty when nothing has changed.
  if (spec.scope.mode !== 'changed' && nodes.length === 0 && missing.length === 0) {
    failures.push({ title: 'This check', detail: 'its scope holds no document the agent may read', weight: 1 });
  }
  return {
    spec,
    key: checkKey(spec),
    label: checkLabel(spec),
    pass: failures.length === 0,
    distance: failures.length,
    failures,
    skipped: [],
    notes: [
      ...(nodes.length === 0 && missing.length === 0 ? ['no documents in scope'] : []),
      ...archived.map((title) => `"${title}" is archived, so a goal does not read it.`),
      ...withheldNote(held),
    ],
  };
}

function coherenceClean(spec: Extract<CheckSpec, { kind: 'coherence.clean' }>, state: ProjectState, options: CheckOptions): CheckResult {
  const requested = [...new Set(spec.checks ?? DETERMINISTIC_CHECK_IDS)];
  const enabled = options.enabled;
  const checks = enabled === undefined ? requested : requested.filter((id) => enabled.includes(id));
  const skipped = requested.filter((id) => !checks.includes(id));
  if (checks.length === 0) return unmet(spec, 'every check it would run is turned off in Settings › Coherence, so nothing was checked', skipped, true);
  // As the scan port reads the project (tools/coherence.ts): the dialogue facts from the project as the agent may read it, and the
  // withheld documents excluded like archived ones, so no finding quotes them.
  const hidden = options.withheld;
  const dialogue = options.dialogue?.(hidden === undefined ? state : withheldState(state, hidden));
  const excluded = excludedBy(hidden);
  let outcome: ReturnType<typeof runDeterministic>;
  try {
    // The copy is discarded: nothing joins the held file, and the review state of the documents stays as the writer left it.
    outcome = runDeterministic(state, heldFile(state), {
      scope: spec.scope,
      checks,
      now: options.now,
      detector: countIn,
      ...(dialogue === undefined ? {} : { dialogue }),
      ...(excluded === undefined ? {} : { isExcluded: excluded }),
    });
  } catch (error) {
    return unmet(spec, error instanceof Error ? error.message : 'the scope could not be read', skipped);
  }
  const { file, run } = outcome;
  const floor = SEVERITY_RANK[spec.minSeverity ?? 'info'];
  const ran = new Set<string>(run.checkIds);
  // A check the scan dropped (the dialogue branch checks and speaker parity read a full scan with the app's dialogue facts; never-mentioned needs every count)
  // did not look at the project. When none of them ran, "no open finding" is no fact about it, so the check is not met (agent-harness §7.2).
  const notRun = checks.filter((id) => !ran.has(id));
  if (notRun.length === checks.length) {
    const why = (run.notes ?? []).filter((note) => /not run|unavailable|no documents/.test(note));
    // The dialogue branch checks and speaker parity read a full scan with the app's dialogue facts: over any other scope no turn can make them run.
    // Never-mentioned is dropped for want of a count, which a write can change, so it stays meetable.
    const isBranch = (id: DeterministicCheckId): boolean => (BRANCH_CHECK_IDS as readonly string[]).includes(id);
    const structural =
      notRun.every((id) => isBranch(id) || id === SPEAKER_PARITY) &&
      (spec.scope.mode !== 'full' || notRun.every((id) => (id === SPEAKER_PARITY ? dialogue?.speakersByContainer === undefined : dialogue === undefined)));
    return unmet(
      spec,
      `nothing was checked: ${notRun.join(', ')} did not run${why.length === 0 ? '' : ` (${why.join('; ')})`}${structural && spec.scope.mode !== 'full' ? '; they run on a full scan' : ''}`,
      [...skipped, ...notRun],
      structural,
    );
  }
  const scope = new Set(run.scope.docIds);
  const titles = new Map(state.manifest.tree.map((node) => [node.id, node.title]));
  // A finding of a check that ran, quoting the scope or quoting nothing (a codex-level one), and still open: dismissed and fixed are clean.
  const failures: CheckFailure[] = file.findings
    .filter(
      (finding) =>
        finding.status === 'open' &&
        ran.has(finding.checkId) &&
        SEVERITY_RANK[finding.severity] >= floor &&
        (finding.evidence.length === 0 || finding.evidence.some((passage) => scope.has(passage.docId))),
    )
    .map((finding): CheckFailure => {
      // A held finding from before a rule withheld a document it quotes still counts, but says nothing of it: no title, id or text.
      if (hidden !== undefined && finding.evidence.some((passage) => hidden.has(passage.docId))) {
        return { title: 'A withheld part of the project', detail: 'a finding that involves a part of the project a rule withholds from the agent', weight: SEVERITY_RANK[finding.severity] };
      }
      const docId = finding.evidence[0]?.docId;
      return {
        ...(docId === undefined ? {} : { docId }),
        title: docId === undefined ? 'Codex' : (titles.get(docId) ?? docId),
        detail: finding.message,
        weight: SEVERITY_RANK[finding.severity],
      };
    });
  return {
    spec,
    key: checkKey(spec),
    label: checkLabel(spec),
    pass: failures.length === 0,
    distance: failures.length,
    failures,
    skipped: [...skipped, ...notRun],
    notes: [...(run.notes ?? []), ...withheldNote(hidden === undefined ? 0 : documentsInScope(state, spec.scope, hidden).withheld)],
  };
}

/** Evaluates one check over the project. Pure for every kind: the same project gives the same result, and nothing is written. */
export function evaluateCheck(spec: CheckSpec, state: ProjectState, options: CheckOptions): CheckResult {
  const problem = checkSpecProblem(spec);
  if (problem !== undefined) return unmet(spec, `this check cannot run: ${problem}`);
  switch (spec.kind) {
    case 'coherence.clean':
      return coherenceClean(spec, state, options);
    case 'words.between':
      return perDocument(spec, state, options.withheld, (node) => {
        const words = wordsOfDocument(state, node.id);
        if (spec.min !== undefined && words < spec.min) return { detail: `has ${words} words, ${spec.min - words} short of ${spec.min}`, weight: spec.min - words };
        if (spec.max !== undefined && words > spec.max) return { detail: `has ${words} words, ${words - spec.max} over ${spec.max}`, weight: words - spec.max };
        return undefined;
      });
    case 'status.all':
      return perDocument(spec, state, options.withheld, (node) =>
        node.status === spec.status ? undefined : { detail: node.status === null ? `has no status, not "${spec.status}"` : `has status "${node.status}", not "${spec.status}"`, weight: 1 },
      );
    case 'synopsis.filled':
      return perDocument(spec, state, options.withheld, (node) => {
        if (node.synopsis.trim() === '') return { detail: 'has no synopsis', weight: 1 };
        const words = countBody(node.synopsis).words;
        return spec.maxWords !== undefined && words > spec.maxWords ? { detail: `has a synopsis of ${words} words, over ${spec.maxWords}`, weight: words - spec.maxWords } : undefined;
      });
  }
}

export function evaluateChecks(specs: readonly CheckSpec[], state: ProjectState, options: CheckOptions): readonly CheckResult[] {
  return specs.map((spec) => evaluateCheck(spec, state, options));
}

/** The large-scope guard a goal satisfies once, at its start: the coherence scopes over `SCAN_DOC_GUARD` documents. */
export function largeScopes(
  specs: readonly CheckSpec[],
  state: ProjectState,
  withheld?: ReadonlySet<string>,
): readonly { readonly spec: CheckSpec; readonly documents: number }[] {
  return specs.flatMap((spec) => {
    if (spec.kind !== 'coherence.clean') return [];
    const documents = coherenceScopeSize(state, spec.scope, withheld);
    return documents > SCAN_DOC_GUARD ? [{ spec, documents }] : [];
  });
}
