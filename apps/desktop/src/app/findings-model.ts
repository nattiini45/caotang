/**
 * The findings tab's and the scene-declaration editor's view models (coherence.md §6.3, §7.1, §8, §5.2). Pure functions over the
 * coherence file and the project, so what the panels say is testable without a page. No React here.
 */

import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, plural, t } from '@lingui/core/macro';
import {
  DISMISSAL_REASONS,
  TIMELINE_MODES,
  effectiveStoryPart,
  findingTypeLabel,
  locateQuote,
  type CoherenceFile,
  type CoherenceRun,
  type DeterministicCheckId,
  type Finding,
  type FindingSeverity,
  type FindingStatus,
  type SceneMeta,
  type ScopeSpec,
  type StoryPart,
} from '@caotang/coherence';
import { dateFormat, isolate, numberFormat, type MessageRef } from '@caotang/i18n';
import { captureTextAnchor } from '@caotang/storyboard';
import { getBody, getRevision, type CodexEntry, type ProjectState } from '@caotang/store';

import { formatterLocale } from '../i18n/format-locale.js';
import { projectCollator } from '../i18n/project-collator.js';
import { renderRef, titleValues } from '../i18n/render-ref.js';
import { childrenOf } from './binder-model.js';
import { containersOf } from './coherence-facts.js';
import { findingFixInstruction, findingFixIntent } from './model-prompts.js';

/** The severity sections, most severe first (coherence.md §5.3: the severity the check or the category gives). */
export const SEVERITY_SECTIONS: readonly { readonly severity: FindingSeverity; readonly label: string }[] = [
  { severity: 'error', get label() { return t`Errors`; } },
  { severity: 'warning', get label() { return t`Warnings`; } },
  { severity: 'info', get label() { return t`Notes`; } },
];

/* lingui-set comment="Counts are display values; title and model identify writer content and the selected model. Check labels form a standalone list after a colon." */

const CHECK_LABELS: Readonly<Record<DeterministicCheckId, MessageDescriptor>> = {
  'codex.alias-collisions': msg`Two codex entries share a name or alias`,
  'codex.never-mentioned': msg`A codex entry is never named in the manuscript`,
  'timeline.order-drift': msg`Scenes run out of chronological order`,
  'timeline.relation': msg`A scene is placed before a scene it must follow`,
  'timeline.window': msg`A scene falls outside its folder’s declared days`,
  'timeline.overlap': msg`Sibling scenes overlap in time`,
  'pov.coverage': msg`A declared point of view is never named in its scene`,
  'presence.expected': msg`A character expected in a scene is never named there`,
  'script.cue-collision': msg`A screenplay character cue matches no codex entry`,
  'script.cue-consistency': msg`One screenplay character is cued with two spellings`,
  'script.shot-coverage': msg`Storyboard shots miss dialogue, a duration or an anchor`,
  'branch.loose-end': msg`A dialogue branch runs out without an ending`,
  'branch.dead-end': msg`A dialogue knot can never be reached`,
  'dialogue.speaker-unknown': msg`A dialogue speaker matches no codex entry`,
  'timeline.gap': msg`A scene is days after the scene before it`,
  'plot.unresolved-thread': msg`A thread’s declared payoff is not in the manuscript`,
  'knowledge.leak': msg`A character knows something before they learn it`,
  'medium.speaker-parity': msg`The screenplay and its dialogue name different speakers`,
  'comic.balloon-density': msg`A balloon or panel carries more words than the lettering guidance`,
  'comic.em-dash': msg`A balloon uses an em dash instead of a double dash`,
  'comic.caps-policy': msg`A ß in a caps book will be lettered as SS`,
  'comic.balloon-coverage': msg`A script line has no balloon, or a balloon no longer matches its script line`,
};

