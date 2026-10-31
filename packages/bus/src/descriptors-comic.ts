/**
 * The comic track's descriptors — [comics.md §3.2](docs/architecture/comics.md). The applies are the store's
 * (`packages/store/src/commands-comic.ts`), reached through the same registry as the rest of the closed set.
 *
 * What a validate can read from the project alone is checked here: the node is the kind the command is about, the value is one the
 * strict write boundary of `@caotang/comic` accepts, a panel's picture is a record the project holds, a script link is legal in both
 * directions, and an `expect` still holds. `comic.derive` and `comic.letter` are deterministic over the script they are given: the
 * model's part in the agent's derive is choosing to ask for them, never what they write, so a validate can run the whole plan and refuse
 * before anything changes.
 *
 * A book's settings and a page are written whole with the value they replace beside them (`expect`), the `shot.setMeta` pattern, so an
 * undo is the same command with the two values swapped and a concurrent edit is refused rather than overwritten.
 */

import {
  loadComicBook,
  loadComicPage,
  planComicDerive,
  planComicLetter,
  renderMessage,
  speakerResolver,
  serializeComicBook,
  serializeComicPage,
  validateComicBook,
  validateComicPage,
  type ValidationError,
} from '@caotang/comic';
import { isAssetId } from '@caotang/pictures';

import type { CommandDescriptor, ValidationNode, ValidationSnapshot } from './command.js';
import {
  changesNothing,
  invalid,
  isRecord,
  limitExceeded,
  notFound,
  requireDeclaredParams,
  requireInteger,
  requireNode,
  requireNonBlankString,
  showValue,
  isContainer,
} from './params.js';
import { err, ok, type CommandError, type Result } from './result.js';

/* ------------------------------------------------------------------ *
 * Param shapes
 * ------------------------------------------------------------------ */

/** A new book: the folder, its settings (the defaults for what is left out), and how many pages it starts with. */
export type ComicCreateBookParams = {
  parentId: string;
  title: string;
  settings?: Record<string, unknown>;
  pages?: number;
};

/** A book's settings written whole over the value they replace (`null` when the folder held none). The script link is not here: `comic.setScript` owns it. */
export type ComicSetBookParams = { nodeId: string; stored: Record<string, unknown> | null; expect: unknown };

/** A page written whole over the value it replaces. `null` removes the stored value, which only the undo of a page's first write sends. */
export type ComicSetPageParams = { nodeId: string; stored: Record<string, unknown> | null; expect: unknown };

/** The script link: a document id, or `null` to clear it. `expect` is the link the plan read (`null` when the book had none). */
export type ComicSetScriptParams = { nodeId: string; scriptDocId: string | null; expect: string | null };

/** The script written from the pages. `expectedRevision` is the linked script's revision the plan read, and is absent when the book has no script. */
export type ComicScriptFromPagesParams = { nodeId: string; expectedRevision?: number };

/**
 * Pages written from the book's linked script. `nodeId` is the book and `doc` the script. `expectedRevision` is the script's revision the
 * plan read; `expect` is the stored value of each of the book's pages, in binder order, that the plan read (empty for a book with no
 * pages, `null` for a page node that holds no value), so a page changed since is refused rather than overwritten.
 */
export type ComicDeriveParams = {
  nodeId: string;
  doc: string;
  expectedRevision: number;
  expect: (Record<string, unknown> | null)[];
};

/**
 * One page's balloons lettered from its script page. `nodeId` is the page, `doc` the book's linked script, `expectedRevision` the script's
 * revision the plan read and `expect` the page's stored value it read. `panel` (1-based) narrows it to one panel of the script page, and
 * `line` (1-based, with `panel`) to one lettering line of it.
 */
export type ComicLetterParams = {
  nodeId: string;
  doc: string;
  expectedRevision: number;
  expect: Record<string, unknown> | null;
  panel?: number;
  line?: number;
};

/** The most pages `comic.createBook` makes at once. */
export const COMIC_CREATE_PAGES_MAX = 100;

