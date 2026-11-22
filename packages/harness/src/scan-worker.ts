import { entryWithheld } from '@caotang/context';
import { loadComicBook } from '@caotang/comic';
import { scanCompute, type CoherenceCheckFile, type KnowledgeFact, type ReviewStateEntry, type SceneMeta, type ScanComputeOutcome, type ScopeSpec } from '@caotang/coherence';
import { loadInkCompiler } from '@caotang/dialogue';
import { emptyAgentFiles, type CodexEntry, type DocumentRecord, type ProjectState, type TreeNode } from '@caotang/store';

import { containersOf, countIn, dialogueFactsOf } from './coherence-facts.js';

export interface ScanWorkerInput {
  readonly state: ProjectState;
  readonly file: CoherenceCheckFile;
  readonly params: Readonly<Record<string, unknown>>;
  readonly approvedLargeScope?: boolean;
  readonly excludedDocIds?: readonly string[];
}

const MANUSCRIPT_ROOT = 'manuscript';

function kindOf(node: TreeNode): string | undefined {
  const kind = (node as { readonly kind?: unknown }).kind;
  return typeof kind === 'string' && kind !== '' ? kind : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectAnchor(anchor: unknown): Record<string, unknown> | undefined {
  if (!isRecord(anchor)) return undefined;
  return {
    ...(anchor['from'] === undefined ? {} : { from: anchor['from'] }),
    ...(anchor['to'] === undefined ? {} : { to: anchor['to'] }),
    ...(anchor['exact'] === undefined ? {} : { exact: anchor['exact'] }),
    ...(anchor['prefix'] === undefined ? {} : { prefix: anchor['prefix'] }),
    ...(anchor['suffix'] === undefined ? {} : { suffix: anchor['suffix'] }),
    ...(anchor['capturedRevision'] === undefined ? {} : { capturedRevision: anchor['capturedRevision'] }),
  };
}

function projectCoverage(entries: unknown, hidden: ReadonlySet<string>): unknown[] {
  if (!Array.isArray(entries)) return [];
  const kept: unknown[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const docId = entry['docId'];
    if (typeof docId === 'string' && hidden.has(docId)) continue;
    const anchor = projectAnchor(entry['anchor']);
    kept.push({
      ...(entry['kind'] === undefined ? {} : { kind: entry['kind'] }),
      ...(docId === undefined ? {} : { docId }),
      ...(anchor === undefined ? {} : { anchor }),
      ...(entry['balloonId'] === undefined ? {} : { balloonId: entry['balloonId'] }),
    });
  }
  return kept;
}

function projectShot(shot: NonNullable<TreeNode['shot']>, hidden: ReadonlySet<string>): NonNullable<TreeNode['shot']> {
  if (!isRecord(shot)) return {};
  const raw = shot as Record<string, unknown>;
  return {
    ...(raw['durationSec'] === undefined ? {} : { durationSec: raw['durationSec'] }),
    ...(Array.isArray(raw['dialogue']) ? { dialogue: projectCoverage(raw['dialogue'], hidden) } : {}),
  } as NonNullable<TreeNode['shot']>;
}

function projectComic(comic: NonNullable<TreeNode['comic']>): NonNullable<TreeNode['comic']> {
  if (!isRecord(comic)) return {};
  const raw = comic as Record<string, unknown>;
  return {
    ...(raw['readingDirection'] === undefined ? {} : { readingDirection: raw['readingDirection'] }),
    ...(raw['letteringFace'] === undefined ? {} : { letteringFace: raw['letteringFace'] }),
    ...(raw['capsTransform'] === undefined ? {} : { capsTransform: raw['capsTransform'] }),
    ...(raw['esszett'] === undefined ? {} : { esszett: raw['esszett'] }),
    ...(raw['pageSize'] === undefined ? {} : { pageSize: raw['pageSize'] }),
    ...(raw['scriptDocId'] === undefined ? {} : { scriptDocId: raw['scriptDocId'] }),
  } as NonNullable<TreeNode['comic']>;
}

function projectBalloons(balloons: readonly unknown[]): unknown[] {
  return balloons.map((balloon) => {
    if (!isRecord(balloon)) return balloon;
    return {
      ...(balloon['id'] === undefined ? {} : { id: balloon['id'] }),
      ...(balloon['text'] === undefined ? {} : { text: balloon['text'] }),
    };
  });
}

function projectPanels(panels: readonly unknown[], hidden: ReadonlySet<string>): unknown[] {
  return panels.map((panel) => {
    if (!isRecord(panel)) return panel;
    return {
      ...(panel['id'] === undefined ? {} : { id: panel['id'] }),
      ...(Array.isArray(panel['balloons']) ? { balloons: projectBalloons(panel['balloons']) } : {}),
      ...(panel['script'] === undefined ? {} : { script: projectCoverage(panel['script'], hidden) }),
    };
  });
}

function projectComicPage(comicPage: NonNullable<TreeNode['comicPage']>, hidden: ReadonlySet<string>): NonNullable<TreeNode['comicPage']> {
  if (!isRecord(comicPage)) return {};
  const raw = comicPage as Record<string, unknown>;
  return {
    ...(raw['size'] === undefined ? {} : { size: raw['size'] }),
    ...(raw['layout'] === undefined ? {} : { layout: raw['layout'] }),
    ...(Array.isArray(raw['panels']) ? { panels: projectPanels(raw['panels'], hidden) } : {}),
  } as NonNullable<TreeNode['comicPage']>;
}

function projectScanNode(node: TreeNode, hidden: ReadonlySet<string>): TreeNode {
  return {
    id: node.id,
    parentId: node.parentId,
    type: node.type,
    title: node.title,
    order: node.order,
    status: node.status,
    label: null,
    keywords: [],
    synopsis: '',
    notes: '',
    ...(node.kind === undefined ? {} : { kind: node.kind }),
    ...(node.shot === undefined ? {} : { shot: projectShot(node.shot, hidden) }),
    ...(node.comic === undefined ? {} : { comic: projectComic(node.comic) }),
    ...(node.comicPage === undefined ? {} : { comicPage: projectComicPage(node.comicPage, hidden) }),
  };
}

function projectScanEntry(entry: CodexEntry): CodexEntry {
  return {
    id: entry.id,
    name: entry.name,
    aliases: [...entry.aliases],
    type: entry.type,
    includePolicy: entry.includePolicy,
    caseSensitive: entry.caseSensitive,
    exclude: [...entry.exclude],
    attachments: [...entry.attachments],
    description: '',
    keywords: [],
    origin: 'manual',
    sources: [],
  };
}

function projectSceneMeta(meta: SceneMeta): SceneMeta {
  return {
    ...(meta.pov === undefined ? {} : { pov: meta.pov }),
    ...(meta.dayOffset === undefined ? {} : { dayOffset: meta.dayOffset }),
    ...(meta.durationDays === undefined ? {} : { durationDays: meta.durationDays }),
    ...(meta.after === undefined ? {} : { after: [...meta.after] }),
    ...(meta.expectedPresent === undefined ? {} : { expectedPresent: [...meta.expectedPresent] }),
    ...(meta.timelineMode === undefined ? {} : { timelineMode: meta.timelineMode }),
    ...(meta.threads === undefined ? {} : { threads: meta.threads.map((thread) => ({ id: thread.id, payoff: thread.payoff })) }),
    ...(meta.learns === undefined ? {} : { learns: meta.learns.map((link) => ({ entryId: link.entryId, factId: link.factId })) }),
    ...(meta.knows === undefined ? {} : { knows: meta.knows.map((link) => ({ entryId: link.entryId, factId: link.factId })) }),
    ...(meta.dialogueContainer === undefined ? {} : { dialogueContainer: meta.dialogueContainer }),
    ...(meta.storyPart === undefined ? {} : { storyPart: meta.storyPart }),
    ...(meta.mainStory === undefined ? {} : { mainStory: meta.mainStory }),
  };
}

function projectKnowledge(fact: KnowledgeFact): KnowledgeFact {
  return {
    id: fact.id,
    text: fact.text,
    ...(fact.ruleId === undefined ? {} : { ruleId: fact.ruleId }),
    ...(fact.entryId === undefined ? {} : { entryId: fact.entryId }),
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  };
}

function projectReviewState(entry: ReviewStateEntry): ReviewStateEntry {
  return { lastReviewedRevision: entry.lastReviewedRevision, lastReviewedAt: entry.lastReviewedAt };
}

function inManuscript(byId: ReadonlyMap<string, TreeNode>, node: TreeNode): boolean {
  let current: TreeNode | undefined = node;
  for (let hops = 0; current !== undefined && hops < 1000; hops += 1) {
    if (current.id === MANUSCRIPT_ROOT) return true;
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return false;
}

function scanBodyIds(state: ProjectState, hidden: ReadonlySet<string>, scope: ScopeSpec | undefined): Set<string> {
  const byId = new Map(state.manifest.tree.map((node) => [node.id, node] as const));
  const named = scope?.mode === 'doc' ? new Set(scope.docIds) : new Set<string>();
  const scriptIds = new Set<string>();
  for (const node of state.manifest.tree) {
    if (hidden.has(node.id) || kindOf(node) !== 'comic') continue;
    const scriptDocId = loadComicBook(node.comic).value.scriptDocId;
    if (scriptDocId === undefined) continue;
    const linked = byId.get(scriptDocId);
    if (linked !== undefined && linked.type === 'document' && kindOf(linked) === 'comic-script' && !hidden.has(linked.id)) scriptIds.add(linked.id);
  }
  const ids = new Set<string>();
  for (const node of state.manifest.tree) {
    if (hidden.has(node.id)) continue;
    if (node.type === 'dialogue') {
      if ((scope === undefined || scope.mode === 'full') && node.status !== 'archived' && inManuscript(byId, node)) ids.add(node.id);
      continue;
    }
    if (node.type !== 'document') continue;
    if (scriptIds.has(node.id)) { ids.add(node.id); continue; }
    if (node.status === 'archived') continue;
    if (inManuscript(byId, node) || named.has(node.id)) ids.add(node.id);
  }
  return ids;
}

function projectScanState(state: ProjectState, hidden: ReadonlySet<string>, scope: ScopeSpec | undefined): ProjectState {
  const tree = state.manifest.tree.filter((node) => !hidden.has(node.id)).map((node) => projectScanNode(node, hidden));
  const bodyIds = scanBodyIds(state, hidden, scope);
  const documents = new Map<string, DocumentRecord>();
  for (const id of bodyIds) {
    const record = state.documents.get(id);
    if (record !== undefined) documents.set(id, { id: record.id, body: record.body, revision: record.revision });
  }
  const identity = state.manifest.project;
  return {
    manifest: {
      app: state.manifest.app,
      formatVersion: state.manifest.formatVersion,
      project: { id: identity.id, name: identity.name, createdAt: identity.createdAt, modifiedAt: identity.modifiedAt, ...(identity.language === undefined ? {} : { language: identity.language }) },
      vocabulary: { statuses: [], labels: [] },
      tree,
      derived: { wordCounts: {}, computedAt: state.manifest.derived.computedAt },
      codex: (state.manifest.codex ?? []).filter((entry) => !entryWithheld(entry, hidden)).map(projectScanEntry),
    },
    documents,
    revisionFloors: new Map(),
    declinedCodexFiles: new Set(),
    declinedDocFiles: new Set(),
    declinedText: new Map(),
    skills: new Map(),
    removedSkillFiles: new Set(),
    agentFiles: emptyAgentFiles(),
    removedAgentFiles: new Set(),
  };
}

function excludedDocIdsOf(state: ProjectState, hidden: ReadonlySet<string>, scope: ScopeSpec | undefined): string[] {
  const byId = new Map(state.manifest.tree.map((node) => [node.id, node] as const));
  const ids = new Set<string>();
  for (const node of state.manifest.tree) {
    if (node.type === 'document' && hidden.has(node.id) && inManuscript(byId, node)) ids.add(node.id);
  }
  if (scope?.mode === 'doc') for (const id of scope.docIds) if (hidden.has(id)) ids.add(id);
  return [...ids];
}

export function projectScanInput(
  state: ProjectState,
  file: CoherenceCheckFile,
  withheld: ReadonlySet<string> | undefined,
  scope?: ScopeSpec,
): { readonly state: ProjectState; readonly file: CoherenceCheckFile; readonly excludedDocIds?: readonly string[] } {
  const hidden = withheld ?? new Set<string>();
  const visible = new Set(state.manifest.tree.filter((node) => !hidden.has(node.id)).map((node) => node.id));
  const sceneMeta: Record<string, SceneMeta> = {};
  for (const [id, meta] of Object.entries(file.sceneMeta)) if (visible.has(id)) sceneMeta[id] = projectSceneMeta(meta);
  const reviewState: Record<string, ReviewStateEntry> = {};
  for (const [id, entry] of Object.entries(file.reviewState)) if (visible.has(id)) reviewState[id] = projectReviewState(entry);
  const excludedDocIds = excludedDocIdsOf(state, hidden, scope);
  return {
    state: projectScanState(state, hidden, scope),
    file: { sceneMeta, reviewState, knowledge: file.knowledge.map(projectKnowledge) },
    ...(excludedDocIds.length === 0 ? {} : { excludedDocIds }),
  };
}

export async function computeScanWorker(input: ScanWorkerInput): Promise<ScanComputeOutcome> {
  const scopeMode = (input.params['scope'] as { readonly mode?: string } | undefined)?.mode ?? 'full';
  if (scopeMode === 'full' && containersOf(input.state).length > 0) await loadInkCompiler();
  const dialogue = scopeMode === 'full' ? dialogueFactsOf(input.state) : undefined;
  return scanCompute(input.params, {
    state: input.state,
    file: input.file,
    ...(input.approvedLargeScope === undefined ? {} : { approvedLargeScope: input.approvedLargeScope }),
    detector: countIn,
    ...(dialogue === undefined ? {} : { dialogue }),
    ...(input.excludedDocIds === undefined ? {} : { excludedDocIds: input.excludedDocIds }),
  });
}
