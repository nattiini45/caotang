/**
 * The comic commands — `comic.createBook`, `comic.setBook`, `comic.setPage`, `comic.setScript` and `comic.scriptFromPages`
 * ([comics.md §3.2](docs/architecture/comics.md)) — and what the project does with a comic book it holds.
 *
 * What these pin: each command is one undo group that puts the manifest back exactly; a guarded write is refused, with nothing changed,
 * when the value it read is no longer the stored one; a book and its pages survive a save, a reload and a bundle, including a value
 * an older or newer build wrote; a panel's picture is a typed use that blocks the picture's deletion; a script is linked in one
 * direction and deleting it unlinks the book in the same undo group; and a script written from the pages never overwrites a script
 * somebody changed since it was read.
 */

import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
  type CommandError,
  type CommandName,
  type ExecutionOutcome,
  type Result,
  type UndoStore,
} from '@caotang/bus';
import { loadComicPage, panelPictureRefs } from '@caotang/comic';
import { captureParagraphAnchor } from '@caotang/pictures';
import {
  MemoryArtifactFs,
  addDocument,
  cloneProjectState,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  exportProjectZip,
  getBody,
  getRevision,
  importProjectZip,
  nodeById,
  readProject,
  setBody,
  writeProject,
  type CodexEntry,
  type ProjectState,
  type TreeNode,
} from '../src/index.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const clock = { now: () => Date.parse('2026-10-09T10:00:00.000Z') };
const CHAPTER = 'n_7K2QX9M4A1';
const ELENA = 'c_5H8QK2M9RT';
const ART = 'a_7K2QX9M4A1';

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  state.manifest.tree.push({
    id: CHAPTER,
    parentId: 'manuscript',
    type: 'folder',
    title: 'Chapter One',
    order: 10,
    status: null,
    label: null,
    keywords: [],
    synopsis: '',
    notes: '',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } satisfies TreeNode);
  const elena: CodexEntry = {
    id: ELENA,
    name: 'Elena Voss',
    aliases: [],
    type: 'character',
    description: '',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  state.manifest.codex = [elena];
  state.manifest.assets = [
    { id: ART, file: `${ART}.png`, mime: 'image/png', sha256: '7k2qx9m4a1'.padEnd(64, '0'), bytes: 100, createdAt: NOW.toISOString() },
  ];
  return state;
}

interface Host {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  readonly bus: BusContext<ProjectState>;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
}

function host(state: ProjectState = project()): Host {
  const registry = createProjectCommandRegistry({ clock });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => undefined,
  };
  return { state, undo, bus, registry };
}

let ordinal = 0;
function run(h: Host, name: CommandName, params: Record<string, unknown>): Result<ExecutionOutcome, CommandError> {
  ordinal += 1;
  const command: Command = { id: `cmd_COMICCMDS${String(ordinal).padStart(3, '0')}`, name, params, issuedBy: 'user', createdAt: 1_000 };
  return execute(command, h.bus, h.registry);
}

function value(result: Result<ExecutionOutcome, CommandError>): Record<string, unknown> {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value.result as Record<string, unknown>;
}