/** The comic-script document kind (comics.md §3.1). */
export const COMIC_SCRIPT_KIND = 'comic-script';

/* ------------------------------------------------------------------ *
 * What the comic commands read of a snapshot
 * ------------------------------------------------------------------ */

export const isComicFolder = (node: ValidationNode): boolean => node.type === 'folder' && node.kind === 'comic';

export const isComicPage = (node: ValidationNode): boolean => node.type === 'comic-page';

export const isComicScript = (node: ValidationNode): boolean => node.type === 'document' && node.kind === COMIC_SCRIPT_KIND;

/** A node's pages in binder order. */
export function comicPagesOf(snapshot: ValidationSnapshot, bookId: string): ValidationNode[] {
  return snapshot.manifest.tree
    .filter((node) => node.parentId === bookId && isComicPage(node))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** The book that links this document as its script, when one does. */
export function bookLinkingScript(snapshot: ValidationSnapshot, docId: string, except?: string): ValidationNode | undefined {
  return snapshot.manifest.tree.find(
    (node) => isComicFolder(node) && node.id !== except && loadComicBook(node.comic).value.scriptDocId === docId,
  );
}

/** JSON equality that does not care about key order, because a stored value may have been written by another build. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const keys = Object.keys(a).filter((key) => a[key] !== undefined);
    const other = Object.keys(b).filter((key) => b[key] !== undefined);
    return keys.length === other.length && keys.every((key) => sameJson(a[key], b[key]));
  }
  return false;
}

const errorsText = (errors: readonly ValidationError[]): string => errors.map((e) => renderMessage(e.message)).join(' ');

function stale(what: string): Result<never, CommandError> {
  return err({
    code: 'revision-conflict',
    message: `${what} changed since it was read, so nothing was changed`,
    target: 'expect',
    correctiveHint: 'read it again and resend the change against what it holds now',
  });
}

function requireBook(snapshot: ValidationSnapshot, params: Record<string, unknown>, what: string): Result<ValidationNode, CommandError> {
  const node = requireNode(snapshot, params, 'nodeId');
  if (!node.ok) return node;
  if (!isComicFolder(node.value)) {
    return invalid(
      `"${node.value.id}" is a ${node.value.type}${node.value.kind === undefined ? '' : ` (${node.value.kind})`}, and only a comic book ${what}`,
      'choose the comic book folder',
      'nodeId',
    );
  }
  return ok(node.value);
}

function requireExpectKey(params: Record<string, unknown>, what: string): Result<unknown, CommandError> {
  if (!Object.prototype.hasOwnProperty.call(params, 'expect')) {
    return invalid(`expect must be the stored ${what} the plan read, or null when there was none`, undefined, 'expect');
  }
  return ok(params['expect']);
}

/** A comic book may not sit in a storyboard or in another comic: both hold only their own children. */
export function comicParentRefusal(parent: ValidationNode): string | undefined {
  if (parent.id === 'root') {
    return 'the project root is not a place for a node: the binder shows only the manuscript and research, so a book made here would never appear';
  }
  if (!isContainer(parent)) return `parent "${parent.id}" is a ${parent.type} and cannot hold children`;
  if (parent.kind === 'storyboard') return `"${parent.id}" is a storyboard, and a storyboard holds only shots, so a comic book cannot be made in it`;
  if (isComicFolder(parent)) return `"${parent.id}" is a comic book, and a comic book holds only its pages and its script, so another book cannot be made in it`;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * comic.createBook
 * ------------------------------------------------------------------ */

export const comicCreateBook: CommandDescriptor<ComicCreateBookParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('comic.createBook', params);
    if (!p.ok) return p;
    const parent = requireNode(snapshot, p.value, 'parentId');
    if (!parent.ok) return parent;
    const refusal = comicParentRefusal(parent.value);
    if (refusal !== undefined) return invalid(refusal, 'create the book under "manuscript" or "research", or under a chapter', 'parentId');
    const title = requireNonBlankString(p.value, 'title');
    if (!title.ok) return title;

    const given = p.value['settings'];
    if (given !== undefined && !isRecord(given)) {
      return invalid(`settings must be an object of book settings, got ${showValue(given)}`, 'pass readingDirection, letteringFace, capsTransform, esszett or pageSize, or leave settings out', 'settings');
    }
    if (given !== undefined && 'scriptDocId' in given) {
      return invalid('a new book has no script to link yet', 'leave scriptDocId out; link a script afterwards with comic.setScript', 'settings.scriptDocId');
    }
    const book = validateComicBook(given ?? {});
    if (!book.ok) return invalid(errorsText(book.errors), undefined, 'settings');

    let pages = 0;
    if (p.value['pages'] !== undefined) {
      const count = requireInteger(p.value, 'pages', { min: 0 });
      if (!count.ok) return count;
      if (count.value > COMIC_CREATE_PAGES_MAX) {
        return limitExceeded(`pages is ${count.value}, limit ${COMIC_CREATE_PAGES_MAX}`, `create at most ${COMIC_CREATE_PAGES_MAX} pages, then add more`, 'pages');
      }
      pages = count.value;
    }
    return ok({ parentId: parent.value.id, title: title.value, settings: serializeComicBook(book.value), pages });
  },
};

