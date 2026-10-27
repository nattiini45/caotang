/**
 * [editor-engine.md] §15 — **apply-then-review**: the review marks, the accepted projection, the diff that makes the marks, and the
 * accept and reject helpers. Everything that needs `@handlewithcare/prosemirror-suggest-changes` lives here, and this module is imported
 * dynamically, only by an editor mounted with `agentEditMode: 'suggestions'`, so the ghost editor and every default mount never load it.
 *
 * ## What the marks are for, and what they are not
 *
 * The store is the authority. An approved agent edit has already been written to it when the editor hears of it, so the marks only SHOW
 * the difference between the text on screen and the text the store holds. The stored body is always the all-accepted text:
 * {@link SuggestionLayer.project} builds that text from the live document (the library's public `applySuggestions` run on a scratch
 * state), and the adapter serializes the projection and nothing else. The mdast handler table does not map the marks.
 *
 * ## Entry path
 *
 * {@link SuggestionLayer.trackAgentEdit} takes the live state and the document the store now holds and returns one transaction of minimal
 * replace steps, run through `transformToSuggestionTransaction` (the library's dispatch decorator is never installed, so a writer's own
 * keystrokes are never tracked). It diffs block by block, then word by word inside a changed paragraph, with diff-match-patch over word
 * tokens, so an unchanged paragraph carries no mark and a rewritten sentence carries marks on the words that changed.
 *
 * Suggestion ids are local: `${turn}.${n}`, a per-editor turn number and a counter. The tool call that made a turn is looked up in the
 * adapter's own map, so no id a provider supplies is ever part of a mark.
 */
