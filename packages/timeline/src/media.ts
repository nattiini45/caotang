/**
 * The medium-adapter registry ([timeline.md §9.3, §9.4](../../../docs/architecture/timeline.md)): the view stays
 * medium-agnostic because each medium says how a node is labelled and measured, and what it hangs on a scene of any
 * medium: a branch glyph and link for a dialogue container, a shot strip under a scene, a page strip under a comic script.
 *
 * Every adapter is a pure read of the project state and the declarations. A tie to another node is the declared one
 * (`SceneMeta.dialogueContainer`, a book's `scriptDocId`) or the storyboard's own folder convention; nothing is matched by
 * likeness, and a tie whose target is gone is kept as a broken link rather than dropped.
 */

import type { SceneMeta } from '@caotang/coherence';
import { parseInk } from '@caotang/dialogue';
import { estimatePageCount, isScreenplayKind, parseFountain } from '@caotang/screenplay';
import { getBody, type ProjectState, type TreeNode } from '@caotang/store';

import type { BranchFacts, MeasureUnit, Medium, MediaLink, StripCell } from './model.js';

/** The glyphs the media add beside the mode glyph. Each is also named in text by the view (§6: never a glyph alone). */
export const DIALOGUE_GLYPH = '\u22d4';
export const STORYBOARD_GLYPH = '\u25a6';
export const COMIC_GLYPH = '\u25a4';

/**
 * The suffix `shots.derive` gives the folder it makes, `<Scene Title> — Shots` (storyboard.md §4). It is the storyboard's
 * own link from a scene to its shots, the only one that exists, so it is restated here rather than importing the package
 * (which carries the contact-sheet PDF engine) into a layout package.
 */
const SHOTS_FOLDER_SUFFIX = ' \u2014 Shots';

/** The facts an adapter can read besides the node and the state: declarations and the tree, indexed once per build. */
export interface MediaContext {
  readonly tree: readonly TreeNode[];
  readonly sceneMeta: Readonly<Record<string, SceneMeta>>;
  node(id: string): TreeNode | undefined;
  /** Children in sibling order. */
  children(id: string): readonly TreeNode[];
  /** An index an adapter builds once for the whole build, such as shots folders by scene title. */
  index<T>(key: string, make: () => T): T;
}

/** A strip before the build gives it the day, part, lane and slot of its host. */
export interface StripDraft {
  kind: 'shot-strip' | 'page-strip';
  medium: Medium;
  glyph: string;
  /** The folder whose children are the cells. */
  sourceId: string;
  label: string;
  cells: StripCell[];
  open: string;
  runtimeSec?: number;
  unmeasured?: number;
  direction?: 'ltr' | 'rtl';
  links?: MediaLink[];
}

export interface SceneAttachment {
  glyph?: string;
  links?: MediaLink[];
  strips?: StripDraft[];
}

export interface MediumAdapter {
  medium: Medium;
  matches(node: TreeNode): boolean;
  label(node: TreeNode, state: ProjectState): string;
  /** Words for prose, estimated pages for a screenplay, the medium's own count for the others (see {@link unit}). */
  measure(node: TreeNode, state: ProjectState): number;
  /** What `measure` counts for this node. Absent is words. */
  unit?(node: TreeNode, state: ProjectState): MeasureUnit;
  /**
   * What this medium hangs on a scene of any medium. The adapter that matches the scene decides its label and measure; any
   * adapter may attach, since a screenplay scene has a shot strip from the storyboard and a branch link from the dialogue.
   */
  attach?(scene: TreeNode, state: ProjectState, context: MediaContext): SceneAttachment | undefined;
  /** Strips this medium hangs under a folder that has no scene of its own, such as a comic book written from its pages. */
  attachToFolder?(folder: TreeNode, state: ProjectState, context: MediaContext): StripDraft[];
  glyph?: string;
}

function titleOf(node: TreeNode): string {
  if (node.title !== '') return node.title;
  const line = node.synopsis.split('\n', 1)[0]?.trim() ?? '';
  return line !== '' ? line : node.id;
}

