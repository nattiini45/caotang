/**
 * The agent's comic tools (comics.md §3.2): `comic.derive`, `comic.letter` and `comic.scriptFromPages` — the three
 * model-backed commands over `@caotang/comic`'s pure planners (`planComicDerive`, `planComicLetter`, `scriptFromPages`).
 * They are native deferred extension rows, like the picture tools: the model names a book (and a script, a page, a
 * panel or a line), and `prepare` fills every guard from the project as it stands — `nodeId`, `doc`,
 * `expectedRevision` and the complete current `expect` values — so a model can never send one, and a page or script
 * that changed since the card was prepared is refused by the bus rather than overwritten. Nothing here writes a
 * picture or any model bytes: derive and letter only ever carry a panel's `assetId` over from the page that was there.
 *
 * Every call dispatches the ordinary `comic.*` command through the bus, so the write is gated, logged and undoable
 * exactly as the spec's table says: derive and scriptFromPages are `write-confirm` (one compensable group), letter is
 * `write-auto` (an exact `comic.setPage` inverse). The plan card's preview is the pure plan itself, as JSON-safe
 * before/after data under one `kind` discriminator (`ComicPreview`), which the app renders.
 *
 * **The module is self-contained until the registry takes it.** `COMIC_TOOL_NAMES`, `COMIC_TOOL_METADATA` and
 * `COMIC_DEFINITIONS` are what `metadata.ts` and `table.ts` join; `COMIC_ACCEPT_EDITS_TOOLS` takes `comic.letter`
 * and not the other two (comics.md §3.2).
 */

// i18n: model-facing

import { COMIC_SCRIPT_KIND, ok, err, comicPagesOf, type CommandError } from '@caotang/bus';
import {
  loadComicBook,
  loadComicPage,
  planComicDerive,
  planComicLetter,
  renderMessage,
  scriptFromPages,
  serializeComicPage,
  speakerResolver,
  type DeriveTotals,
} from '@caotang/comic';
import { getBody, getRevision, nodeById, type ProjectState } from '@caotang/store';

import { failure, invalidParams } from '../errors.js';
import type { ToolMetadata } from '../metadata.js';
import { resolveNode, type NodeFilter } from '../resolve.js';
import { param, type ObjectSpec } from '../schema.js';
import type { CallParams, PreparedCall, PrepareFn } from '../types.js';
import { plural } from '../util.js';
import { checkCommand } from './common.js';

export const COMIC_TOOL_NAMES = ['comic.derive', 'comic.letter', 'comic.scriptFromPages'] as const;

export type ComicToolName = (typeof COMIC_TOOL_NAMES)[number];

/** A metadata row in `ToolMetadata`'s shape, named by a comic tool until `metadata.ts` adds the names to `ToolName`. */
export type ComicToolMetadata = Omit<ToolMetadata, 'name'> & { readonly name: ComicToolName };

const AUTO_SENTENCE = 'Applies automatically within an approved turn.';
const CONFIRM_SENTENCE = 'Requires user confirmation.';

export const COMIC_TOOL_METADATA: readonly ComicToolMetadata[] = [
  {
    name: 'comic.derive',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 2000,
    descriptionVersion: 1,
    description: `Derive a comic book’s pages — panels, balloon text and fresh script anchors — from a comic script, as one card that shows every page before and after, including the pages it creates and the script link it sets when the book has none. Name the book by title or id, and the script by title or id (default: the script the book links). The script’s revision and the complete current value of every page are read from the project and guard the write, so a page or script changed since was read is refused, never overwritten. It generates no picture and never changes one a panel holds. ${CONFIRM_SENTENCE}`,
    surface: 'extension',
    load: 'deferred',
    keywords: ['comic', 'derive', 'script', 'pages', 'panels', 'balloons', 'full script'],
  },
  {
    name: 'comic.letter',
    risk: 'write-auto',
    undoable: true,
    response_token_cap: 1500,
    descriptionVersion: 1,
    description: `Letter one page of a comic book from the book’s linked script: place a balloon for each of the script page’s lettering lines and update the balloons it already covers, optionally narrowed to one panel (panel, counted from 1) and one line of it (line). Name the book and the page by title or id. The script’s revision and the page’s complete current value are read from the project and guard the write, so a change made since was read is refused, never overwritten. It never adds or moves a panel and never removes a balloon. ${AUTO_SENTENCE}`,
    surface: 'extension',
    load: 'deferred',
    keywords: ['comic', 'letter', 'lettering', 'balloons', 'script', 'page', 'panel', 'line'],
  },
  {
    name: 'comic.scriptFromPages',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 2000,
    descriptionVersion: 1,
    description: `Write a comic book’s comic-script document from its pages (the Marvel method): every balloon becomes a script line, and a fresh anchor for each line is captured into the covering panel. A book with no script gets a new script document and the link in the same undo group; a book that has one updates it against the revision read. The card shows the whole script before and after plus the link and coverage changes. Name the book by title or id. ${CONFIRM_SENTENCE}`,
    surface: 'extension',
    load: 'deferred',
    keywords: ['comic', 'script', 'marvel', 'pages', 'write script', 'from pages', 'coverage'],
  },
];

