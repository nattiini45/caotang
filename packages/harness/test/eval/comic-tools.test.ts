/**
 * The comic tools under a mock provider: the model's reply is a native tool call, and the call's `argumentsJson` —
 * only the selectors the tool declares — is what runs. The mock answers, the params are checked against the closed
 * spec, `prepare` fills every guard from the project, and the prepared command goes through the shipped bus against
 * the store's real registry, exactly as the runtime drives a native tool (the registry rows themselves are joined by
 * the app-side integration, which this file does not touch).
 *
 * Pinned here: a mock-model derive over titles only writes the pages and the link; a call that smuggles `expect` or
 * `expectedRevision` into its arguments is refused by the closed set before anything is prepared; and a mock-model
 * `comic.scriptFromPages` over the book alone creates the script from the lettered page.
 */

import {
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
import { createMockProvider, nativeCall } from '@caotang/gateway/mock';
import type { ChatRequest, ToolDef } from '@caotang/gateway';
import {
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  getBody,
  nodeById,
  setBody,
  type CodexEntry,
  type ProjectState,
} from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { createHarness } from '../../src/index.js';
import { COMIC_DEFINITIONS, COMIC_TOOL_METADATA, COMIC_TOOL_NAMES, type ComicToolName } from '../../src/tools/comics.js';
import type { CallParams, CommandDone, ToolValue } from '../../src/types.js';
import { checkParams } from '../../src/validate.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const clock = { now: () => Date.parse('2026-10-09T10:00:00.000Z') };
const CHAPTER = 'n_7K2QX9M4A1';
const ELENA = 'c_5H8QK2M9RT';

const SCRIPT = ['PAGE 1 (2 panels)', '', 'PANEL 1', '', '1. ELENA VOSS: The ferry is late.', '', 'PANEL 2', '', '2. CAPTION: Midnight.', ''].join('\n');

/** The tools as the planner would declare them to a native-mode model: schema derived from the spec, text from the metadata row. */
const TOOL_DEFS: readonly ToolDef[] = COMIC_TOOL_NAMES.map((name) => ({
  name,
  description: COMIC_TOOL_METADATA.find((row) => row.name === name)!.description,
  parameters: toJsonSchema(COMIC_DEFINITIONS[name].params),
}));

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
const next = (prefix: string): string => `${prefix}-${(sequence += 1)}`;

const CONFIRMED: PermissionContext = { confirmed: true };

function run(w: World, name: CommandName, params: Record<string, unknown>): Result<ExecutionOutcome, CommandError> {
  const command: Command = { id: next('cmd'), name, params, issuedBy: 'user', createdAt: 1_000 };
  return execute(command, w.bus(), w.registry);
}

const good = <T>(result: Result<T, CommandError>): T => {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
};

function newBook(w: World): string {
  return (good(run(w, 'comic.createBook', { parentId: CHAPTER, title: 'Issue One', pages: 0 })).result as Record<string, unknown>)['nodeId'] as string;
}

function scriptDoc(w: World, bookId: string): string {
  const id = (good(run(w, 'binder.create', { parentId: bookId, type: 'document', kind: 'comic-script', title: 'Script' })).result as Record<string, unknown>)['nodeId'] as string;
  setBody(w.state, id, SCRIPT);
  return id;
}

interface ModelCallRun {
  readonly outcome: Result<ToolValue, CommandError>;
  readonly preview: unknown;
}

/** One model reply's tool call, run the way the runtime runs a native tool; returns the outcome and the card's preview. */
function runModelCall(w: World, name: string, argumentsJson: string): ModelCallRun {
  const definition = COMIC_DEFINITIONS[name as ComicToolName];
  if (definition === undefined) throw new Error(`no comic tool "${name}"`);
  const params = JSON.parse(argumentsJson) as unknown;
  const checked = checkParams(name, definition.params, params);
  if (!checked.ok) return { outcome: checked as Result<ToolValue, CommandError>, preview: undefined };
  const refusedByRule = definition.refine?.(checked.value);
  if (refusedByRule !== undefined) return { outcome: { ok: false, error: refusedByRule }, preview: undefined };
  const prepared = definition.prepare(checked.value, { state: w.state, registry: w.registry, clock: clock.now });
  if (!prepared.ok) return { outcome: prepared as Result<ToolValue, CommandError>, preview: undefined };
  const turnId = next('turn');
  const callId = next('call');
  const done: CommandDone[] = [];
  for (const [index, step] of prepared.value.commands.entries()) {
    const commandParams = typeof step.params === 'function' ? step.params(done) : step.params;
    const command: Command = { id: next('cmd'), name: step.name, params: commandParams as CallParams, issuedBy: 'agent', turnId, callId: `${callId}:${index}`, createdAt: 1_000 };
    const result = execute(command, w.bus(CONFIRMED), w.registry);
    if (!result.ok) return { outcome: result as Result<ToolValue, CommandError>, preview: prepared.value.preview };
    done.push({ name: step.name, outcome: result.value });
  }
  return { outcome: prepared.value.finish(done), preview: prepared.value.preview };
}

/** The one tool call a mock reply asked for, asserted present. */
function theCall(reply: { readonly toolCalls?: readonly { name: string; argumentsJson: string }[] }): { name: string; argumentsJson: string } {
  const call = reply.toolCalls?.[0];
  if (call === undefined) throw new Error('the mock reply carried no tool call');
  return call;
}

/** The request the planner sends: the comic tools declared, one user message. */
function request(content: string): ChatRequest {
  return { messages: [{ role: 'user', content }], tools: TOOL_DEFS };
}

describe('the comic tools under a mock provider', () => {
  it('runs a mock-model derive over titles only: the pages and the link are written, the guards were the tool’s', async () => {
    const w = world();
    const bookId = newBook(w);
    const docId = scriptDoc(w, bookId);

    const provider = createMockProvider({ scripts: [nativeCall('comic.derive', { book: 'Issue One', script: 'Script' })] });
    const reply = await provider.completeOnce(request('Turn the script of Issue One into pages.'));
    const call = theCall(reply);
    expect(call).toMatchObject({ name: 'comic.derive' });
    expect(JSON.parse(call.argumentsJson)).toEqual({ book: 'Issue One', script: 'Script' });

    const run_ = runModelCall(w, call.name, call.argumentsJson);
    if (!run_.outcome.ok) throw new Error(`refused: ${run_.outcome.error.code}: ${run_.outcome.error.message}`);
    const value = run_.outcome.value;
    expect(value.data).toMatchObject({ book: { id: bookId, title: 'Issue One' }, script: { id: docId }, linked: true, pages: 1, created: 1 });
    expect((run_.preview as { kind: string }).kind).toBe('comic-derive');
    expect(nodeById(w.state, bookId)?.comic).toMatchObject({ scriptDocId: docId });
    const pages = w.state.manifest.tree.filter((n) => n.parentId === bookId && n.type === 'comic-page');
    expect(pages).toHaveLength(1);
    expect(value.summary).toContain('"Issue One"');
    expect(value.summary).toContain('"Script"');
  });

  it('refuses a mock-model call that smuggles a guard into its arguments, and writes nothing', async () => {
    const w = world();
    const bookId = newBook(w);
    scriptDoc(w, bookId);
    const before = JSON.stringify(w.state.manifest.tree);

    const provider = createMockProvider({ scripts: [nativeCall('comic.derive', { book: 'Issue One', script: 'Script', expect: [], expectedRevision: 99 })] });
    const reply = await provider.completeOnce(request('Derive, trusting my guards.'));
    const call = theCall(reply);
    const run_ = runModelCall(w, call.name, call.argumentsJson);
    if (run_.outcome.ok) throw new Error('expected a refusal');
    expect(run_.outcome.error.code).toBe('invalid-params');
    expect(run_.outcome.error.message).toContain('expect');
    expect(JSON.stringify(w.state.manifest.tree)).toBe(before);
  });

  it('runs a mock-model scriptFromPages over the book alone, creating the script from a lettered page', async () => {
    const w = world();
    const bookId = newBook(w);
    const pages = (good(run(w, 'comic.createBook', { parentId: CHAPTER, title: 'Lettered', pages: 1 })).result as Record<string, unknown>)['pageIds'] as string[];
    const page = structuredClone(nodeById(w.state, pages[0]!)!.comicPage!);
    (page['panels'] as Record<string, unknown>[])[0] = {
      ...(page['panels'] as Record<string, unknown>[])[0]!,
      balloons: [{ id: 'bl_8M2QX7K4A1', kind: 'speech', text: 'The ferry is late.', speaker: ELENA, rect: [0.05, 0.05, 0.2, 0.1] }],
    };
    good(run(w, 'comic.setPage', { nodeId: pages[0], stored: page, expect: nodeById(w.state, pages[0]!)!.comicPage }));
    void bookId;

    const provider = createMockProvider({ scripts: [nativeCall('comic.scriptFromPages', { book: 'Lettered' })] });
    const reply = await provider.completeOnce(request('Write the script from the pages of Lettered.'));
    const call = theCall(reply);
    expect(JSON.parse(call.argumentsJson)).toEqual({ book: 'Lettered' });
    const run_ = runModelCall(w, call.name, call.argumentsJson);
    if (!run_.outcome.ok) throw new Error(`refused: ${run_.outcome.error.code}: ${run_.outcome.error.message}`);
    const script = run_.outcome.value.data['script'] as { id: string; created: boolean };
    expect(script.created).toBe(true);
    expect(getBody(w.state, script.id)).toContain('ELENA VOSS: The ferry is late.');
    expect((run_.preview as { kind: string; body: { after: string } }).body.after).toContain('PAGE 1');
  });

  it('is registered and gated like every native row: refused without an approval, applied behind a one-step confirmation', () => {
    const w = world();
    const bookId = newBook(w);
    scriptDoc(w, bookId);
    const harness = createHarness({ state: w.state, registry: w.registry, clock: clock.now });
    const pages = () => w.state.manifest.tree.filter((n) => n.parentId === bookId && n.type === 'comic-page');

    const refusedCall = harness.call({ name: 'comic.derive', callId: 'gate-1', params: { book: 'Issue One', script: 'Script' } }, { turnId: 'gate-turn' });
    expect(refusedCall.ok).toBe(false);
    if (!refusedCall.ok) expect(refusedCall.error.code).toBe('permission-denied');
    expect(pages()).toHaveLength(0);

    const applied = harness.call(
      { name: 'comic.derive', callId: 'gate-2', params: { book: 'Issue One', script: 'Script' } },
      { turnId: 'gate-turn', permission: { confirmed: true } },
    );
    if (!applied.ok) throw new Error(`refused: ${applied.error.code}: ${applied.error.message}`);
    expect(applied.value.data).toMatchObject({ linked: true, pages: 1, created: 1 });
    expect(pages()).toHaveLength(1);
    expect(nodeById(w.state, bookId)?.comic).toMatchObject({ scriptDocId: (applied.value.data['script'] as { id: string }).id });
  });
});