const TYPE_LABELS: Readonly<Record<string, MessageDescriptor>> = {
  'alias-collision': msg`Shared name`,
  'never-mentioned': msg`Never named`,
  'order-drift': msg`Out of order`,
  'strand-order-drift': msg`Out of order in its strand`,
  'after-violated': msg`Placed before a scene it follows`,
  'outside-span': msg`Outside the folder’s days`,
  'sibling-overlap': msg`Overlapping scenes`,
  'time-gap': msg`A gap in time`,
  'knows-before-learns': msg`Knows before learning`,
  'never-learns': msg`Never learns it`,
  'pov-unresolved': msg`Unknown point of view`,
  'pov-not-named': msg`Point of view not named`,
  'expected-absent': msg`Expected character missing`,
  'cue-unmatched': msg`Cue matches no codex entry`,
  'cue-spelling': msg`Cue spelled two ways`,
  'duration-missing': msg`Shot without a duration`,
  uncovered: msg`Not covered by a shot`,
  'anchor-drift': msg`Shot anchor moved`,
  'loose-end': msg`Loose end`,
  unreachable: msg`Unreachable knot`,
  'unresolved-speaker': msg`Unknown speaker`,
  'ambiguous-speaker': msg`Speaker matches two entries`,
  'speaker-differs': msg`Speaker spelled differently`,
  'speaker-screenplay-only': msg`Only the screenplay has this speaker`,
  'speaker-dialogue-only': msg`Only the dialogue has this speaker`,
  unletteredLine: msg`Script line without a balloon`,
  staleAnchor: msg`Balloon’s script text changed`,
  brokenBalloon: msg`Balloon missing from its panel`,
  staleDocument: msg`Lettered from another script`,
};

const REASON_LABELS: Readonly<Record<(typeof DISMISSAL_REASONS)[number]['id'], MessageDescriptor>> = {
  flashback: msg`Flashback`,
  'in-world-lie': msg`In-world lie`,
  'unreliable-narrator': msg`Unreliable narrator`,
  intentional: msg`Intentional`,
  'false-positive': msg`False positive`,
};

/** The status filter the tab offers. `open` is the default: a dismissed or fixed finding is history until someone asks for it. */
export type FindingFilter = 'open' | 'dismissed' | 'fixed' | 'all';

export const FILTER_LABELS: Readonly<Record<FindingFilter, string>> = {
  get open() { return t`Open`; },
  get dismissed() { return t`Dismissed`; },
  get fixed() { return t`Marked fixed`; },
  get all() { return t`All`; },
};

/** One quoted passage of a finding, with the document it is in and the body-projection offsets the editor reveals. */
export interface QuoteView {
  readonly docId: string;
  readonly docTitle: string;
  readonly quote: string;
  readonly from: number;
  readonly to: number;
}

/**
 * The sentence a finding card shows (i18n.md §3.4, I7): a deterministic finding's reference in the
 * current interface language with its writer titles isolated once; a model-authored finding has no
 * reference, so the English it was stored with stays as written across a later locale switch.
 */
export function findingMessageText(finding: { readonly message: string; readonly messageRef?: MessageRef }): string {
  return finding.messageRef === undefined
    ? finding.message
    : renderRef(finding.messageRef, { userValues: titleValues(finding.messageRef) });
}

/** One finding as the card shows it. */
export interface FindingView {
  readonly id: string;
  readonly type: string;
  /** The type in the writer's words, which the card header shows (`findingTypeLabel`). */
  readonly typeLabel: string;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly message: string;
  /** I7: the deterministic check's reference, when the finding has one. A model-authored finding has none. */
  readonly messageRef?: MessageRef;
  readonly expected: string | undefined;
  readonly note: string | undefined;
  readonly dismissedReason: string | undefined;
  readonly quotes: readonly QuoteView[];
  readonly redetected: number;
  /** The fact the finding is about (coherence.md §4.2). Findings that share it are one group card. */
  readonly factGroup: string;
  /** The check that produced it, for the card's label and the report. */
  readonly checkId: string;
  /**
   * Whether "Fix with agent" can plan a fix for it: its primary passage (binder order, `primaryQuoteOf`) is in a scene the agent drafts. A dialogue passage is not
   * one (the draft writes beats, not a rewrite of a passage), so such a finding offers no Fix.
   */
  readonly fixable: boolean;
}

/**
 * The binder position of every node, manuscript first: the order the writer reads the binder in (codex-panels §1). Every node
 * is ranked, not only documents, so a dialogue container's quote ranks by where it sits in the binder like any scene's.
 */
