/**
 * The applies of the seven comic commands — [comics.md §3.2](docs/architecture/comics.md). Their descriptors are the bus's
 * (`comicCommands`, `descriptors-comic.ts`), which check the shape, the strict write boundary of `@caotang/comic` and every
 * guard, so a refusal here is never the first place a bad value is caught.
 *
 * A book's settings are the folder's `comic` field, a page's panels the node's `comicPage` field, and neither is a body: a page is
 * structure only, like a shot, and a script is an ordinary Markdown document. The three small writes (`comic.setBook`,
 * `comic.setPage`, `comic.setScript`) are undone by the same command with its two values swapped, and they do not stamp
 * `updatedAt`, so that the swap returns the manifest to the bytes it had. `comic.createBook` is undone by deleting the folder it
 * made, which takes its pages with it. `comic.scriptFromPages` writes a document and the coverage on several pages at once, so it
 * is `compensable`: one before-image, one restore. `comic.derive` is compensable for the same reason (it links a script, makes pages and
 * rewrites others), and `comic.letter` is undone by `comic.setPage` with its two values swapped, since it changes one page's value.
 */

import {
  comicCommands,
  comicPagesOf,
  type ApplyContext,
  type Command,
  type CommandApply,
  type CommandName,
  type CommandRegistry,
  type ComicCreateBookParams,
  type ComicDeriveParams,
  type ComicLetterParams,
  type ComicScriptFromPagesParams,
  type ComicSetBookParams,
  type ComicSetPageParams,
  type ComicSetScriptParams,
} from '@caotang/bus';
import {
  captureAnchor,
  loadComicBook,
  loadComicPage,
  pageFromTemplate,
  planComicDerive,
  planComicLetter,
  scriptFromPages,
  serializeComicPage,
  speakerResolver,
} from '@caotang/comic';
import { newId } from '@caotang/ids';

import type { ApplyClock } from './commands-project.js';
import { paragraphLinksOfDoc, mapLinksThroughWrite, type AnchorPort } from './body-write.js';
import { replaceList, undoList, type ListUndo } from './picture-registry.js';
import { addDocument, addNode, getBody, getRevision, nodeById, removeNode, setBody, type ProjectState } from './state.js';

type ComicApply<P> = CommandApply<P, ProjectState>;

/** What the title of a script a book made for itself is. */
const SCRIPT_TITLE_SUFFIX = 'script';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function inverseCommand<P>(name: CommandName, params: P, clock: ApplyClock): Command<P> {
  return { id: newId('cmd'), name, params, issuedBy: 'user', createdAt: clock.now() };
}