/* ------------------------------------------------------------------ *
 * comic.setBook
 * ------------------------------------------------------------------ */

export const comicSetBook: CommandDescriptor<ComicSetBookParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('comic.setBook', params);
    if (!p.ok) return p;
    const node = requireBook(snapshot, p.value, 'holds these settings');
    if (!node.ok) return node;
    const expect = requireExpectKey(p.value, 'book settings');
    if (!expect.ok) return expect;
    if (!sameJson(node.value.comic ?? null, expect.value ?? null)) return stale(`the settings of "${node.value.title}"`);

    const stored = p.value['stored'];
    const current = loadComicBook(node.value.comic).value;
    const linked = current.scriptDocId;
    if (stored === null) {
      if (linked !== undefined) {
        return invalid('stored must be the whole book settings object while the book has a script linked', 'send every setting; use comic.setScript to change the script link', 'stored');
      }
      if (node.value.comic === undefined) return changesNothing(`the settings of "${node.value.title}" are already unset`, 'leave the book as it is', 'stored');
      return ok({ nodeId: node.value.id, stored: null, expect: expect.value });
    }
    if (!isRecord(stored)) return invalid('stored must be the whole book settings object, or null to remove it', undefined, 'stored');
    if (stored['scriptDocId'] !== linked) {
      return invalid('the script link is not changed here', 'use comic.setScript to link, relink or unlink the book\'s script', 'stored.scriptDocId');
    }
    const book = validateComicBook(stored, current);
    if (!book.ok) return invalid(errorsText(book.errors), undefined, 'stored');
    const value = serializeComicBook(book.value);
    if (sameJson(value, node.value.comic ?? null)) {
      return changesNothing(`the settings of "${node.value.title}" are already these`, 'change a setting, or leave the book as it is', 'stored');
    }
    return ok({ nodeId: node.value.id, stored: value, expect: expect.value });
  },
};

/* ------------------------------------------------------------------ *
 * comic.setPage
 * ------------------------------------------------------------------ */

function codexIdsOf(snapshot: ValidationSnapshot): Set<string> {
  return new Set((snapshot.manifest.codex ?? []).map((entry) => entry.id));
}

/**
 * The references a page value makes that the project has to hold: each panel's picture is a record of the registry, and each
 * balloon's speaker a codex entry. A reference the stored page already makes is kept as it is, so a page whose picture was
 * lost can still be edited, and the missing picture shows in the page instead of locking it.
 */
