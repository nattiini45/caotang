/**
 * The agent's coherence path (coherence.md §5.1, §5.3, §7): the scan honours the writer's Coherence settings and reads the
 * dialogue facts, `coherence.review` is an async port the harness runs once its plan is approved, and project.overview names no
 * write tool to a caller that may not write (extensibility §9).
 */

import { describe, expect, it } from 'vitest';

import { BRANCH_CHECK_IDS, DETERMINISTIC_CHECK_IDS, type CoherenceModel, type DeterministicCheckId, type ModelReply, type ModelRequest } from '@caotang/coherence';
import { plannerSystem } from '../src/agent/protocol.js';
import { portPreflights } from '../src/agent/ports.js';
import { STORM, makeHarness, makeState, refusalOf, run, valueOf } from './fixtures.js';
import { createAgentPorts, type Harness, type ToolListing } from '../src/index.js';

/** A model that answers every review call with the same reply, and records each request it was sent. */
function scriptedModel(content: string): { readonly model: CoherenceModel; readonly calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  const model: CoherenceModel = {
    model: 'test-model',
    complete: async (request) => {
      calls.push(request);
      return { content, usage: { promptTokens: 10, completionTokens: 5 } };
    },
  };
  return { model, calls };
}

/** The listing of one tool, from the harness's own table. */
function listingOf(harness: Harness, name: string): ToolListing {
  const listing = harness.tools().find((tool) => tool.name === name);
  if (listing === undefined) throw new Error(`no listing for ${name}`);
  return listing;
}

/** A plan staged for `docIds`, as the loop stages it before a card is shown. */
function stagedPlan(harness: Harness, docIds: readonly string[]) {
  const planned = harness.reviewPlan({ scope: { mode: 'doc', docIds: [...docIds] } });
  if (!planned.ok) throw new Error(`planning failed: ${planned.error.message}`);
  return planned.value;
}

/** The approval a plan's card gives, as the loop passes it to the harness. */
const APPROVED = { turnId: 'turn-review', permission: { approvedPlan: true as const } };

describe('coherence.scan and the writer’s Coherence settings (coherence.md §5.1, Settings › Coherence)', () => {
  it('runs every check and says nothing about settings when the app gives none, as a bare harness always has', () => {
    const outcome = valueOf(run(makeHarness({}), 'coherence.scan', { scope: { mode: 'full' } }));
    expect(outcome.notes).toBeUndefined();
  });

  it('leaves out a check the writer turned off, even when the model names it, and says so in the answer', () => {
    const harness = makeHarness({ coherence: { checks: () => ['codex.alias-collisions', 'timeline.relation'] } });
    const outcome = valueOf(run(harness, 'coherence.scan', { scope: { mode: 'full' }, checks: ['codex.never-mentioned', 'timeline.relation'] }));
    const notes = (outcome.notes ?? []).join(' ');
    expect(notes).toContain('codex.never-mentioned');
    expect(notes).not.toContain('timeline.relation');
    // The run that was recorded names only the checks that ran.
    expect(harness.state.coherence?.runs.at(-1)?.checkIds).toEqual(['timeline.relation']);
  });

  it('refuses in plain words when every check it would run is turned off, and records no run', () => {
    const harness = makeHarness({ coherence: { checks: () => [] } });
    const refused = refusalOf(run(harness, 'coherence.scan', { scope: { mode: 'full' } }));
    expect(refused.code).toBe('invalid-params');
    expect(refused.message).toContain('turned off in Settings');
    expect(harness.state.coherence?.runs ?? []).toEqual([]);
  });

  it('keeps every check when all are on, so the scan is the one the Findings tab runs', () => {
    const all: readonly DeterministicCheckId[] = [...DETERMINISTIC_CHECK_IDS];
    const outcome = valueOf(run(makeHarness({ coherence: { checks: () => all } }), 'coherence.scan', { scope: { mode: 'full' } }));
    expect(outcome.notes).toBeUndefined();
  });

  it('reads the dialogue facts of the open project at each scan, and a full scan runs the branch checks on them (dialogue-narrative.md §5)', () => {
    const seen: number[] = [];
    const harness = makeHarness({
      coherence: {
        dialogue: (state) => {
          seen.push(state.manifest.tree.length);
          return { findings: [], containerIds: [] };
        },
      },
    });
    run(harness, 'coherence.scan', { scope: { mode: 'full' } });
    run(harness, 'coherence.scan', { scope: { mode: 'full' } });
    expect(seen).toHaveLength(2);
    // The recorded run names a branch check among the checks it ran, and does not say the dialogue checks were left out.
    const recorded = harness.state.coherence?.runs.at(-1);
    expect(recorded?.checkIds).toContain(BRANCH_CHECK_IDS[0]);
    expect((recorded?.notes ?? []).join(' ')).not.toContain('dialogue checks not run');
  });
});