function narrow<P>(apply: ComicApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

const copy = <T>(value: T): T => structuredClone(value);

function pageNodesOf(state: ProjectState, bookId: string) {
  return comicPagesOf(state, bookId).map((entry) => nodeById(state, entry.id)!);
}

/** The settings a book keeps after its script link is taken out: an object that holds nothing is not stored at all. */
function withoutScriptLink(comic: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (comic === undefined) return undefined;
  const next = { ...comic };
  delete next['scriptDocId'];
  return Object.keys(next).length === 0 ? undefined : next;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function createBookApply(clock: ApplyClock): ComicApply<ComicCreateBookParams> {
  return (state, params, context) => {
    const now = new Date(clock.now());
    const settings = copy(params.settings ?? {});
    const book = addNode(state, { parentId: params.parentId, title: params.title, kind: 'comic', now });
    book.comic = settings;
    const loaded = loadComicBook(settings).value;
    const pageIds: string[] = [];
    for (let i = 0; i < (params.pages ?? 0); i += 1) {
      const page = addNode(state, { parentId: book.id, title: `Page ${i + 1}`, type: 'comic-page', now });
      page.comicPage = serializeComicPage(pageFromTemplate({ size: loaded.pageSize, direction: loaded.readingDirection as 'ltr' | 'rtl' }));
      pageIds.push(page.id);
    }
    context.undo.inverse(inverseCommand('project.deleteNode', { nodeId: book.id }, clock));
    context.report({
      affected: [book, ...pageIds.map((id) => nodeById(state, id)!)].map((node) => ({ nodeId: node.id, title: node.title })),
      summary: `created the comic book "${book.title}" with ${plural(pageIds.length, 'page', 'pages')}`,
    });
    return { nodeId: book.id, pageIds };
  };
}

function setBookApply(clock: ApplyClock): ComicApply<ComicSetBookParams> {
  return (state, params, context) => {
    const node = nodeById(state, params.nodeId);
    if (node === undefined) throw new Error(`comic.setBook reached its apply with no node "${params.nodeId}"`);
    if (params.stored === null) delete node.comic;
    else node.comic = copy(params.stored);
    context.undo.inverse(
      inverseCommand('comic.setBook', { nodeId: node.id, stored: (params.expect ?? null) as Record<string, unknown> | null, expect: params.stored }, clock),
    );
    context.report({ affected: [{ nodeId: node.id, title: node.title }], summary: `changed the settings of the comic book "${node.title}"` });
    return { nodeId: node.id };
  };
}

function setPageApply(clock: ApplyClock): ComicApply<ComicSetPageParams> {
  return (state, params, context) => {
    const node = nodeById(state, params.nodeId);
    if (node === undefined) throw new Error(`comic.setPage reached its apply with no node "${params.nodeId}"`);
    if (params.stored === null) delete node.comicPage;
    else node.comicPage = copy(params.stored);
    context.undo.inverse(
      inverseCommand('comic.setPage', { nodeId: node.id, stored: (params.expect ?? null) as Record<string, unknown> | null, expect: params.stored }, clock),
    );
    context.report({ affected: [{ nodeId: node.id, title: node.title }], summary: `changed the page "${node.title}"` });
    return { nodeId: node.id };
  };
}

function setScriptApply(clock: ApplyClock): ComicApply<ComicSetScriptParams> {
  return (state, params, context) => {
    const node = nodeById(state, params.nodeId);
    if (node === undefined) throw new Error(`comic.setScript reached its apply with no node "${params.nodeId}"`);
    if (params.scriptDocId === null) {
      const rest = withoutScriptLink(node.comic);
      if (rest === undefined) delete node.comic;
      else node.comic = rest;
    } else {
      node.comic = { ...(node.comic ?? {}), scriptDocId: params.scriptDocId };
    }
    context.undo.inverse(
      inverseCommand('comic.setScript', { nodeId: node.id, scriptDocId: params.expect, expect: params.scriptDocId }, clock),
    );
    const title = params.scriptDocId === null ? undefined : (nodeById(state, params.scriptDocId)?.title ?? params.scriptDocId);
    context.report({
      affected: [{ nodeId: node.id, title: node.title }],
      summary: title === undefined ? `unlinked the script of the comic book "${node.title}"` : `linked "${title}" as the script of the comic book "${node.title}"`,
    });
    return { nodeId: node.id, scriptDocId: params.scriptDocId };
  };
}

function scriptFromPagesApply(clock: ApplyClock, anchors: AnchorPort): ComicApply<ComicScriptFromPagesParams> {
  return (state, params, context: ApplyContext) => {
    const book = nodeById(state, params.nodeId);
    if (book === undefined) throw new Error(`comic.scriptFromPages reached its apply with no node "${params.nodeId}"`);
    const linkedId = loadComicBook(book.comic).value.scriptDocId;
    const pages = pageNodesOf(state, book.id);
    const codex = new Map((state.manifest.codex ?? []).map((entry) => [entry.id, entry.name]));
    const generated = scriptFromPages(
      pages.map((node, index) => ({ number: index + 1, page: loadComicPage(node.comicPage).value })),
      { speakerName: (id) => codex.get(id) },
    );

    // The before-image comes first. A page value is copied whole because the restore puts back the exact stored bytes.
    const bookBefore = book.comic === undefined ? undefined : copy(book.comic);
    const pagesBefore = pages.map((node) => ({ node, before: node.comicPage === undefined ? undefined : copy(node.comicPage) }));
    let created: string | undefined;
    let bodyBefore: string | undefined;
    let linksUndo: ListUndo | undefined;
    let docId: string;

    if (linkedId === undefined) {
      const doc = addDocument(state, { parentId: book.id, title: `${book.title} ${SCRIPT_TITLE_SUFFIX}`, type: 'document', kind: 'comic-script', body: generated.body, now: new Date(clock.now()) });
      docId = doc.id;
      created = doc.id;
      book.comic = { ...(book.comic ?? {}), scriptDocId: docId };
    } else {
      docId = linkedId;
      bodyBefore = getBody(state, docId);
      // A re-derived script replaces the document's whole body, so its paragraph links are mapped across the write exactly as
      // `doc.write`'s are (pictures.md §2.3): a picture attached to a paragraph the derivation kept stays on it, and one whose
      // paragraph the derivation dropped is marked orphaned, never silently dropped.
      const priorLinks = paragraphLinksOfDoc(state, docId);
      setBody(state, docId, generated.body);
      if (priorLinks.length > 0) {
        const mapped = mapLinksThroughWrite(state, anchors, docId, bodyBefore, generated.body, getRevision(state, docId));
        if (mapped.changed.length > 0) linksUndo = replaceList(state, 'assetLinks', mapped.next, mapped.changed);
      }
    }
    const revision = getRevision(state, docId);

    // Each panel covers the lines it letters, captured fresh against the body just written. A coverage entry for another document stays.
    const linesByPanel = new Map<string, Record<string, unknown>[]>();
    for (const line of generated.lines) {
      const page = pages[line.pageIndex];
      const anchor = captureAnchor(generated.body, line.from, line.to, revision);
      if (page === undefined || anchor === undefined) continue;
      const key = `${page.id}\u0000${line.panelId}`;
      const entries = linesByPanel.get(key) ?? [];
      entries.push({ kind: 'comic-script-line', docId, anchor, balloonId: line.balloonId });
      linesByPanel.set(key, entries);
    }
    let covered = 0;
    for (const { node } of pagesBefore) {
      if (!isRecord(node.comicPage) || !Array.isArray(node.comicPage['panels'])) continue;
      const next = copy(node.comicPage);
      for (const panel of next['panels'] as unknown[]) {
        if (!isRecord(panel) || typeof panel['id'] !== 'string') continue;
        const kept = (Array.isArray(panel['script']) ? (panel['script'] as unknown[]) : []).filter(
          (entry) => !(isRecord(entry) && entry['kind'] === 'comic-script-line' && entry['docId'] === docId),
        );
        const fresh = linesByPanel.get(`${node.id}\u0000${panel['id']}`) ?? [];
        covered += fresh.length;
        const merged = [...kept, ...fresh];
        if (merged.length === 0) delete panel['script'];
        else panel['script'] = merged;
      }
      node.comicPage = next;
    }

    context.undo.compensate(`restore the script and the pages of "${book.title}"`, () => {
      const held = nodeById(state, book.id);
      if (held !== undefined) {
        if (bookBefore === undefined) delete held.comic;
        else held.comic = copy(bookBefore);
      }
      for (const { node, before } of pagesBefore) {
        const heldPage = nodeById(state, node.id);
        if (heldPage === undefined) continue;
        if (before === undefined) delete heldPage.comicPage;
        else heldPage.comicPage = copy(before);
      }
      if (created !== undefined) {
        if (nodeById(state, created) !== undefined) removeNode(state, created);
      } else if (bodyBefore !== undefined && state.documents.has(docId)) {
        setBody(state, docId, bodyBefore);
        // The prior links were captured independently of the body, so the same undo restores them (pictures.md §2.3).
        if (linksUndo !== undefined) undoList(state, linksUndo);
      }
    });

    const scriptTitle = nodeById(state, docId)?.title ?? docId;
    context.report({
      affected: [{ nodeId: book.id, title: book.title }, { nodeId: docId, title: scriptTitle }],
      summary: `wrote "${scriptTitle}" from the pages of the comic book "${book.title}"`,
    });
    return { nodeId: book.id, scriptDocId: docId, created: created !== undefined, lines: generated.lines.length, covered };
  };
}

function deriveApply(clock: ApplyClock): ComicApply<ComicDeriveParams> {
  return (state, params, context: ApplyContext) => {
    const book = nodeById(state, params.nodeId);
    if (book === undefined) throw new Error(`comic.derive reached its apply with no node "${params.nodeId}"`);
    const docId = params.doc;
    const existing = pageNodesOf(state, book.id);
    const plan = planComicDerive({
      docId,
      body: getBody(state, docId),
      revision: getRevision(state, docId),
      book: loadComicBook(book.comic).value,
      pages: existing.map((node) => loadComicPage(node.comicPage).value),
      speakerId: speakerResolver((state.manifest.codex ?? []).map((entry) => ({ id: entry.id, name: entry.name, aliases: entry.aliases }))),
    });
    if (!plan.ok) throw new Error(`comic.derive reached its apply with a plan its validate refuses: ${plan.problems.map((p) => p.code).join(', ')}`);

    // The before-images come first, and a page value is copied whole because the restore puts back the exact stored bytes.
    const bookBefore = book.comic === undefined ? undefined : copy(book.comic);
    const pagesBefore = existing.map((node) => ({ id: node.id, before: node.comicPage === undefined ? undefined : copy(node.comicPage) }));
    const made: string[] = [];
    const linked = loadComicBook(book.comic).value.scriptDocId === undefined;
    if (linked) book.comic = { ...(book.comic ?? {}), scriptDocId: docId };

    const now = new Date(clock.now());
    const touched: string[] = [];
    const pageIds: string[] = [];
    for (const derived of plan.pages) {
      let node = existing[derived.number - 1];
      if (node === undefined) {
        node = addNode(state, { parentId: book.id, title: `Page ${derived.number}`, type: 'comic-page', now });
        made.push(node.id);
      }
      pageIds.push(node.id);
      if (!derived.created && !derived.changed) continue;
      node.comicPage = serializeComicPage(derived.page);
      touched.push(node.id);
    }

    context.undo.compensate(`restore the pages of "${book.title}"`, () => {
      const held = nodeById(state, book.id);
      if (held !== undefined) {
        if (bookBefore === undefined) delete held.comic;
        else held.comic = copy(bookBefore);
      }
      for (const { id, before } of pagesBefore) {
        const page = nodeById(state, id);
        if (page === undefined) continue;
        if (before === undefined) delete page.comicPage;
        else page.comicPage = copy(before);
      }
      for (const id of made) if (nodeById(state, id) !== undefined) removeNode(state, id);
    });

    const { totals } = plan;
    const scriptTitle = nodeById(state, docId)?.title ?? docId;
    context.report({
      affected: [book, ...touched.map((id) => nodeById(state, id)!)].map((node) => ({ nodeId: node.id, title: node.title })),
      summary: `derived ${plural(totals.pages, 'page', 'pages')} of the comic book "${book.title}" from "${scriptTitle}": ${plural(totals.created, 'new page', 'new pages')}, ${plural(totals.placed, 'balloon', 'balloons')} placed, ${totals.updated} updated, ${totals.removed} removed`,
    });
    return { nodeId: book.id, scriptDocId: docId, linked, pageIds, ...totals };
  };
}

function letterApply(clock: ApplyClock): ComicApply<ComicLetterParams> {
  return (state, params, context) => {
    const node = nodeById(state, params.nodeId);
    const book = node?.parentId === null || node === undefined ? undefined : nodeById(state, node.parentId);
    if (node === undefined || book === undefined) throw new Error(`comic.letter reached its apply with no page "${params.nodeId}" in a book`);
    const plan = planComicLetter({
      docId: params.doc,
      body: getBody(state, params.doc),
      revision: getRevision(state, params.doc),
      readingDirection: loadComicBook(book.comic).value.readingDirection,
      page: loadComicPage(node.comicPage).value,
      pageNumber: pageNodesOf(state, book.id).findIndex((entry) => entry.id === node.id) + 1,
      ...(params.panel === undefined ? {} : { panel: params.panel }),
      ...(params.line === undefined ? {} : { line: params.line }),
      speakerId: speakerResolver((state.manifest.codex ?? []).map((entry) => ({ id: entry.id, name: entry.name, aliases: entry.aliases }))),
    });
    if (!plan.ok) throw new Error(`comic.letter reached its apply with a plan its validate refuses: ${plan.problems.map((p) => p.code).join(', ')}`);

    const before = node.comicPage === undefined ? null : copy(node.comicPage);
    node.comicPage = serializeComicPage(plan.page);
    context.undo.inverse(inverseCommand('comic.setPage', { nodeId: node.id, stored: before, expect: copy(node.comicPage) }, clock));
    context.report({
      affected: [{ nodeId: node.id, title: node.title }],
      summary: `lettered the page "${node.title}" from its script: ${plural(plan.placed, 'balloon', 'balloons')} placed, ${plan.updated} updated`,
    });
    return { nodeId: node.id, placed: plan.placed, updated: plan.updated, lines: plan.lines };
  };
}

/** The seven comic registrations, for the store's registry. None needs a host port, so all are always wired. */
export function comicCommandRegistrations(options: { readonly clock: ApplyClock; readonly anchors: AnchorPort }): Partial<CommandRegistry> {
  const { clock } = options;
  return {
    'comic.createBook': { descriptor: comicCommands.comicCreateBook, apply: narrow(createBookApply(clock)) },
    'comic.setBook': { descriptor: comicCommands.comicSetBook, apply: narrow(setBookApply(clock)) },
    'comic.setPage': { descriptor: comicCommands.comicSetPage, apply: narrow(setPageApply(clock)) },
    'comic.setScript': { descriptor: comicCommands.comicSetScript, apply: narrow(setScriptApply(clock)) },
    'comic.scriptFromPages': { descriptor: comicCommands.comicScriptFromPages, apply: narrow(scriptFromPagesApply(clock, options.anchors)) },
    'comic.derive': { descriptor: comicCommands.comicDerive, apply: narrow(deriveApply(clock)) },
    'comic.letter': { descriptor: comicCommands.comicLetter, apply: narrow(letterApply(clock)) },
  };
}