import { Extension, Mark } from '@tiptap/core';
import type { Extensions } from '@tiptap/core';
import type { MarkSpec, Node as PmNode, Slice } from '@tiptap/pm/model';
import { EditorState, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { isHistoryTransaction } from '@tiptap/pm/history';
import { Mapping, ReplaceStep } from '@tiptap/pm/transform';
import {
  applySuggestion,
  applySuggestions,
  revertSuggestion,
  revertSuggestions,
  suggestChanges,
  suggestChangesKey,
  transformToSuggestionTransaction,
} from '@handlewithcare/prosemirror-suggest-changes';
import type { Editor } from '@tiptap/core';
import type { ParseResult } from '../pipeline.js';
import type { AgentEditOutcome, ReviewApi, ReviewState, ReviewSuggestion } from '../seam.js';
import { caotangExtensions } from './extensions.js';
import type { CaotangExtensionOptions } from './extensions.js';

/** One pending suggestion: the marks that share an id. */
export interface SuggestionSpan {
  /** The local id, `${turn}.${n}`. */
  readonly id: string;
  /** The editor's turn number, which {@link SuggestionLayer} groups by. */
  readonly turn: number;
  /** What the span does to the text on screen. */
  readonly kind: 'insert' | 'delete' | 'replace';
  /** The first and last position of the marks in the live document. */
  readonly from: number;
  readonly to: number;
  /** The words added and the words removed, shortened for a status line. */
  readonly added: string;
  readonly removed: string;
}

/** The accepted text of a document that holds marks, and how its positions relate to the live ones. */
export interface Projection {
  readonly doc: PmNode;
  /** Live positions to projected positions. */
  readonly mapping: Mapping;
}

export interface SuggestionLayer {
  /** The review state, the calls that resolve the marks of one editor, and the call that lands an agent edit as marks. */
  createReview(host: ReviewHost): ReviewDesk;
  /** The mark extensions and the plugin, to add to the focus editor's set. */
  extensions(options: CaotangExtensionOptions): Extensions;
  hasMarks(doc: PmNode): boolean;
  /** The all-accepted document, or `null` when `doc` holds no marks (it is its own projection). */
  project(doc: PmNode): Projection | null;
  /** The pending suggestions of `doc`, in document order. */
  spans(doc: PmNode): SuggestionSpan[];
  /** The ids of the suggestions at the selection `[from, to]`: the marks it touches, or sits against when it is a caret. */
  idsAt(doc: PmNode, from: number, to: number): string[];
  /**
   * One transaction that shows `next` over `state.doc` as marks, ids made by `newId`. `meta` is set on the transaction before the
   * transform, because the transform copies the meta of the transaction it is given and builds a new one. `null` when no diff could be
   * made (more distinct words than the token table holds), which the caller treats as a fallback.
   */
  trackAgentEdit(state: EditorState, next: PmNode, newId: () => string, meta: (tr: Transaction) => void): Transaction | null;
  /** One transaction that accepts (or rejects) the suggestions `ids`; `null` when none of them is in the document. */
  resolve(state: EditorState, ids: readonly string[], mode: 'accept' | 'reject'): Transaction | null;
  /** The same for every suggestion in the document. */
  resolveAll(state: EditorState, mode: 'accept' | 'reject'): Transaction | null;
  /** A selection transaction that selects the span, scrolled into view. */
  select(state: EditorState, span: SuggestionSpan): Transaction;
}

/* ------------------------------------------------------------------ *
 * Marks
 * ------------------------------------------------------------------ */

const markIds = (node: PmNode): string[] => {
  const ids: string[] = [];
  for (const mark of node.marks) {
    const name = mark.type.name;
    if (name === 'insertion' || name === 'deletion' || name === 'modification') ids.push(String(mark.attrs['id']));
  }
  return ids;
};

/**
 * The marks. They carry only an `id`, and render as `ins` and `del` with classes, never an inline `style` (the library's own
 * `toDOM` writes `style="display: block"` on a block mark, which the app's CSP refuses). A block mark's display is a rule in styles.css.
 */
const markSpec = (tag: string, name: string): Pick<MarkSpec, 'toDOM'> => ({
  toDOM: (mark, inline) => [
    tag,
    { class: `suggestion suggestion-${name}`, 'data-suggestion-id': String(mark.attrs['id']), 'data-inline': String(inline) },
    0,
  ],
});

const INSERTION = Mark.create({
  name: 'insertion',
  priority: 10,
  inclusive: false,
  excludes: 'deletion modification insertion',
  addAttributes: () => ({ id: { default: null } }),
});
const DELETION = Mark.create({
  name: 'deletion',
  priority: 10,
  inclusive: false,
  excludes: 'insertion modification deletion',
  addAttributes: () => ({ id: { default: null } }),
});
const MODIFICATION = Mark.create({
  name: 'modification',
  priority: 10,
  inclusive: false,
  excludes: 'deletion insertion',
  addAttributes: () => ({
    id: { default: null },
    type: { default: null },
    attrName: { default: null },
    previousValue: { default: null },
    newValue: { default: null },
  }),
});

/**
 * The writer's own typing never becomes a deletion. A character typed inside a struck-through span inherits its mark, and the
 * projection would delete it from the stored body, so the mark is taken off whatever a user transaction inserts. An undo, a redo and
 * the resolutions bring marks back on purpose, so they are left alone.
 */
const typingGuard = (): Plugin =>
  new Plugin({
    key: new PluginKey('reviewTypingGuard'),
    appendTransaction(transactions, _before, state) {
      const deletion = state.schema.marks['deletion'];
      if (deletion === undefined) return null;
      const fix = state.tr;
      transactions.forEach((tr, at) => {
        if (!tr.docChanged || tr.getMeta('addToHistory') === false || isHistoryTransaction(tr) || tr.getMeta(suggestChangesKey) !== undefined) return;
        // Positions after this transaction's step travel through the rest of it and through the transactions that follow.
        const later = new Mapping();
        for (const following of transactions.slice(at + 1)) later.appendMapping(following.mapping);
        tr.steps.forEach((step, index) => {
          if (!(step instanceof ReplaceStep)) return;
          const rest = tr.mapping.slice(index + 1);
          step.getMap().forEach((_from, _to, start, end) => {
            if (end > start) fix.removeMark(later.map(rest.map(start, -1), -1), later.map(rest.map(end, 1), 1), deletion);
          });
        });
      });
      return fix.steps.length > 0 ? fix : null;
    },
  });

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

const hasMarks = (doc: PmNode): boolean => {
  const { insertion, deletion, modification } = doc.type.schema.marks;
  if (insertion === undefined || deletion === undefined || modification === undefined) return false;
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.marks.some((mark) => mark.type === insertion || mark.type === deletion || mark.type === modification)) found = true;
    return !found;
  });
  return found;
};

/**
 * A scratch state over a document and one empty paragraph after it. The library's accept and reject code, when a marked block ends the
 * document, reads the character after it, one position past the end, and throws (0.1.8, commands.js). The padding gives it
 * something to read; the steps it makes never touch the padding, and the projection drops it again.
 */
const padded = (doc: PmNode): EditorState => {
  const pad = doc.type.schema.nodes['paragraph']?.createAndFill();
  return EditorState.create({ doc: pad === null || pad === undefined ? doc : doc.copy(doc.content.addToEnd(pad)) });
};

/** Passes of the library's accept or reject over one document; a deletion that crosses differently marked runs needs more than one. */
const SWEEPS = 8;

/**
 * Runs the library's accept-all or reject-all on a scratch state until no mark is left, and returns the transaction of every step it made.
 * One pass leaves part of a deleted range marked when the range starts on plain text and crosses runs whose other marks differ (0.1.8:
 * 'a b *it* c d' becoming 'a d'), so a single pass is not the accepted text. The steps are in the positions of `doc`, because the padding
 * sits after it.
 */
