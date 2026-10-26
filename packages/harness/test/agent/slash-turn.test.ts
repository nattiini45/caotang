/**
 * The turn side of slash commands (agent-harness §2, "Slash commands"): `forcePlan`, `TurnReport.command` and its run-log record, a plan
 * of reads, and the context preview. The real session on the real bus, with the mock gateway; nothing needs a key.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest } from '@caotang/gateway';
import type { MockScript } from '@caotang/gateway/mock';
import type { ProjectState } from '@caotang/store';

import {
  createAgentPorts,
  createAgentSession,
  createBudgetMeter,
  createContextPort,
  createHarness,
  createMemoryRunLog,
  type AgentSession,
  type AgentSessionOptions,
  type Decision,
  type PendingCard,
  type PermissionMode,
  type PlanStep,
  type RunEvent,
  type RuleSet,
  type RunLogPort,
  type SourcedRule,
  type TurnReport,
} from '../../src/index.js';
import { FRIEND, LANDING, STORM, clock, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, prose, steps, transcript } from './scripts.js';

const REQUEST = 'Keep the storm scenes together.';
/** `filter.save` is write-auto and no mode's edit list holds it: a single call of it runs at once, and accept-edits would not approve its card. */
const FILTER = { tool: 'filter.save', params: { name: 'Unfinished', root: 'manuscript', criteria: { statusId: 'draft' } }, expect: 'a filter for drafts is saved' };
const LABEL = { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled' };

interface Built {
  readonly session: AgentSession;
  readonly state: ProjectState;
  readonly asked: PendingCard[];
  readonly requests: ChatRequest[];
}

async function build(
  scripts: readonly MockScript[],
  extras: Partial<AgentSessionOptions> & { readonly decision?: Decision; readonly state?: ProjectState; readonly rules?: readonly SourcedRule[] } = {},
): Promise<Built> {
  const state = extras.state ?? makeState();
  const base = await mockGateway(scripts);
  const requests: ChatRequest[] = [];
  const gateway = { ...base, complete: (request: ChatRequest, signal?: AbortSignal) => (requests.push(request), base.complete(request, signal)) };
  const set: RuleSet = { rules: extras.rules ?? [] };
  const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now, rules: () => set });
  const asked: PendingCard[] = [];
  const { decision, state: _state, rules: _rules, ...rest } = extras;
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state }),
    decide: async (card) => {
      asked.push(card);
      return decision ?? { action: 'approve' };
    },
    sessionId: 'slash',
    ...rest,
  });
  return { session, state, asked, requests };
}

const planner = (step: PlanStep, intent = REQUEST) => [transcript(intent, [steps(step), answer('Done.')])];
const kinds = (report: TurnReport) => report.cards.map((card) => [card.kind, card.decision]);