export function binderOrderOf(state: ProjectState): ReadonlyMap<string, number> {
  const order = new Map<string, number>();
  const visit = (parentId: string): void => {
    for (const node of childrenOf(state, parentId)) {
      order.set(node.id, order.size);
      visit(node.id);
    }
  };
  visit('root');
  return order;
}

/**
 * The primary passage of a finding: the quote Fix with agent rewrites (coherence.md §6.3). It is the quote whose document comes first
 * in the binder, then the quote earlier in that document. Binder order is one the writer sees, so the choice does not depend on the
 * document ids, which are minted per project. A dialogue container ranks by its own binder position too, so a finding whose first
 * quote is in one offers no Fix. A quote in a node the binder no longer holds comes after every other quote.
 */
export function primaryQuoteOf<Quote extends { readonly docId: string; readonly from: number }>(
  order: ReadonlyMap<string, number>,
  quotes: readonly Quote[],
): Quote | undefined {
  const rank = (quote: Quote): number => order.get(quote.docId) ?? Number.MAX_SAFE_INTEGER;
  let best: Quote | undefined;
  for (const quote of quotes) {
    if (best === undefined || rank(quote) < rank(best) || (rank(quote) === rank(best) && quote.from < best.from)) best = quote;
  }
  return best;
}

/** Whether a node is a scene the agent drafts (`scene.draft`'s own target): a document, in prose or in Fountain. */
export function isDraftableScene(state: ProjectState, docId: string): boolean {
  return state.manifest.tree.find((node) => node.id === docId)?.type === 'document';
}

/**
 * The findings that share one fact (coherence.md §4.2, §8): one problem with citations, not one alarm per citation. The card's
 * heading is the first finding's message, and each finding keeps its own actions.
 */
export interface FindingGroupView {
  readonly factGroup: string;
  readonly severity: FindingSeverity;
  readonly heading: string;
  /** I7: the heading's reference when the first finding has one, so the group card can render it in the UI language. */
  readonly headingRef?: MessageRef;
  readonly findings: readonly FindingView[];
}

export interface SeveritySection {
  readonly severity: FindingSeverity;
  readonly label: string;
  readonly findings: readonly FindingView[];
  /** The same findings, grouped by fact in the order the file holds them. */
  readonly groups: readonly FindingGroupView[];
}

/** The title of a document, or a plain fallback when the document is gone (a dangling quote is shown, never hidden). */
export function docTitleOf(state: ProjectState, docId: string): string {
  return state.manifest.tree.find((node) => node.id === docId)?.title ?? t`a document that is no longer in the project`;
}

/**
 * Whether a quoted passage is still the text the scan found: the document's body holds the quote at its offsets. The offsets
 * are only as good as the text they were taken from, so a passage the writer has edited since the scan is not revealed, since
 * revealing it would select other text (coherence.md §8). The scan is the way to find it again.
 */
export function quoteIsCurrent(state: ProjectState, quote: Pick<QuoteView, 'docId' | 'quote' | 'from' | 'to'>): boolean {
  return getBody(state, quote.docId).slice(quote.from, quote.to) === quote.quote;
}

/** Open findings, which is the number the tab's badge shows. */
export function openFindingCount(file: CoherenceFile | undefined): number {
  return file === undefined ? 0 : file.findings.filter((finding) => finding.status === 'open').length;
}

/** The findings the filter keeps, grouped by severity in the order the sections give. Empty sections are dropped. */
export function severitySections(state: ProjectState, file: CoherenceFile | undefined, filter: FindingFilter): SeveritySection[] {
  const findings = file === undefined ? [] : file.findings.filter((finding) => filter === 'all' || finding.status === statusOf(filter));
  const order = binderOrderOf(state);
  const views = findings.map((finding) => viewOf(state, order, finding));
  return SEVERITY_SECTIONS.map((section) => {
    const own = views.filter((view) => view.severity === section.severity);
    return { severity: section.severity, label: section.label, findings: own, groups: groupsByFact(own, section.severity) };
  }).filter((section) => section.findings.length > 0);
}

/**
 * Groups one severity's findings by their fact. The group keeps the order of its first finding, so the inbox reads the file's
 * order rather than an order of its own. A finding with no message of its own takes its type as the heading, so no card is blank.
 */
