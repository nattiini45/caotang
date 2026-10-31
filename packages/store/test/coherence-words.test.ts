/**
 * The words the coherence applies name their changes with (coherence.md §7.1, §8). The Undo tooltip and the activity log show
 * them, so a writer's own change names a declaration, a reason or a run in plain words, and never a field name, a reason id
 * or a run id. The unit cases pin the tables; the command cases read the summary a writer's change reports.
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
  type CommandName,
  type UndoStore,
} from '@caotang/bus';
import { newId } from '@caotang/ids';

import { declarationChangeWords, dismissalWordsOf, runWordsOf } from '../src/coherence-words.js';
import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  emptyCoherenceState,
  type ProjectState,
} from '../src/index.js';

const OPENED = new Date('2026-10-01T09:00:00.000Z');
const clock = { now: () => Date.parse('2026-10-08T10:00:00.000Z') };
const CHAPTER = 'n_CHAPTER001';
const STORM = 'n_TEMPEST001';
const FINDING = 'f_AAAAAAAAAA';
const RUN = 'r_AAAAAAAAAA';
const MESSAGE = 'Elena is expected in "The Storm" but is never named there';

/**
 * A manuscript with one document, and a coherence file with one finding that has a message (open unless `status` says
 * otherwise), and one whole-manuscript scan that took no findings.
 */
function fixture(status: 'open' | 'fixed' = 'open'): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER });
  addDocument(state, { parentId: CHAPTER, title: 'The Storm', body: 'The gale arrived at dawn.', now: OPENED, id: STORM });
  const coherence = emptyCoherenceState();
  coherence.findings.push({ id: FINDING, status, message: MESSAGE, updatedAt: OPENED.toISOString(), evidence: [{ docId: STORM }] });
  coherence.runs.push({
    id: RUN,
    at: '2026-10-01T00:00:00.000Z',
    kind: 'deterministic',
    checkIds: ['codex.alias-collisions', 'codex.never-mentioned', 'presence.expected'],
    scope: { docIds: [STORM], mode: 'full' },
    findingsUpserted: [],
    status: 'complete',
  });
  state.coherence = coherence;
  return state;
}

/** One send as the writer, on a fresh project: the activity log's summary for it. A refusal fails the test, since the summary is the point. */
function writerSummaryOf(name: CommandName, params: Record<string, unknown>, status: 'open' | 'fixed' = 'open'): string {
  const state = fixture(status);
  const registry = createProjectCommandRegistry({ clock });
  const log = createActivityLog();
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log,
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  const command: Command = { id: newId('cmd'), name, params, issuedBy: 'user', createdAt: clock.now() };
  const result = execute(command, bus, registry);
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return log.entries().at(-1)?.summary ?? '';
}

describe('the coherence words name a change in the writer’s terms (coherence.md §7.1, §8)', () => {
  it('names each scene declaration by its word, once, in the order the patch gave them', () => {
    expect(declarationChangeWords(['after_add', 'after_remove', 'pov', 'dayOffset', 'expectedPresent_add', 'durationDays'])).toBe(
      'dependencies, point of view, day, expected presence and duration',
    );
    expect(declarationChangeWords(['timelineMode'])).toBe('timeline mode');
    expect(declarationChangeWords(['dayOffset', 'storyPart'])).toBe('day and story part');
    expect(declarationChangeWords(['threads_add', 'threads_remove'])).toBe('threads');
  });

  it('names a dismissal reason in the picker’s words, and returns a reason it does not hold as written', () => {
    expect(dismissalWordsOf('in-world-lie')).toBe('in-world lie');
    expect(dismissalWordsOf('false-positive')).toBe('false positive');
    expect(dismissalWordsOf('deep POV')).toBe('deep POV');
  });

  it('names a run by its kind, its scope and its checks or categories, never by its id', () => {
    const checks = Array.from({ length: 14 }, (_, index) => `check.${index}`);
    expect(runWordsOf({ kind: 'deterministic', checkIds: checks, scope: { docIds: [STORM], mode: 'full' } })).toBe(
      'a scan of the whole manuscript (14 checks)',
    );
    expect(runWordsOf({ kind: 'deterministic', checkIds: ['presence.expected'], scope: { docIds: [STORM, CHAPTER], mode: 'doc' } })).toBe(
      'a scan of 2 documents (1 check)',
    );
    expect(runWordsOf({ kind: 'llm', checkIds: ['llm:factual'], scope: { docIds: [STORM] } })).toBe('a model review of 1 document (1 category)');
    expect(runWordsOf({ kind: 'llm', checkIds: ['llm:factual', 'llm:timeline-plot', 'llm:narrative-style'], scope: { docIds: [STORM, CHAPTER, 'n_X'] } })).toBe(
      'a model review of 3 documents (3 categories)',
    );
  });

  it('names a dismissed finding by its message and the reason in words, with no finding id', () => {
    const summary = writerSummaryOf('coherence.setFindingStatus', { findingId: FINDING, status: 'dismissed', reason: 'in-world-lie' });
    expect(summary).toBe(`dismissed the finding “${MESSAGE}” as in-world lie`);
    expect(summary).not.toContain(FINDING);
  });

  it('names a finding marked fixed by its message, and a reopened one as reopened', () => {
    expect(writerSummaryOf('coherence.setFindingStatus', { findingId: FINDING, status: 'fixed' })).toBe(`marked the finding “${MESSAGE}” fixed`);
    expect(writerSummaryOf('coherence.setFindingStatus', { findingId: FINDING, status: 'open' }, 'fixed')).toBe(`reopened the finding “${MESSAGE}”`);
  });

  it('names a scene declaration change by the declaration, not by the patch key', () => {
    expect(writerSummaryOf('coherence.setSceneMeta', { docId: STORM, patch: { dayOffset: 3, durationDays: 2 } })).toBe(
      'set day and duration on the scene declarations of "The Storm"',
    );
  });

  it('names a discarded run by its scope and checks, with no run id', () => {
    // The fixture's run took no findings, so the summary names the run alone.
    const summary = writerSummaryOf('coherence.discardRun', { runId: RUN });
    expect(summary).toBe('discarded a scan of the whole manuscript (3 checks)');
    expect(summary).not.toContain(RUN);
  });
});
