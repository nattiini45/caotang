/**
 * The coherence module's tools, wired into the registry (coherence.md §7).
 *
 * - `coherence.scan` is a read the engine answers by default. Its run joins the held coherence file.
 * - `coherence.setFindingStatus` marks a finding fixed only through the engine's refusals and its
 *   postcondition, and the change is the bus command's: undoable, and logged. A dismissal is refused.
 * - `coherence.review` has no default port, because its model call is async and a port is synchronous,
 *   so it is refused as not wired until an app supplies a provider-backed one.
 * - A scope over the document guard is refused in words a read caller can act on, and the one-document
 *   scan those words name runs. A run with many finding groups is answered within its cap, not refused.
 * - A dismissal survives a save and a reload of `coherence.json` (coherence.md §3). The save is named here
 *   by the test; nothing in the app calls it yet.
 */

import { describe, expect, it } from 'vitest';

import { capOf, fitsCap } from '../src/index.js';
import { CHAPTER_ONE, OPENED, STORM, TICK, makeHarness, makeState, refusalOf, run, valueOf } from './fixtures.js';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
  type CommandRegistry,
} from '@caotang/bus';
import { loadCoherence, saveCoherence, type CoherenceFile, type Finding } from '@caotang/coherence';
import { newId } from '@caotang/ids';
import { MemoryArtifactFs, addDocument, type ProjectState } from '@caotang/store';

const FINDING = 'f_AAAAAAAAAA';
const QUOTE = 'The lamp failed.';

/**
 * Seeds one open llm finding in the held coherence file, quoting `QUOTE` in the storm. The engine's
 * postcondition reads the quote back out of the manuscript, so the test decides whether it is still there.
 */
function seedFinding(state: ProjectState): void {
  const from = state.documents.get(STORM)!.body.indexOf(QUOTE);
  const finding: Finding = {
    id: FINDING,
    runId: 'r_RUN0000000',
    class: 'llm',
    checkId: 'llm:factual',
    type: 'factual',
    severity: 'error',
    status: 'open',
    factGroup: 'the lamp|state',
    evidence: [{ docId: STORM, quote: QUOTE, from, to: from + QUOTE.length }],
    createdAt: '2026-10-08T09:00:00.000Z',
    updatedAt: '2026-10-08T09:00:00.000Z',
    message: 'The lamp is said to fail twice.',
  };
  // The state holds the store's structural copy of the file; the coherence module's file is that copy's
  // subtype, so this is the one cast a test needs to seed a finding the engine will read as it is.
  const file = (state.coherence ?? (state.coherence = emptyFile())) as unknown as CoherenceFile;
  file.findings.push(finding);
}

function emptyFile(): NonNullable<ProjectState['coherence']> {
  return { formatVersion: 1, findings: [], runs: [], sceneMeta: {}, worldRules: [], knowledge: [], reviewState: {} };
}