export function groupsByFact(findings: readonly FindingView[], severity: FindingSeverity): FindingGroupView[] {
  const groups = new Map<string, FindingView[]>();
  for (const finding of findings) {
    const own = groups.get(finding.factGroup) ?? [];
    own.push(finding);
    groups.set(finding.factGroup, own);
  }
  return [...groups.entries()].map(([factGroup, members]) => ({
    factGroup,
    severity,
    heading: members[0]?.message || members[0]?.typeLabel || t`Finding`,
    headingRef: members[0]?.messageRef,
    findings: members,
  }));
}

function statusOf(filter: Exclude<FindingFilter, 'all'>): FindingStatus {
  return filter === 'fixed' ? 'fixed' : filter;
}

function viewOf(state: ProjectState, order: ReadonlyMap<string, number>, finding: Finding): FindingView {
  const primary = primaryQuoteOf(order, finding.evidence);
  const typeMessage = Object.hasOwn(TYPE_LABELS, finding.type) ? TYPE_LABELS[finding.type] : undefined;
  return {
    id: finding.id,
    type: finding.type,
    typeLabel: typeMessage === undefined ? findingTypeLabel(finding.type) : i18n._(typeMessage),
    severity: finding.severity,
    status: finding.status,
    message: finding.message,
    messageRef: finding.messageRef,
    expected: finding.expected,
    note: finding.note,
    dismissedReason: finding.dismissedReason,
    quotes: finding.evidence.map((evidence) => ({
      docId: evidence.docId,
      docTitle: docTitleOf(state, evidence.docId),
      quote: evidence.quote,
      from: evidence.from,
      to: evidence.to,
    })),
    redetected: finding.redetections?.length ?? 0,
    factGroup: finding.factGroup,
    checkId: finding.checkId,
    fixable: primary !== undefined && isDraftableScene(state, primary.docId),
  };
}

/* ------------------------------------------------------------------ *
 * Run history and scope (coherence.md §6.2, §8)
 * ------------------------------------------------------------------ */

/** One run of the history as its row shows it (coherence.md §8: kind, scope, date, findings upserted, tokens for model runs). */
export interface RunView {
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly status: string;
  readonly scopeLabel: string;
  readonly findingCount: number;
  readonly checkLabels: readonly string[];
  readonly notes: readonly string[];
  readonly tokenLine: string | undefined;
  /** The scope "Run again" scans, or `undefined` when the run does not say what it covered (a run kept before scopes were recorded). */
  readonly rerunScope: ScopeSpec | undefined;
}

/**
 * The scope a run covered, as a scan takes it again (coherence.md §8, "re-run same scope"). A full run is re-run as a full scan.
 * A run over one document is re-run as that document, whatever mode it recorded: the engine's `changed` scope selects the documents
 * whose revision is newer than their last review, and the run being re-run has just reviewed them, so `changed` would select nothing.
 * A `changed` run over several documents names no scope the engine can take again (its documents are a list, and the engine has no
 * such scope), so it is not offered again. A run that did not record its mode is re-run only when it read a single document.
 */
export function rerunScopeOf(run: CoherenceRun): ScopeSpec | undefined {
  if (run.scope.mode === 'full') return { mode: 'full' };
  return run.scope.docIds.length === 1 ? { mode: 'doc', docIds: [...run.scope.docIds] } : undefined;
}

/** Newest first: the history reads the way the writer looks for a recent run. */
export function runViewsOf(file: CoherenceFile | undefined, docTitle: (docId: string) => string, locale: string = formatterLocale()): RunView[] {
  if (file === undefined) return [];
  return [...file.runs].reverse().map((run) => runViewOf(run, docTitle, locale));
}

/** A run's time in words for the writer: a day and a clock time, in the formatter locale (i18n.md §4.1, D3). An unreadable stamp shows as it is. */
export function runTimeLabel(at: string, locale: string = formatterLocale()): string {
  const stamp = Date.parse(at);
  if (Number.isNaN(stamp)) return at;
  return dateFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(stamp));
}