const sweep = (doc: PmNode, mode: 'accept' | 'reject'): Transaction => {
  const command = mode === 'accept' ? applySuggestions : revertSuggestions;
  let state = padded(doc);
  const all = state.tr;
  for (let pass = 0; pass < SWEEPS && hasMarks(state.doc); pass += 1) {
    let made: Transaction | null = null;
    command(state, (tr) => {
      made = tr;
    });
    const step = made as Transaction | null;
    if (step === null || step.steps.length === 0) break;
    for (const each of step.steps) all.step(each);
    state = EditorState.create({ doc: all.doc });
  }
  return all;
};

/** `doc` with any review mark `sweep` could not settle removed, so no document leaves here holding a mark the plain schema lacks. */
const unmarked = (doc: PmNode): PmNode => {
  if (!hasMarks(doc)) return doc;
  const { insertion, deletion, modification } = doc.type.schema.marks;
  const tr = EditorState.create({ doc }).tr;
  for (const type of [insertion, deletion, modification]) if (type !== undefined) tr.removeMark(0, tr.doc.content.size, type);
  return tr.doc;
};

const project = (doc: PmNode): Projection | null => {
  if (!hasMarks(doc)) return null;
  const done = sweep(doc, 'accept');
  // Marks the library would not touch at all still leave the document marked: strip them so the projection is always plain.
  if (done.steps.length === 0) return { doc: unmarked(doc), mapping: done.mapping };
  // The padding goes, unless it is all that is left: a document the edit emptied reads as one empty paragraph, as an empty body parses.
  const last = done.doc.lastChild;
  const kept = last !== null && done.doc.childCount > 1 ? done.doc.copy(done.doc.content.cut(0, done.doc.content.size - last.nodeSize)) : done.doc;
  return { doc: unmarked(kept), mapping: done.mapping };
};

/* ------------------------------------------------------------------ *
 * Spans
 * ------------------------------------------------------------------ */

const turnOf = (id: string): number => Number(id.slice(0, id.indexOf('.')));

const shorten = (text: string): string => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

const spansOf = (doc: PmNode): SuggestionSpan[] => {
  interface Draft {
    from: number;
    to: number;
    added: string;
    removed: string;
  }
  const byId = new Map<string, Draft>();
  doc.descendants((node, pos) => {
    for (const mark of node.marks) {
      const name = mark.type.name;
      if (name !== 'insertion' && name !== 'deletion' && name !== 'modification') continue;
      const id = String(mark.attrs['id']);
      const draft = byId.get(id) ?? { from: pos, to: pos, added: '', removed: '' };
      draft.from = Math.min(draft.from, pos);
      draft.to = Math.max(draft.to, pos + node.nodeSize);
      const text = node.isText ? (node.text ?? '').replace(/\u200B/g, '') : '';
      if (name === 'insertion') draft.added += text;
      if (name === 'deletion') draft.removed += text;
      byId.set(id, draft);
    }
    return true;
  });
  return [...byId.entries()]
    .map(([id, draft]): SuggestionSpan => ({
      id,
      turn: turnOf(id),
      kind: draft.added !== '' && draft.removed !== '' ? 'replace' : draft.removed !== '' ? 'delete' : 'insert',
      from: draft.from,
      to: draft.to,
      added: shorten(draft.added),
      removed: shorten(draft.removed),
    }))
    .sort((a, b) => a.from - b.from);
};

const idsAt = (doc: PmNode, from: number, to: number): string[] => {
  const found = new Set<string>();
  const size = doc.content.size;
  // A caret is next to a mark when the node before or after it carries one.
  const lo = from === to ? Math.max(0, from - 1) : from;
  const hi = from === to ? Math.min(size, to + 1) : to;
  doc.nodesBetween(lo, hi, (node) => {
    for (const id of markIds(node)) found.add(id);
    return true;
  });
  return [...found];
};

/* ------------------------------------------------------------------ *
 * Diff: blocks, then words
 * ------------------------------------------------------------------ */

type DiffOp = readonly [number, string];

/** The slice of diff-match-patch the diff uses. */
export interface DiffEngine {
  diff_main(a: string, b: string, checkLines?: boolean): DiffOp[];
  diff_cleanupSemantic(diffs: DiffOp[]): void;
}

/** One edit, in the coordinates of the document before it: replace `[from, to)` with `slice`. */
export interface Hunk {
  readonly from: number;
  readonly to: number;
  readonly slice: Slice;
}

/** First code unit of the token alphabet, in the CJK block: letters of that block are not word characters to the engine's clean-up. */
const ALPHABET_START = 0x4e00;
const ALPHABET_END = 0xd7ff;