function referenceProblem(snapshot: ValidationSnapshot, next: Record<string, unknown>, before: Record<string, unknown> | undefined): string | undefined {
  const records = new Set((snapshot.manifest.assets ?? []).map((record) => record.id));
  const codex = codexIdsOf(snapshot);
  const keptPictures = new Set<string>();
  const keptSpeakers = new Set<string>();
  const stored = before === undefined ? [] : (Array.isArray(before['panels']) ? (before['panels'] as unknown[]) : []);
  for (const panel of stored) {
    if (!isRecord(panel)) continue;
    if (typeof panel['assetId'] === 'string') keptPictures.add(panel['assetId']);
    for (const balloon of Array.isArray(panel['balloons']) ? (panel['balloons'] as unknown[]) : []) {
      if (isRecord(balloon) && typeof balloon['speaker'] === 'string') keptSpeakers.add(balloon['speaker']);
    }
  }
  const panels = Array.isArray(next['panels']) ? (next['panels'] as unknown[]) : [];
  for (const [i, panel] of panels.entries()) {
    if (!isRecord(panel)) continue;
    const assetId = panel['assetId'];
    if (typeof assetId === 'string' && !keptPictures.has(assetId)) {
      if (!isAssetId(assetId)) return `panels[${i}].assetId "${assetId}" is not a picture id`;
      if (!records.has(assetId)) return `panels[${i}].assetId names the picture "${assetId}", which the project does not hold; import it first`;
    }
    for (const [j, balloon] of (Array.isArray(panel['balloons']) ? (panel['balloons'] as unknown[]) : []).entries()) {
      const speaker = isRecord(balloon) ? balloon['speaker'] : undefined;
      if (typeof speaker === 'string' && !keptSpeakers.has(speaker) && !codex.has(speaker)) {
        return `panels[${i}].balloons[${j}].speaker "${speaker}" is not a codex entry; a speaker is a codex id, never a name`;
      }
    }
  }
  return undefined;
}

export const comicSetPage: CommandDescriptor<ComicSetPageParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('comic.setPage', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    if (!isComicPage(node.value)) {
      return invalid(`"${node.value.id}" is a ${node.value.type}, and only a comic page holds panels`, 'choose the comic page whose panels to change', 'nodeId');
    }
    const expect = requireExpectKey(p.value, 'page');
    if (!expect.ok) return expect;
    if (!sameJson(node.value.comicPage ?? null, expect.value ?? null)) return stale(`the page "${node.value.title}"`);

    const stored = p.value['stored'];
    if (stored === null) return ok({ nodeId: node.value.id, stored: null, expect: expect.value });
    if (!isRecord(stored)) return invalid('stored must be the whole page object, or null to remove it', undefined, 'stored');
    const before = node.value.comicPage === undefined ? undefined : loadComicPage(node.value.comicPage).value;
    const page = validateComicPage(stored, before);
    if (!page.ok) return invalid(errorsText(page.errors), undefined, 'stored');
    const value = serializeComicPage(page.value);
    const problem = referenceProblem(snapshot, value, node.value.comicPage);
    if (problem !== undefined) return invalid(problem, 'import the picture, or choose a codex entry, and resend', 'stored');
    if (sameJson(value, node.value.comicPage ?? null)) {
      return changesNothing(`the page "${node.value.title}" already holds this`, 'change the page, or leave it as it is', 'stored');
    }
    return ok({ nodeId: node.value.id, stored: value, expect: expect.value });
  },
};

/* ------------------------------------------------------------------ *
 * comic.setScript
 * ------------------------------------------------------------------ */