function runViewOf(run: CoherenceRun, docTitle: (docId: string) => string, locale: string): RunView {
  const docs = run.scope.docIds;
  const documents = docs.length;
  const scopeLabel =
    docs.length === 0
      ? t`no documents`
      : docs.length === 1
        ? `"${isolate(docTitle(docs[0] ?? ''))}"`
        : plural(documents, { one: '# document', other: '# documents' });
  const checkLabels = run.checkIds.map(checkLabelForRun);
  const count = numberFormat(locale);
  const prompt = run.tokens === undefined ? '' : count.format(run.tokens.promptTokens);
  const completion = run.tokens === undefined ? '' : count.format(run.tokens.completionTokens);
  return {
    id: run.id,
    at: runTimeLabel(run.at, locale),
    kind: run.kind === 'deterministic' ? t`Quick scan` : t`Model review`,
    status: run.status === 'complete' ? t`complete` : run.status === 'partial' ? t`partial` : t`discarded`,
    scopeLabel,
    findingCount: run.findingsUpserted.length,
    checkLabels,
    notes: run.notes ?? [],
    rerunScope: run.kind === 'deterministic' ? rerunScopeOf(run) : undefined,
    tokenLine:
      run.tokens === undefined
        ? undefined
        : run.model === undefined
          ? t`${{ prompt }} tokens in, ${{ completion }} out`
          : t`${{ prompt }} tokens in, ${{ completion }} out (${{ model: isolate(run.model) }})`,
  };
}

/** A run's check id in words: a deterministic check by its label, a model category as "Model: <category>". */
export function checkLabelForRun(id: string): string {
  if (id.startsWith('llm:')) {
    const category = id.slice('llm:'.length);
    switch (category) {
      case 'timeline-plot': return t`Model: timeline plot`;
      case 'characterization': return t`Model: characterization`;
      case 'world-building': return t`Model: world building`;
      case 'factual': return t`Model: factual`;
      case 'narrative-style': return t`Model: narrative style`;
      default: return t`Model: ${{ category: isolate(category.replace(/-/g, ' ')) }}`;
    }
  }
  return Object.hasOwn(CHECK_LABELS, id) ? checkLabelOf(id as DeterministicCheckId) : id;
}

/** The scopes the Findings tab offers (coherence.md §6.2): this document, what changed since the last pass, the whole manuscript. */
export const SCOPE_CHOICES: readonly { readonly id: 'doc' | 'changed' | 'full'; readonly label: string }[] = [
  { id: 'doc', get label() { return t`This document`; } },
  { id: 'changed', get label() { return t`Changed since the last scan`; } },
  { id: 'full', get label() { return t`Whole manuscript`; } },
];

/**
 * The scope a choice names. "This document" needs a document in view; without one the choice names nothing, and the tab says so
 * rather than scanning a guess.
 */
export function scopeFor(choice: 'doc' | 'changed' | 'full', currentDocId: string | undefined): ScopeSpec | undefined {
  if (choice === 'doc') return currentDocId === undefined ? undefined : { mode: 'doc', docIds: [currentDocId] };
  if (choice === 'changed') return { mode: 'changed' };
  return { mode: 'full' };
}

/**
 * What the Findings tab's quick scan covers, in the writer's words: the checks that are on in Settings, and what the model
 * review is for. The tab shows it beside the scan, so a writer knows what a clean scan does and does not mean. The checks
 * come from Settings for this tab only; an agent's scan does not read them yet (see the harness's coherence tools).
 */
export function scanCoverageLine(enabled: readonly DeterministicCheckId[]): string {
  if (enabled.length === 0) {
    return t`Every quick check is off in Settings, so this tab’s scan runs nothing. Turn checks on in Settings.`;
  }
  const checks = enabled.map(checkLabelOf).join('; ');
  return t`The Findings tab’s quick scan checks for: ${{ checks }}. It does not read the story for plot or character problems; the model review does that.`;
}

/** The plain-words name of one check, for the Settings section. */
export function checkLabelOf(id: DeterministicCheckId): string {
  return i18n._(CHECK_LABELS[id]);
}

/** One reason on the dismissal picker: its label, its tooltip where the spec gives one, and whether it cross-links to the mode picker. */
export interface ReasonView {
  readonly id: string;
  readonly label: string;
  readonly tooltip: string | undefined;
  readonly crossLink: string | undefined;
}