class TokenTable {
  private readonly ids = new Map<string, string>();
  /** The one-character name of a token, or `null` when the table is full. */
  idOf(key: string): string | null {
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const code = ALPHABET_START + this.ids.size;
    if (code > ALPHABET_END) return null;
    const id = String.fromCharCode(code);
    this.ids.set(key, id);
    return id;
  }
}

const nodeKeys = new WeakMap<PmNode, string>();
const keyOfNode = (node: PmNode): string => {
  let key = nodeKeys.get(node);
  if (key === undefined) {
    key = JSON.stringify(node.toJSON());
    nodeKeys.set(node, key);
  }
  return key;
};

const marksKey = (node: PmNode): string => node.marks.map((mark) => `${mark.type.name}${JSON.stringify(mark.attrs)}`).join('|');

/** 0 for a space, 1 for a letter, a digit or an underscore, 2 for anything else. */
const charClass = (char: string): number => {
  if (/\s/u.test(char)) return 0;
  return /[\p{L}\p{N}_]/u.test(char) ? 1 : 2;
};

interface Token {
  readonly key: string;
  readonly from: number;
  readonly to: number;
  readonly space: boolean;
}

/** The words, spaces, marks and leaf nodes of a textblock, each with its position in the document. */
const tokensOf = (block: PmNode, contentStart: number): Token[] => {
  const out: Token[] = [];
  block.forEach((child, offset) => {
    const at = contentStart + offset;
    const marks = marksKey(child);
    if (!child.isText) {
      out.push({ key: `n:${child.type.name}:${JSON.stringify(child.attrs)}:${marks}`, from: at, to: at + child.nodeSize, space: false });
      return;
    }
    const text = child.text ?? '';
    let start = 0;
    while (start < text.length) {
      const klass = charClass(text.charAt(start));
      let end = start + 1;
      // A word and a space run on; any other character is a token of its own.
      while (klass !== 2 && end < text.length && charClass(text.charAt(end)) === klass) end += 1;
      out.push({ key: `t:${marks}:${text.slice(start, end)}`, from: at + start, to: at + end, space: klass === 0 });
      start = end;
    }
  });
  return out;
};

/** The edits that turn the textblock `oldBlock` into `newBlock`, as hunks of the old document. `null` when the token table is full. */
const inlineHunks = (
  engine: DiffEngine,
  table: TokenTable,
  oldBlock: PmNode,
  oldStart: number,
  newDoc: PmNode,
  newBlock: PmNode,
  newStart: number,
): Hunk[] | null => {
  const a = tokensOf(oldBlock, oldStart);
  const b = tokensOf(newBlock, newStart);
  let textA = '';
  let textB = '';
  for (const token of a) {
    const id = table.idOf(token.key);
    if (id === null) return null;
    textA += id;
  }
  for (const token of b) {
    const id = table.idOf(token.key);
    if (id === null) return null;
    textB += id;
  }
  const diffs = engine.diff_main(textA, textB, false);
  engine.diff_cleanupSemantic(diffs);

  // The regions that changed, as token ranges of both sequences. Two regions with only a space or two between them are one, so a
  // reworded phrase is one suggestion and not a word-by-word scatter.
  interface Region {
    a0: number;
    a1: number;
    b0: number;
    b1: number;
  }
  const regions: Region[] = [];
  let i = 0;
  let j = 0;
  let open: Region | null = null;
  for (const [op, text] of diffs) {
    const n = text.length;
    if (op === 0) {
      open = null;
      i += n;
      j += n;
      continue;
    }
    if (open === null) {
      open = { a0: i, a1: i, b0: j, b1: j };
      regions.push(open);
    }
    if (op < 0) {
      i += n;
      open.a1 = i;
    } else {
      j += n;
      open.b1 = j;
    }
  }
  const merged: Region[] = [];
  for (const region of regions) {
    const before = merged[merged.length - 1];
    if (before !== undefined && region.a0 - before.a1 <= 2 && a.slice(before.a1, region.a0).every((token) => token.space)) {
      before.a1 = region.a1;
      before.b1 = region.b1;
    } else {
      merged.push({ ...region });
    }
  }

  const oldEnd = oldStart + oldBlock.content.size;
  const newEnd = newStart + newBlock.content.size;
  return merged.map((region) => {
    const from = region.a0 < a.length ? (a[region.a0] as Token).from : oldEnd;
    const to = region.a1 > region.a0 ? (a[region.a1 - 1] as Token).to : from;
    const nFrom = region.b0 < b.length ? (b[region.b0] as Token).from : newEnd;
    const nTo = region.b1 > region.b0 ? (b[region.b1 - 1] as Token).to : nFrom;
    return { from, to, slice: newDoc.slice(nFrom, nTo) };
  });
};

