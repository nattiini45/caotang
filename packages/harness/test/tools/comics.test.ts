/**
 * The agent's comic tools (comics.md §3.2), driven directly beneath their registry rows the way the runtime drives them:
 * params checked against the spec's closed set, the tool's own refusal rule, `prepare`, then every prepared command
 * through the shipped bus, then `finish` — against the store's real command registry and a real in-memory project.
 * Nothing is mocked.
 *
 * Pinned here: the three rows' names, metadata and closed schemas (no guard key a model could send); the guards `prepare`
 * fills from the project (`nodeId`, `doc`, `expectedRevision`, the complete `expect` values); title/id resolution that
 * refuses an ambiguous book, script or page with its candidates instead of guessing; the full-script derive, the Marvel
 * pages-to-script create and update, and the lettering, each with its JSON-safe before/after preview and its report
 * naming the book, page and script with the counts the bus actually reported; repeated text anchors lettered as distinct
 * lines; a page or script changed between the card and the write refused with nothing written; one undo restoring the
 * exact bytes; and no picture generated or lost anywhere.
 */

import {
  COMMAND_REGISTRY,
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  toJsonSchema,
  type BusContext,
  type Command,
  type CommandError,
  type CommandName,
  type ExecutionOutcome,
  type PermissionContext,
  type Result,
  type UndoStore,
} from '@caotang/bus';
import { loadComicPage, panelPictureRefs } from '@caotang/comic';
import {
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  getBody,
  getRevision,
  nodeById,
  setBody,
  type CodexEntry,
  type ProjectState,
  type TreeNode,
} from '@caotang/store';
import { describe, expect, it } from 'vitest';

import {
  COMIC_ACCEPT_EDITS_TOOLS,
  COMIC_DEFINITIONS,
  COMIC_TOOL_METADATA,
  COMIC_TOOL_NAMES,
  type ComicPreview,
  type ComicToolName,
} from '../../src/tools/comics.js';
import type { CallParams, CommandDone, PreparedCall, ToolValue } from '../../src/types.js';
import { checkParams } from '../../src/validate.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const clock = { now: () => Date.parse('2026-10-09T10:00:00.000Z') };
const CHAPTER = 'n_7K2QX9M4A1';
const ELENA = 'c_5H8QK2M9RT';
const ART = 'a_7K2QX9M4A1';

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

/** A script page that letters the same text twice: the two anchors must differ even though the exact text is one. */
const REPEATED_SCRIPT = ['PAGE 1 (1 panel)', '', 'PANEL 1', '', '1. ELENA VOSS: Same words.', '2. ELENA VOSS: Same words.', ''].join('\n');

interface World {
  readonly state: ProjectState;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
  readonly undo: UndoStore;
  readonly bus: (permission?: PermissionContext) => BusContext<ProjectState>;
}

function world(): World {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter One', now: NOW, id: CHAPTER });
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
  state.manifest.assets = [{ id: ART, file: `${ART}.png`, mime: 'image/png', sha256: '7k2qx9m4a1'.padEnd(64, '0'), bytes: 100, createdAt: NOW.toISOString() }];
  const registry = createProjectCommandRegistry({ clock });
  const log = createActivityLog();
  const idempotency = createIdempotencyCache();
  const view = createViewState();
  // eslint-disable-next-line prefer-const
  let undo: UndoStore;
  const bus = (permission?: PermissionContext): BusContext<ProjectState> => ({
    state,
    view,
    read: () => state,
    ...(permission === undefined ? {} : { permission }),
    undo,
    log,
    idempotency,
    notify: () => undefined,
  });
  undo = createUndoStore({ dispatch: (command) => execute(command, bus(), registry) });
  return { state, registry, undo, bus };
}

let sequence = 0;
const next = (prefix: string): string => {
  sequence += 1;
  return `${prefix}-${sequence}`;
};

function command(name: CommandName, params: CallParams, turnId: string, callId: string): Command {
  return { id: next('cmd'), name, params, issuedBy: 'agent', turnId, callId, createdAt: 1_000 };
}

/** One bus command straight at the registry, the way a fixture sets a project up. */
function run(w: World, name: CommandName, params: Record<string, unknown>): Result<ExecutionOutcome, CommandError> {
  return execute(command(name, params, next('turn'), next('call')), w.bus(), w.registry);
}