function wordsOf(node: TreeNode, state: ProjectState): number {
  const counted = state.manifest.derived.wordCounts[node.id];
  if (typeof counted === 'number') return counted;
  const body = getBody(state, node.id).trim();
  return body === '' ? 0 : body.split(/\s+/u).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const PROSE_ADAPTER: MediumAdapter = {
  medium: 'prose',
  matches: () => true,
  label: titleOf,
  measure: wordsOf,
};

interface ScreenplayFacts {
  body: string;
  heading: string | undefined;
  pages: number;
}

const SCREENPLAY_CACHE_LIMIT = 256;
const screenplayCache = new Map<string, ScreenplayFacts>();

/** Parsing is the costly step, so a document's facts are kept while its body is unchanged. */
function screenplayFacts(node: TreeNode, state: ProjectState): ScreenplayFacts {
  const body = getBody(state, node.id);
  const known = screenplayCache.get(node.id);
  if (known !== undefined && known.body === body) return known;
  const parsed = parseFountain(body);
  const facts: ScreenplayFacts = {
    body,
    heading: parsed.scenes[0]?.heading,
    pages: body.trim() === '' ? 0 : estimatePageCount(parsed.elements),
  };
  if (screenplayCache.size >= SCREENPLAY_CACHE_LIMIT) screenplayCache.clear();
  screenplayCache.set(node.id, facts);
  return facts;
}

export const SCREENPLAY_ADAPTER: MediumAdapter = {
  medium: 'screenplay',
  matches: (node) => isScreenplayKind(node.kind),
  label: (node, state) => screenplayFacts(node, state).heading ?? titleOf(node),
  measure: (node, state) => screenplayFacts(node, state).pages,
  unit: () => 'pages',
};

/* ------------------------------------------------------------------ *
 * Dialogue (Ink)
 * ------------------------------------------------------------------ */

interface InkFacts {
  body: string;
  lines: number;
  branches: BranchFacts;
}

const inkCache = new Map<string, InkFacts>();

/** The parse is kept while the body is unchanged, like a screenplay's. A target a divert cannot resolve is not a link. */
function inkFacts(node: TreeNode, state: ProjectState): InkFacts {
  const body = getBody(state, node.id);
  const known = inkCache.get(node.id);
  if (known !== undefined && known.body === body) return known;
  const parsed = parseInk(body);
  const ids = new Set(parsed.graph.nodes.map((beat) => beat.id));
  const edges = new Set<string>();
  const reach = (from: string, target: string): void => {
    if (ids.has(target)) edges.add(`${from}\u0000${target}`);
  };
  for (const beat of parsed.graph.nodes) {
    for (const divert of beat.diverts) reach(divert.from, divert.target);
    for (const choice of beat.choices) reach(choice.from, choice.target);
  }
  const facts: InkFacts = {
    body,
    lines: parsed.lines.length,
    branches: { beats: parsed.graph.nodes.filter((beat) => beat.kind !== 'root').length, choices: parsed.graph.choices.length, links: edges.size },
  };
  if (inkCache.size >= SCREENPLAY_CACHE_LIMIT) inkCache.clear();
  inkCache.set(node.id, facts);
  return facts;
}

/**
 * A dialogue container is not a scene of its own: nothing declares when it happens, and `coherence.setSceneMeta` refuses
 * to date one. It reaches the timeline through the scene that declares it (`SceneMeta.dialogueContainer`, the one-way link
 * of medium.speaker-parity), so it takes that scene's day, part and lane exactly as the scene's prose does, and a container no
 * scene points at has no place on the timeline.
 */
export const DIALOGUE_ADAPTER: MediumAdapter = {
  medium: 'dialogue',
  matches: (node) => node.type === 'dialogue',
  label: titleOf,
  measure: (node, state) => inkFacts(node, state).lines,
  unit: () => 'lines',
  glyph: DIALOGUE_GLYPH,
  attach(scene, state, context) {
    const ref = context.sceneMeta[scene.id]?.dialogueContainer;
    if (ref === undefined) return undefined;
    const target = context.node(ref);
    if (target === undefined || target.type !== 'dialogue') return { links: [{ medium: 'dialogue', ref, broken: true }] };
    return {
      glyph: DIALOGUE_GLYPH,
      links: [{ medium: 'dialogue', nodeId: target.id, ref, title: target.title, branches: inkFacts(target, state).branches }],
    };
  },
};

/* ------------------------------------------------------------------ *
 * Storyboard
 * ------------------------------------------------------------------ */

function isStoryboardFolder(node: TreeNode): boolean {
  return node.type === 'folder' && node.kind === 'storyboard';
}

/** A shot's duration is a finite number of seconds, at least zero; anything else is as if it were not written. */
function durationOf(stored: Record<string, unknown> | undefined): number | undefined {
  const value = stored?.['durationSec'];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function shotStrip(folder: TreeNode, context: MediaContext): StripDraft {
  const cells: StripCell[] = [];
  let runtime = 0;
  let unmeasured = 0;
  for (const shot of context.children(folder.id)) {
    if (shot.type !== 'shot') continue;
    const stored = isRecord(shot.shot) ? shot.shot : undefined;
    const cell: StripCell = { nodeId: shot.id, number: cells.length + 1, title: titleOf(shot) };
    const image = stored?.['image'];
    if (typeof image === 'string' && image !== '') cell.assetId = image;
    const seconds = durationOf(stored);
    if (seconds === undefined) unmeasured += 1;
    else {
      cell.durationSec = seconds;
      runtime += seconds;
    }
    cells.push(cell);
  }
  return { kind: 'shot-strip', medium: 'storyboard', glyph: STORYBOARD_GLYPH, sourceId: folder.id, label: titleOf(folder), cells, open: folder.id, runtimeSec: runtime, unmeasured };
}

/** The `<Scene Title> — Shots` folders beside their scenes, first in binder order when a title is taken twice. */
function shotsFolders(context: MediaContext): Map<string, TreeNode> {
  return context.index('storyboard:folders', () => {
    const folders = new Map<string, TreeNode>();
    for (const node of context.tree) {
      if (!isStoryboardFolder(node) || node.parentId === null) continue;
      const key = `${node.parentId}\u0000${node.title}`;
      if (!folders.has(key)) folders.set(key, node);
    }
    return folders;
  });
}

export const STORYBOARD_ADAPTER: MediumAdapter = {
  medium: 'storyboard',
  matches: (node) => isStoryboardFolder(node) || node.type === 'shot',
  label: titleOf,
  measure: (node, state) => (isStoryboardFolder(node) ? state.manifest.tree.filter((child) => child.parentId === node.id && child.type === 'shot').length : 1),
  unit: () => 'shots',
  glyph: STORYBOARD_GLYPH,
  attach(scene, _state, context) {
    if (scene.type !== 'document' || scene.parentId === null) return undefined;
    const folder = shotsFolders(context).get(`${scene.parentId}\u0000${scene.title}${SHOTS_FOLDER_SUFFIX}`);
    return folder === undefined ? undefined : { strips: [shotStrip(folder, context)] };
  },
};

/* ------------------------------------------------------------------ *
 * Comics
 * ------------------------------------------------------------------ */

function isComicBook(node: TreeNode): boolean {
  return node.type === 'folder' && node.kind === 'comic';
}

function isComicScript(node: TreeNode): boolean {
  return node.type === 'document' && node.kind === 'comic-script';
}

/** The book's declared script link: a non-empty string or nothing. A malformed one reads as no link, as the comic loader reads it. */
function scriptRefOf(book: TreeNode): string | undefined {
  const id = book.comic?.['scriptDocId'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function pagesOf(book: TreeNode, children: (id: string) => readonly TreeNode[]): TreeNode[] {
  return children(book.id).filter((node) => node.type === 'comic-page');
}

function panelsOf(page: TreeNode): unknown[] {
  const panels = isRecord(page.comicPage) ? page.comicPage['panels'] : undefined;
  return Array.isArray(panels) ? panels : [];
}

function pageCount(book: TreeNode, state: ProjectState): number {
  return state.manifest.tree.filter((child) => child.parentId === book.id && child.type === 'comic-page').length;
}

/** Pages of the book that declares this script, or 0 when no book does. */
function scriptPages(script: TreeNode, state: ProjectState): number {
  const book = state.manifest.tree.find((candidate) => isComicBook(candidate) && scriptRefOf(candidate) === script.id);
  return book === undefined ? 0 : pageCount(book, state);
}

function pageStrip(book: TreeNode, context: MediaContext, links?: MediaLink[]): StripDraft | undefined {
  const pages = pagesOf(book, context.children);
  if (pages.length === 0) return undefined;
  const cells: StripCell[] = pages.map((page, at) => {
    const panels = panelsOf(page);
    const cell: StripCell = { nodeId: page.id, number: at + 1, title: titleOf(page), panels: panels.length };
    for (const panel of panels) {
      const asset = isRecord(panel) ? panel['assetId'] : undefined;
      if (typeof asset === 'string' && asset !== '') {
        cell.assetId = asset;
        break;
      }
    }
    return cell;
  });
  return {
    kind: 'page-strip',
    medium: 'comic',
    glyph: COMIC_GLYPH,
    sourceId: book.id,
    label: titleOf(book),
    cells,
    open: (cells[0] as StripCell).nodeId,
    direction: book.comic?.['readingDirection'] === 'rtl' ? 'rtl' : 'ltr',
    ...(links !== undefined ? { links } : {}),
  };
}

/** Books by the script they declare. A script belongs to one book (comics.md §2); if a hand-edited file says two, the first in binder order has it. */
function booksByScript(context: MediaContext): Map<string, TreeNode> {
  return context.index('comic:books', () => {
    const books = new Map<string, TreeNode>();
    for (const node of context.tree) {
      const ref = isComicBook(node) ? scriptRefOf(node) : undefined;
      if (ref !== undefined && !books.has(ref)) books.set(ref, node);
    }
    return books;
  });
}

/**
 * Comics: the unit is the book's linked comic-script document (`scriptDocId`, never a title match). A script with its book
 * is measured in the book's pages and has a page strip under it; a book with no script, or whose script is gone, has its
 * strip under the book itself and takes only the book folder's own span (comics.md §6). No text is invented for either.
 */
export const COMIC_ADAPTER: MediumAdapter = {
  medium: 'comic',
  matches: (node) => isComicScript(node) || node.type === 'comic-page' || isComicBook(node),
  label: titleOf,
  measure(node, state) {
    if (node.type === 'comic-page') return panelsOf(node).length;
    const pages = isComicBook(node) ? pageCount(node, state) : scriptPages(node, state);
    return pages > 0 || isComicBook(node) ? pages : wordsOf(node, state);
  },
  unit(node, state) {
    if (node.type === 'comic-page') return 'panels';
    return isComicBook(node) || scriptPages(node, state) > 0 ? 'pages' : 'words';
  },
  glyph: COMIC_GLYPH,
  attach(scene, _state, context) {
    if (!isComicScript(scene)) return undefined;
    const book = booksByScript(context).get(scene.id);
    if (book === undefined) return { glyph: COMIC_GLYPH };
    const strip = pageStrip(book, context);
    return {
      glyph: COMIC_GLYPH,
      links: [{ medium: 'comic', nodeId: book.id, ref: scene.id, title: book.title }],
      ...(strip !== undefined ? { strips: [strip] } : {}),
    };
  },
  attachToFolder(folder, _state, context) {
    if (!isComicBook(folder)) return [];
    const ref = scriptRefOf(folder);
    if (ref !== undefined) {
      const script = context.node(ref);
      // A live script carries the strip as its scene. If that scene is not on the timeline (archived, or outside the scope),
      // the pages are not drawn under the book as if it had none. A script another book already has is not this book's, so
      // this one is drawn under itself with the link marked broken.
      if (script !== undefined && isComicScript(script) && booksByScript(context).get(ref) === folder) return [];
    }
    const strip = pageStrip(folder, context, ref === undefined ? undefined : [{ medium: 'comic', ref, broken: true }]);
    return strip === undefined ? [] : [strip];
  },
};

/** Most specific first; prose matches everything and goes last. */
export const MEDIUM_ADAPTERS: readonly MediumAdapter[] = [COMIC_ADAPTER, SCREENPLAY_ADAPTER, DIALOGUE_ADAPTER, STORYBOARD_ADAPTER, PROSE_ADAPTER];

export function adapterFor(node: TreeNode, adapters: readonly MediumAdapter[] = MEDIUM_ADAPTERS): MediumAdapter {
  return adapters.find((adapter) => adapter.matches(node)) ?? PROSE_ADAPTER;
}

export function unitOf(adapter: MediumAdapter, node: TreeNode, state: ProjectState): MeasureUnit {
  return adapter.unit?.(node, state) ?? 'words';
}

export function createMediaContext(input: {
  tree: readonly TreeNode[];
  sceneMeta: Readonly<Record<string, SceneMeta>>;
  nodes: ReadonlyMap<string, TreeNode>;
  children: ReadonlyMap<string, readonly TreeNode[]>;
}): MediaContext {
  const indexes = new Map<string, unknown>();
  const none: readonly TreeNode[] = [];
  return {
    tree: input.tree,
    sceneMeta: input.sceneMeta,
    node: (id) => input.nodes.get(id),
    children: (id) => input.children.get(id) ?? none,
    index<T>(key: string, make: () => T): T {
      if (!indexes.has(key)) indexes.set(key, make());
      return indexes.get(key) as T;
    },
  };
}

/** What every adapter hangs on one scene, merged: the glyphs side by side, the links and the strips in adapter order. */
export function attachmentsOf(scene: TreeNode, state: ProjectState, context: MediaContext, adapters: readonly MediumAdapter[] = MEDIUM_ADAPTERS): Required<SceneAttachment> {
  const out: Required<SceneAttachment> = { glyph: '', links: [], strips: [] };
  for (const adapter of adapters) {
    const got = adapter.attach?.(scene, state, context);
    if (got === undefined) continue;
    if (got.glyph !== undefined && !out.glyph.includes(got.glyph)) out.glyph += got.glyph;
    if (got.links !== undefined) out.links.push(...got.links);
    if (got.strips !== undefined) out.strips.push(...got.strips);
  }
  return out;
}

export function folderStripsOf(folder: TreeNode, state: ProjectState, context: MediaContext, adapters: readonly MediumAdapter[] = MEDIUM_ADAPTERS): StripDraft[] {
  return adapters.flatMap((adapter) => adapter.attachToFolder?.(folder, state, context) ?? []);
}
