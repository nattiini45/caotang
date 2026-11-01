/**
 * The shared import preview's model (import-preview.md, issue #267): what every structured import shows before anything is written,
 * the writer's corrections to it, and the one `binder.importTree` command it commits. Pure: no React, no DOM, no store writes.
 *
 * **Readers plug in through a source.** The dialog never parses. A source (`ImportPreviewSource`) has already read its file (in a
 * `'self'` Worker where the format needs one) and answers one question again and again: given these rule chips and these manual
 * splits, what is the proposed tree? The splitter of #266 is one such source's answer; the Twee import is another. So the dialog's
 * rule chips, options and fields are the source's own, and the dialog draws them, keeps the writer's edits, and commits.
 *
 * **Rules first, manual edits second** (import-preview.md §3). A chip change re-runs `source.plan`; the manual splits ride along as
 * overrides by block index, and the binder edits (rename, exclude, reorder) are applied after, by node id. The dialog asks before it
 * drops them.
 */

import type { ImportTreeCodexEntry, ImportTreeNode, ImportTreeParams } from '@caotang/bus';
import type { importScanSentence, scanImport } from '@caotang/harness';
import type { keepsImportedBody } from '@caotang/store';

import { formatCount } from '../i18n/locale.js';

/**
 * The package functions the model calls, handed in rather than imported (helpers.ts builds the one set the app uses). The dialog and
 * this model load in a lazy chunk; importing `@caotang/harness` or `@caotang/store` here made the bundler split the package roots out
 * of the entry into a shared chunk of their own. The entry already holds both, so the host passes them down.
 */
export interface PreviewHelpers {
  readonly scanImport: typeof scanImport;
  readonly importScanSentence: typeof importScanSentence;
  readonly keepsImportedBody: typeof keepsImportedBody;
}

// ---------------------------------------------------------------------------------------------------------------------------
// What a source hands the dialog
// ---------------------------------------------------------------------------------------------------------------------------

/** A node of the proposed tree. Folders have children; documents have a body. Ids are stable for one input (`chapter-12`). */
export interface PreviewNode {
  readonly id: string;
  readonly role: 'part' | 'chapter' | 'scene' | 'text' | 'front' | 'back' | 'container';
  readonly title: string;
  /** The first block of the node in the text pane, and the last (inclusive). */
  readonly startBlock: number;
  readonly endBlock: number;
  readonly words: number;
  readonly children?: readonly PreviewNode[];
  /** Caotang-dialect Markdown. Images are `![alt](import:…)`, the refs of `pictures()`. */
  readonly body?: string;
  readonly notes?: string;
  readonly synopsis?: string;
  readonly keywords?: readonly string[];
  /** Front and back matter only: where it goes. `skip` keeps it out (and the report says so). */
  readonly place?: 'manuscript' | 'research' | 'skip';
  /** The source's own fields (front-matter keys, CSV columns), mapped by the writer in the Fields section. */
  readonly fields?: Readonly<Record<string, string | readonly string[]>>;
}

/** Why a split is where it is, shown on its ✂ marker ("Heading 1", "scene break \"* * *\"", "Page break + \"CHAPTER TWO\""). */
export interface PreviewMarker {
  readonly blockIndex: number;
  readonly kind: 'part' | 'chapter' | 'scene' | 'back-matter';
  readonly reason: string;
}

/** One unit of the text pane: a paragraph, a heading, a break, a picture. */
export interface PreviewBlock {
  readonly kind: 'heading' | 'para' | 'break' | 'image' | 'pagebreak' | 'other';
  readonly text: string;
}

export interface PreviewLoss {
  readonly message: string;
  readonly count?: number;
  readonly blockIndex?: number;
}

/** A sanity flag ("Chapter 2 is 26,000 words with no scene breaks"), with a one-click fix when one is obvious. */
export interface PreviewFlag {
  readonly message: string;
  readonly nodeId?: string;
  readonly fix?: { readonly label: string; readonly overrides: Partial<PreviewOverrides> };
}

export interface PreviewCounts {
  readonly words: number;
  readonly parts: number;
  readonly chapters: number;
  readonly scenes: number;
  readonly images: number;
  readonly comments: number;
  readonly footnotes: number;
}