/** A dismissal reason in the picker's words, as a card shows it. A reason the picker does not hold is shown as written. */
export function dismissalLabelOf(reason: string): string {
  const known = DISMISSAL_REASONS.find((candidate) => candidate.id === reason);
  return known === undefined ? reason : i18n._(REASON_LABELS[known.id]);
}

/**
 * The open finding after `findingId` in the order the tab shows them (severity, then group, then the card's place in it), or the one
 * before it when it is the last. Undefined when no other finding is open. Focus goes there after a dismissal, so the keyboard stays
 * on the findings.
 */
export function nextOpenFindingId(sections: readonly SeveritySection[], findingId: string): string | undefined {
  const open = sections
    .flatMap((section) => section.groups.flatMap((group) => group.findings))
    .filter((finding) => finding.status === 'open')
    .map((finding) => finding.id);
  const at = open.indexOf(findingId);
  if (at < 0) return open[0];
  return open[at + 1] ?? open[at - 1];
}

/** The dismissal picker's reasons, in the order §6.3 lists them. Technique reasons carry the cross-link line. */
export function dismissalReasons(): ReasonView[] {
  return DISMISSAL_REASONS.map((reason) => ({
    id: reason.id,
    label: dismissalLabelOf(reason.id),
    tooltip: reason.id === 'in-world-lie' ? t`In-story deception between characters.` : reason.id === 'unreliable-narrator' ? t`Narration-level deception.` : undefined,
    crossLink: reason.modeCrossLink ? t`Declare this as a scene mode instead.` : undefined,
  }));
}

/** The note limit a dismissal or a fix may carry, in code points (coherence.md §7). */
export const NOTE_LIMIT = 500;

/**
 * The scene declarations of one document, read from the coherence file as the Inspector shows them. A document with none
 * reads as empty, not as absent, so the editor can always show its fields.
 */
export function sceneMetaOf(file: CoherenceFile | undefined, docId: string): SceneMeta {
  return file?.sceneMeta[docId] ?? {};
}

/**
 * The dialogue containers a scene may be compared with (coherence.md §5.1 `medium.speaker-parity`): the ones a scan reads, which are
 * live and under the manuscript. A link to any other container is `missing`, so the Inspector can say so and offer to clear it.
 */
export function dialogueContainerChoices(
  state: ProjectState,
  linked: string | undefined,
): { readonly containers: readonly { id: string; title: string }[]; readonly missing: boolean } {
  const containers = containersOf(state).map((node) => ({ id: node.id, title: node.title }));
  return { containers, missing: linked !== undefined && !containers.some((container) => container.id === linked) };
}

/** The document ids a scene may name as `after`: every document except the scene itself. */
export function afterCandidates(state: ProjectState, docId: string): { id: string; title: string }[] {
  return state.manifest.tree
    .filter((node) => node.type === 'document' && node.id !== docId)
    .map((node) => ({ id: node.id, title: node.title }));
}

/**
 * The codex entries a POV may name: characters first, since that is what a point of view is, then the rest by name. Names are
 * writer content, so they sort by the **project language** (i18n.md §4.3, D9): a Swedish novel sorts å after z under any
 * interface. A project that names no language yet falls back to the formatter locale.
 */
export function povCandidates(entries: readonly CodexEntry[], projectLanguage?: string): CodexEntry[] {
  const byName = projectCollator(projectLanguage);
  return [...entries].sort((a, b) => {
    const rank = (entry: CodexEntry): number => (entry.type === 'character' ? 0 : 1);
    return rank(a) - rank(b) || byName.compare(a.name, b.name);
  });
}

/** The timeline modes the Inspector offers, by name. */
export const MODE_OPTIONS: readonly string[] = TIMELINE_MODES;