describe('coherence.scan (coherence.md §7 tool 15)', () => {
  it('is wired by default and records its run in the held coherence file, which it creates when there is none', () => {
    const state = makeState();
    expect(state.coherence).toBeUndefined();
    const outcome = valueOf(run(makeHarness({}, state), 'coherence.scan', { scope: { mode: 'full' } }));
    expect(state.coherence?.runs.length).toBeGreaterThan(0);
    expect(outcome.data['runId']).toBeDefined();
  });

  it('is a read, so an external caller may run it with no approval', () => {
    const state = makeState();
    const outcome = makeHarness({}, state).external.call(
      { name: 'coherence.scan', callId: 'external-scan', params: { scope: { mode: 'full' } } },
      { turnId: 'external-turn' },
    );
    expect(outcome.ok).toBe(true);
  });

  it('refuses an unknown check id at the registry, naming the closed set of check ids', () => {
    // The check list is a closed enum in the tool's params, so the registry's own check refuses it
    // before the engine is asked (the engine's own list-of-valid-ids message is for a direct caller).
    const error = refusalOf(run(makeHarness({}), 'coherence.scan', { checks: ['made.up'] }));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('must be one of');
  });

  it('refuses a scope over the document guard in words a read caller can act on, and the one-document scan it names runs', () => {
    const state = makeState();
    const ids = Array.from({ length: 21 }, (_, index) => addDocument(state, { parentId: CHAPTER_ONE, title: `Scene ${index}`, body: `Scene ${index} is here.`, now: OPENED }).id);
    const harness = makeHarness({}, state);
    const error = refusalOf(run(harness, 'coherence.scan', { scope: { mode: 'full' } }));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('over the 20-document guard');
    expect(error.message).toContain('Scan one document at a time');
    // The refusal names no confirmation the caller could give: the card it used to point at does not exist for a read.
    expect(error.message).not.toContain('in the card');
    expect(error.message).not.toContain('confirm it');
    // The refusal wrote nothing: no run was recorded before it.
    expect(state.coherence?.runs ?? []).toHaveLength(0);
    // The corrective path the refusal names is real: a scan of one of those documents runs.
    const one = valueOf(run(harness, 'coherence.scan', { scope: { mode: 'doc', docIds: [ids[0]!] } }));
    expect(one.data['runId']).toBeDefined();
  });

  it('answers within its cap when the run holds more finding groups than fit, and says how many it left out', () => {
    const state = makeState();
    // Forty entries that share one alias: every pair collides, and each collision is a finding of its own.
    for (let index = 0; index < 40; index += 1) {
      state.manifest.codex?.push({ ...state.manifest.codex![0]!, id: `c_CL${String(index).padStart(8, '0')}`, name: `Holder ${index}`, aliases: ['Shared'] });
    }
    const outcome = valueOf(run(makeHarness({}, state), 'coherence.scan', { scope: { mode: 'full' } }));
    const shown = outcome.data['groups'] as unknown[];
    expect(fitsCap(outcome.data, capOf('coherence.scan'))).toBe(true);
    expect(shown.length).toBeGreaterThan(0);
    // The run holds every finding it made; only the answer is cut.
    expect(state.coherence?.findings.length ?? 0).toBeGreaterThan(shown.length);
    expect(outcome.notes?.join(' ')).toContain('left out');
  });

  it('replays the same callId as the cached answer, with one run recorded (command-bus §6)', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const first = valueOf(run(harness, 'coherence.scan', { scope: { mode: 'full' } }, { turnId: 'turn-replay', callId: 'scan-once' }));
    const runsAfterFirst = state.coherence?.runs.length;
    expect(runsAfterFirst).toBe(1);
    // The same call again, with the same callId: the held file is not touched, and the answer is the first one.
    const replay = valueOf(run(harness, 'coherence.scan', { scope: { mode: 'full' } }, { turnId: 'turn-replay', callId: 'scan-once' }));
    expect(replay).toEqual(first);
    expect(state.coherence?.runs.length).toBe(1);
  });

  it('refuses a scope over the guard without the writer’s agreement, and runs it once the turn carries a one-step confirmation (coherence.md §7 tool 15)', () => {
    const state = makeState();
    Array.from({ length: 21 }, (_, index) => addDocument(state, { parentId: CHAPTER_ONE, title: `Scene ${index}`, body: `Scene ${index} is here.`, now: OPENED }));
    const harness = makeHarness({}, state);
    expect(refusalOf(run(harness, 'coherence.scan', { scope: { mode: 'full' } })).code).toBe('invalid-params');
    expect(state.coherence?.runs ?? []).toHaveLength(0);
    const confirmed = valueOf(run(harness, 'coherence.scan', { scope: { mode: 'full' } }, { permission: { confirmed: true } }));
    expect(confirmed.data['runId']).toBeDefined();
    expect(state.coherence?.runs.length).toBe(1);
  });

  it('writes one activity row for the run, under the turn that asked for it, from the caller’s source (coherence.md §9)', () => {
    const harness = makeHarness({}, makeState());
    valueOf(run(harness, 'coherence.scan', { scope: { mode: 'full' } }, { turnId: 'turn-report' }));
    const rows = harness.log.entries().filter((entry) => entry.command === 'coherence.scan');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ issuedBy: 'agent', turnId: 'turn-report', source: 'native', affected: [] });
    expect(rows[0]?.summary).toMatch(/^Scan /);
  });
});