describe('forcePlan', () => {
  it('shows a card for a single reversible step that otherwise runs at once', async () => {
    const plain = await build(planner(LABEL));
    const report = await plain.session.submit(REQUEST);
    expect(kinds(report)).toEqual([['auto', 'auto']]);
    expect(plain.asked).toHaveLength(0);

    const forced = await build(planner(LABEL));
    const shown = await forced.session.submit(REQUEST, { forcePlan: true });
    expect(shown.status).toBe('applied');
    expect(kinds(shown)).toEqual([['plan', 'approved']]);
    expect(forced.asked.map((card) => card.kind)).toEqual(['plan']);
    expect(forced.state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBe('act-2');
  });

  it('writes nothing when the writer cancels the card it forced', async () => {
    const forced = await build(planner(LABEL), { decision: { action: 'cancel' } });
    const report = await forced.session.submit(REQUEST, { forcePlan: true });
    expect(report.status).toBe('cancelled');
    expect(forced.state.manifest.tree.find((node) => node.id === FRIEND)?.label).not.toBe('act-2');
  });

  it('does not let a mode approve a card the mode would not have approved', async () => {
    // Accept-edits runs a single filter.save at once, as every mode runs a reversible single step. Forced to a card, the mode that
    // approves only text and field edits leaves the card to the writer.
    const plain = await build(planner(FILTER), { mode: 'accept-edits' });
    expect(kinds(await plain.session.submit(REQUEST))).toEqual([['auto', 'auto']]);
    const forced = await build(planner(FILTER), { mode: 'accept-edits' });
    const report = await forced.session.submit(REQUEST, { forcePlan: true });
    expect(forced.asked).toHaveLength(1);
    expect(kinds(report)).toEqual([['plan', 'approved']]);
  });

  it('is approved by a mode exactly where the mode approves any card of the step', async () => {
    const forced = await build(planner(LABEL), { mode: 'accept-edits' });
    const report = await forced.session.submit(REQUEST, { forcePlan: true });
    expect(forced.asked).toHaveLength(0);
    expect(kinds(report)).toEqual([['auto', 'auto']]);
  });

  it('keeps plan-only a mode that refuses every write', async () => {
    const forced = await build(planner(LABEL), { mode: 'plan-only' });
    const report = await forced.session.submit(REQUEST, { forcePlan: true });
    expect(forced.asked).toHaveLength(0);
    expect(report.undoGroupId).toBeUndefined();
    expect(report.heldSteps?.map((step) => step.tool)).toEqual(['meta.set']);
    expect(forced.state.manifest.tree.find((node) => node.id === FRIEND)?.label).not.toBe('act-2');
  });

  it('leaves a card that was always the writer’s as it was, in every mode', async () => {
    for (const mode of ['ask', 'accept-edits', 'auto'] as PermissionMode[]) {
      const memory = { tool: 'memory.write', params: { title: 'Dialogue tags', type: 'style', body: 'Use said.' }, expect: 'the note is saved' };
      const run = await build(planner(memory), { mode });
      const report = await run.session.submit(REQUEST, { forcePlan: true, preload: ['memory.write'] });
      expect(run.asked, mode).toHaveLength(1);
      expect(kinds(report), mode).toEqual([['confirm', 'approved']]);
    }
  });
});

describe('TurnReport.command', () => {
  it('names the command on a planner turn, and on a plan the app built', async () => {
    const run = await build(planner(LABEL));
    const planned = await run.session.submit(REQUEST, { command: 'plan' });
    expect(planned.command).toBe('plan');
    const given = await run.session.submitPlan('Label The Friend', { steps: [LABEL] }, { command: 'draft' });
    expect(given.command).toBe('draft');
  });

  it('is absent for a turn no command started, and ignores a name that is not a command name', async () => {
    const run = await build(planner(LABEL));
    expect('command' in (await run.session.submit(REQUEST))).toBe(false);
    expect('command' in (await run.session.submit(REQUEST, { command: 'Not A Command' }))).toBe(false);
  });

  it('is written to the run log with the turn, and read back by a resume', async () => {
    const log = createMemoryRunLog();
    const run = await build(planner(LABEL), { runLog: { port: log as RunLogPort, projectId: 'p_SLASH' } });
    await run.session.submitPlan('Label The Friend', { steps: [LABEL] }, { command: 'draft' });
    const dump = JSON.parse(log.dump()) as RunEvent[][];
    const start = dump.flat().find((event) => event.t === 'turn.start');
    expect(start).toMatchObject({ t: 'turn.start', command: 'draft', wire: 'plan' });
  });

  it('is kept when a run is resumed after a reload', async () => {
    const log = createMemoryRunLog();
    let drop = (): void => {};
    const dropped = new Promise<void>((resolve) => {
      drop = resolve;
    });
    // The tab goes as the second step is about to begin.
    const dropping: RunLogPort = {
      ...log,
      append: (runId, events, patch) => {
        if (events.some((event) => event.t === 'step.intent' && event.index === 1)) {
          drop();
          return new Promise<void>(() => {});
        }
        return log.append(runId, events, patch);
      },
    };
    const state = makeState();
    const first = await build([], { state, runLog: { port: dropping, projectId: 'p_SLASH' }, sessionId: 'first' });
    void first.session.submitPlan('Label and note', { steps: [LABEL, { tool: 'notes.append', params: { doc: 'The Landing', text: 'A note.' }, expect: 'noted' }] }, { command: 'plan' });
    await dropped;
    const [run] = await log.open('p_SLASH');
    await log.update(run?.runId ?? '', { status: 'interrupted' });
    const second = await build([], { state, runLog: { port: log, projectId: 'p_SLASH' }, sessionId: 'second' });
    const report = await second.session.resume(run?.runId ?? '');
    expect(report.command).toBe('plan');
    const starts = ((await log.events(run?.runId ?? '')) as RunEvent[]).filter((event) => event.t === 'turn.start');
    expect(starts.map((event) => (event.t === 'turn.start' ? event.command : undefined))).toEqual(['plan', 'plan']);
  });

  it('does not write a command to the log for a turn without one', async () => {
    const log = createMemoryRunLog();
    const run = await build(planner(LABEL), { runLog: { port: log as RunLogPort, projectId: 'p_SLASH' } });
    await run.session.submit(REQUEST);
    const start = (JSON.parse(log.dump()) as RunEvent[][]).flat().find((event) => event.t === 'turn.start');
    expect(start && 'command' in start).toBe(false);
  });
});

describe('the card of a command’s plan', () => {
  const draft: PlanStep = { tool: 'scene.draft', params: { doc: FRIEND, instruction: 'Open.', mode: 'draft' }, expect: 'The Friend holds a new draft' };
  const compile: PlanStep = { tool: 'export.compile', params: { format: 'md', selection: { root: 'manuscript' } }, expect: 'the manuscript compiled as md' };

  for (const step of [draft, compile]) {
    it(`is the planner’s card for the same ${step.tool} step`, async () => {
      const scripts = (): MockScript[] => [...planner(step, 'Do it.'), prose('Brief: Open.', 'The ferry came in.')];
      const viaPlanner = await build(scripts(), { decision: { action: 'cancel' } });
      await viaPlanner.session.submit('Do it.');
      const viaCommand = await build(scripts(), { decision: { action: 'cancel' } });
      await viaCommand.session.submitPlan('Do it.', { steps: [step] }, { command: 'draft' });
      expect(viaCommand.asked).toHaveLength(1);
      const [theirs, ours] = [viaPlanner.asked[0], viaCommand.asked[0]];
      expect(ours?.kind).toBe(theirs?.kind);
      expect(ours?.card.steps).toEqual(theirs?.card.steps);
      expect({ ...ours?.card, id: '', turnId: '' }).toEqual({ ...theirs?.card, id: '', turnId: '' });
    });
  }
});

describe('a command’s plan is held to the agent’s rules (agent-harness §4)', () => {
  const draftStorm: PlanStep = { tool: 'scene.draft', params: { doc: STORM, instruction: 'Open.' }, expect: 'The Storm holds a draft' };
  const note: PlanStep = { tool: 'notes.append', params: { doc: 'The Landing', text: 'Check the tide.' }, expect: 'noted' };

  it('refuses a step a deny rule covers before its draft is asked for, and says why', async () => {
    const run = await build([prose('Brief: Open.', 'Never drafted.')], { rules: [{ effect: 'deny', tool: 'scene.draft', source: 'project' }] });
    const report = await run.session.submitPlan('Draft “The Storm”', { steps: [draftStorm] }, { command: 'draft' });
    expect(report.status).toBe('failed');
    expect(report.askBack?.reason).toContain('scene.draft');
    expect(run.requests).toHaveLength(0);
    expect(run.asked).toHaveLength(0);
    expect(run.state.documents.get(STORM)?.body).not.toContain('Never drafted.');
  });

  it('refuses a draft in a subtree whose writes are denied, whatever the command', async () => {
    const run = await build([prose('Brief: Open.', 'Never drafted.')], { rules: [{ effect: 'deny', tool: '*', source: 'project', scope: { subtree: STORM }, access: 'write' }] });
    const report = await run.session.submitPlan('Draft “The Storm”', { steps: [draftStorm] }, { command: 'draft' });
    expect(report.status).toBe('failed');
    expect(run.requests).toHaveLength(0);
  });

  it('shows a card for a step an ask rule covers, in every mode', async () => {
    for (const mode of ['ask', 'accept-edits', 'auto'] as PermissionMode[]) {
      const run = await build([], { mode, rules: [{ effect: 'ask', tool: 'notes.append', source: 'project' }] });
      const report = await run.session.submitPlan('Note on The Landing', { steps: [note] }, { command: 'plan' });
      expect(run.asked, mode).toHaveLength(1);
      expect(kinds(report), mode).toEqual([['confirm', 'approved']]);
    }
  });

  it('cannot reach a document a read rule withholds: a scan of it is refused and nothing of it is read', async () => {
    const run = await build([], { rules: [{ effect: 'deny', tool: '*', source: 'project', scope: { subtree: LANDING }, access: 'read' }] });
    const report = await run.session.submitPlan('Scan “The Landing”', { steps: [{ tool: 'coherence.scan', params: { scope: { mode: 'doc', docIds: [LANDING] } }, expect: 'findings' }] }, { command: 'scan' });
    expect(report.status).toBe('failed');
    expect(report.trace.every((row) => row.outcome !== 'ok')).toBe(true);
    expect(run.requests).toHaveLength(0);
  });
});

describe('a plan of one read', () => {
  const scan = { tool: 'coherence.scan', params: { scope: { mode: 'full' } }, expect: 'findings' };

  it('runs at once, behind no card the writer decides, and makes no model call', async () => {
    const run = await build([]);
    const report = await run.session.submitPlan('Scan the manuscript for coherence problems', { steps: [scan] }, { command: 'scan' });
    expect(report.status).toBe('applied');
    expect(kinds(report)).toEqual([['auto', 'auto']]);
    expect(report.trace.map((row) => [row.tool, row.outcome])).toEqual([['coherence.scan', 'ok']]);
    expect(run.asked).toHaveLength(0);
    expect(run.requests).toHaveLength(0);
    expect(report.modelCalls).toBe(0);
  });

  it('is refused for a document it cannot find, naming the step', async () => {
    const run = await build([]);
    const report = await run.session.submitPlan('Scan one document', { steps: [{ ...scan, params: { scope: { mode: 'doc', docIds: ['n_MSSNG00001'] } } }] });
    expect(report.status).toBe('failed');
    expect(report.trace[0]?.outcome).toBe('refused');
  });
});

describe('a command turn is held to the run limits like any other', () => {
  it('stops a draft the limits could not afford, before the model is asked', async () => {
    const meter = createBudgetMeter({ maxTokens: 1 });
    const run = await build([prose('Brief: Open.', 'Never drafted.')], { meter });
    const report = await run.session.submitPlan('Draft “The Friend”', { steps: [{ tool: 'scene.draft', params: { doc: FRIEND, instruction: 'Open.' }, expect: 'a draft' }] }, { command: 'draft' });
    expect(report.status).toBe('failed');
    expect(report.command).toBe('draft');
    expect(run.requests).toHaveLength(0);
    expect(run.state.documents.get(FRIEND)?.body).toBe('');
  });
});

describe('contextPreview', () => {
  it('lists the layers of the next planner request with their tokens, and sends nothing', async () => {
    const run = await build([]);
    const preview = run.session.contextPreview();
    expect(preview.layers.map((layer) => layer.id)).toEqual(expect.arrayContaining(['L0', 'L1', 'L7']));
    expect(preview.layers.every((layer) => Number.isInteger(layer.tokens) && layer.tokens >= 0)).toBe(true);
    expect(preview.promptTokens).toBeGreaterThan(0);
    expect(run.requests).toHaveLength(0);
  });

  it('reports what the assembly left out under a small budget', async () => {
    const state = makeState();
    state.agentFiles = { ...state.agentFiles, instructions: { path: 'CAOTANG.md', text: 'British spelling. '.repeat(400) } };
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const session = createAgentSession({
      harness,
      gateway: await mockGateway([]),
      context: createContextPort({ state, config: { layerBudgets: { LI: 50 } } }),
      decide: async () => ({ action: 'cancel' }),
      sessionId: 'preview',
    });
    expect(session.contextPreview().dropped.join(' ')).toContain('CAOTANG.md');
  });
});