export const comicSetScript: CommandDescriptor<ComicSetScriptParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('comic.setScript', params);
    if (!p.ok) return p;
    const node = requireBook(snapshot, p.value, 'has a script link');
    if (!node.ok) return node;
    const expect = requireExpectKey(p.value, 'script link');
    if (!expect.ok) return expect;
    if (expect.value !== null && typeof expect.value !== 'string') {
      return invalid(`expect must be the linked document id, or null when the book had none, got ${showValue(expect.value)}`, undefined, 'expect');
    }
    const linked = loadComicBook(node.value.comic).value.scriptDocId ?? null;
    if (linked !== expect.value) return stale(`the script link of "${node.value.title}"`);

    const target = p.value['scriptDocId'];
    if (target !== null && (typeof target !== 'string' || target.trim() === '')) {
      return invalid(`scriptDocId must be a document id, or null to unlink, got ${showValue(target)}`, undefined, 'scriptDocId');
    }
    if (target === linked) {
      return changesNothing(
        target === null ? `"${node.value.title}" has no script linked` : `"${node.value.title}" already uses this script`,
        'choose another script, or leave the link as it is',
        'scriptDocId',
      );
    }
    if (target !== null) {
      const doc = snapshot.manifest.tree.find((n) => n.id === target);
      if (doc === undefined) return notFound(`no document with id "${target}"`, 'choose a comic script from the binder', 'scriptDocId');
      if (!isComicScript(doc)) {
        return invalid(`"${doc.title}" is not a comic script`, 'a book links a document marked as a comic script; make one with binder.create (type document, kind comic-script) or comic.scriptFromPages', 'scriptDocId');
      }
      const other = bookLinkingScript(snapshot, target, node.value.id);
      if (other !== undefined) {
        return invalid(`"${doc.title}" is already the script of the book "${other.title}", and a script belongs to one book`, 'unlink it there first, or choose another script', 'scriptDocId');
      }
    }
    return ok({ nodeId: node.value.id, scriptDocId: target, expect: expect.value });
  },
};

/* ------------------------------------------------------------------ *
 * comic.scriptFromPages
 * ------------------------------------------------------------------ */

export const comicScriptFromPages: CommandDescriptor<ComicScriptFromPagesParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('comic.scriptFromPages', params);
    if (!p.ok) return p;
    const node = requireBook(snapshot, p.value, 'has pages to write a script from');
    if (!node.ok) return node;
    if (comicPagesOf(snapshot, node.value.id).length === 0) {
      return invalid(`"${node.value.title}" has no pages, so there is nothing to write a script from`, 'add a page to the book first', 'nodeId');
    }
    const linked = loadComicBook(node.value.comic).value.scriptDocId;
    const revision = p.value['expectedRevision'];
    if (linked === undefined) {
      if (revision !== undefined) {
        return invalid('expectedRevision names the revision of a script, and this book has none', 'leave expectedRevision out; the command makes the script', 'expectedRevision');
      }
      return ok({ nodeId: node.value.id });
    }
    const doc = snapshot.manifest.tree.find((n) => n.id === linked);
    if (doc === undefined || !isComicScript(doc)) {
      return invalid(
        'The script for this book is no longer in the project. Choose a script, or work from the pages.',
        'relink with comic.setScript (a new script, or null to unlink) and then write the script from the pages',
        'nodeId',
      );
    }
    const expected = requireInteger(p.value, 'expectedRevision', { min: 0 });
    if (!expected.ok) {
      return invalid(
        `"${doc.title}" is this book's script, so writing it needs the revision the plan read`,
        'send expectedRevision with the script\'s current revision, so a change made since cannot be overwritten',
        'expectedRevision',
      );
    }
    const actual = snapshot.documents.get(linked)?.revision;
    if (actual !== expected.value) {
      return err({
        code: 'revision-conflict',
        message: `the script "${doc.title}" was modified since it was read (revision ${expected.value} → ${actual ?? 'missing'}), so it was not overwritten`,
        target: 'expectedRevision',
        correctiveHint: 'read the script again, then write it from the pages against that revision',
        details: { expectedRevision: expected.value, ...(actual === undefined ? {} : { actualRevision: actual }) },
      });
    }
    return ok({ nodeId: node.value.id, expectedRevision: expected.value });
  },
};

/* ------------------------------------------------------------------ *
 * comic.derive and comic.letter
 * ------------------------------------------------------------------ */

function codexNames(snapshot: ValidationSnapshot): ReturnType<typeof speakerResolver> {
  return speakerResolver((snapshot.manifest.codex ?? []).map((entry) => ({ id: entry.id, name: entry.name })));
}