const wordSet = (node: PmNode): Map<string, number> => {
  const words = new Map<string, number>();
  for (const word of node.textContent.toLowerCase().split(/\s+/u)) {
    if (word !== '') words.set(word, (words.get(word) ?? 0) + 1);
  }
  return words;
};

/** How much of the shorter of the two texts the other keeps, by word count. */
const similarity = (a: PmNode, b: PmNode): number => {
  const left = wordSet(a);
  const right = wordSet(b);
  let shared = 0;
  let total = 0;
  for (const [word, count] of left) shared += Math.min(count, right.get(word) ?? 0);
  for (const count of left.values()) total += count;
  let other = 0;
  for (const count of right.values()) other += count;
  const smaller = Math.min(total, other);
  return smaller === 0 ? 0 : shared / smaller;
};

const sameShape = (a: PmNode, b: PmNode): boolean => a.type === b.type && JSON.stringify(a.attrs) === JSON.stringify(b.attrs);

const SIMILAR = 0.4;

/** Whether the old block and the new one are the same paragraph, edited: the pairing that keeps unchanged and rewritten text apart. */
const pairable = (a: PmNode, b: PmNode): boolean => {
  if (a.type !== b.type) return false;
  // An empty paragraph is filled, not replaced: the words go into it.
  if (a.isTextblock) return a.content.size === 0 || b.content.size === 0 || similarity(a, b) >= SIMILAR;
  return !a.isLeaf;
};

/**
 * The hunks that turn the children of `oldParent` into those of `newParent`. Children are aligned by diff-match-patch over whole-block
 * tokens. A run of changed children is paired in order where two blocks are the same kind and alike, and a pair is refined: a textblock by
 * words, a container (a list, a quote, a list item) by its children. What is not paired is one whole-block hunk.
 */
const childHunks = (
  engine: DiffEngine,
  table: TokenTable,
  oldParent: PmNode,
  oldBase: number,
  newDoc: PmNode,
  newParent: PmNode,
  newBase: number,
): Hunk[] | null => {
  const oldKids: Array<{ node: PmNode; pos: number }> = [];
  const newKids: Array<{ node: PmNode; pos: number }> = [];
  oldParent.forEach((node, offset) => oldKids.push({ node, pos: oldBase + offset }));
  newParent.forEach((node, offset) => newKids.push({ node, pos: newBase + offset }));
  const oldEnd = oldBase + oldParent.content.size;
  const newEnd = newBase + newParent.content.size;
  const startOld = (k: number): number => (k < oldKids.length ? (oldKids[k] as { pos: number }).pos : oldEnd);
  const startNew = (k: number): number => (k < newKids.length ? (newKids[k] as { pos: number }).pos : newEnd);

  let textA = '';
  let textB = '';
  for (const kid of oldKids) {
    const id = table.idOf(keyOfNode(kid.node));
    if (id === null) return null;
    textA += id;
  }
  for (const kid of newKids) {
    const id = table.idOf(keyOfNode(kid.node));
    if (id === null) return null;
    textB += id;
  }
  const diffs = engine.diff_main(textA, textB, false);

  const hunks: Hunk[] = [];
  const settle = (o0: number, o1: number, n0: number, n1: number): boolean => {
    // Pair the changed children of one run, in order.
    const pairs: Array<[number, number]> = [];
    let cursor = n0;
    for (let o = o0; o < o1; o += 1) {
      const oldNode = (oldKids[o] as { node: PmNode }).node;
      for (let n = cursor; n < n1; n += 1) {
        if (pairable(oldNode, (newKids[n] as { node: PmNode }).node)) {
          pairs.push([o, n]);
          cursor = n + 1;
          break;
        }
      }
    }
    pairs.push([o1, n1]);
    let o = o0;
    let n = n0;
    for (const [po, pn] of pairs) {
      // A run of blocks added or removed together is one suggestion: the library resolves neighbouring block marks of one kind as a
      // single run (`findSuggestionMarkEnd`), so they are given one id and kept or put back together.
      if (o < po || n < pn) {
        hunks.push({ from: startOld(o), to: startOld(po), slice: newDoc.slice(startNew(n), startNew(pn)) });
      }
      if (po < o1) {
        const oldKid = oldKids[po] as { node: PmNode; pos: number };
        const newKid = newKids[pn] as { node: PmNode; pos: number };
        if (oldKid.node.isTextblock && sameShape(oldKid.node, newKid.node)) {
          const inner = inlineHunks(engine, table, oldKid.node, oldKid.pos + 1, newDoc, newKid.node, newKid.pos + 1);
          if (inner === null) return false;
          hunks.push(...inner);
        } else if (!oldKid.node.isTextblock && !oldKid.node.isLeaf && sameShape(oldKid.node, newKid.node)) {
          const inner = childHunks(engine, table, oldKid.node, oldKid.pos + 1, newDoc, newKid.node, newKid.pos + 1);
          if (inner === null) return false;
          hunks.push(...inner);
        } else {
          hunks.push({ from: oldKid.pos, to: oldKid.pos + oldKid.node.nodeSize, slice: newDoc.slice(newKid.pos, newKid.pos + newKid.node.nodeSize) });
        }
      }
      o = po + 1;
      n = pn + 1;
    }
    return true;
  };

  let i = 0;
  let j = 0;
  let runOld = -1;
  let runNew = -1;
  for (const [op, text] of diffs) {
    const n = text.length;
    if (op === 0) {
      if (runOld >= 0 && !settle(runOld, i, runNew, j)) return null;
      runOld = -1;
      i += n;
      j += n;
      continue;
    }
    if (runOld < 0) {
      runOld = i;
      runNew = j;
    }
    if (op < 0) i += n;
    else j += n;
  }
  if (runOld >= 0 && !settle(runOld, i, runNew, j)) return null;
  return hunks;
};