export interface PreviewPlan {
  readonly blocks: readonly PreviewBlock[];
  readonly markers: readonly PreviewMarker[];
  readonly tree: readonly PreviewNode[];
  readonly counts: PreviewCounts;
  readonly losses: readonly PreviewLoss[];
  readonly flags: readonly PreviewFlag[];
}

/** Manual splits by block index, applied by the source after its rules (#266's `SplitOverrides`). */
export interface PreviewOverrides {
  readonly noSplit: readonly number[];
  readonly sceneAt: readonly number[];
  readonly chapterAt: readonly number[];
}

/** A rule chip: "Chapters at [Heading 1 (24) ▾]". */
export interface PreviewChip {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/** A reader option: "Accept tracked changes", "Comments → scene notes (12)", "Import images (3, 2.1 MB)". */
export interface PreviewOption {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly detail?: string;
  /** A network step (decision 10): always off until the writer turns it on, and the label names the host, the count and the size. */
  readonly network?: { readonly host: string; readonly count: number; readonly bytes: number };
}

/** A source field the writer maps: a front-matter key, a CSV column. */
export interface PreviewField {
  readonly key: string;
  readonly count: number;
  readonly samples: readonly string[];
  /** The source's guess; `ignore` when it has none. */
  readonly suggested?: FieldTarget;
}

export type FieldTarget = 'synopsis' | 'keywords' | 'status' | 'label' | 'notes' | 'ignore';
export const FIELD_TARGETS: readonly FieldTarget[] = ['synopsis', 'keywords', 'status', 'label', 'notes', 'ignore'];

/** A codex row the source found (a Characters folder, a cast list, a CSV row). */
export interface PreviewCodexRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  /** The passage that names it, in the imported text: the first document (or this node) that holds the quote. */
  readonly cite?: { readonly nodeId?: string; readonly quote: string };
  /** The row's full text as a Research page, when the source has one. */
  readonly page?: { readonly title: string; readonly body: string };
}

export interface PreviewPicture {
  readonly ref: string;
  readonly name: string;
  readonly bytes: number;
  readonly alt?: string;
  readonly data: () => Uint8Array;
}

export interface PreviewSettings {
  readonly chips: Readonly<Record<string, string>>;
  readonly options: Readonly<Record<string, boolean>>;
}

/** A list the source adds to the report (the Twee import's "What the import does", "Warnings"). */
export interface PreviewReportList {
  readonly heading: string;
  readonly label: string;
  readonly lines: readonly string[];
}

/** What the commit hands a source that writes on its own (the Twee import's `dialogue.importInk`). */
export interface CustomCommit {
  /** `message` is the status line's; absent when the source reports for itself. */
  (plan: PreviewPlan): Promise<{ readonly ok: true; readonly message?: string } | { readonly ok: false; readonly message: string }>;
}

/** Text a reader kept out of the blocks that the injection scan still reads (RTF hidden text, link targets), with what it is. */
export interface ScanExtra {
  /** Where the text is, as the report names it ("hidden text"). */
  readonly label: string;
  readonly text: string;
}