function scriptRevisionConflict(title: string, expected: number, actual: number | undefined): Result<never, CommandError> {
  return err({
    code: 'revision-conflict',
    message: `the script "${title}" was modified since it was read (revision ${expected} → ${actual ?? 'missing'}), so nothing was changed`,
    target: 'expectedRevision',
    correctiveHint: 'read the script again, then plan against that revision',
    details: { expectedRevision: expected, ...(actual === undefined ? {} : { actualRevision: actual }) },
  });
}

/** The script a derive or a letter reads: a comic script that is the book's own, and the revision the plan read still its. */
function requireBookScript(
  snapshot: ValidationSnapshot,
  params: Record<string, unknown>,
  book: ValidationNode,
  options: { linkIfFree: boolean },
): Result<{ doc: ValidationNode; revision: number; body: string; link: boolean }, CommandError> {
  const docId = requireNonBlankString(params, 'doc');
  if (!docId.ok) return docId;
  const doc = snapshot.manifest.tree.find((n) => n.id === docId.value);
  if (doc === undefined) return notFound(`no document with id "${docId.value}"`, 'choose the book\'s comic script', 'doc');
  if (!isComicScript(doc)) {
    return invalid(`"${doc.title}" is not a comic script`, 'name the comic-script document the book uses', 'doc');
  }
  const linked = loadComicBook(book.comic).value.scriptDocId;
  let link = false;
  if (linked === undefined) {
    if (!options.linkIfFree) {
      return invalid(`"${book.title}" has no script linked`, 'link a comic script with comic.setScript, or derive the book\'s pages from one first', 'doc');
    }
    const other = bookLinkingScript(snapshot, doc.id, book.id);
    if (other !== undefined) {
      return invalid(`"${doc.title}" is already the script of the book "${other.title}", and a script belongs to one book`, 'unlink it there first, or choose another script', 'doc');
    }
    link = true;
  } else if (linked !== doc.id) {
    const current = snapshot.manifest.tree.find((n) => n.id === linked);
    return invalid(
      `"${book.title}" already uses ${current === undefined ? `a script that is no longer in the project (${linked})` : `"${current.title}"`} as its script, not "${doc.title}"`,
      'use the book\'s own script, or relink the book with comic.setScript first',
      'doc',
    );
  }
  const expected = requireInteger(params, 'expectedRevision', { min: 0 });
  if (!expected.ok) {
    return invalid(`"${doc.title}" is read to plan this, so the revision the plan read is needed`, 'send expectedRevision with the script\'s current revision', 'expectedRevision');
  }
  const held = snapshot.documents.get(doc.id);
  if (held === undefined || held.revision !== expected.value) return scriptRevisionConflict(doc.title, expected.value, held?.revision);
  return ok({ doc, revision: held.revision, body: held.body, link });
}

export const comicDerive: CommandDescriptor<ComicDeriveParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('comic.derive', params);
    if (!p.ok) return p;
    const book = requireBook(snapshot, p.value, 'has pages to derive');
    if (!book.ok) return book;
    const script = requireBookScript(snapshot, p.value, book.value, { linkIfFree: true });
    if (!script.ok) return script;

    const expect = p.value['expect'];
    if (!Array.isArray(expect)) {
      return invalid('expect must be the stored value of each of the book\'s pages the plan read, in order, or an empty list when it has none', undefined, 'expect');
    }
    const nodes = comicPagesOf(snapshot, book.value.id);
    if (nodes.length !== expect.length || nodes.some((node, i) => !sameJson(node.comicPage ?? null, expect[i] ?? null))) {
      return stale(`the pages of "${book.value.title}"`);
    }

    const settings = loadComicBook(book.value.comic).value;
    const plan = planComicDerive({
      docId: script.value.doc.id,
      body: script.value.body,
      revision: script.value.revision,
      book: settings,
      pages: nodes.map((node) => loadComicPage(node.comicPage).value),
      speakerId: codexNames(snapshot),
    });
    if (!plan.ok) {
      return invalid(plan.problems.map((problem) => renderMessage(problem.message)).join(' '), 'change the script or the pages so the two agree, and plan again', 'doc');
    }
    for (const derived of plan.pages) {
      const before = nodes[derived.number - 1];
      const checked = validateComicPage(serializeComicPage(derived.page), before === undefined ? undefined : loadComicPage(before.comicPage).value);
      if (!checked.ok) return invalid(`page ${derived.number} of the script cannot be written: ${errorsText(checked.errors)}`, undefined, 'doc');
    }
    if (!script.value.link && plan.totals.changed === 0) {
      return changesNothing(`the pages of "${book.value.title}" already read as "${script.value.doc.title}" gives them`, 'change the script, or leave the pages as they are', 'doc');
    }
    return ok({ nodeId: book.value.id, doc: script.value.doc.id, expectedRevision: script.value.revision, expect: expect as ComicDeriveParams['expect'] });
  },
};