function good<T>(result: Result<T, CommandError>): T {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function refused<T>(result: Result<T, CommandError>): CommandError {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

const node = (w: World, id: string): TreeNode => nodeById(w.state, id)!;

const pagesOf = (w: World, bookId: string): TreeNode[] =>
  w.state.manifest.tree.filter((n) => n.parentId === bookId && n.type === 'comic-page').sort((a, b) => a.order - b.order);

function newBook(w: World, extra: Record<string, unknown> = {}): { bookId: string; pageIds: string[] } {
  const made = good(run(w, 'comic.createBook', { parentId: CHAPTER, title: 'Issue One', pages: 2, ...extra })).result as Record<string, unknown>;
  return { bookId: made['nodeId'] as string, pageIds: made['pageIds'] as string[] };
}

/** A comic-script document under the book, its body written, optionally linked as the book's script. */
function scriptDoc(w: World, bookId: string, body: string, link = false, title = 'Script'): string {
  const id = (good(run(w, 'binder.create', { parentId: bookId, type: 'document', kind: 'comic-script', title }))['result'] as Record<string, unknown>)['nodeId'] as string;
  setBody(w.state, id, body);
  if (link) good(run(w, 'comic.setScript', { nodeId: bookId, scriptDocId: id, expect: node(w, bookId).comic?.['scriptDocId'] ?? null }));
  return id;
}

/** A page value with one panel holding one balloon, so there is something to letter and to cover. */
function lettered(w: World, pageId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const page = structuredClone(node(w, pageId).comicPage!);
  const panels = page['panels'] as Record<string, unknown>[];
  panels[0] = {
    ...panels[0],
    ...extra,
    balloons: [{ id: 'bl_8M2QX7K4A1', kind: 'speech', text: 'The ferry is late.', speaker: ELENA, rect: [0.05, 0.05, 0.2, 0.1] }],
  };
  return page;
}

function setPage(w: World, pageId: string, stored: Record<string, unknown> | null) {
  return run(w, 'comic.setPage', { nodeId: pageId, stored, expect: node(w, pageId).comicPage ?? null });
}

/* ------------------------------------------------------------------ *
 * Driving a comic tool the way the runtime does
 * ------------------------------------------------------------------ */

interface PreparedTool {
  readonly prepared: PreparedCall;
  readonly params: CallParams;
}

function prepareTool(w: World, name: ComicToolName, input: unknown): Result<PreparedTool, CommandError> {
  const definition = COMIC_DEFINITIONS[name];
  const checked = checkParams(name, definition.params, input);
  if (!checked.ok) return checked;
  const refusedByRule = definition.refine?.(checked.value);
  if (refusedByRule !== undefined) return { ok: false, error: refusedByRule };
  const prepared = definition.prepare(checked.value, { state: w.state, registry: w.registry, clock: clock.now });
  if (!prepared.ok) return prepared;
  return { ok: true, value: { prepared: prepared.value, params: checked.value } };
}

/** The writer confirmed the card, the flow fact a write-confirm command needs (command-bus §4). */
const CONFIRMED: PermissionContext = { confirmed: true };

/** Dispatches one prepared call's commands through the bus, in order, and finishes. */
function dispatchPrepared(w: World, tool: PreparedTool, permission: PermissionContext = CONFIRMED): Result<ToolValue, CommandError> {
  const turnId = next('turn');
  const callId = next('call');
  const done: CommandDone[] = [];
  for (const [index, step] of tool.prepared.commands.entries()) {
    const params = typeof step.params === 'function' ? step.params(done) : step.params;
    const result = execute(command(step.name, params, turnId, `${callId}:${index}`), w.bus(permission), w.registry);
    if (!result.ok) return result;
    done.push({ name: step.name, outcome: result.value });
  }
  return tool.prepared.finish(done);
}

interface ToolRun {
  readonly outcome: Result<ToolValue, CommandError>;
  readonly preview: ComicPreview | undefined;
  readonly params: CallParams | undefined;
}

/** One full tool call: closed-set check, refine, prepare, dispatch, finish — with the preview the card would show. */
function runTool(w: World, name: ComicToolName, input: unknown, permission: PermissionContext = CONFIRMED): ToolRun {
  const prep = prepareTool(w, name, input);
  if (!prep.ok) return { outcome: prep, preview: undefined, params: undefined };
  const outcome = dispatchPrepared(w, prep.value, permission);
  return { outcome, preview: prep.value.prepared.preview as ComicPreview | undefined, params: prep.value.params };
}

const valueOf = (run_: ToolRun): ToolValue => good(run_.outcome);
const refusalOf = (run_: ToolRun): CommandError => refused(run_.outcome);

function undoLast(w: World): void {
  const last = w.undo.groups().at(-1);
  if (last === undefined) throw new Error('nothing to undo');
  const result = w.undo.undo(last.id);
  if (!result.ok) throw new Error(`undo refused: ${result.error.message}`);
}

const snapshotOf = (w: World): unknown =>
  JSON.parse(
    JSON.stringify({
      tree: w.state.manifest.tree,
      assets: w.state.manifest.assets ?? [],
      docs: [...w.state.documents.values()].map((d) => [d.id, d.body]),
    }),
  );

/* ------------------------------------------------------------------ *
 * The registry surface
 * ------------------------------------------------------------------ */

describe('the comic tools and the registry', () => {
  it('names three tools, each with a metadata row, a native definition and a closed schema', () => {
    expect([...COMIC_TOOL_NAMES]).toEqual(['comic.derive', 'comic.letter', 'comic.scriptFromPages']);
    expect(COMIC_TOOL_METADATA.map((row) => row.name)).toEqual([...COMIC_TOOL_NAMES]);
    expect(Object.keys(COMIC_DEFINITIONS)).toEqual([...COMIC_TOOL_NAMES]);
    for (const name of COMIC_TOOL_NAMES) {
      const definition = COMIC_DEFINITIONS[name];
      expect(definition.kind).toBe('native');
      const schema = toJsonSchema(definition.params);
      expect(schema['type']).toBe('object');
      expect(schema['additionalProperties']).toBe(false);
    }
    // The model's params are the selectors only: no guard key is even declarable, so none can be sent.
    expect(Object.keys(toJsonSchema(COMIC_DEFINITIONS['comic.derive'].params)['properties'] as object)).toEqual(['book', 'script']);
    expect(Object.keys(toJsonSchema(COMIC_DEFINITIONS['comic.letter'].params)['properties'] as object)).toEqual(['book', 'page', 'panel', 'line']);
    expect(Object.keys(toJsonSchema(COMIC_DEFINITIONS['comic.scriptFromPages'].params)['properties'] as object)).toEqual(['book']);
  });

  it('takes each tool’s risk and undo from the command it dispatches', () => {
    const risk = (name: CommandName) => COMMAND_REGISTRY[name].descriptor.agentRisk;
    expect(risk('comic.derive')).toBe('write-confirm');
    expect(risk('comic.letter')).toBe('write-auto');
    expect(risk('comic.scriptFromPages')).toBe('write-confirm');
    const row = (name: ComicToolName) => COMIC_TOOL_METADATA.find((candidate) => candidate.name === name)!;
    expect(COMIC_TOOL_METADATA.map((meta) => meta.risk)).toEqual(['write-confirm', 'write-auto', 'write-confirm']);
    for (const name of COMIC_TOOL_NAMES) {
      const meta = row(name);
      expect(meta.risk).toBe(risk(name));
      expect(meta.undoable).toBe(true);
      expect(meta.surface).toBe('extension');
      expect(meta.load).toBe('deferred');
      expect(meta.descriptionVersion).toBe(1);
      expect(meta.response_token_cap).toBeGreaterThan(0);
      expect(meta.keywords?.length).toBeGreaterThan(0);
    }
    expect(row('comic.derive').description.endsWith('Requires user confirmation.')).toBe(true);
    expect(row('comic.scriptFromPages').description.endsWith('Requires user confirmation.')).toBe(true);
    expect(row('comic.letter').description.endsWith('Applies automatically within an approved turn.')).toBe(true);
    // The write-auto rows join ACCEPT_EDITS_TOOLS; the confirm-class ones do not.
    expect([...COMIC_ACCEPT_EDITS_TOOLS]).toEqual(['comic.letter']);
  });

  it('refuses a guard key smuggled into the model’s params, before anything is prepared', () => {
    const w = world();
    const { bookId } = newBook(w, { pages: 0 });
    const docId = scriptDoc(w, bookId, SCRIPT);
    const before = snapshotOf(w);
    const run_ = runTool(w, 'comic.derive', { book: 'Issue One', script: 'Script', expect: [], expectedRevision: 0, doc: docId, nodeId: bookId });
    const error = refusalOf(run_);
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('expect');
    expect(snapshotOf(w)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ *
 * comic.derive
 * ------------------------------------------------------------------ */

describe('comic.derive', () => {
  it('derives the whole book from a script named by title, filling every guard from the project', () => {
    const w = world();
    const { bookId } = newBook(w, { pages: 0 });
    const docId = scriptDoc(w, bookId, SCRIPT);
    const before = snapshotOf(w);

    const prep = good(prepareTool(w, 'comic.derive', { book: 'Issue One', script: 'Script' }));
    // The guards are the tool's, read from the state: the book and script ids, the script's revision, every page's stored value.
    const command = prep.prepared.commands[0]!;
    expect(command.name).toBe('comic.derive');
    expect(command.params).toEqual({ nodeId: bookId, doc: docId, expectedRevision: getRevision(w.state, docId), expect: [] });

    const preview = prep.prepared.preview as Extract<ComicPreview, { kind: 'comic-derive' }>;
    expect(preview.kind).toBe('comic-derive');
    expect(preview.book).toEqual({ id: bookId, title: 'Issue One' });
    expect(preview.script).toEqual({ id: docId, title: 'Script', revision: getRevision(w.state, docId) });
    expect(preview.link).toEqual({ before: null, after: docId });
    expect(preview.pages).toHaveLength(2);
    expect(preview.pages[0]).toMatchObject({ number: 1, pageId: null, created: true, before: null, panels: 2, placed: 3 });
    expect(preview.pages[1]).toMatchObject({ number: 2, created: true, panels: 1, placed: 1 });
    expect(preview.totals).toMatchObject({ pages: 2, created: 2, placed: 4 });
    // The preview is complete and JSON-safe: a round trip changes nothing.
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
    expect(preview.pages[0]!['after']).toHaveProperty('panels');

    const outcome = good(dispatchPrepared(w, prep));
    expect(outcome.data).toMatchObject({
      book: { id: bookId, title: 'Issue One' },
      script: { id: docId },
      linked: true,
      pages: 2,
      created: 2,
      placed: 4,
    });
    expect((outcome.data['pageIds'] as string[])).toHaveLength(2);
    expect(outcome.summary).toContain('"Issue One"');
    expect(outcome.summary).toContain('"Script"');
    expect(outcome.summary).toContain('2 pages');
    expect(outcome.summary).toContain('4 balloons placed');

    const pages = pagesOf(w, bookId);
    expect(pages.map((p) => p.title)).toEqual(['Page 1', 'Page 2']);
    expect(node(w, bookId).comic).toMatchObject({ scriptDocId: docId });
    const page = loadComicPage(pages[0]!.comicPage).value;
    expect(page.panels).toHaveLength(2);
    expect(page.panels[0]?.balloons.map((b) => [b.kind, b.text, b.speaker])).toEqual([
      ['speech', 'The ferry is late.', ELENA],
      ['caption', 'Midnight.', undefined],
    ]);
    // No picture was generated: the registry is untouched and no panel carries one.
    expect(w.state.manifest.assets).toHaveLength(1);
    expect(pagesOf(w, bookId).flatMap((n) => panelPictureRefs(n.comicPage))).toEqual([]);

    undoLast(w);
    expect(snapshotOf(w)).toEqual(before);
    expect(pagesOf(w, bookId)).toEqual([]);
  });

  it('derives from the book’s linked script when no script is named, and leaves the link as it is', () => {
    const w = world();
    const { bookId } = newBook(w, { pages: 0 });
    const docId = scriptDoc(w, bookId, SCRIPT, true);
    const run_ = runTool(w, 'comic.derive', { book: 'Issue One' });
    const preview = run_.preview as Extract<ComicPreview, { kind: 'comic-derive' }>;
    expect(preview.link).toEqual({ before: docId, after: docId });
    const outcome = valueOf(run_);
    expect(outcome.data).toMatchObject({ script: { id: docId }, linked: false, pages: 2 });
    expect(node(w, bookId).comic).toMatchObject({ scriptDocId: docId });
  });

  it('letters two identical script lines as two balloons with distinct anchors', () => {
    const w = world();
    const { bookId } = newBook(w, { pages: 0 });
    const docId = scriptDoc(w, bookId, REPEATED_SCRIPT);
    const run_ = runTool(w, 'comic.derive', { book: bookId, script: docId });
    const preview = run_.preview as Extract<ComicPreview, { kind: 'comic-derive' }>;
    const after = preview.pages[0]!['after'] as Record<string, unknown>;
    const panels = after['panels'] as Record<string, unknown>[];
    const balloons = panels[0]!['balloons'] as Record<string, unknown>[];
    expect(balloons).toHaveLength(2);
    expect(balloons.map((b) => b['text'])).toEqual(['Same words.', 'Same words.']);
    const coverage = panels[0]!['script'] as { anchor: { from: number; to: number; exact: string }; balloonId: string }[];
    expect(coverage).toHaveLength(2);
    // The same words twice are two lines: distinct offsets, each anchored on its own text.
    expect(coverage[0]!.anchor.from).not.toBe(coverage[1]!.anchor.from);
    expect(coverage[0]!.anchor.to).not.toBe(coverage[1]!.anchor.to);
    expect(coverage[0]!.anchor.exact).toContain('Same words.');
    expect(coverage[1]!.anchor.exact).toContain('Same words.');
    expect(coverage[0]!.balloonId).not.toBe(coverage[1]!.balloonId);
    valueOf(run_);
    const page = loadComicPage(pagesOf(w, bookId)[0]!.comicPage).value;
    const stored = page.panels[0]?.script ?? [];
    const body = getBody(w.state, docId);
    expect(new Set(stored.map((entry) => entry.anchor.from)).size).toBe(2);
    for (const entry of stored) expect(body.slice(entry.anchor.from, entry.anchor.to)).toBe(entry.anchor.exact);
  });

  it('keeps a picture a panel holds and carries it over unchanged, writing no new picture', () => {
    const w = world();
    const { bookId, pageIds } = newBook(w, { pages: 2 });
    scriptDoc(
      w,
      bookId,
      `PAGE 1 (6 panels)\n\n${Array.from({ length: 6 }, (_, i) => `PANEL ${i + 1}\n\n${i === 0 ? '1. ELENA VOSS: The ferry is very late.\n' : ''}`).join('\n')}`,
      true,
    );
    good(setPage(w, pageIds[0]!, lettered(w, pageIds[0]!, { assetId: ART })));
    const assetsBefore = structuredClone(w.state.manifest.assets);

    const run_ = runTool(w, 'comic.derive', { book: 'Issue One' });
    const preview = run_.preview as Extract<ComicPreview, { kind: 'comic-derive' }>;
    const after = preview.pages[0]!['after'] as { panels: { assetId?: string }[] };
    expect(after.panels[0]?.assetId).toBe(ART);
    const outcome = valueOf(run_);
    expect(outcome.data).toMatchObject({ created: 0, placed: 1 });
    expect(w.state.manifest.assets).toEqual(assetsBefore);
    expect(panelPictureRefs(node(w, pageIds[0]!).comicPage)).toEqual([{ assetId: ART, panelId: loadComicPage(node(w, pageIds[0]!).comicPage).value.panels[0]!.id }]);
  });

  it('refuses an ambiguous book, script or page with its candidates, and a book with no link and no script named', () => {
    const w = world();
    const first = newBook(w, { pages: 0 });
    newBook(w, { title: 'Issue Two', pages: 0 });

    const ambiguousBook = refusalOf(runTool(w, 'comic.derive', { book: 'Issue' }));
    expect(ambiguousBook.code).toBe('invalid-params');
    expect(ambiguousBook.message).toContain('Issue One');
    expect(ambiguousBook.message).toContain('Issue Two');
    expect((ambiguousBook.details as { candidates: unknown[] }).candidates).toHaveLength(2);

    scriptDoc(w, first.bookId, SCRIPT, false, 'Script');
    scriptDoc(w, first.bookId, SCRIPT, false, 'Script');
    const before = snapshotOf(w);
    const ambiguousScript = refusalOf(runTool(w, 'comic.derive', { book: 'Issue One', script: 'Script' }));
    expect(ambiguousScript.message).toContain('Script');
    expect((ambiguousScript.details as { candidates: unknown[] }).candidates).toHaveLength(2);

    const noScript = refusalOf(runTool(w, 'comic.derive', { book: 'Issue One' }));
    expect(noScript.code).toBe('invalid-params');
    expect(noScript.target).toBe('params.script');
    expect(snapshotOf(w)).toEqual(before);
  });

  it('refuses a page or script changed between the card and the write, and changes nothing', () => {
    const w = world();
    const { bookId, pageIds } = newBook(w, { pages: 1 });
    const docId = scriptDoc(w, bookId, 'PAGE 1 (6 panels)\n\nPANEL 1\n\n1. ELENA VOSS: The ferry is late.\n', true);

    // The script moved on after the plan read it.
    const staleScript = good(prepareTool(w, 'comic.derive', { book: 'Issue One' }));
    setBody(w.state, docId, `${getBody(w.state, docId)}\nPAGE 2\n\nPANEL 1\n\n1. ELENA VOSS: New.\n`);
    const afterEdit = snapshotOf(w);
    const scriptRefusal = refused(dispatchPrepared(w, staleScript));
    expect(scriptRefusal.code).toBe('revision-conflict');
    expect(scriptRefusal.target).toBe('expectedRevision');
    expect(snapshotOf(w)).toEqual(afterEdit);

    // A page changed after the plan read it.
    const stalePage = good(prepareTool(w, 'comic.derive', { book: 'Issue One' }));
    good(setPage(w, pageIds[0]!, lettered(w, pageIds[0]!)));
    const afterPageEdit = snapshotOf(w);
    const pageRefusal = refused(dispatchPrepared(w, stalePage));
    expect(pageRefusal.code).toBe('revision-conflict');
    expect(pageRefusal.target).toBe('expect');
    expect(snapshotOf(w)).toEqual(afterPageEdit);
  });
});

/* ------------------------------------------------------------------ *
 * comic.letter
 * ------------------------------------------------------------------ */

describe('comic.letter', () => {
  function lettering(): { w: World; bookId: string; pageIds: string[]; docId: string } {
    const w = world();
    const { bookId, pageIds } = newBook(w);
    const docId = scriptDoc(w, bookId, SCRIPT.replace('PAGE 1 (2 panels)', 'PAGE 1 (6 panels)'), true);
    return { w, bookId, pageIds, docId };
  }

  it('letters the whole page from the book’s linked script, with the page before and after on the card', () => {
    const { w, bookId, pageIds, docId } = lettering();
    const before = snapshotOf(w);
    const pageBefore = structuredClone(node(w, pageIds[0]!).comicPage);

    const prep = good(prepareTool(w, 'comic.letter', { book: 'Issue One', page: 'Page 1' }));
    const command = prep.prepared.commands[0]!;
    expect(command.name).toBe('comic.letter');
    // The linked script and the complete current page value are the tool's, read from the state.
    expect(command.params).toEqual({
      nodeId: pageIds[0],
      doc: docId,
      expectedRevision: getRevision(w.state, docId),
      expect: pageBefore,
    });

    const preview = prep.prepared.preview as Extract<ComicPreview, { kind: 'comic-letter' }>;
    expect(preview.kind).toBe('comic-letter');
    expect(preview.book).toEqual({ id: bookId, title: 'Issue One' });
    expect(preview.page).toEqual({ id: pageIds[0], title: 'Page 1', number: 1 });
    expect(preview.script).toEqual({ id: docId, title: 'Script', revision: getRevision(w.state, docId) });
    expect(preview.before).toEqual(pageBefore);
    expect(preview.changed).toBe(true);
    expect(preview.placed).toBe(3);
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
    const after = preview.after as { panels: { balloons: unknown[] }[] };
    expect(after.panels.map((p) => p.balloons.length)).toEqual([2, 1, 0, 0, 0, 0]);

    const outcome = good(dispatchPrepared(w, prep));
    expect(outcome.data).toMatchObject({
      book: { id: bookId, title: 'Issue One' },
      page: { id: pageIds[0], title: 'Page 1', number: 1 },
      script: { id: docId },
      placed: 3,
      updated: 0,
      lines: 3,
    });
    expect(outcome.summary).toContain('"Page 1"');
    expect(outcome.summary).toContain('"Issue One"');
    expect(outcome.summary).toContain('"Script"');
    expect(outcome.summary).toContain('3 balloons placed');

    const after_ = loadComicPage(node(w, pageIds[0]!).comicPage).value;
    expect(after_.panels[0]?.balloons[0]).toMatchObject({ text: 'The ferry is late.', speaker: ELENA });

    undoLast(w);
    expect(snapshotOf(w)).toEqual(before);
  });

  it('narrows to one panel and one line, and refuses line without panel', () => {
    const { w, pageIds, docId } = lettering();
    valueOf(runTool(w, 'comic.letter', { book: 'Issue One', page: 'Page 1' }));
    setBody(w.state, docId, getBody(w.state, docId).replace('The ferry is late.', 'The ferry is gone.'));

    const lineOnly = runTool(w, 'comic.letter', { book: 'Issue One', page: 'Page 1', line: 1 });
    expect(refusalOf(lineOnly).target).toBe('params.line');

    const prep = good(prepareTool(w, 'comic.letter', { book: 'Issue One', page: 'Page 1', panel: 1, line: 1 }));
    expect(prep.prepared.commands[0]!.params).toMatchObject({ panel: 1, line: 1 });
    const preview = prep.prepared.preview as Extract<ComicPreview, { kind: 'comic-letter' }>;
    expect(preview.panel).toBe(1);
    expect(preview.line).toBe(1);
    expect(preview.lines).toBe(1);
    const outcome = good(dispatchPrepared(w, prep));
    expect(outcome.data).toMatchObject({ placed: 0, updated: 1, lines: 1, panel: 1, line: 1 });
    const first = loadComicPage(node(w, pageIds[0]!).comicPage).value.panels[0]!.balloons[0]!;
    expect(first).toMatchObject({ text: 'The ferry is gone.' });
  });

  it('refuses a page or script changed since it was read, an unlinked book, and a page of another book', () => {
    const { w, bookId, pageIds, docId } = lettering();

    const staleScript = good(prepareTool(w, 'comic.letter', { book: 'Issue One', page: 'Page 1' }));
    setBody(w.state, docId, `${getBody(w.state, docId)}\n`);
    const afterEdit = snapshotOf(w);
    const scriptRefusal = refused(dispatchPrepared(w, staleScript));
    expect(scriptRefusal.code).toBe('revision-conflict');
    expect(snapshotOf(w)).toEqual(afterEdit);

    const stalePage = good(prepareTool(w, 'comic.letter', { book: 'Issue One', page: 'Page 1' }));
    good(setPage(w, pageIds[0]!, lettered(w, pageIds[0]!)));
    const afterPageEdit = snapshotOf(w);
    const pageRefusal = refused(dispatchPrepared(w, stalePage));
    expect(pageRefusal.code).toBe('revision-conflict');
    expect(pageRefusal.target).toBe('expect');
    expect(snapshotOf(w)).toEqual(afterPageEdit);

    const unlinked = world();
    const bare = newBook(unlinked, { pages: 1 });
    scriptDoc(unlinked, bare.bookId, SCRIPT);
    const noLink = refusalOf(runTool(unlinked, 'comic.letter', { book: 'Issue One', page: 'Page 1' }));
    expect(noLink.message).toContain('no script linked');

    const other = newBook(w, { title: 'Issue Two', pages: 1 });
    const foreign = refusalOf(runTool(w, 'comic.letter', { book: 'Issue Two', page: node(w, pageIds[0]!).id }));
    expect(foreign.code).toBe('invalid-params');
    expect(foreign.message).toContain('not in the comic book');
    void bookId;
    void other;
  });
});

/* ------------------------------------------------------------------ *
 * comic.scriptFromPages
 * ------------------------------------------------------------------ */

describe('comic.scriptFromPages', () => {
  it('creates the script from the pages, with the whole script, link and coverage on the card, and one undo takes it all back', () => {
    const w = world();
    const { bookId, pageIds } = newBook(w, { pages: 2 });
    good(setPage(w, pageIds[0]!, lettered(w, pageIds[0]!)));
    const before = snapshotOf(w);

    const prep = good(prepareTool(w, 'comic.scriptFromPages', { book: 'Issue One' }));
    // The model named only the book; the command is the book id, with no expectedRevision while there is no script.
    expect(prep.prepared.commands[0]!.params).toEqual({ nodeId: bookId });

    const preview = prep.prepared.preview as Extract<ComicPreview, { kind: 'comic-script-from-pages' }>;
    expect(preview.kind).toBe('comic-script-from-pages');
    expect(preview.book).toEqual({ id: bookId, title: 'Issue One' });
    expect(preview.link).toEqual({ before: null, after: null, created: true });
    expect(preview.script).toMatchObject({ id: null, revision: null });
    expect(preview.body.before).toBeNull();
    expect(preview.body.after).toContain('PAGE 1 (6 panels)');
    expect(preview.body.after).toContain('ELENA VOSS: The ferry is late.');
    expect(preview.lines).toBe(1);
    expect(preview.coverage.after).toBe(1);
    expect(preview.coverage.pages).toHaveLength(2);
    expect(preview.coverage.pages[0]).toMatchObject({ number: 1, pageId: pageIds[0], before: 0, after: 1 });
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);

    const outcome = good(dispatchPrepared(w, prep));
    const result = outcome.data;
    expect(result['book']).toEqual({ id: bookId, title: 'Issue One' });
    const script = result['script'] as { id: string; title: string; created: boolean };
    expect(script.created).toBe(true);
    expect(outcome.summary).toContain('"Issue One"');
    expect(outcome.summary).toContain(script.title);
    expect(outcome.data['lines']).toBe(1);
    expect(outcome.data['covered']).toBe(1);

    const docId = script.id;
    expect(node(w, docId)).toMatchObject({ type: 'document', kind: 'comic-script', parentId: bookId });
    expect(node(w, bookId).comic).toMatchObject({ scriptDocId: docId });
    const body = getBody(w.state, docId);
    expect(body).toContain('ELENA VOSS: The ferry is late.');
    const covered = (node(w, pageIds[0]!).comicPage!['panels'] as { script?: { docId: string; balloonId: string; anchor: { from: number; to: number; exact: string } }[] }[])[0]!.script!;
    expect(covered).toHaveLength(1);
    expect(covered[0]).toMatchObject({ docId, balloonId: 'bl_8M2QX7K4A1' });
    expect(body.slice(covered[0]!.anchor.from, covered[0]!.anchor.to)).toBe(covered[0]!.anchor.exact);

    undoLast(w);
    expect(snapshotOf(w)).toEqual(before);
  });

  it('updates the linked script against the revision the tool read, and refuses one changed since', () => {
    const w = world();
    const { bookId, pageIds } = newBook(w, { pages: 2 });
    const created = valueOf(runTool(w, 'comic.scriptFromPages', { book: 'Issue One' }));
    const firstScript = created.data['script'] as { id: string };
    const revision = getRevision(w.state, firstScript.id);
    const createdBody = getBody(w.state, firstScript.id);

    good(setPage(w, pageIds[0]!, lettered(w, pageIds[0]!)));
    const prep = good(prepareTool(w, 'comic.scriptFromPages', { book: 'Issue One' }));
    // The linked script's revision is filled in by the tool.
    expect(prep.prepared.commands[0]!.params).toEqual({ nodeId: bookId, expectedRevision: revision });
    const preview = prep.prepared.preview as Extract<ComicPreview, { kind: 'comic-script-from-pages' }>;
    expect(preview.link).toEqual({ before: firstScript.id, after: firstScript.id, created: false });
    expect(preview.body.before).toBe(getBody(w.state, firstScript.id));
    expect(preview.body.after).toContain('ELENA VOSS');
    const outcome = good(dispatchPrepared(w, prep));
    expect(outcome.data['script']).toMatchObject({ id: firstScript.id, created: false });
    expect(outcome.data['lines']).toBe(1);
    expect(getBody(w.state, firstScript.id)).toContain('ELENA VOSS: The ferry is late.');

    // A script changed since the plan read it is refused, never overwritten.
    const stale = good(prepareTool(w, 'comic.scriptFromPages', { book: 'Issue One' }));
    setBody(w.state, firstScript.id, 'PAGE 1\n\nPANEL 1\n\nA hand-written line.\n');
    const afterEdit = snapshotOf(w);
    const refusal = refused(dispatchPrepared(w, stale));
    expect(refusal.code).toBe('revision-conflict');
    expect(refusal.target).toBe('expectedRevision');
    expect(snapshotOf(w)).toEqual(afterEdit);
    expect(getBody(w.state, firstScript.id)).toContain('A hand-written line.');

    undoLast(w);
    // The undo reverses the update, so the script is the one the create wrote.
    expect(getBody(w.state, firstScript.id)).toBe(createdBody);
    expect(getBody(w.state, firstScript.id)).not.toContain('A hand-written line.');
  });

  it('refuses a book with no pages, and an ambiguous book title', () => {
    const w = world();
    const empty = (good(run(w, 'comic.createBook', { parentId: CHAPTER, title: 'Empty', pages: 0 })).result as Record<string, unknown>)['nodeId'] as string;
    const noPages = refusalOf(runTool(w, 'comic.scriptFromPages', { book: 'Empty' }));
    expect(noPages.message).toContain('no pages');
    void empty;
    newBook(w);
    newBook(w, { title: 'Issue Two' });
    const ambiguous = refusalOf(runTool(w, 'comic.scriptFromPages', { book: 'Issue' }));
    expect((ambiguous.details as { candidates: unknown[] }).candidates).toHaveLength(2);
  });
});