/** The hunks that turn `oldDoc` into `newDoc`, or `null` when the token table filled. Exported for the tests. */
export const diffHunks = (engine: DiffEngine, oldDoc: PmNode, newDoc: PmNode): Hunk[] | null =>
  childHunks(engine, new TokenTable(), oldDoc, 0, newDoc, newDoc, 0);

/* ------------------------------------------------------------------ *
 * The layer
 * ------------------------------------------------------------------ */

/** Loads the diff engine the way the anchor ladder loads it: once, from the CommonJS module's three possible shapes. */
const loadEngine = async (): Promise<DiffEngine> => {
  const module = (await import('diff-match-patch')) as unknown as {
    diff_match_patch?: new () => DiffEngine;
    default?: { diff_match_patch?: new () => DiffEngine } & (new () => DiffEngine);
  };
  const ctor = module.diff_match_patch ?? module.default?.diff_match_patch ?? module.default;
  if (typeof ctor !== 'function') throw new Error('diff-match-patch@1.0.5 exported no constructor, so the review layer cannot diff.');
  return new ctor();
};

/** One transaction made of the steps of the commands that resolve `ids`, run one after another on the state each leaves. */
const chain = (
  state: EditorState,
  runs: ReadonlyArray<(on: EditorState, dispatch: (tr: Transaction) => void) => boolean>,
): Transaction | null => {
  const merged = state.tr;
  let on = padded(state.doc);
  let failed = false;
  for (const run of runs) {
    run(on, (tr) => {
      for (const step of tr.steps) failed = merged.maybeStep(step).failed !== null || failed;
      on = on.apply(tr);
    });
  }
  if (failed || merged.steps.length === 0) return null;
  // The commands set this on their own transaction; the merged one is a new object that must say the same.
  merged.setMeta(suggestChangesKey, { skip: true });
  return merged;
};

/** What the review calls need from the adapter that owns the editor. */
export interface ReviewHost {
  readonly editor: Editor;
  /** Dispatches a transaction through the adapter's lane and scope handling. */
  commit(tr: Transaction): void;
  destroyed(): boolean;
  /** Puts a parsed body in the place of the whole document, outside the writer's undo: the fallback when marks are not trusted. */
  replace(next: ParseResult): void;
  /** Marks a transaction as the agent's (Lane 2), so the writer's undo never reaches it. */
  markAgent(tr: Transaction): void;
  /** Whether `doc`, on the live schema, serializes to exactly the body `next` serializes to. */
  matches(doc: PmNode, next: ParseResult): boolean;
  /** The body the editor now shows came from `next`: its diagnostics are the load's. */
  loaded(next: ParseResult): void;
}

/** The meta an accept carries, so the update it causes is not mistaken for the writer's edit. The adapter spells the same string itself, because importing it would load this module with the editor. */
export const REVIEW_ACCEPT = 'caotangReviewAccept';

/** One editor's review calls, and the call that lands an agent edit. */
export interface ReviewDesk {
  readonly api: ReviewApi;
  /**
   * Shows `next`, which the store already holds, as marks over the text on screen, as one turn of `toolCallId`. Earlier marks are
   * accepted first: that changes nothing the store holds, and the new diff is made against the text on screen. When the marks would not
   * project back to `next` exactly, the text is replaced instead and the outcome says why.
   */
  land(next: ParseResult, toolCallId: string): AgentEditOutcome;
}