describe('coherence.review as an async port (coherence.md §5.3, §7 tool 16)', () => {
  it('is not wired, and not async, without a model source', () => {
    const listing = listingOf(makeHarness({}), 'coherence.review');
    expect(listing.wired).toBe(false);
    expect(listing.async).toBe(false);
  });

  it('is wired and async once the app gives a model source', () => {
    const { model } = scriptedModel('{"spans": []}');
    const listing = listingOf(makeHarness({ coherence: { model: () => model } }), 'coherence.review');
    expect(listing.wired).toBe(true);
    expect(listing.async).toBe(true);
  });

  it('plans with no model call, so the card can show what the review will read before anyone approves it', () => {
    const { model, calls } = scriptedModel('{"spans": []}');
    const plan = stagedPlan(makeHarness({ coherence: { model: () => model } }), [STORM]);
    expect(plan.scopeDocIds).toEqual([STORM]);
    expect(plan.documents.map((doc) => doc.docId)).toEqual([STORM]);
    expect(plan.estimate.extractCalls).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('refuses to plan, with a sentence that names the provider, when none is active', () => {
    const harness = makeHarness({ coherence: { model: () => undefined } });
    const planned = harness.reviewPlan({ scope: { mode: 'doc', docIds: [STORM] } });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error.message).toMatch(/provider/i);
  });

  it('refuses a synchronous call, even under an approval, because it awaits a model and runs only through callAsync', () => {
    const { model } = scriptedModel('{"spans": []}');
    const harness = makeHarness({ coherence: { model: () => model } });
    // Without an approval the gate refuses first, as it does every write-confirm tool.
    expect(refusalOf(run(harness, 'coherence.review', { scope: { mode: 'full' } })).code).toBe('permission-denied');
    const approved = harness.call({ name: 'coherence.review', callId: 'c-sync', params: { scope: { mode: 'full' } } }, APPROVED);
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.error.code).toBe('invalid-params');
    expect(approved.error.message).toContain('awaits a model');
  });

  it('refuses without the writer’s approval, and calls no model', async () => {
    const { model, calls } = scriptedModel('{"spans": []}');
    const harness = makeHarness({ coherence: { model: () => model } });
    const plan = stagedPlan(harness, [STORM]);
    const outcome = await harness.callAsync({ name: 'coherence.review', callId: 'c-1', params: { scope: { mode: 'doc', docIds: [STORM] } }, proposal: plan }, { turnId: 'turn-open' });
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('runs the approved plan through the engine with the app’s model, and records the run in the held file', async () => {
    const { model, calls } = scriptedModel('{"spans": []}');
    const harness = makeHarness({ coherence: { model: () => model } });
    const plan = stagedPlan(harness, [STORM]);
    const outcome = await harness.callAsync({ name: 'coherence.review', callId: 'c-2', params: { scope: { mode: 'doc', docIds: [STORM] } }, proposal: plan }, APPROVED);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.summary).toMatch(/^Review /);
    expect(calls).toHaveLength(1);
    expect(harness.state.coherence?.runs).toHaveLength(1);
    expect(harness.log.entries().some((entry) => entry.command === 'coherence.review')).toBe(true);
  });

  it('answers a replay of the same call from its record, so the review runs once', async () => {
    const { model, calls } = scriptedModel('{"spans": []}');
    const harness = makeHarness({ coherence: { model: () => model } });
    const plan = stagedPlan(harness, [STORM]);
    const call = { name: 'coherence.review', callId: 'c-3', params: { scope: { mode: 'doc', docIds: [STORM] } }, proposal: plan };
    await harness.callAsync(call, APPROVED);
    const again = await harness.callAsync(call, APPROVED);
    expect(again.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(harness.state.coherence?.runs).toHaveLength(1);
  });

  it('keeps a scan made while the review waits on its model, so the run that scan recorded is not overwritten', async () => {
    let answer: (reply: ModelReply) => void = () => {};
    const waiting = new Promise<ModelReply>((resolve) => {
      answer = resolve;
    });
    let asked = 0;
    const model: CoherenceModel = {
      model: 'test-model',
      complete: () => {
        asked += 1;
        return waiting;
      },
    };
    const harness = makeHarness({ coherence: { model: () => model } });
    const plan = stagedPlan(harness, [STORM]);
    const review = harness.callAsync({ name: 'coherence.review', callId: 'c-race', params: { scope: { mode: 'doc', docIds: [STORM] } }, proposal: plan }, APPROVED);
    // The review has sent its extraction and is waiting for the model's answer.
    expect(asked).toBe(1);
    // The writer scans while the review waits. The scan replaces the held findings file, with its run in it.
    const scan = valueOf(run(harness, 'coherence.scan', { scope: { mode: 'full' } }, { callId: 'scan-while-waiting' }));
    answer({ content: '{"spans": []}', usage: { promptTokens: 10, completionTokens: 5 } });
    const outcome = await review;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Both runs are in the held file, in the order they were recorded: the scan's run was not replaced by the review's copy.
    expect((harness.state.coherence?.runs ?? []).map((recorded) => recorded.id)).toEqual([scan.data['runId'], outcome.value.data['runId']]);
  });

  it('is refused to an external caller, which holds no approval and may not reach a model through Caotang', async () => {
    const { model, calls } = scriptedModel('{"spans": []}');
    const harness = makeHarness({ coherence: { model: () => model } });
    const outcome = await harness.callAsync({ name: 'coherence.review', callId: 'c-4', params: { scope: { mode: 'full' } } }, { turnId: 'ext', source: 'mcp' });
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('records no finding for a model answer it cannot read, so nothing unverified reaches the inbox', async () => {
    const { model } = scriptedModel('this is not JSON');
    const harness = makeHarness({ coherence: { model: () => model } });
    const plan = stagedPlan(harness, [STORM]);
    await harness.callAsync({ name: 'coherence.review', callId: 'c-5', params: { scope: { mode: 'doc', docIds: [STORM] } }, proposal: plan }, APPROVED);
    expect(harness.state.coherence?.findings ?? []).toEqual([]);
  });

  it('runs the port state check before an async call, so a plan and its call refuse alike', async () => {
    const { model, calls } = scriptedModel('{"spans": []}');
    const harness = makeHarness({ coherence: { model: () => model } });
    const held = { message: 'the state refuses this review' };
    portPreflights['coherence.review'] = () => ({
      code: 'invalid-params',
      message: held.message,
      correctiveHint: 'check the scope and call again',
    });
    try {
      const plan = stagedPlan(harness, [STORM]);
      const outcome = await harness.callAsync({ name: 'coherence.review', callId: 'c-state', params: { scope: { mode: 'doc', docIds: [STORM] } }, proposal: plan }, APPROVED);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.message).toBe(held.message);
      expect(calls).toHaveLength(0);
    } finally {
      delete portPreflights['coherence.review'];
    }
  });
});

describe('project.overview names no write tool to a caller that may not write (extensibility §9)', () => {
  it('names the write tool to the agent, which may write', () => {
    const state = makeState();
    state.manifest.tree = state.manifest.tree.filter((node) => node.type !== 'document');
    const outcome = valueOf(run(makeHarness({}, state), 'project.overview', {}));
    expect(JSON.stringify(outcome)).toContain('Use binder.restructure to create chapters.');
  });

  it('names no write tool to a read-only external caller, and says where chapters are made', async () => {
    const state = makeState();
    state.manifest.tree = state.manifest.tree.filter((node) => node.type !== 'document');
    const harness = makeHarness({ externalWrites: false }, state);
    const outcome = await harness.external.call({ name: 'project.overview', callId: 'ro-1', params: {} }, { turnId: 'ext-ro' });
    expect(outcome.ok).toBe(true);
    const text = JSON.stringify(outcome.ok ? outcome.value : {});
    expect(text).not.toContain('binder.restructure');
    expect(text).toContain('Chapters are made in Caotang, because this server is read-only.');
  });
});

describe('the planner’s tool list (agent-harness §3, tool 10’s supersession note)', () => {
  it('offers the review, and not continuity.scan, once the review is wired', () => {
    const { model } = scriptedModel('{"spans": []}');
    const wired = plannerSystem(makeHarness({ ports: createAgentPorts(), coherence: { model: () => model } }).tools());
    expect(wired).toContain('- coherence.review [write-confirm]');
    expect(wired).not.toContain('- continuity.scan');
  });

  it('still offers continuity.scan when no review is wired, so a harness without a model is unchanged', () => {
    const plain = plannerSystem(makeHarness({ ports: createAgentPorts() }).tools());
    expect(plain).toContain('- continuity.scan');
    expect(plain).not.toContain('- coherence.review');
  });
});