describe('coherence.setFindingStatus (coherence.md §6.3, §7 tool 17)', () => {
  it('refuses the agent a dismissal, in the words the spec gives it, and leaves the finding open', () => {
    const state = makeState();
    seedFinding(state);
    const harness = makeHarness({}, state);
    const error = refusalOf(
      run(harness, 'coherence.setFindingStatus', { findingId: FINDING, status: 'dismissed', note: 'Fine.' }, { permission: { approvedPlan: true } }),
    );
    expect(error.code).toBe('hard-denied');
    expect(error.message).toContain('dismissal is a writer judgment');
    expect(state.coherence?.findings[0]?.status).toBe('open');
  });

  it('refuses to mark a finding fixed while its quoted text is still in the manuscript', () => {
    const state = makeState();
    seedFinding(state);
    const error = refusalOf(run(makeHarness({}, state), 'coherence.setFindingStatus', { findingId: FINDING, status: 'fixed' }, { permission: { approvedPlan: true } }));
    expect(error.message).toContain('evidence still present');
    expect(state.coherence?.findings[0]?.status).toBe('open');
  });

  it('marks a finding fixed through the bus once its text has changed, and one undo reopens it', () => {
    const state = makeState();
    seedFinding(state);
    // The writer has edited the passage away, so the postcondition holds.
    state.documents.get(STORM)!.body = 'Rain.';
    const harness = makeHarness({}, state);
    const outcome = valueOf(
      run(harness, 'coherence.setFindingStatus', { findingId: FINDING, status: 'fixed', note: 'Reworded.' }, { permission: { approvedPlan: true } }),
    );
    expect(state.coherence?.findings[0]?.status).toBe('fixed');
    expect(state.coherence?.findings[0]?.note).toBe('Reworded.');
    expect(outcome.undoGroupId).toBeDefined();

    expect(harness.undo.undo(outcome.undoGroupId!).ok).toBe(true);
    expect(state.coherence?.findings[0]?.status).toBe('open');
  });

  it('refuses a finding id the held file does not hold, and names where to find one', () => {
    const state = makeState();
    seedFinding(state);
    const error = refusalOf(run(makeHarness({}, state), 'coherence.setFindingStatus', { findingId: 'f_BBBBBBBBBB', status: 'fixed' }, { permission: { approvedPlan: true } }));
    expect(error.message).toContain('no finding has id "f_BBBBBBBBBB"');
  });

  it('is refused to an external caller while the project has not opened external writes (write-auto, restricted)', () => {
    const state = makeState();
    seedFinding(state);
    const outcome = makeHarness({}, state).external.call(
      { name: 'coherence.setFindingStatus', callId: 'external-fix', params: { findingId: FINDING, status: 'fixed' } },
      { turnId: 'external-turn' },
    );
    expect(outcome.ok).toBe(false);
    expect(state.coherence?.findings[0]?.status).toBe('open');
  });
});

describe('coherence.review (coherence.md §5.3, §7 tool 16)', () => {
  it('is refused as not wired by default, because its model call is async and no default port answers it', () => {
    const error = refusalOf(run(makeHarness({}), 'coherence.review', { scope: { mode: 'full' } }, { permission: { confirmed: true } }));
    expect(error.code).toBe('internal');
    expect(error.message).toContain('has no implementation in this build');
  });
});

/**
 * A dismissal is the writer's, so the test sends it as the user would from the inbox: the bus command, with
 * `issuedBy: 'user'`, which the gate reads as the writer's own gesture (command-bus §4).
 */
function dismissAsWriter(state: ProjectState, registry: CommandRegistry, findingId: string, reason: string) {
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo: createUndoStore({ dispatch: (command) => execute(command, bus, registry) }),
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  const command: Command = {
    id: newId('cmd'),
    name: 'coherence.setFindingStatus',
    params: { findingId, status: 'dismissed', reason },
    issuedBy: 'user',
    createdAt: TICK,
  };
  return execute(command, bus, registry);
}

describe('the held coherence file through a save and a reload (coherence.md §3)', () => {
  it('keeps a dismissal, and its reason, through a save and a reload of coherence.json', async () => {
    const state = makeState();
    // Two entries that share an alias collide, and a collision is a finding the scan records.
    state.manifest.codex?.push({ ...state.manifest.codex![0]!, id: 'c_ADAAAAAAAA', name: 'Ada', aliases: ['Shared'] });
    state.manifest.codex?.push({ ...state.manifest.codex![0]!, id: 'c_BEAAAAAAAA', name: 'Bea', aliases: ['Shared'] });
    const fs = new MemoryArtifactFs();
    // The project is opened the way the app must open it: load the file, and keep the load to save with.
    const opened = await loadCoherence(fs);
    expect(opened.status).toBe('absent');
    state.coherence = opened.file;

    const harness = makeHarness({}, state);
    valueOf(run(harness, 'coherence.scan', { scope: { mode: 'full' } }));
    const finding = state.coherence?.findings[0];
    expect(finding?.status).toBe('open');

    expect(dismissAsWriter(state, harness.registry, finding!.id, 'flashback').ok).toBe(true);
    await saveCoherence(fs, opened, state.coherence as unknown as CoherenceFile);

    const reopened = await loadCoherence(fs);
    expect(reopened.status).toBe('loaded');
    const back = reopened.file.findings.find((candidate) => candidate.id === finding!.id);
    expect(back?.status).toBe('dismissed');
    expect(back?.dismissedReason).toBe('flashback');
  });
});