/** The review state of one editor, and the calls that resolve its marks. */
const createReview = (layer: Omit<SuggestionLayer, 'createReview'>, host: ReviewHost): ReviewDesk => {
  const { editor } = host;
  /** The turns this editor has shown, by their local number. A mark's id holds the number and never the tool call. */
  const turnTools = new Map<number, string>();
  const listeners = new Set<() => void>();
  const empty: ReviewState = { pending: 0, byToolCall: [], current: null, selected: 0, position: 0 };
  let review: ReviewState = empty;
  let spansFor: { readonly doc: PmNode; readonly spans: SuggestionSpan[] } | null = null;
  const pendingSpans = (): SuggestionSpan[] => {
    if (host.destroyed()) return [];
    const live = editor.state.doc;
    if (spansFor === null || spansFor.doc !== live) spansFor = { doc: live, spans: layer.spans(live) };
    return spansFor.spans;
  };
  const suggestionOf = (span: SuggestionSpan): ReviewSuggestion => ({
    id: span.id,
    toolCallId: turnTools.get(span.turn) ?? null,
    kind: span.kind,
    added: span.added,
    removed: span.removed,
  });
  /** The ids of the suggestions the caret or selection touches, in document order. */
  const selectedIds = (): string[] => {
    const { from, to } = editor.state.selection;
    const here = new Set(layer.idsAt(editor.state.doc, from, to));
    return pendingSpans()
      .filter((span) => here.has(span.id))
      .map((span) => span.id);
  };
  const read = (): ReviewState => {
    const spans = pendingSpans();
    if (spans.length === 0) return empty;
    const here = new Set(selectedIds());
    const at = spans.findIndex((span) => here.has(span.id));
    const counts = new Map<number, number>();
    for (const span of spans) counts.set(span.turn, (counts.get(span.turn) ?? 0) + 1);
    return {
      pending: spans.length,
      byToolCall: [...counts.entries()]
        .sort((a, b) => a[0] - b[0])
        .flatMap(([turn, pending]) => {
          const toolCallId = turnTools.get(turn);
          return toolCallId === undefined ? [] : [{ toolCallId, pending }];
        }),
      current: at < 0 ? null : suggestionOf(spans[at] as SuggestionSpan),
      selected: here.size,
      position: at + 1,
    };
  };
  const same = (a: ReviewState, b: ReviewState): boolean =>
    a.pending === b.pending &&
    a.position === b.position &&
    a.selected === b.selected &&
    a.current?.id === b.current?.id &&
    a.byToolCall.length === b.byToolCall.length &&
    a.byToolCall.every((entry, index) => entry.toolCallId === b.byToolCall[index]?.toolCallId && entry.pending === b.byToolCall[index]?.pending);
  // Tells the subscribers when the marks or the caret's place among them changed. Nothing is computed while no one listens.
  editor.on('transaction', () => {
    if (host.destroyed() || listeners.size === 0) return;
    const next = read();
    if (same(review, next)) return;
    review = next;
    for (const listener of [...listeners]) listener();
  });

  /** Accepts or rejects suggestions in one Lane 1 transaction, so one Ctrl+Z puts them back. */
  const resolveIds = (ids: readonly string[], mode: 'accept' | 'reject'): number => {
    if (host.destroyed() || ids.length === 0) return 0;
    const tr = layer.resolve(editor.state, ids, mode);
    if (tr === null) return 0;
    if (mode === 'accept') tr.setMeta(REVIEW_ACCEPT, true);
    host.commit(tr);
    return ids.length;
  };
  const idsOfToolCall = (toolCallId: string): string[] => {
    const turns = new Set([...turnTools].filter(([, call]) => call === toolCallId).map(([turn]) => turn));
    return pendingSpans()
      .filter((span) => turns.has(span.turn))
      .map((span) => span.id);
  };
  const resolveAll = (mode: 'accept' | 'reject'): number => {
    if (host.destroyed()) return 0;
    const count = pendingSpans().length;
    const tr = layer.resolveAll(editor.state, mode);
    if (tr === null) return 0;
    if (mode === 'accept') tr.setMeta(REVIEW_ACCEPT, true);
    host.commit(tr);
    return count;
  };
  const moveTo = (direction: 1 | -1): boolean => {
    const spans = pendingSpans();
    if (spans.length === 0) return false;
    const here = read().current;
    const hereSpan = here === null ? undefined : spans.find((span) => span.id === here.id);
    const from = hereSpan === undefined ? editor.state.selection.from : hereSpan.from;
    const ahead =
      direction === 1
        ? spans.filter((span) => (hereSpan === undefined ? span.from >= from : span.from > from))
        : spans.filter((span) => span.from < from).reverse();
    const target = ahead[0] ?? (direction === 1 ? spans[0] : spans[spans.length - 1]);
    if (target === undefined) return false;
    host.commit(layer.select(editor.state, target));
    return true;
  };
  const api: ReviewApi = {
    // The same object while nothing in it changed, so a view that reads it on every render sees a stable value.
    state: () => {
      const next = read();
      if (!same(review, next)) review = next;
      return review;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    accept: () => resolveIds(selectedIds(), 'accept'),
    reject: () => resolveIds(selectedIds(), 'reject'),
    acceptToolCall: (toolCallId) => resolveIds(idsOfToolCall(toolCallId), 'accept'),
    rejectToolCall: (toolCallId) => resolveIds(idsOfToolCall(toolCallId), 'reject'),
    acceptAll: () => resolveAll('accept'),
    rejectAll: () => resolveAll('reject'),
    next: () => moveTo(1),
    previous: () => moveTo(-1),
  };
  const land = (next: ParseResult, toolCallId: string): AgentEditOutcome => {
    const fallback = (reason: 'diff' | 'mismatch'): AgentEditOutcome => {
      host.replace(next);
      return { landed: 'replaced', reason };
    };
    if (layer.hasMarks(editor.state.doc)) {
      const earlier = layer.resolveAll(editor.state, 'accept');
      if (earlier !== null) {
        host.markAgent(earlier);
        host.commit(earlier);
      }
    }
    const turn = Math.max(0, ...turnTools.keys()) + 1;
    let counter = 0;
    const tracked = layer.trackAgentEdit(
      editor.state,
      editor.schema.nodeFromJSON(next.doc.toJSON()),
      () => `${turn}.${(counter += 1)}`,
      (tr) => host.markAgent(tr),
    );
    if (tracked === null) return fallback('diff');
    if (!host.matches(layer.project(tracked.doc)?.doc ?? tracked.doc, next)) return fallback('mismatch');
    turnTools.set(turn, toolCallId);
    if (tracked.docChanged) host.commit(tracked);
    host.loaded(next);
    return { landed: 'suggestions', suggestions: api.state().pending };
  };
  return { api, land };
};

/** Loads the review layer: the library, the diff engine and the helpers over them. */
export const loadSuggestionLayer = async (diff?: DiffEngine): Promise<SuggestionLayer> => {
  const engine = diff ?? (await loadEngine());
  const resolveWith = (state: EditorState, ids: readonly string[], mode: 'accept' | 'reject'): Transaction | null =>
    chain(
      state,
      ids.map((id) => (on: EditorState, dispatch: (tr: Transaction) => void) =>
        (mode === 'accept' ? applySuggestion(id) : revertSuggestion(id))(on, dispatch),
      ),
    );
  const layer: Omit<SuggestionLayer, 'createReview'> = {
    extensions: (options) => [
      ...caotangExtensions({ ...options, reviewMarks: true }),
      INSERTION,
      DELETION,
      MODIFICATION,
      Extension.create({
        name: 'reviewSchema',
        extendMarkSchema: (extension) => {
          if (extension.name === 'insertion') return markSpec('ins', 'insertion');
          if (extension.name === 'deletion') return markSpec('del', 'deletion');
          if (extension.name === 'modification') return markSpec('span', 'modification');
          return {};
        },
        addProseMirrorPlugins: () => [suggestChanges(), typingGuard()],
      }),
    ],
    hasMarks,
    project,
    spans: spansOf,
    idsAt,
    trackAgentEdit: (state, next, newId, meta) => {
      const hunks = diffHunks(engine, state.doc, next);
      if (hunks === null) return null;
      const raw = state.tr;
      // In document order, each hunk's positions carried through the steps before it. Blocks added at one place keep their order because the
      // second goes in after the first (`rebasePos` in the library does the same through its own steps).
      for (const hunk of hunks) raw.replace(raw.mapping.map(hunk.from, 1), raw.mapping.map(hunk.to, 1), hunk.slice);
      meta(raw);
      const tracked = transformToSuggestionTransaction(raw, state, newId);
      // The library moves an empty caret to the suggestion it just made; the writer's caret stays where their text is.
      return tracked.setSelection(state.selection.map(tracked.doc, tracked.mapping));
    },
    resolve: resolveWith,
    resolveAll: (state, mode) => {
      const tr = state.tr;
      let failed = false;
      for (const step of sweep(state.doc, mode).steps) failed = tr.maybeStep(step).failed !== null || failed;
      if (failed || tr.steps.length === 0) return null;
      tr.setMeta(suggestChangesKey, { skip: true });
      return tr;
    },
    select: (state, span) => {
      const $from = state.doc.resolve(Math.min(span.from, state.doc.content.size));
      const $to = state.doc.resolve(Math.min(span.to, state.doc.content.size));
      return state.tr.setSelection(TextSelection.between($from, $to)).scrollIntoView();
    },
  };
  return { ...layer, createReview: (host) => createReview(layer, host) };
};