/** A readable name for a timeline mode, for the picker. */
export function modeLabel(mode: string | undefined): string {
  switch (mode) {
    case undefined:
    case 'linear': return t`Linear (the default)`;
    case 'flashback': return t`Flashback`;
    case 'flash-forward': return t`Flash forward`;
    case 'parallel': return t`Parallel`;
    case 'frame': return t`Frame`;
    case 'dream': return t`Dream`;
    case 'mythic': return t`Mythic`;
    case 'backstory': return t`Backstory`;
    case 'simultaneous': return t`Simultaneous`;
    case 'circular': return t`Circular`;
    case 'time-skip': return t`Time skip`;
    default: return mode.replace(/-/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
  }
}

/** The three story parts a node can declare, in the order the Story part select lists them (coherence.md §5.2.2). */
export function storyPartLabel(part: StoryPart): string {
  switch (part) {
    case 'prologue': return t`Prologue`;
    case 'epilogue': return t`Epilogue`;
    default: return t`Main story`;
  }
}

/**
 * The part a node would be in with no declaration of its own: its folders' nearest declaration, else the main story. The
 * Inspector names it beside "Inherit" so a writer sees what clearing the declaration returns to.
 */
export function inheritedStoryPartOf(state: ProjectState, file: CoherenceFile | undefined, nodeId: string): StoryPart {
  const own = file?.sceneMeta[nodeId];
  const rest = own === undefined || own.storyPart === undefined ? (file?.sceneMeta ?? {}) : { ...file?.sceneMeta, [nodeId]: { ...own, storyPart: undefined } };
  return effectiveStoryPart(state.manifest.tree, rest, nodeId);
}

/** The writer's reading of a day number: a true minus sign, grouped for the formatter locale, as in "Day −14" (coherence.md §8). */
export function dayLabel(day: number): string {
  const magnitude = numberFormat(formatterLocale()).format(Math.abs(day));
  const value = day < 0 ? `−${magnitude}` : magnitude;
  return t`Day ${{ day: isolate(value) }}`;
}

/** The turn a "Fix with agent" starts: its intent for the panel, and the plan the harness checks and cards (agent-harness §2). */
export interface FixPlan {
  readonly intent: string;
  readonly plan: { readonly steps: readonly { readonly tool: string; readonly params: Record<string, unknown>; readonly expect: string }[] };
}

/**
 * The pre-filled plan of "Fix with agent" (coherence.md §6.3): one `scene.draft` in `rewrite_selection` mode over the passage the
 * finding's primary passage (`primaryQuoteOf`: binder order), with its anchor captured fresh from the text as it stands now. The quote is located again first, because the
 * stored offsets may be stale, and a passage that is no longer where the finding says is refused rather than guessed at. The
 * card is the normal confirm flow: nothing is written here.
 */
export function fixPlanFor(state: ProjectState, file: CoherenceFile | undefined, findingId: string): FixPlan | string {
  const finding = file?.findings.find((candidate) => candidate.id === findingId);
  if (finding === undefined) return t`That finding is no longer in the findings file, so there is nothing to fix. Open the Findings tab again.`;
  const evidence = primaryQuoteOf(binderOrderOf(state), finding.evidence);
  if (evidence === undefined) return t`This finding quotes no passage, so there is no text to fix. Fix it in the codex or the scene notes.`;
  // The same predicate the Fix button is gated on (`fixable`), so a fix that reaches this function without the button is refused too.
  if (!isDraftableScene(state, evidence.docId)) {
    return state.manifest.tree.find((node) => node.id === evidence.docId)?.type === 'dialogue'
      ? t`Fix with agent drafts prose and screenplay scenes, not dialogue. Edit this passage in the dialogue’s Ink text.`
      : t`Fix with agent drafts prose and screenplay scenes. Edit this passage by hand.`;
  }
  const body = getBody(state, evidence.docId);
  const located = locateQuote(body, evidence.quote, evidence.from, evidence.to);
  if (located === undefined) {
    return t`The passage this finding quotes has changed, so it is not where the finding says. Run the scan again to find it.`;
  }
  const anchor = captureTextAnchor(body, located.from, located.to, getRevision(state, evidence.docId));
  if (anchor === undefined) return t`The passage is too long to rewrite in one step. Select the part to change in the editor, then ask the agent for it.`;
  const title = state.manifest.tree.find((node) => node.id === evidence.docId)?.title ?? evidence.docId;
  return {
    intent: findingFixIntent(title),
    plan: {
      steps: [
        {
          tool: 'scene.draft',
          params: {
            doc: evidence.docId,
            mode: 'rewrite_selection',
            selection: { ...anchor },
            instruction: findingFixInstruction(finding.message),
          },
          expect: t`the passage no longer conflicts with the rest of the story`,
        },
      ],
    },
  };
}