function refusal(result: Result<ExecutionOutcome, CommandError>): CommandError {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

function undoLast(h: Host): void {
  const last = h.undo.groups().at(-1);
  if (last === undefined) throw new Error('nothing to undo');
  const result = h.undo.undo(last.id);
  if (!result.ok) throw new Error(`undo refused: ${result.error.message}`);
}

const snapshotOf = (state: ProjectState): unknown =>
  JSON.parse(JSON.stringify({ tree: state.manifest.tree, counts: state.manifest.derived.wordCounts, docs: [...state.documents.values()].map((d) => [d.id, d.body]) }));

function newBook(h: Host, extra: Record<string, unknown> = {}): { bookId: string; pageIds: string[] } {
  const made = value(run(h, 'comic.createBook', { parentId: CHAPTER, title: 'Issue One', pages: 2, ...extra }));
  return { bookId: made['nodeId'] as string, pageIds: made['pageIds'] as string[] };
}

const node = (h: Host, id: string): TreeNode => nodeById(h.state, id)!;

/** A page with one panel holding one balloon, so there is something to letter and to cover. */
function lettered(h: Host, pageId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const page = structuredClone(node(h, pageId).comicPage!);
  const panels = page['panels'] as Record<string, unknown>[];
  panels[0] = {
    ...panels[0],
    ...extra,
    balloons: [{ id: 'bl_8M2QX7K4A1', kind: 'speech', text: 'The ferry is late.', speaker: ELENA, rect: [0.05, 0.05, 0.2, 0.1] }],
  };
  return page;
}

function setPage(h: Host, pageId: string, stored: Record<string, unknown> | null) {
  return run(h, 'comic.setPage', { nodeId: pageId, stored, expect: node(h, pageId).comicPage ?? null });
}

describe('comic.createBook', () => {
  it('makes a comic folder with its settings and pages, and one undo takes them all', () => {
    const h = host();
    const before = snapshotOf(h.state);
    const { bookId, pageIds } = newBook(h, { settings: { readingDirection: 'rtl', pageSize: 'manga-b5' } });

    const book = node(h, bookId);
    expect(book).toMatchObject({ type: 'folder', kind: 'comic', parentId: CHAPTER, title: 'Issue One' });
    expect(book.comic).toMatchObject({ readingDirection: 'rtl', pageSize: 'manga-b5' });
    expect(pageIds).toHaveLength(2);
    for (const id of pageIds) {
      expect(node(h, id)).toMatchObject({ type: 'comic-page', parentId: bookId });
      const page = loadComicPage(node(h, id).comicPage).value;
      expect(page.size).toBe('manga-b5');
      expect(page.panels).toHaveLength(6);
    }
    expect(h.state.documents.size).toBe(0);

    undoLast(h);
    expect(snapshotOf(h.state)).toEqual(before);
  });

  it('refuses a book in a storyboard, in another book, at the root, or with a bad setting', () => {
    const h = host();
    const { bookId } = newBook(h);
    expect(refusal(run(h, 'comic.createBook', { parentId: bookId, title: 'Inner' })).code).toBe('invalid-params');
    expect(refusal(run(h, 'comic.createBook', { parentId: 'root', title: 'Rooted' })).code).toBe('invalid-params');
    expect(refusal(run(h, 'comic.createBook', { parentId: CHAPTER, title: 'Bad', settings: { pageSize: 'postcard' } })).code).toBe('invalid-params');
    expect(refusal(run(h, 'comic.createBook', { parentId: CHAPTER, title: 'Linked', settings: { scriptDocId: 'n_3W8RN2TQ6C' } })).code).toBe('invalid-params');
    expect(refusal(run(h, 'comic.createBook', { parentId: CHAPTER, title: 'Many', pages: 101 })).code).toBe('limit-exceeded');
  });
});

describe('binder.create and binder.move for pages', () => {
  it('makes a page in a book with the book\'s own size, and refuses one anywhere else', () => {
    const h = host();
    const { bookId } = newBook(h, { settings: { pageSize: 'manga-b5' } });
    const made = value(run(h, 'binder.create', { parentId: bookId, type: 'comic-page', title: 'Page 3' }));
    const page = loadComicPage(node(h, made['nodeId'] as string).comicPage).value;
    expect(page.size).toBe('manga-b5');
    expect(page.panels.length).toBeGreaterThan(0);

    expect(refusal(run(h, 'binder.create', { parentId: CHAPTER, type: 'comic-page', title: 'Loose' })).code).toBe('invalid-params');
    expect(refusal(run(h, 'binder.create', { parentId: bookId, type: 'document', title: 'Prose' })).code).toBe('invalid-params');
    undoLast(h);
    expect(nodeById(h.state, made['nodeId'] as string)).toBeUndefined();
  });

  it('reorders pages inside the book, and refuses to move a page out of it', () => {
    const h = host();
    const { bookId, pageIds } = newBook(h);
    value(run(h, 'binder.move', { nodeId: pageIds[1], newParentId: bookId, index: 0 }));
    const order = h.state.manifest.tree.filter((n) => n.parentId === bookId).sort((a, b) => a.order - b.order).map((n) => n.id);
    expect(order).toEqual([pageIds[1], pageIds[0]]);
    expect(refusal(run(h, 'binder.move', { nodeId: pageIds[0], newParentId: CHAPTER })).code).toBe('invalid-params');
  });
});

describe('comic.setBook', () => {
  it('writes the settings whole, refuses a stale expectation, and undoes exactly', () => {
    const h = host();
    const { bookId } = newBook(h);
    const before = structuredClone(node(h, bookId).comic);
    const stored = { ...before, readingDirection: 'rtl', letteringFace: 'comic-neue', capsTransform: false, esszett: false, pageSize: 'us-comic' };
    value(run(h, 'comic.setBook', { nodeId: bookId, stored, expect: before }));
    expect(node(h, bookId).comic).toMatchObject({ readingDirection: 'rtl' });

    const stale = refusal(run(h, 'comic.setBook', { nodeId: bookId, stored: { ...stored, esszett: true }, expect: before }));
    expect(stale.code).toBe('revision-conflict');
    expect(node(h, bookId).comic).toMatchObject({ readingDirection: 'rtl', esszett: false });

    undoLast(h);
    expect(node(h, bookId).comic).toEqual(before);
  });

  it('keeps a value another build wrote, and refuses a new one it does not know', () => {
    const h = host();
    const { bookId } = newBook(h);
    node(h, bookId).comic = { readingDirection: 'boustrophedon', futureKey: { nested: true } };
    const current = structuredClone(node(h, bookId).comic)!;
    const kept = { ...current, esszett: true };
    value(run(h, 'comic.setBook', { nodeId: bookId, stored: kept, expect: current }));
    expect(node(h, bookId).comic).toMatchObject({ readingDirection: 'boustrophedon', futureKey: { nested: true }, esszett: true });

    const now = structuredClone(node(h, bookId).comic)!;
    const bad = refusal(run(h, 'comic.setBook', { nodeId: bookId, stored: { ...now, readingDirection: 'diagonal' }, expect: now }));
    expect(bad.code).toBe('invalid-params');
  });

  it('does not change the script link, and says nothing changed when nothing did', () => {
    const h = host();
    const { bookId } = newBook(h);
    const current = node(h, bookId).comic ?? null;
    expect(refusal(run(h, 'comic.setBook', { nodeId: bookId, stored: { ...(current ?? {}), scriptDocId: 'n_3W8RN2TQ6C' }, expect: current })).code).toBe('invalid-params');
    expect(refusal(run(h, 'comic.setBook', { nodeId: bookId, stored: current, expect: current })).code).toBe('invalid-params');
  });
});

describe('comic.setPage', () => {
  it('writes the page whole, refuses a stale expectation, and one undo puts the old page back', () => {
    const h = host();
    const { pageIds } = newBook(h);
    const before = structuredClone(node(h, pageIds[0]!).comicPage);
    const next = lettered(h, pageIds[0]!);
    value(setPage(h, pageIds[0]!, next));
    expect((node(h, pageIds[0]!).comicPage!['panels'] as { balloons: unknown[] }[])[0]!.balloons).toHaveLength(1);

    const stale = refusal(run(h, 'comic.setPage', { nodeId: pageIds[0], stored: before, expect: before }));
    expect(stale.code).toBe('revision-conflict');

    undoLast(h);
    expect(node(h, pageIds[0]!).comicPage).toEqual(before);
  });

  it('refuses a picture the project does not hold and a speaker that is a name', () => {
    const h = host();
    const { pageIds } = newBook(h);
    const missing = refusal(setPage(h, pageIds[0]!, lettered(h, pageIds[0]!, { assetId: 'a_3W8RN2TQ6C' })));
    expect(missing.message).toContain('a_3W8RN2TQ6C');

    const page = lettered(h, pageIds[0]!);
    ((page['panels'] as Record<string, unknown>[])[0]!['balloons'] as Record<string, unknown>[])[0]!['speaker'] = 'Elena';
    expect(refusal(setPage(h, pageIds[0]!, page)).message).toContain('codex');
    expect(refusal(run(h, 'comic.setPage', { nodeId: 'manuscript', stored: page, expect: null })).code).toBe('invalid-params');
  });

  it('keeps a picture the page already names after the picture is lost, so the page stays editable', () => {
    const h = host();
    const { pageIds } = newBook(h);
    value(setPage(h, pageIds[0]!, lettered(h, pageIds[0]!, { assetId: ART })));
    h.state.manifest.assets = [];
    const page = structuredClone(node(h, pageIds[0]!).comicPage!);
    ((page['panels'] as Record<string, unknown>[])[0]!['balloons'] as Record<string, unknown>[])[0]!['text'] = 'Still late.';
    value(setPage(h, pageIds[0]!, page));
  });

  it('keeps a balloon kind and a key an older or newer build wrote', () => {
    const h = host();
    const { pageIds } = newBook(h);
    const page = lettered(h, pageIds[0]!);
    const first = (page['panels'] as Record<string, unknown>[])[0]!;
    (first['balloons'] as Record<string, unknown>[])[0]!['kind'] = 'telepathy';
    page['futureKey'] = [1, 2];
    node(h, pageIds[0]!).comicPage = structuredClone(page);
    const next = structuredClone(page);
    ((next['panels'] as Record<string, unknown>[])[0]!['balloons'] as Record<string, unknown>[])[0]!['text'] = 'Edited.';
    value(setPage(h, pageIds[0]!, next));
    expect(node(h, pageIds[0]!).comicPage).toMatchObject({ futureKey: [1, 2] });
    expect(JSON.stringify(node(h, pageIds[0]!).comicPage)).toContain('telepathy');
  });
});

describe('a panel\'s picture is a typed use', () => {
  it('blocks deleting the picture, and the use goes with the panel', () => {
    const h = host();
    const { pageIds } = newBook(h);
    value(setPage(h, pageIds[0]!, lettered(h, pageIds[0]!, { assetId: ART })));
    expect(panelPictureRefs(node(h, pageIds[0]!).comicPage)).toHaveLength(1);

    const refused = refusal(run(h, 'asset.delete', { assetId: ART }));
    expect(refused.code).toBe('invalid-params');
    expect(refused.message).toContain('Page 1');

    undoLast(h);
    value(run(h, 'asset.delete', { assetId: ART }));
  });
});

describe('comic.setScript', () => {
  function script(h: Host, parentId: string = CHAPTER): string {
    return value(run(h, 'binder.create', { parentId, type: 'document', kind: 'comic-script', title: 'Script' }))['nodeId'] as string;
  }

  it('links, relinks and unlinks, each as one undo group', () => {
    const h = host();
    const { bookId } = newBook(h);
    const one = script(h, bookId);
    const two = script(h, bookId);
    const bare = structuredClone(node(h, bookId).comic) ?? null;

    value(run(h, 'comic.setScript', { nodeId: bookId, scriptDocId: one, expect: null }));
    expect(node(h, bookId).comic).toMatchObject({ scriptDocId: one });
    value(run(h, 'comic.setScript', { nodeId: bookId, scriptDocId: two, expect: one }));
    expect(node(h, bookId).comic).toMatchObject({ scriptDocId: two });
    value(run(h, 'comic.setScript', { nodeId: bookId, scriptDocId: null, expect: two }));
    expect(node(h, bookId).comic).not.toHaveProperty('scriptDocId');

    undoLast(h);
    expect(node(h, bookId).comic).toMatchObject({ scriptDocId: two });
    undoLast(h);
    undoLast(h);
    expect(node(h, bookId).comic ?? null).toEqual(bare);
  });

  it('refuses a document that is not a comic script, one linked elsewhere, and a stale link', () => {
    const h = host();
    const first = newBook(h);
    const second = newBook(h);
    const prose = addDocument(h.state, { parentId: CHAPTER, title: 'Prose', body: 'Text.', now: NOW }).id;
    const one = script(h, first.bookId);

    expect(refusal(run(h, 'comic.setScript', { nodeId: first.bookId, scriptDocId: prose, expect: null })).code).toBe('invalid-params');
    value(run(h, 'comic.setScript', { nodeId: first.bookId, scriptDocId: one, expect: null }));
    const taken = refusal(run(h, 'comic.setScript', { nodeId: second.bookId, scriptDocId: one, expect: null }));
    expect(taken.message).toContain('one book');
    expect(refusal(run(h, 'comic.setScript', { nodeId: first.bookId, scriptDocId: null, expect: null })).code).toBe('revision-conflict');
    expect(refusal(run(h, 'comic.setScript', { nodeId: first.bookId, scriptDocId: one, expect: one })).code).toBe('invalid-params');
  });

  it('is unlinked by deleting the script, and one undo brings back the document and the link', () => {
    const h = host();
    const { bookId, pageIds } = newBook(h);
    const doc = script(h, bookId);
    value(run(h, 'comic.setScript', { nodeId: bookId, scriptDocId: doc, expect: null }));
    const before = snapshotOf(h.state);

    value(run(h, 'project.deleteNode', { nodeId: doc }));
    expect(nodeById(h.state, doc)).toBeUndefined();
    expect(node(h, bookId).comic ?? {}).not.toHaveProperty('scriptDocId');
    expect(pageIds.every((id) => nodeById(h.state, id) !== undefined)).toBe(true);

    undoLast(h);
    expect(snapshotOf(h.state)).toEqual(before);
    expect(node(h, bookId).comic).toMatchObject({ scriptDocId: doc });
  });
});

describe('comic.scriptFromPages', () => {
  it('writes a script with a fresh anchor for every lettered line, links it, and one undo removes it', () => {
    const h = host();
    const { bookId, pageIds } = newBook(h);
    value(setPage(h, pageIds[0]!, lettered(h, pageIds[0]!)));
    const before = snapshotOf(h.state);
    const pagesBefore = structuredClone(pageIds.map((id) => node(h, id).comicPage));

    const outcome = value(run(h, 'comic.scriptFromPages', { nodeId: bookId }));
    const docId = outcome['scriptDocId'] as string;
    expect(outcome['created']).toBe(true);
    expect(node(h, docId)).toMatchObject({ type: 'document', kind: 'comic-script', parentId: bookId });
    expect(node(h, bookId).comic).toMatchObject({ scriptDocId: docId });
    const body = getBody(h.state, docId);
    expect(body).toContain('PAGE 1 (6 panels)');
    expect(body).toContain('ELENA VOSS: The ferry is late.');

    const covered = (node(h, pageIds[0]!).comicPage!['panels'] as { script?: { docId: string; balloonId: string; anchor: { from: number; to: number; exact: string; capturedRevision: number } }[] }[])[0]!.script!;
    expect(covered).toHaveLength(1);
    expect(covered[0]).toMatchObject({ docId, balloonId: 'bl_8M2QX7K4A1' });
    expect(body.slice(covered[0]!.anchor.from, covered[0]!.anchor.to)).toBe(covered[0]!.anchor.exact);
    expect(covered[0]!.anchor.exact).toContain('The ferry is late.');
    expect(covered[0]!.anchor.capturedRevision).toBe(getRevision(h.state, docId));

    undoLast(h);
    expect(snapshotOf(h.state)).toEqual(before);
    expect(pageIds.map((id) => node(h, id).comicPage)).toEqual(pagesBefore);
  });

  it('writes a script for pages that have no lettering', () => {
    const h = host();
    const { bookId } = newBook(h);
    const docId = value(run(h, 'comic.scriptFromPages', { nodeId: bookId }))['scriptDocId'] as string;
    expect(getBody(h.state, docId)).toContain('PAGE 2 (6 panels)');
    expect(value(run(h, 'comic.scriptFromPages', { nodeId: bookId, expectedRevision: getRevision(h.state, docId) }))['lines']).toBe(0);
  });

  it('overwrites a linked script only against the revision it read, and undoes to the old text', () => {
    const h = host();
    const { bookId, pageIds } = newBook(h);
    const docId = value(run(h, 'comic.scriptFromPages', { nodeId: bookId }))['scriptDocId'] as string;
    const revision = getRevision(h.state, docId);

    const missing = refusal(run(h, 'comic.scriptFromPages', { nodeId: bookId }));
    expect(missing.target).toBe('expectedRevision');

    setBody(h.state, docId, 'PAGE 1\n\nPANEL 1\n\nA hand-written line.\n');
    const conflict = refusal(run(h, 'comic.scriptFromPages', { nodeId: bookId, expectedRevision: revision }));
    expect(conflict.code).toBe('revision-conflict');
    expect(getBody(h.state, docId)).toContain('A hand-written line.');

    value(setPage(h, pageIds[0]!, lettered(h, pageIds[0]!)));
    const written = value(run(h, 'comic.scriptFromPages', { nodeId: bookId, expectedRevision: getRevision(h.state, docId) }));
    expect(written['created']).toBe(false);
    expect(getBody(h.state, docId)).toContain('ELENA VOSS');
    undoLast(h);
    expect(getBody(h.state, docId)).toContain('A hand-written line.');
    expect((node(h, pageIds[0]!).comicPage!['panels'] as { script?: unknown }[])[0]!.script).toBeUndefined();
  });

  it('maps a picture\'s paragraph anchor across a re-derived script, and one undo puts both back', () => {
    const h = host();
    const { bookId, pageIds } = newBook(h);
    const docId = value(run(h, 'comic.scriptFromPages', { nodeId: bookId }))['scriptDocId'] as string;
    // A picture attached to the second page's heading. The derivation keeps that heading, but lettering the *first* page inserts
    // text above it, so the anchor only stays on its paragraph if the write maps it — an unmapped link would point at the old offsets,
    // which now land in the first page's script.
    const body = getBody(h.state, docId);
    const at = body.indexOf('PAGE 2');
    const anchor = captureParagraphAnchor(body, at, getRevision(h.state, docId));
    if (anchor === undefined) throw new Error('no anchor');
    h.state.manifest.assetLinks = [{ id: 'l_9SCRIPTANC', assetId: ART, target: { kind: 'paragraph', nodeId: docId, anchor }, role: 'reference', order: 10 }];
    const before = structuredClone(h.state.manifest.assetLinks);

    value(setPage(h, pageIds[0]!, lettered(h, pageIds[0]!)));
    value(run(h, 'comic.scriptFromPages', { nodeId: bookId, expectedRevision: getRevision(h.state, docId) }));

    const rewritten = getBody(h.state, docId);
    const link = h.state.manifest.assetLinks?.find((candidate) => candidate.id === 'l_9SCRIPTANC');
    const moved = link?.target as { anchor: { from: number; to: number; exact: string }; orphaned?: true } | undefined;
    expect(moved?.orphaned).toBeUndefined();
    expect(moved?.anchor.exact).toContain('PAGE 2');
    expect(rewritten.slice(moved!.anchor.from, moved!.anchor.to)).toBe(moved!.anchor.exact);
    expect(moved!.anchor.from).toBeGreaterThan(anchor.from);

    undoLast(h);
    expect(h.state.manifest.assetLinks).toEqual(before);
  });

  it('refuses a book with no pages and a book whose script is gone', () => {
    const h = host();
    const empty = value(run(h, 'comic.createBook', { parentId: CHAPTER, title: 'Empty', pages: 0 }))['nodeId'] as string;
    expect(refusal(run(h, 'comic.scriptFromPages', { nodeId: empty })).message).toContain('no pages');

    const { bookId } = newBook(h);
    node(h, bookId).comic = { scriptDocId: 'n_3W8RN2TQ6C' };
    expect(refusal(run(h, 'comic.scriptFromPages', { nodeId: bookId })).message).toContain('no longer in the project');
  });
});

describe('a comic book through save, reload and bundle', () => {
  async function built(): Promise<{ state: ProjectState; bookId: string; pageIds: string[]; docId: string }> {
    const h = host();
    const { bookId, pageIds } = newBook(h, { settings: { readingDirection: 'rtl' } });
    value(setPage(h, pageIds[0]!, lettered(h, pageIds[0]!, { assetId: ART })));
    const docId = value(run(h, 'comic.scriptFromPages', { nodeId: bookId }))['scriptDocId'] as string;
    node(h, bookId).comic = { ...node(h, bookId).comic!, futureSetting: 'kept' };
    const page = node(h, pageIds[1]!);
    page.comicPage = { ...page.comicPage!, futureKey: { a: 1 } };
    return { state: h.state, bookId, pageIds, docId };
  }

  it('reads back the same book, pages, script and unknown keys from a folder', async () => {
    const { state, bookId, pageIds, docId } = await built();
    const fs = new MemoryArtifactFs();
    await writeProject(fs, cloneProjectState(state), { now: NOW });
    const loaded = await readProject(fs);

    const reread = (id: string): TreeNode => loaded.state.manifest.tree.find((n) => n.id === id)!;
    expect(reread(bookId)).toMatchObject({ type: 'folder', kind: 'comic', comic: { readingDirection: 'rtl', scriptDocId: docId, futureSetting: 'kept' } });
    expect(reread(pageIds[0]!).comicPage).toEqual(node({ state } as Host, pageIds[0]!).comicPage);
    expect(reread(pageIds[1]!).comicPage).toMatchObject({ futureKey: { a: 1 } });
    expect(loaded.state.documents.get(docId)?.body).toBe(getBody(state, docId));
    expect(Object.keys(fs.snapshot()).filter((path) => path.startsWith('docs/')).sort()).toEqual([`docs/${docId}.md`]);
  });

  it('survives a bundle', async () => {
    const { state, bookId, pageIds } = await built();
    const zip = await exportProjectZip(state, { now: NOW });
    const imported = await importProjectZip(zip.bytes);
    const loaded = await readProject(imported.fs);
    const reread = (id: string): TreeNode => loaded.state.manifest.tree.find((n) => n.id === id)!;
    expect(reread(bookId).comic).toMatchObject({ readingDirection: 'rtl' });
    expect(reread(pageIds[0]!).comicPage).toEqual(node({ state } as Host, pageIds[0]!).comicPage);
  });
});

/** A comic-script document under the book, with its body written, and optionally linked as the book's script. */
function scriptDoc(h: Host, bookId: string, body: string, link = false): string {
  const id = value(run(h, 'binder.create', { parentId: bookId, type: 'document', kind: 'comic-script', title: 'Script' }))['nodeId'] as string;
  setBody(h.state, id, body);
  if (link) value(run(h, 'comic.setScript', { nodeId: bookId, scriptDocId: id, expect: null }));
  return id;
}

const SCRIPT = [
  'PAGE 1 (2 panels)',
  '',
  'PANEL 1',
  'The pier at night.',
  '',
  '1. ELENA VOSS: The ferry is late.',
  '2. CAPTION: Midnight.',
  '',
  'PANEL 2',
  '',
  '3. UNKNOWN VOICE (OFF): Hello?',
  '',
  'PAGE 2',
  '',
  'PANEL 1',
  '',
  '1. SFX: HONK',
  '',
].join('\n');

const pagesOf = (h: Host, bookId: string): TreeNode[] => h.state.manifest.tree.filter((n) => n.parentId === bookId && n.type === 'comic-page').sort((a, b) => a.order - b.order);
const storedPages = (h: Host, bookId: string): unknown[] => pagesOf(h, bookId).map((n) => n.comicPage ?? null);

describe('comic.derive', () => {
  function bare(): { h: Host; bookId: string; docId: string } {
    const h = host();
    const { bookId } = newBook(h, { pages: 0 });
    return { h, bookId, docId: scriptDoc(h, bookId, SCRIPT) };
  }
  const derive = (h: Host, bookId: string, docId: string, extra: Record<string, unknown> = {}) =>
    run(h, 'comic.derive', { nodeId: bookId, doc: docId, expectedRevision: getRevision(h.state, docId), expect: storedPages(h, bookId), ...extra });

  it('makes the pages, panels and balloons the script gives, links the script, and one undo takes all of it back', () => {
    const { h, bookId, docId } = bare();
    const before = snapshotOf(h.state);
    const outcome = value(derive(h, bookId, docId));
    expect(outcome).toMatchObject({ scriptDocId: docId, linked: true, pages: 2, created: 2, placed: 4 });
    expect(node(h, bookId).comic).toMatchObject({ scriptDocId: docId });

    const [one, two] = pagesOf(h, bookId);
    expect(one).toMatchObject({ type: 'comic-page', title: 'Page 1' });
    expect(two).toMatchObject({ title: 'Page 2' });
    const page = loadComicPage(one?.comicPage).value;
    expect(page.panels).toHaveLength(2);
    expect(page.panels[0]?.balloons.map((b) => [b.kind, b.text, b.speaker])).toEqual([
      ['speech', 'The ferry is late.', ELENA],
      ['caption', 'Midnight.', undefined],
    ]);
    // An unknown speaker is not guessed at: the balloon has no speaker, and the script line still names it.
    expect(page.panels[1]?.balloons[0]).toMatchObject({ kind: 'speech', text: 'Hello?', offPanel: true });
    expect(page.panels[1]?.balloons[0]?.speaker).toBeUndefined();

    const body = getBody(h.state, docId);
    const cover = page.panels[0]?.script?.[0];
    expect(cover).toMatchObject({ docId, balloonId: page.panels[0]?.balloons[0]?.id });
    expect(body.slice(cover?.anchor.from, cover?.anchor.to)).toBe('1. ELENA VOSS: The ferry is late.');
    expect(cover?.anchor.capturedRevision).toBe(getRevision(h.state, docId));
    expect(h.state.manifest.assets?.length).toBe(1);
    expect(pagesOf(h, bookId).flatMap((n) => panelPictureRefs(n.comicPage))).toEqual([]);

    undoLast(h);
    expect(snapshotOf(h.state)).toEqual(before);
    expect(pagesOf(h, bookId)).toEqual([]);
    expect(node(h, bookId).comic ?? {}).not.toHaveProperty('scriptDocId');
  });

  it('refuses against anything changed since the plan read it, and changes nothing', () => {
    const { h, bookId, docId } = bare();
    const staleRevision = getRevision(h.state, docId);
    setBody(h.state, docId, `${SCRIPT}\nPAGE 3\nPANEL 1\n\nMARA: New.\n`);
    const before = snapshotOf(h.state);
    expect(refusal(run(h, 'comic.derive', { nodeId: bookId, doc: docId, expectedRevision: staleRevision, expect: [] })).code).toBe('revision-conflict');
    expect(snapshotOf(h.state)).toEqual(before);

    const ok = value(derive(h, bookId, docId));
    expect(ok['pages']).toBe(3);
    const pages = snapshotOf(h.state);
    const stalePages = refusal(run(h, 'comic.derive', { nodeId: bookId, doc: docId, expectedRevision: getRevision(h.state, docId), expect: [] }));
    expect(stalePages).toMatchObject({ code: 'revision-conflict', target: 'expect' });
    expect(snapshotOf(h.state)).toEqual(pages);
  });

  it('refuses a document that is not the book\'s script, naming the one it uses, and a script another book holds', () => {
    const { h, bookId, docId } = bare();
    value(derive(h, bookId, docId));
    const other = scriptDoc(h, bookId, SCRIPT);
    const second = value(run(h, 'comic.createBook', { parentId: CHAPTER, title: 'Other', pages: 0 }))['nodeId'] as string;
    const before = snapshotOf(h.state);
    const wrong = refusal(derive(h, bookId, other));
    expect(wrong.message).toContain('already uses "Script"');
    expect(refusal(derive(h, bookId, CHAPTER)).code).toBe('invalid-params');

    expect(refusal(derive(h, second, docId)).message).toContain('one book');
    expect(snapshotOf(h.state)).toEqual(before);
  });

  it('refuses a script whose pages are not numbered in order, a script with no pages, and a book that is not a book', () => {
    const { h, bookId } = bare();
    const gap = scriptDoc(h, bookId, 'PAGE 1\nPANEL 1\n\nPAGE 3\nPANEL 1\n');
    expect(refusal(derive(h, bookId, gap)).message).toContain('1, 3');
    const none = scriptDoc(h, bookId, 'Notes only.');
    expect(refusal(derive(h, bookId, none)).message).toContain('no page headers');
    expect(refusal(run(h, 'comic.derive', { nodeId: CHAPTER, doc: gap, expectedRevision: 0, expect: [] })).code).toBe('invalid-params');
  });

  it('keeps a picture and hand lettering on pages it updates, writes no picture, and one undo puts the exact bytes back', () => {
    const h = host();
    const { bookId, pageIds } = newBook(h, { pages: 2 });
    const docId = scriptDoc(h, bookId, 'PAGE 1 (6 panels)\n\nPANEL 1\n\n1. ELENA VOSS: The ferry is late.\n', true);
    value(setPage(h, pageIds[0]!, lettered(h, pageIds[0]!, { assetId: ART })));
    const before = snapshotOf(h.state);
    const pagesBefore = structuredClone(storedPages(h, bookId));
    const panelsBefore = loadComicPage(node(h, pageIds[0]!).comicPage).value.panels;

    // 1 script panel against a page of 6: the picture would be misplaced, so the page is refused as it stands.
    const refused = refusal(derive(h, bookId, docId, { expect: storedPages(h, bookId) }));
    expect(refused.message).toContain('holds a picture');
    expect(snapshotOf(h.state)).toEqual(before);

    setBody(h.state, docId, `PAGE 1 (6 panels)\n\n${Array.from({ length: 6 }, (_, i) => `PANEL ${i + 1}\n\n${i === 0 ? '1. ELENA VOSS: The ferry is very late.\n' : ''}`).join('\n')}`);
    const done = value(derive(h, bookId, docId));
    expect(done).toMatchObject({ created: 0, updated: 0, placed: 1 });
    const after = loadComicPage(node(h, pageIds[0]!).comicPage).value.panels;
    expect(after[0]).toMatchObject({ id: panelsBefore[0]?.id, assetId: ART, rect: panelsBefore[0]?.rect });
    expect(after[0]?.balloons.map((b) => b.text)).toEqual(['The ferry is late.', 'The ferry is very late.']);
    expect(panelPictureRefs(node(h, pageIds[0]!).comicPage)).toEqual([{ assetId: ART, panelId: panelsBefore[0]?.id }]);
    expect(node(h, pageIds[1]!).comicPage).toEqual(pagesBefore[1]);

    undoLast(h);
    expect(storedPages(h, bookId)).toEqual(pagesBefore);
  });

  it('says so, and changes nothing, when the pages already read as the script gives them', () => {
    const { h, bookId, docId } = bare();
    value(derive(h, bookId, docId));
    const before = snapshotOf(h.state);
    const again = refusal(derive(h, bookId, docId));
    expect(again.details).toMatchObject({ changesNothing: true });
    expect(snapshotOf(h.state)).toEqual(before);
  });
});

describe('comic.letter', () => {
  function lettering(): { h: Host; bookId: string; pageIds: string[]; docId: string } {
    const h = host();
    const { bookId, pageIds } = newBook(h);
    return { h, bookId, pageIds, docId: scriptDoc(h, bookId, SCRIPT.replace('PAGE 1 (2 panels)', 'PAGE 1 (6 panels)'), true) };
  }
  const letter = (h: Host, pageId: string, docId: string, extra: Record<string, unknown> = {}) =>
    run(h, 'comic.letter', { nodeId: pageId, doc: docId, expectedRevision: getRevision(h.state, docId), expect: node(h, pageId).comicPage ?? null, ...extra });

  it('places the balloons the script page names, keeps the panels as they are, and one undo restores the page', () => {
    const { h, pageIds, docId } = lettering();
    const before = snapshotOf(h.state);
    const pageBefore = structuredClone(node(h, pageIds[0]!).comicPage);
    const outcome = value(letter(h, pageIds[0]!, docId));
    expect(outcome).toMatchObject({ placed: 3, updated: 0, lines: 3 });

    const after = loadComicPage(node(h, pageIds[0]!).comicPage).value;
    expect(after.panels.map((p) => p.balloons.length)).toEqual([2, 1, 0, 0, 0, 0]);
    expect(after.panels.map((p) => p.rect)).toEqual(loadComicPage(pageBefore).value.panels.map((p) => p.rect));
    expect(after.panels[0]?.balloons[0]).toMatchObject({ text: 'The ferry is late.', speaker: ELENA });
    expect(after.panels[0]?.script?.[0]?.anchor.exact).toBe('1. ELENA VOSS: The ferry is late.');

    undoLast(h);
    expect(node(h, pageIds[0]!).comicPage).toEqual(pageBefore);
    expect(snapshotOf(h.state)).toEqual(before);
  });

  it('updates a balloon in place when its line changes, and letters one line on request', () => {
    const { h, pageIds, docId } = lettering();
    value(letter(h, pageIds[0]!, docId));
    const first = loadComicPage(node(h, pageIds[0]!).comicPage).value.panels[0]!.balloons[0]!;
    setBody(h.state, docId, getBody(h.state, docId).replace('The ferry is late.', 'The ferry is gone.'));
    const outcome = value(letter(h, pageIds[0]!, docId, { panel: 1, line: 1 }));
    expect(outcome).toMatchObject({ placed: 0, updated: 1, lines: 1 });
    const after = loadComicPage(node(h, pageIds[0]!).comicPage).value.panels[0]!.balloons[0]!;
    expect(after).toMatchObject({ id: first.id, text: 'The ferry is gone.', rect: first.rect });
  });

  it('refuses against anything changed since the plan read it, and changes nothing', () => {
    const { h, pageIds, docId } = lettering();
    const before = snapshotOf(h.state);
    const staleRevision = getRevision(h.state, docId);
    setBody(h.state, docId, `${getBody(h.state, docId)}\n`);
    const afterEdit = snapshotOf(h.state);
    expect(refusal(run(h, 'comic.letter', { nodeId: pageIds[0], doc: docId, expectedRevision: staleRevision, expect: node(h, pageIds[0]!).comicPage })).code).toBe('revision-conflict');
    expect(refusal(run(h, 'comic.letter', { nodeId: pageIds[0], doc: docId, expectedRevision: getRevision(h.state, docId), expect: null })).code).toBe('revision-conflict');
    expect(snapshotOf(h.state)).toEqual(afterEdit);
    expect(before).not.toEqual(afterEdit);
  });

  it('refuses a page with fewer panels than its script page, a script the book does not use, and a missing line', () => {
    const { h, bookId, pageIds, docId } = lettering();
    const few = structuredClone(node(h, pageIds[0]!).comicPage!);
    (few['panels'] as unknown[]).length = 1;
    value(setPage(h, pageIds[0]!, few));
    expect(refusal(letter(h, pageIds[0]!, docId)).message).toContain('has 1 panels');

    const { pageIds: ids2, docId: doc2, h: h2 } = lettering();
    const other = scriptDoc(h2, h2.state.manifest.tree.find((n) => n.id === ids2[0])!.parentId!, SCRIPT);
    expect(refusal(letter(h2, ids2[0]!, other)).message).toContain('already uses');
    expect(refusal(letter(h2, ids2[0]!, doc2, { panel: 1, line: 9 })).message).toContain('no lettering line 9');
    expect(refusal(letter(h2, ids2[0]!, doc2, { line: 1 })).target).toBe('line');
    expect(bookId).toBeDefined();

    const unlinked = host();
    const made = newBook(unlinked);
    const loose = scriptDoc(unlinked, made.bookId, SCRIPT);
    expect(refusal(letter(unlinked, made.pageIds[0]!, loose)).message).toContain('no script linked');
  });

  it('says so when the page is already lettered as the script gives it', () => {
    const { h, pageIds, docId } = lettering();
    value(letter(h, pageIds[0]!, docId));
    expect(refusal(letter(h, pageIds[0]!, docId)).details).toMatchObject({ changesNothing: true });
  });
});