/* ------------------------------------------------------------------ *
 * Small readers over untrusted params (already shape-checked by the schema)
 * ------------------------------------------------------------------ */

const text = (source: Readonly<Record<string, unknown>>, key: string): string => {
  const value = source[key];
  return typeof value === 'string' ? value : '';
};

/** The node filters the selectors resolve against: a comic book, a comic page, a comic script. */
const COMIC_BOOK: NodeFilter = (node) => node.type === 'folder' && node.kind === 'comic';
const COMIC_PAGE: NodeFilter = (node) => node.type === 'comic-page';
const COMIC_SCRIPT: NodeFilter = (node) => node.type === 'document' && node.kind === COMIC_SCRIPT_KIND;

/** The codex name resolver the pure planners take: a script speaker name to the one entry it stands for. */
function speakerIdOf(state: ProjectState) {
  return speakerResolver((state.manifest.codex ?? []).map((entry) => ({ id: entry.id, name: entry.name, aliases: entry.aliases })));
}

const titleOf = (state: ProjectState, id: string): string => nodeById(state, id)?.title ?? id;

/** How many of a page's panels' coverage entries are this script's, the count `comic.scriptFromPages` replaces. */
function coverageCountOf(node: { readonly comicPage?: Readonly<Record<string, unknown>> }, docId: string | undefined): number {
  if (docId === undefined || node.comicPage === undefined) return 0;
  const panels = Array.isArray(node.comicPage['panels']) ? (node.comicPage['panels'] as unknown[]) : [];
  let count = 0;
  for (const panel of panels) {
    if (typeof panel !== 'object' || panel === null || !Array.isArray((panel as Record<string, unknown>)['script'])) continue;
    for (const entry of (panel as Record<string, unknown>)['script'] as unknown[]) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        (entry as Record<string, unknown>)['kind'] === 'comic-script-line' &&
        (entry as Record<string, unknown>)['docId'] === docId
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * Preview shapes — one union under a `kind` discriminator, all JSON-safe
 * ------------------------------------------------------------------ */

/** A named node the card shows: its id and its human title. */
export interface ComicNodeRef {
  readonly id: string;
  readonly title: string;
}

/** One page of a derive card: the stored value before and after, and what the plan did to it. */
export interface ComicDerivePagePreview {
  readonly number: number;
  /** The page node's id, or null for a page the derive creates. */
  readonly pageId: string | null;
  readonly title: string;
  readonly created: boolean;
  readonly changed: boolean;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown>;
  readonly panels: number;
  readonly lines: number;
  readonly placed: number;
  readonly updated: number;
  readonly removed: number;
}

/** The derive card: every page before and after, plus the script link change. */
export interface ComicDerivePreview {
  readonly kind: 'comic-derive';
  readonly book: ComicNodeRef;
  readonly script: ComicNodeRef & { readonly revision: number };
  /** The book's script link before the derive and after it (the script's id; the derive sets it when the book had none). */
  readonly link: { readonly before: string | null; readonly after: string };
  readonly pages: readonly ComicDerivePagePreview[];
  readonly totals: DeriveTotals;
}

/** The letter card: the whole page before and after. */
export interface ComicLetterPreview {
  readonly kind: 'comic-letter';
  readonly book: ComicNodeRef;
  readonly page: ComicNodeRef & { readonly number: number };
  readonly script: ComicNodeRef & { readonly revision: number };
  readonly panel?: number;
  readonly line?: number;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown>;
  readonly changed: boolean;
  readonly placed: number;
  readonly updated: number;
  readonly lines: number;
}

/** One page's coverage change in a scriptFromPages card: this script's covered lines before and after. */
export interface ComicScriptCoveragePreview {
  readonly number: number;
  readonly pageId: string;
  readonly before: number;
  readonly after: number;
}

/** The scriptFromPages card: the whole script before and after, plus the link and coverage changes. */
export interface ComicScriptFromPagesPreview {
  readonly kind: 'comic-script-from-pages';
  readonly book: ComicNodeRef;
  /** The link before and after; `after` is null when the command creates the script document, which `created` says. */
  readonly link: { readonly before: string | null; readonly after: string | null; readonly created: boolean };
  readonly script: { readonly id: string | null; readonly title: string; readonly revision: number | null };
  readonly body: { readonly before: string | null; readonly after: string };
  readonly lines: number;
  readonly coverage: { readonly pages: readonly ComicScriptCoveragePreview[]; readonly before: number; readonly after: number };
}

/** What the plan card shows for a comic tool, before anything runs. */
export type ComicPreview = ComicDerivePreview | ComicLetterPreview | ComicScriptFromPagesPreview;

/* ------------------------------------------------------------------ *
 * comic.derive
 * ------------------------------------------------------------------ */

export const comicDeriveParams: ObjectSpec = param.object(
  'The comic book to derive, and the script to derive from.',
  {
    book: param.string('The comic book: a folder title, or its id. An ambiguous title lists its candidates.', { nonBlank: true }),
    script: param.string(
      'The comic script to derive the pages from: a document title, or its id. Default: the script the book links. A book with no link gets this one linked, when no other book holds it.',
      { nonBlank: true },
    ),
  },
  ['book'],
);

export const prepareComicDerive: PrepareFn = (params, context) => {
  const { state } = context;
  const book = resolveNode(state, text(params, 'book'), COMIC_BOOK, 'comic book', 'params.book');
  if (!book.ok) return err(book.error);
  const settings = loadComicBook(book.value.comic).value;

  // The script: the one named, else the book's linked one. Never guessed: an unlinked book without a named script is refused.
  let docId: string;
  const scriptRef = text(params, 'script');
  if (scriptRef.trim() !== '') {
    const doc = resolveNode(state, scriptRef, COMIC_SCRIPT, 'comic script', 'params.script');
    if (!doc.ok) return err(doc.error);
    docId = doc.value.id;
  } else if (settings.scriptDocId !== undefined) {
    docId = settings.scriptDocId;
  } else {
    return err(
      invalidParams(
        `"${book.value.title}" has no script linked, so name the comic script to derive from`,
        'pass script with the title or id of a comic-script document',
        'params.script',
      ),
    );
  }

  // The guards are read here, from the project as it stands: the script's revision and every page's stored value.
  const revision = getRevision(state, docId);
  const pages = comicPagesOf(state, book.value.id);
  const command: CallParams = {
    nodeId: book.value.id,
    doc: docId,
    expectedRevision: revision,
    expect: pages.map((page) => page.comicPage ?? null),
  };
  const checked = checkCommand(context, 'comic.derive', command);
  if (!checked.ok) return err(checked.error);

  // The preview is the pure plan over the same inputs the apply will read, so the card shows exactly what will be written.
  const plan = planComicDerive({
    docId,
    body: getBody(state, docId),
    revision,
    book: settings,
    pages: pages.map((page) => loadComicPage(page.comicPage).value),
    speakerId: speakerIdOf(state),
  });
  if (!plan.ok) {
    return err(
      invalidParams(
        plan.problems.map((problem) => renderMessage(problem.message)).join(' '),
        'change the script or the pages so the two agree, and plan again',
        'params.script',
      ),
    );
  }

  const preview: ComicDerivePreview = {
    kind: 'comic-derive',
    book: { id: book.value.id, title: book.value.title },
    script: { id: docId, title: titleOf(state, docId), revision },
    link: { before: settings.scriptDocId ?? null, after: docId },
    pages: plan.pages.map((derived) => {
      const existing = pages[derived.number - 1];
      return {
        number: derived.number,
        pageId: existing?.id ?? null,
        title: existing?.title ?? `Page ${derived.number}`,
        created: derived.created,
        changed: derived.changed,
        before: (existing?.comicPage ?? null) as Record<string, unknown> | null,
        after: serializeComicPage(derived.page),
        panels: derived.panels,
        lines: derived.lines,
        placed: derived.placed,
        updated: derived.updated,
        removed: derived.removed,
      };
    }),
    totals: { ...plan.totals },
  };

  return ok({
    commands: [{ name: 'comic.derive', params: checked.value }],
    preview,
    finish: (done) => {
      const outcome = done[0]?.outcome;
      if (outcome === undefined) {
        return failure({ code: 'internal', message: '"comic.derive" dispatched nothing', correctiveHint: 'report this as a defect' });
      }
      const result = outcome.result as Record<string, unknown>;
      const scriptTitle = titleOf(state, String(result['scriptDocId'] ?? docId));
      const pages_ = Number(result['pages'] ?? 0);
      const created = Number(result['created'] ?? 0);
      const placed = Number(result['placed'] ?? 0);
      const updated = Number(result['updated'] ?? 0);
      const removed = Number(result['removed'] ?? 0);
      return ok({
        data: {
          book: { id: book.value.id, title: book.value.title },
          script: { id: docId, title: scriptTitle },
          linked: result['linked'] === true,
          pageIds: result['pageIds'] ?? [],
          pages: result['pages'],
          created: result['created'],
          changed: result['changed'],
          placed: result['placed'],
          updated: result['updated'],
          removed: result['removed'],
        },
        summary: `derived ${plural(pages_, 'page')} of the comic book "${book.value.title}" from "${scriptTitle}": ${plural(created, 'new page')}, ${plural(placed, 'balloon')} placed, ${updated} updated, ${removed} removed`,
        affected: [...outcome.affected],
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
      });
    },
  } satisfies PreparedCall);
};

/* ------------------------------------------------------------------ *
 * comic.letter
 * ------------------------------------------------------------------ */

export const comicLetterParams: ObjectSpec = param.object(
  'The comic book and the page of it to letter from the book’s linked script.',
  {
    book: param.string('The comic book: a folder title, or its id. An ambiguous title lists its candidates.', { nonBlank: true }),
    page: param.string('The page to letter: its title, or its id, among the book’s pages. An ambiguous title lists its candidates.', { nonBlank: true }),
    panel: param.integer('Letter only this panel of the script page, counted from 1. Default: every panel of the page.', { minimum: 1 }),
    line: param.integer('Letter only this lettering line of that panel, counted from 1. Needs panel.', { minimum: 1 }),
  },
  ['book', 'page'],
);

/** `line` names a line of a panel, so it is meaningless without `panel` (the command refuses it the same way). */
export function refineComicLetter(params: CallParams): CommandError | undefined {
  if (params['line'] !== undefined && params['panel'] === undefined) {
    return invalidParams('line names a lettering line of a panel, so it needs panel as well', 'send panel with line, or leave line out to letter every line of the page', 'params.line');
  }
  return undefined;
}

export const prepareComicLetter: PrepareFn = (params, context) => {
  const { state } = context;
  const book = resolveNode(state, text(params, 'book'), COMIC_BOOK, 'comic book', 'params.book');
  if (!book.ok) return err(book.error);
  const page = resolveNode(state, text(params, 'page'), COMIC_PAGE, 'comic page', 'params.page');
  if (!page.ok) return err(page.error);
  if (page.value.parentId !== book.value.id) {
    return err(
      invalidParams(`the page "${page.value.title}" is not in the comic book "${book.value.title}"`, `choose one of "${book.value.title}"’s pages`, 'params.page'),
    );
  }

  // Letter reads the book's linked script; it never links one itself.
  const settings = loadComicBook(book.value.comic).value;
  const linked = settings.scriptDocId;
  if (linked === undefined) {
    return err(
      invalidParams(
        `"${book.value.title}" has no script linked, so there is nothing to letter from`,
        'link a comic script to the book first, or derive the book’s pages from a script with comic.derive',
        'params.book',
      ),
    );
  }

  const panel = typeof params['panel'] === 'number' ? params['panel'] : undefined;
  const line = typeof params['line'] === 'number' ? params['line'] : undefined;
  const revision = getRevision(state, linked);
  const command: CallParams = {
    nodeId: page.value.id,
    doc: linked,
    expectedRevision: revision,
    expect: page.value.comicPage ?? null,
    ...(panel === undefined ? {} : { panel }),
    ...(line === undefined ? {} : { line }),
  };
  const checked = checkCommand(context, 'comic.letter', command);
  if (!checked.ok) return err(checked.error);

  const pages = comicPagesOf(state, book.value.id);
  const number = pages.findIndex((entry) => entry.id === page.value.id) + 1;
  const plan = planComicLetter({
    docId: linked,
    body: getBody(state, linked),
    revision,
    readingDirection: settings.readingDirection,
    page: loadComicPage(page.value.comicPage).value,
    pageNumber: number,
    ...(panel === undefined ? {} : { panel }),
    ...(line === undefined ? {} : { line }),
    speakerId: speakerIdOf(state),
  });
  if (!plan.ok) {
    return err(
      invalidParams(
        plan.problems.map((problem) => renderMessage(problem.message)).join(' '),
        'derive the page from the script with comic.derive, or change the script, and letter again',
        'params.page',
      ),
    );
  }

  const preview: ComicLetterPreview = {
    kind: 'comic-letter',
    book: { id: book.value.id, title: book.value.title },
    page: { id: page.value.id, title: page.value.title, number },
    script: { id: linked, title: titleOf(state, linked), revision },
    ...(panel === undefined ? {} : { panel }),
    ...(line === undefined ? {} : { line }),
    before: (page.value.comicPage ?? null) as Record<string, unknown> | null,
    after: serializeComicPage(plan.page),
    changed: plan.changed,
    placed: plan.placed,
    updated: plan.updated,
    lines: plan.lines,
  };

  return ok({
    commands: [{ name: 'comic.letter', params: checked.value }],
    preview,
    finish: (done) => {
      const outcome = done[0]?.outcome;
      if (outcome === undefined) {
        return failure({ code: 'internal', message: '"comic.letter" dispatched nothing', correctiveHint: 'report this as a defect' });
      }
      const result = outcome.result as Record<string, unknown>;
      const scriptTitle = titleOf(state, linked);
      const placed = Number(result['placed'] ?? 0);
      const updated = Number(result['updated'] ?? 0);
      return ok({
        data: {
          book: { id: book.value.id, title: book.value.title },
          page: { id: page.value.id, title: page.value.title, number },
          script: { id: linked, title: scriptTitle },
          ...(panel === undefined ? {} : { panel }),
          ...(line === undefined ? {} : { line }),
          placed: result['placed'],
          updated: result['updated'],
          lines: result['lines'],
        },
        summary: `lettered the page "${page.value.title}" of the comic book "${book.value.title}" from "${scriptTitle}": ${plural(placed, 'balloon')} placed, ${updated} updated`,
        affected: [...outcome.affected],
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
      });
    },
  } satisfies PreparedCall);
};

/* ------------------------------------------------------------------ *
 * comic.scriptFromPages
 * ------------------------------------------------------------------ */

export const comicScriptFromPagesParams: ObjectSpec = param.object(
  'The comic book whose pages to write the script from.',
  {
    book: param.string('The comic book: a folder title, or its id. An ambiguous title lists its candidates.', { nonBlank: true }),
  },
  ['book'],
);

export const prepareComicScriptFromPages: PrepareFn = (params, context) => {
  const { state } = context;
  const book = resolveNode(state, text(params, 'book'), COMIC_BOOK, 'comic book', 'params.book');
  if (!book.ok) return err(book.error);

  // The guard: the linked script's revision the plan read, filled here; absent when the book has no script, because the command makes one.
  const settings = loadComicBook(book.value.comic).value;
  const linked = settings.scriptDocId;
  const command: CallParams = {
    nodeId: book.value.id,
    ...(linked === undefined ? {} : { expectedRevision: getRevision(state, linked) }),
  };
  const checked = checkCommand(context, 'comic.scriptFromPages', command);
  if (!checked.ok) return err(checked.error);

  // The preview is the pure writer over the book's pages as they stand, so the card shows the script it will write.
  const pages = comicPagesOf(state, book.value.id);
  const codexName = new Map((state.manifest.codex ?? []).map((entry) => [entry.id, entry.name]));
  const generated = scriptFromPages(
    pages.map((node, index) => ({ number: index + 1, page: loadComicPage(node.comicPage).value })),
    { speakerName: (id) => codexName.get(id) },
  );
  const coveragePages = pages.map((node, index) => ({
    number: index + 1,
    pageId: node.id,
    before: coverageCountOf(node, linked),
    after: generated.lines.filter((line) => line.pageIndex === index).length,
  }));

  const preview: ComicScriptFromPagesPreview = {
    kind: 'comic-script-from-pages',
    book: { id: book.value.id, title: book.value.title },
    link: { before: linked ?? null, after: linked ?? null, created: linked === undefined },
    script: {
      id: linked ?? null,
      title: linked === undefined ? `${book.value.title} script` : titleOf(state, linked),
      revision: linked === undefined ? null : getRevision(state, linked),
    },
    body: { before: linked === undefined ? null : getBody(state, linked), after: generated.body },
    lines: generated.lines.length,
    coverage: {
      pages: coveragePages,
      before: coveragePages.reduce((sum, entry) => sum + entry.before, 0),
      after: generated.lines.length,
    },
  };

  return ok({
    commands: [{ name: 'comic.scriptFromPages', params: checked.value }],
    preview,
    finish: (done) => {
      const outcome = done[0]?.outcome;
      if (outcome === undefined) {
        return failure({ code: 'internal', message: '"comic.scriptFromPages" dispatched nothing', correctiveHint: 'report this as a defect' });
      }
      const result = outcome.result as Record<string, unknown>;
      const scriptDocId = String(result['scriptDocId'] ?? '');
      const scriptTitle = titleOf(state, scriptDocId);
      const created = result['created'] === true;
      const lines = Number(result['lines'] ?? 0);
      const covered = Number(result['covered'] ?? 0);
      return ok({
        data: {
          book: { id: book.value.id, title: book.value.title },
          script: { id: scriptDocId, title: scriptTitle, created },
          lines: result['lines'],
          covered: result['covered'],
        },
        summary: created
          ? `created "${scriptTitle}" from the pages of the comic book "${book.value.title}" (${plural(lines, 'line')})`
          : `wrote "${scriptTitle}" from the pages of the comic book "${book.value.title}" (${plural(lines, 'line')} lettered, ${covered} covered)`,
        affected: [...outcome.affected],
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
      });
    },
  } satisfies PreparedCall);
};

/* ------------------------------------------------------------------ *
 * What the registry joins
 * ------------------------------------------------------------------ */

export type ComicDefinition = {
  readonly kind: 'native';
  readonly params: ObjectSpec;
  readonly prepare: PrepareFn;
  readonly refine?: (params: CallParams) => CommandError | undefined;
};

/** The registry definitions, in `table.ts`'s `Definition` shape, keyed by tool name. */
export const COMIC_DEFINITIONS: Readonly<Record<ComicToolName, ComicDefinition>> = {
  'comic.derive': { kind: 'native', params: comicDeriveParams, prepare: prepareComicDerive },
  'comic.letter': { kind: 'native', params: comicLetterParams, prepare: prepareComicLetter, refine: refineComicLetter },
  'comic.scriptFromPages': { kind: 'native', params: comicScriptFromPagesParams, prepare: prepareComicScriptFromPages },
};

/** The write-auto tools `ACCEPT_EDITS_TOOLS` takes (comics.md §3.2): `comic.letter` only; the other two are confirm-class. */
export const COMIC_ACCEPT_EDITS_TOOLS: readonly ComicToolName[] = ['comic.letter'];