export const comicLetter: CommandDescriptor<ComicLetterParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('comic.letter', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    if (!isComicPage(node.value)) {
      return invalid(`"${node.value.id}" is a ${node.value.type}, and only a comic page is lettered`, 'choose the comic page to letter', 'nodeId');
    }
    const book = snapshot.manifest.tree.find((n) => n.id === node.value.parentId);
    if (book === undefined || !isComicFolder(book)) {
      return invalid(`the page "${node.value.title}" is not in a comic book`, 'move the page into a comic book first', 'nodeId');
    }
    const script = requireBookScript(snapshot, p.value, book, { linkIfFree: false });
    if (!script.ok) return script;
    const expect = requireExpectKey(p.value, 'page');
    if (!expect.ok) return expect;
    if (!sameJson(node.value.comicPage ?? null, expect.value ?? null)) return stale(`the page "${node.value.title}"`);

    const panel = p.value['panel'] === undefined ? undefined : requireInteger(p.value, 'panel', { min: 1 });
    if (panel !== undefined && !panel.ok) return panel;
    const line = p.value['line'] === undefined ? undefined : requireInteger(p.value, 'line', { min: 1 });
    if (line !== undefined && !line.ok) return line;
    if (line !== undefined && panel === undefined) {
      return invalid('line names a lettering line of a panel, so it needs panel as well', 'send panel with line, or leave line out to letter every line of the page', 'line');
    }

    const number = comicPagesOf(snapshot, book.id).findIndex((entry) => entry.id === node.value.id) + 1;
    const before = loadComicPage(node.value.comicPage).value;
    const plan = planComicLetter({
      docId: script.value.doc.id,
      body: script.value.body,
      revision: script.value.revision,
      readingDirection: loadComicBook(book.comic).value.readingDirection,
      page: before,
      pageNumber: number,
      ...(panel?.ok ? { panel: panel.value } : {}),
      ...(line?.ok ? { line: line.value } : {}),
      speakerId: codexNames(snapshot),
    });
    if (!plan.ok) {
      return invalid(plan.problems.map((problem) => renderMessage(problem.message)).join(' '), 'derive the page from the script, or change the script, and plan again', 'nodeId');
    }
    const checked = validateComicPage(serializeComicPage(plan.page), before);
    if (!checked.ok) return invalid(errorsText(checked.errors), undefined, 'nodeId');
    if (!plan.changed) {
      return changesNothing(`the page "${node.value.title}" is already lettered as the script gives it`, 'change the script, or leave the page as it is', 'nodeId');
    }
    return ok({
      nodeId: node.value.id,
      doc: script.value.doc.id,
      expectedRevision: script.value.revision,
      expect: expect.value as Record<string, unknown> | null,
      ...(panel?.ok ? { panel: panel.value } : {}),
      ...(line?.ok ? { line: line.value } : {}),
    });
  },
};

export const comicCommands = {
  comicCreateBook,
  comicSetBook,
  comicSetPage,
  comicSetScript,
  comicScriptFromPages,
  comicDerive,
  comicLetter,
} as const;