export interface ImportPreviewSource {
  readonly fileName: string;
  /** The dialog's title: "Import “The Lighthouse Keeper.docx”". */
  readonly title: string;
  /** One sentence above the header, when the source has something to say first. */
  readonly intro?: string;
  /** Reads the file. Called once, before anything else, with a progress line and a cancel. */
  load?(progress: (text: string) => void, signal: AbortSignal): Promise<void>;
  chips(): readonly PreviewChip[];
  options(): readonly PreviewOption[];
  plan(settings: PreviewSettings, overrides: PreviewOverrides): PreviewPlan;
  fields?(): readonly PreviewField[];
  codexRows?(): readonly PreviewCodexRow[];
  pictures?(): readonly PreviewPicture[];
  /** Text outside the tree that the injection scan reads too (issue #54); its hits are listed by `label`. */
  scanExtra?(): readonly ScanExtra[];
  /** Title, author and language from the file's metadata. */
  metadata?(): { readonly title?: string; readonly author?: string; readonly language?: string };
  report?(plan: PreviewPlan): readonly PreviewReportList[];
  importLabel?(plan: PreviewPlan): string;
  /** Writes the import itself, as one undo step. Absent: the dialog commits through `binder.importTree`. */
  readonly commit?: CustomCommit;
  /** The id of the option that brings the pictures in; the pictures are left out when it is off. */
  readonly picturesOption?: string;
  /**
   * The tree is the source's to make and the writer only reads it (the Twee import's one container): no split, merge, rename,
   * reorder or exclude controls are shown.
   */
  readonly readOnly?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The writer's edits
// ---------------------------------------------------------------------------------------------------------------------------

export interface PreviewEdits {
  readonly overrides: PreviewOverrides;
  /** New titles, by node id. */
  readonly titles: Readonly<Record<string, string>>;
  /** Left out of the import, by node id (and everything under it). */
  readonly excluded: readonly string[];
  /** A sibling order the writer chose, by parent id (`''` for the top level). */
  readonly order: Readonly<Record<string, readonly string[]>>;
}

export const NO_OVERRIDES: PreviewOverrides = { noSplit: [], sceneAt: [], chapterAt: [] };
export const NO_EDITS: PreviewEdits = { overrides: NO_OVERRIDES, titles: {}, excluded: [], order: {} };

/** How many manual edits the writer made: what a rule change asks before it drops. */
export function editCount(edits: PreviewEdits): number {
  const { noSplit, sceneAt, chapterAt } = edits.overrides;
  return noSplit.length + sceneAt.length + chapterAt.length + Object.keys(edits.titles).length + edits.excluded.length + Object.keys(edits.order).length;
}

function without(list: readonly number[], value: number): number[] {
  return list.filter((item) => item !== value);
}

/** `×` on a ✂ marker: the split at this block goes (a manual split is taken back; a rule's split is overridden). */
export function removeSplit(edits: PreviewEdits, blockIndex: number): PreviewEdits {
  const o = edits.overrides;
  if (o.sceneAt.includes(blockIndex) || o.chapterAt.includes(blockIndex)) {
    return { ...edits, overrides: { ...o, sceneAt: without(o.sceneAt, blockIndex), chapterAt: without(o.chapterAt, blockIndex) } };
  }
  return { ...edits, overrides: { ...o, noSplit: [...without(o.noSplit, blockIndex), blockIndex].sort((a, b) => a - b) } };
}

/** "+ split here" (a scene) or "+ chapter here", before this block. */
export function addSplit(edits: PreviewEdits, blockIndex: number, kind: 'scene' | 'chapter'): PreviewEdits {
  const o = edits.overrides;
  const noSplit = without(o.noSplit, blockIndex);
  const sceneAt = without(o.sceneAt, blockIndex);
  const chapterAt = without(o.chapterAt, blockIndex);
  if (kind === 'scene') sceneAt.push(blockIndex);
  else chapterAt.push(blockIndex);
  return { ...edits, overrides: { noSplit, sceneAt: sceneAt.sort((a, b) => a - b), chapterAt: chapterAt.sort((a, b) => a - b) } };
}

/** Merge a chapter (or part) with the next one: the next one's split goes. */
export function mergeWithNext(edits: PreviewEdits, tree: readonly PreviewNode[], nodeId: string): PreviewEdits {
  const siblings = siblingsOf(tree, nodeId);
  if (siblings === undefined) return edits;
  const at = siblings.findIndex((node) => node.id === nodeId);
  const next = siblings[at + 1];
  if (next === undefined) return edits;
  return removeSplit(edits, next.startBlock);
}

export function rename(edits: PreviewEdits, nodeId: string, title: string): PreviewEdits {
  const trimmed = title.trim();
  if (trimmed === '') return edits;
  return { ...edits, titles: { ...edits.titles, [nodeId]: trimmed } };
}

export function toggleExcluded(edits: PreviewEdits, nodeId: string): PreviewEdits {
  const excluded = edits.excluded.includes(nodeId) ? edits.excluded.filter((id) => id !== nodeId) : [...edits.excluded, nodeId];
  return { ...edits, excluded };
}

/** Move a node one place up or down among its siblings. */
export function move(edits: PreviewEdits, tree: readonly PreviewNode[], nodeId: string, by: -1 | 1): PreviewEdits {
  const shown = applyEdits(tree, edits);
  const parentId = parentOf(shown, nodeId) ?? '';
  const siblings = (parentId === '' ? shown : findNode(shown, parentId)?.children ?? []).map((node) => node.id);
  const at = siblings.indexOf(nodeId);
  const to = at + by;
  if (at < 0 || to < 0 || to >= siblings.length) return edits;
  const next = [...siblings];
  next.splice(at, 1);
  next.splice(to, 0, nodeId);
  return { ...edits, order: { ...edits.order, [parentId]: next } };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------------------------------------------------------

export function findNode(tree: readonly PreviewNode[], id: string): PreviewNode | undefined {
  for (const node of tree) {
    if (node.id === id) return node;
    const found = findNode(node.children ?? [], id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function siblingsOf(tree: readonly PreviewNode[], id: string): readonly PreviewNode[] | undefined {
  if (tree.some((node) => node.id === id)) return tree;
  for (const node of tree) {
    const found = siblingsOf(node.children ?? [], id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parentOf(tree: readonly PreviewNode[], id: string, parent: string | null = null): string | null | undefined {
  for (const node of tree) {
    if (node.id === id) return parent;
    const found = parentOf(node.children ?? [], id, node.id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The tree as the writer sees it: the renames applied and the chosen order kept. Excluded nodes stay (shown unticked). */
export function applyEdits(tree: readonly PreviewNode[], edits: PreviewEdits, parentId = ''): PreviewNode[] {
  const order = edits.order[parentId];
  const nodes = tree.map((node) => {
    const title = edits.titles[node.id] ?? node.title;
    const children = node.children === undefined ? undefined : applyEdits(node.children, edits, node.id);
    return { ...node, title, ...(children === undefined ? {} : { children }) };
  });
  if (order === undefined) return nodes;
  const rank = new Map(order.map((id, index) => [id, index] as const));
  return [...nodes].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export function isExcluded(edits: PreviewEdits, tree: readonly PreviewNode[], nodeId: string): boolean {
  let at: string | null | undefined = nodeId;
  while (at !== null && at !== undefined) {
    if (edits.excluded.includes(at)) return true;
    at = parentOf(tree, at);
  }
  return false;
}

/** One visible row of the binder pane, with what the tree role needs (`aria-level`, `aria-setsize`, `aria-posinset`). */
export interface TreeRow {
  readonly node: PreviewNode;
  readonly level: number;
  readonly setSize: number;
  readonly position: number;
  readonly hasChildren: boolean;
}

export function visibleRows(tree: readonly PreviewNode[], collapsed: ReadonlySet<string>, level = 1): TreeRow[] {
  const rows: TreeRow[] = [];
  tree.forEach((node, index) => {
    const children = node.children ?? [];
    rows.push({ node, level, setSize: tree.length, position: index + 1, hasChildren: children.length > 0 });
    if (children.length > 0 && !collapsed.has(node.id)) rows.push(...visibleRows(children, collapsed, level + 1));
  });
  return rows;
}

/** The deepest node that holds a block: the row the binder selects when the writer clicks in the text. */
export function nodeAtBlock(tree: readonly PreviewNode[], blockIndex: number): PreviewNode | undefined {
  for (const node of tree) {
    if (blockIndex < node.startBlock || blockIndex > node.endBlock) continue;
    return nodeAtBlock(node.children ?? [], blockIndex) ?? node;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The virtualised text pane
// ---------------------------------------------------------------------------------------------------------------------------

/** A block's estimated height before it is measured: a line per 90 characters, at the pane's line height, plus its margin. */
export function estimateHeight(block: PreviewBlock, lineHeight = 22, charsPerLine = 90): number {
  const lines = Math.max(1, Math.ceil(block.text.length / charsPerLine));
  return lines * lineHeight + (block.kind === 'heading' ? 16 : 10);
}

/** Prefix sums of the heights: `offsets[i]` is the top of block i, `offsets[n]` the whole height. */
export function offsetsOf(heights: readonly number[]): Float64Array {
  const offsets = new Float64Array(heights.length + 1);
  for (let i = 0; i < heights.length; i += 1) offsets[i + 1] = (offsets[i] as number) + (heights[i] as number);
  return offsets;
}

/** The blocks to render for a scroll position: the ones in view and `overscan` blocks either side. Binary search, so 200k words stay cheap. */
export function visibleRange(offsets: Float64Array, scrollTop: number, viewport: number, overscan = 8): { start: number; end: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const find = (y: number): number => {
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((offsets[mid] as number) <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const first = find(Math.max(0, scrollTop));
  const last = find(scrollTop + Math.max(viewport, 1));
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan + 1) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The header, the report and the scan
// ---------------------------------------------------------------------------------------------------------------------------

function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** "84,212 words · 24 chapters · 71 scenes · 3 images · 12 comments · 9 footnotes · 4 codex rows": what was detected, zeros left out. */
export function headerLine(counts: PreviewCounts, codexRows: number): string {
  const parts = [plural(counts.words, 'word')];
  if (counts.parts > 0) parts.push(plural(counts.parts, 'part'));
  parts.push(plural(counts.chapters, 'chapter'), plural(counts.scenes, 'scene'));
  if (counts.images > 0) parts.push(plural(counts.images, 'image'));
  if (counts.comments > 0) parts.push(plural(counts.comments, 'comment'));
  if (counts.footnotes > 0) parts.push(plural(counts.footnotes, 'footnote'));
  if (codexRows > 0) parts.push(plural(codexRows, 'codex row'));
  return parts.join(' · ');
}

/** A network option's label (decision 10): the host, the count and the size, so the writer knows what leaves the machine. */
export function networkLabel(option: PreviewOption): string {
  if (option.network === undefined) return option.label;
  const { host, count, bytes } = option.network;
  const size = bytes >= 1_000_000 ? `${formatCount(Math.round(bytes / 100_000) / 10)} MB` : `${formatCount(Math.max(1, Math.round(bytes / 1000)))} kB`;
  return `${option.label} (downloads ${plural(count, 'file')}, about ${size}, from ${host})`;
}

/** The settings a source starts from. A network option starts off whatever the source says (decision 10). */
export function initialSettings(chips: readonly PreviewChip[], options: readonly PreviewOption[]): PreviewSettings {
  return {
    chips: Object.fromEntries(chips.map((chip) => [chip.id, chip.value])),
    options: Object.fromEntries(options.map((option) => [option.id, option.network === undefined ? option.checked : false])),
  };
}

/** One passage that reads like instructions to an AI, with where it is: the node's title. */
export interface InjectionRow {
  readonly nodeId: string;
  readonly where: string;
  readonly excerpt: string;
  readonly kind: string;
}

/**
 * The injection scan over every document of the tree and its notes (issue #54), located by node, and over the text the reader kept
 * outside the tree (`extra`), located by its label with no node. Nothing is changed by it.
 */
export function scanTree(tree: readonly PreviewNode[], helpers: PreviewHelpers, extra: readonly ScanExtra[] = []): { readonly total: number; readonly rows: readonly InjectionRow[]; readonly sentence: (name: string) => string | undefined } {
  const parts: { where: string; text: string }[] = [];
  const titles = new Map<string, string>();
  const walk = (nodes: readonly PreviewNode[]): void => {
    for (const node of nodes) {
      titles.set(node.id, node.title);
      if (node.body !== undefined) parts.push({ where: node.id, text: node.body });
      if (node.notes !== undefined && node.notes !== '') parts.push({ where: node.id, text: node.notes });
      walk(node.children ?? []);
    }
  };
  walk(tree);
  const labels = new Map<string, string>();
  extra.forEach((part, index) => {
    const where = `extra:${index}`;
    labels.set(where, part.label);
    parts.push({ where, text: part.text });
  });
  const found = helpers.scanImport(parts);
  return {
    total: found.total,
    rows: found.hits.map((hit) => {
      const label = labels.get(hit.where);
      if (label !== undefined) return { nodeId: '', where: label, excerpt: hit.excerpt, kind: hit.kind };
      return { nodeId: hit.where, where: titles.get(hit.where) ?? hit.where, excerpt: hit.excerpt, kind: hit.kind };
    }),
    // The status line's sentence after the import, the one every import says (ScriptImport.tsx).
    sentence: (name) => helpers.importScanSentence(name, found),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Mapping: fields, vocabulary values and codex rows
// ---------------------------------------------------------------------------------------------------------------------------

export type ValueAnswer = { readonly action: 'add' } | { readonly action: 'map'; readonly termId: string } | { readonly action: 'ignore' };

export interface VocabularyTermLike {
  readonly id: string;
  readonly name: string;
}

/** A status or label value the project does not hold, by id or name (case-insensitively). */
export function unknownValues(values: readonly string[], terms: readonly VocabularyTermLike[]): string[] {
  const held = new Set(terms.flatMap((term) => [term.id.toLowerCase(), term.name.trim().toLowerCase()]));
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== '' && !held.has(value.toLowerCase())))];
}

export type CodexAnswer =
  | { readonly action: 'import' }
  | { readonly action: 'skip' }
  | { readonly action: 'rename'; readonly name: string }
  | { readonly action: 'page' };

/** The codex row's name collides with an entry or alias the codex holds, or with an earlier row (case-insensitively). */
export function collisions(rows: readonly PreviewCodexRow[], held: readonly string[]): Set<string> {
  const taken = new Set(held.map((name) => name.trim().toLowerCase()));
  const out = new Set<string>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    if (taken.has(key)) out.add(row.id);
    taken.add(key);
  }
  return out;
}

/** The answer a row starts with: Skip when it collides, Import otherwise. Never a merge. */
export function defaultCodexAnswer(rowId: string, colliding: ReadonlySet<string>): CodexAnswer {
  return colliding.has(rowId) ? { action: 'skip' } : { action: 'import' };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The commit: one binder.importTree
// ---------------------------------------------------------------------------------------------------------------------------

export interface CommitInput {
  readonly plan: PreviewPlan;
  readonly edits: PreviewEdits;
  /** `manuscript`, or the id of a folder of this project; folders are appended, never merged. */
  readonly destination: string;
  readonly mapping: Readonly<Record<string, FieldTarget>>;
  readonly statuses: readonly VocabularyTermLike[];
  readonly labels: readonly VocabularyTermLike[];
  readonly statusAnswers: Readonly<Record<string, ValueAnswer>>;
  readonly labelAnswers: Readonly<Record<string, ValueAnswer>>;
  readonly codexRows: readonly PreviewCodexRow[];
  readonly codexAnswers: Readonly<Record<string, CodexAnswer>>;
  readonly codexHeld: readonly string[];
  readonly pictures: readonly PreviewPicture[];
}

export interface CommitPlan {
  readonly params: Omit<ImportTreeParams, 'pictures'>;
  readonly pictures: readonly { readonly ref: string; readonly bytes: Uint8Array; readonly alt?: string }[];
  /** What the import leaves out, in sentences, for the status line. */
  readonly notices: readonly string[];
  /** Documents whose body would not survive a save and reload: the commit is refused until they are excluded. */
  readonly unkept: readonly string[];
  readonly documents: number;
  readonly folders: number;
}

function asList(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return (typeof value === 'string' ? value.split(/[,;]/) : [...value]).map((item) => item.trim()).filter((item) => item !== '');
}

function resolveTerm(value: string, terms: readonly VocabularyTermLike[], answers: Readonly<Record<string, ValueAnswer>>, added: Set<string>): string | undefined {
  const key = value.trim().toLowerCase();
  const held = terms.find((term) => term.id.toLowerCase() === key || term.name.trim().toLowerCase() === key);
  if (held !== undefined) return held.id;
  const answer = answers[value.trim()] ?? { action: 'ignore' };
  if (answer.action === 'map') return answer.termId;
  if (answer.action === 'add') {
    added.add(value.trim());
    return value.trim();
  }
  return undefined;
}

/** The writer's preview as the one command that commits it. Pure: the session stages the pictures and dispatches. */
export function buildCommit(input: CommitInput, helpers: PreviewHelpers): CommitPlan {
  const { plan, edits } = input;
  const tree = applyEdits(plan.tree, edits);
  const nodes: ImportTreeNode[] = [];
  const indexOf = new Map<string, number>();
  const notices: string[] = [];
  const unkept: string[] = [];
  const addedStatuses = new Set<string>();
  const addedLabels = new Set<string>();
  let documents = 0;
  let folders = 0;
  const destination = input.destination;
  const intoManuscript = destination === 'manuscript';

  const metaOf = (node: PreviewNode): Partial<ImportTreeNode> => {
    let synopsis = node.synopsis;
    const keywords = [...(node.keywords ?? [])];
    let status: string | undefined;
    let label: string | undefined;
    const notes: string[] = node.notes === undefined || node.notes === '' ? [] : [node.notes];
    for (const [key, raw] of Object.entries(node.fields ?? {})) {
      const target = input.mapping[key] ?? 'ignore';
      const values = asList(raw);
      if (values.length === 0 || target === 'ignore') continue;
      if (target === 'synopsis') synopsis = [synopsis, values.join(', ')].filter((part) => part !== undefined && part !== '').join('\n\n');
      else if (target === 'keywords') keywords.push(...values);
      else if (target === 'notes') notes.push(`${key}: ${values.join(', ')}`);
      else if (target === 'status') status = resolveTerm(values[0] as string, input.statuses, input.statusAnswers, addedStatuses) ?? status;
      else if (target === 'label') label = resolveTerm(values[0] as string, input.labels, input.labelAnswers, addedLabels) ?? label;
    }
    const uniqueKeywords = [...new Set(keywords.map((keyword) => keyword.slice(0, 64)))].slice(0, 32);
    return {
      ...(synopsis === undefined || synopsis === '' ? {} : { synopsis: [...synopsis].slice(0, 2000).join('') }),
      ...(uniqueKeywords.length === 0 ? {} : { keywords: uniqueKeywords }),
      ...(status === undefined ? {} : { status }),
      ...(label === undefined ? {} : { label }),
      ...(notes.length === 0 ? {} : { notes: [...notes.join('\n\n')].slice(0, 50_000).join('') }),
    };
  };

  const push = (node: PreviewNode, parent: number | undefined, place: 'research' | undefined): void => {
    if (edits.excluded.includes(node.id)) return;
    const isFolder = (node.children?.length ?? 0) > 0 || node.role === 'part' || node.role === 'chapter';
    if (node.role === 'front' || node.role === 'back') {
      const where = node.place ?? 'research';
      if (where === 'skip') {
        notices.push(`“${node.title}” was left out, as chosen in the preview.`);
        return;
      }
      if (where === 'research') {
        addDocument(node, undefined, 'research');
        return;
      }
      // Into the manuscript: a document needs a chapter there, so it gets a folder of its own name.
      if (intoManuscript && parent === undefined) {
        nodes.push({ type: 'folder', title: node.title });
        folders += 1;
        addDocument(node, nodes.length - 1, undefined);
        return;
      }
      addDocument(node, parent, undefined);
      return;
    }
    if (isFolder) {
      nodes.push({ type: 'folder', title: node.title, ...(parent === undefined ? {} : { parent }), ...(place === undefined ? {} : { place }), ...metaOf(node) });
      folders += 1;
      const at = nodes.length - 1;
      indexOf.set(node.id, at);
      for (const child of node.children ?? []) push(child, at, undefined);
      return;
    }
    if (parent === undefined && intoManuscript && place === undefined) {
      // A scene at the top of an import into the manuscript: a chapter of its own name holds it (the chapter rule).
      nodes.push({ type: 'folder', title: node.title });
      folders += 1;
      addDocument(node, nodes.length - 1, undefined);
      return;
    }
    addDocument(node, parent, place);
  };

  function addDocument(node: PreviewNode, parent: number | undefined, place: 'research' | undefined): void {
    const body = node.body ?? '';
    if (!helpers.keepsImportedBody(body, node.title)) unkept.push(node.title);
    nodes.push({ type: 'document', title: node.title, body, ...(parent === undefined ? {} : { parent }), ...(place === undefined ? {} : { place }), ...metaOf(node) });
    indexOf.set(node.id, nodes.length - 1);
    documents += 1;
  }

  for (const node of tree) push(node, undefined, undefined);

  // The pictures the kept bodies use, and only those.
  const bodies = nodes.map((node) => node.body ?? '').join('\n');
  const pictures = input.pictures.filter((picture) => bodies.includes(`](${picture.ref}`));
  const dropped = input.pictures.length - pictures.length;
  if (dropped > 0) notices.push(`${plural(dropped, 'picture')} in left-out text ${dropped === 1 ? 'was' : 'were'} not imported.`);

  // The codex rows, by the writer's answers.
  const entries: ImportTreeCodexEntry[] = [];
  const pages: { title: string; body: string }[] = [];
  for (const row of input.codexRows) {
    const answer = input.codexAnswers[row.id] ?? { action: 'import' };
    if (answer.action === 'skip') continue;
    if (answer.action === 'page') {
      if (row.page !== undefined) pages.push({ title: row.page.title, body: row.page.body });
      else notices.push(`“${row.name}” has no text of its own, so it was not imported as a page.`);
      continue;
    }
    const name = answer.action === 'rename' ? answer.name.trim() : row.name;
    if (name === '') continue;
    const base = { name, type: row.type, ...(row.description === undefined || row.description === '' ? {} : { description: [...row.description].slice(0, 2000).join('') }) };
    const cite = citeOf(row, nodes, indexOf);
    if (cite !== undefined) {
      entries.push({ ...base, node: cite.node, cite: { from: cite.from, to: cite.to, quote: cite.quote } });
      continue;
    }
    if (row.page !== undefined && row.page.body.includes(row.name)) {
      pages.push({ title: row.page.title, body: row.page.body });
      const from = row.page.body.indexOf(row.name);
      entries.push({ ...base, page: pages.length - 1, cite: { from, to: from + row.name.length, quote: row.name } });
      continue;
    }
    notices.push(`“${row.name}” is not named in the imported text, so its codex entry was not made.`);
  }

  const vocabulary = {
    ...(addedStatuses.size === 0 ? {} : { statuses: [...addedStatuses] }),
    ...(addedLabels.size === 0 ? {} : { labels: [...addedLabels] }),
  };
  const params: Omit<ImportTreeParams, 'pictures'> = {
    parentId: destination,
    nodes,
    ...(Object.keys(vocabulary).length === 0 ? {} : { vocabulary }),
    ...(entries.length + pages.length === 0 ? {} : { codex: { entries, ...(pages.length === 0 ? {} : { pages }) } }),
  };
  return {
    params,
    pictures: pictures.map((picture) => ({ ref: picture.ref, bytes: picture.data(), ...(picture.alt === undefined ? {} : { alt: picture.alt }) })),
    notices,
    unkept,
    documents,
    folders,
  };
}

/** Where a codex row's quote is in the imported documents: its own node first, then the first document that holds it. */
function citeOf(row: PreviewCodexRow, nodes: readonly ImportTreeNode[], indexOf: ReadonlyMap<string, number>): { node: number; from: number; to: number; quote: string } | undefined {
  const quote = (row.cite?.quote ?? row.name).slice(0, 300);
  if (quote === '') return undefined;
  const own = row.cite?.nodeId === undefined ? undefined : indexOf.get(row.cite.nodeId);
  const order = own === undefined ? nodes.keys() : [own, ...nodes.keys()];
  for (const index of order) {
    const node = nodes[index];
    if (node?.type !== 'document' || node.place === 'research') continue;
    const from = (node.body ?? '').indexOf(quote);
    if (from >= 0) return { node: index, from, to: from + quote.length, quote };
  }
  return undefined;
}

/** The status line after an import: what was made, and what was left out. */
export function importedSentence(fileName: string, commit: CommitPlan): string {
  const made = `Imported ${plural(commit.documents, 'document')} in ${plural(commit.folders, 'folder')} from ${fileName}.`;
  return [made, ...commit.notices].join(' ');
}
