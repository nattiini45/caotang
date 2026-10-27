/**
 * A real in-memory project, assembled the way `packages/store/test/exit-gate.test.ts`
 * assembles one: the store's own `createProjectState`, `addFolder` and `addDocument`,
 * and the store's own command registry. Nothing here is a mock of the bus or the
 * store. The only things a test replaces are the ports the spec leaves injected.
 */

import type { ApplyContext } from '@caotang/bus';
import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  type ProjectState,
} from '@caotang/store';
import { withResultChecks } from '../src/testing.js';
import { createHarness, type Harness, type HarnessOptions, type ToolOutcome } from '../src/index.js';

export const OPENED = new Date('2026-10-08T09:00:00.000Z');

/** A fixed clock, so an inverse's `createdAt` is an assertion and not a number. */
export const TICK = 1_760_000_000_000;
export const clock = { now: () => TICK };

export const CHAPTER_ONE = 'n_CHAPTR0001';
export const CHAPTER_TWO = 'n_CHAPTR0002';
export const LANDING = 'n_BEACH00001';
export const STORM = 'n_TEMPEST001';
export const FRIEND = 'n_BRAVE00001';
export const ENTRY = 'c_HANNE00001';
export const ENTRY_TWO = 'c_KSTR000001';
/** A well-formed id no fixture node carries. */
export const MISSING = 'n_MSSNG00001';

export const LANDING_BODY = 'The ferry was late, as always.';

export function makeState(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  state.manifest.vocabulary.labels = [
    { id: 'act-1', name: 'Act 1', color: '#8a8a8a' },
    { id: 'act-2', name: 'Act 2', color: '#4a90d9' },
  ];
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER_ONE });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 2', now: OPENED, id: CHAPTER_TWO });
  addDocument(state, {
    parentId: CHAPTER_ONE,
    title: 'The Landing',
    body: LANDING_BODY,
    now: OPENED,
    id: LANDING,
    status: 'draft',
    label: 'act-1',
    keywords: ['sea', 'grief'],
    synopsis: 'Elena returns to the island.',
    notes: 'Fix pacing in the last three paragraphs.',
  });
  addDocument(state, { parentId: CHAPTER_ONE, title: 'The Storm', now: OPENED, id: STORM, body: 'Rain.\n\n***\n\nThe lamp failed.' });
  addDocument(state, { parentId: CHAPTER_TWO, title: 'The Friend', now: OPENED, id: FRIEND });
  state.manifest.codex?.push({
    id: ENTRY,
    name: 'Elena',
    aliases: [],
    type: 'character',
    description: 'The keeper.',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
  });
  state.manifest.codex?.push({
    id: ENTRY_TWO,
    name: 'Kestrel',
    aliases: [],
    type: 'other',
    description: 'The bird.',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
  });
  return state;
}

/**
 * A byte serialisation that is a property of the value, not of insertion order.
 * The same instrument `exit-gate.test.ts` uses for §10's undo-replay comparison.
 */
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Map) {
    return `{${[...value.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${canonical(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  if (value instanceof Set) return `[${[...value].map(canonical).sort().join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * Everything an undo has to restore: the manifest, the bodies, the decline record. The revision is left out: it is runtime
 * bookkeeping that is never serialised, and an undo is a write that moves it up (command-bus §5), so it cannot come back to
 * its old number. The store's own tests check that it rises.
 */
export function snapshotOf(state: ProjectState): string {
  const documents = new Map(
    [...state.documents].map(([id, record]): [string, { id: string; body: string }] => [id, { id: record.id, body: record.body }]),
  );
  return canonical({ manifest: state.manifest, documents, declinedCodexFiles: state.declinedCodexFiles });
}

/** A harness whose every successful result is checked against its row's declared schema (testing.ts). */
export function makeHarness(overrides: Partial<HarnessOptions> = {}, state: ProjectState = makeState()): Harness {
  return withResultChecks(createHarness({ state, clock: clock.now, ...overrides }));
}

/** A registry whose `export.compile` and `export.compileSelection` applies are fakes, for the real apply that is not built yet. */
export function registryWithFakeExports() {
  const registry = createProjectCommandRegistry({ clock });
  const fakeApply = (state: unknown, params: Record<string, unknown>, context: ApplyContext) => {
    void state;
    context.undo.compensate('delete the exported file', () => {});
    context.report({ affected: [], summary: `compiled to ${String(params['format'])}` });
    return { artifact: `export-${String(params['format'])}`, words: 42, chars: 200 };
  };
  return {
    ...registry,
    'export.compile': { descriptor: registry['export.compile'].descriptor, apply: fakeApply },
    'export.compileSelection': { descriptor: registry['export.compileSelection'].descriptor, apply: fakeApply },
  } as typeof registry;
}

let callSeq = 0;
/** A callId unique within the process, so a test never collides with another's. */
export function callId(prefix = 'call'): string {
  callSeq += 1;
  return `${prefix}-${callSeq}`;
}

export interface RunOptions {
  readonly turnId?: string;
  readonly callId?: string;
  readonly permission?: { readonly approvedPlan?: boolean; readonly confirmed?: boolean };
  readonly source?: 'native' | 'mcp';
  /** The call is a delegated agent's (`TurnContext.agentPath`). */
  readonly agentPath?: string;
}

/** One tool call under one turn. A fresh callId unless the test names one (to exercise a replay). */
export function run(harness: Harness, name: string, params: unknown, options: RunOptions = {}) {
  return harness.call(
    { name, callId: options.callId ?? callId(name), params },
    {
      turnId: options.turnId ?? `turn-${callSeq}`,
      ...(options.permission === undefined ? {} : { permission: options.permission }),
      ...(options.source === undefined ? {} : { source: options.source }),
      ...(options.agentPath === undefined ? {} : { agentPath: options.agentPath }),
    },
  );
}

/** The value of a successful call. Fails the test, with the refusal printed, for anything else. */
export function valueOf(outcome: ToolOutcome) {
  if (!outcome.ok) throw new Error(`expected success, got refusal: ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value;
}

/** The refusal of a failed call. Fails the test for a success. */
export function refusalOf(outcome: ToolOutcome) {
  if (outcome.ok) throw new Error(`expected a refusal, got success: ${JSON.stringify(outcome.value.data)}`);
  return outcome.error;
}

/** `createHarness`, with every successful result checked against its row's declared schema. For a test that builds its own options. */
export function checkedHarness(options: HarnessOptions): Harness {
  return withResultChecks(createHarness(options));
}
