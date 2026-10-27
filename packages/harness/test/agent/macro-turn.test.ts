/**
 * A macro's turn (extensibility.md §10): the plan `expandMacro` makes goes through `submitPlan` like any plan, so it is carded, gated, ruled
 * and moded as any plan is, it runs as one turn in one undo group, and the run log and the report name the macro. The real session on the
 * real bus, with the mock gateway; nothing needs a key.
 */

import { describe, expect, it } from 'vitest';

import type { ProjectMacro } from '@caotang/bus';
import type { MockScript } from '@caotang/gateway/mock';
import type { ProjectState } from '@caotang/store';

import {
  createAgentPorts,
  createAgentSession,
  createContextPort,
  createHarness,
  createMemoryRunLog,
  createTraceStore,
  expandMacro,
  macroCommandName,
  macroIntent,
  type AgentSession,
  type AgentSessionOptions,
  type Decision,
  type PendingCard,
  type PermissionMode,
  type RuleSet,
  type RunEvent,
  type RunLogPort,
  type SourcedRule,
  type TurnReport,
} from '../../src/index.js';
import { CHAPTER_ONE, FRIEND, LANDING, clock, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';

const PARAMS = {
  kind: 'object' as const,
  description: 'The macro params.',
  properties: { doc: { kind: 'string' as const, description: 'The document.' } },
  required: ['doc'],
};

function macro(slug: string, steps: ProjectMacro['steps']): ProjectMacro {
  return { id: 'm_7K2QX9M4A1', slug, name: 'Tidy up', description: '', params: PARAMS, steps };
}

const ONE_WRITE = macro('one-write', [{ tool: 'meta.set', params: { targets: [{ $param: 'doc' }], label: 'act-2' }, expect: 'The document is labelled.' }]);
const TWO_WRITES = macro('two-writes', [
  { tool: 'meta.set', params: { targets: [{ $param: 'doc' }], label: 'act-2' }, expect: 'The document is labelled.' },
  { tool: 'notes.append', params: { doc: { $param: 'doc' }, text: 'Tidied.' }, expect: 'A note is added.' },
]);
const READS = macro('reads', [
  { tool: 'doc.read', params: { doc: { $param: 'doc' } }, expect: 'The document is read.' },
  { tool: 'notes.read', params: { doc: { $param: 'doc' } }, expect: 'Its notes are read.' },
]);
const FILTER = macro('filter', [{ tool: 'filter.save', params: { name: 'Unfinished', root: 'manuscript', criteria: { statusId: 'draft' } }, expect: 'A filter is saved.' }]);

interface Built {
  readonly session: AgentSession;
  readonly state: ProjectState;
  readonly asked: PendingCard[];
}

async function build(extras: Partial<AgentSessionOptions> & { readonly decision?: Decision; readonly rules?: readonly SourcedRule[] } = {}): Promise<Built> {
  const state = makeState();
  const scripts: MockScript[] = [];
  const set: RuleSet = { rules: extras.rules ?? [] };
  const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now, rules: () => set });
  const asked: PendingCard[] = [];
  const { decision, rules: _rules, ...rest } = extras;
  const session = createAgentSession({
    harness,
    gateway: await mockGateway(scripts),
    context: createContextPort({ state }),
    decide: async (card) => {
      asked.push(card);
      return decision ?? { action: 'approve' };
    },
    sessionId: 'macro',
    ...rest,
  });
  return { session, state, asked };
}

/** The turn the Macros panel starts: the expanded plan, named by the macro, with a card for any write. */
async function runMacro(built: Built, subject: ProjectMacro, values: Record<string, unknown>, force = true): Promise<TurnReport> {
  const plan = expandMacro(subject, values);
  if (!plan.ok) throw new Error(plan.error.message);
  const reads = plan.value.steps.every((step) => step.tool === 'doc.read' || step.tool === 'notes.read');
  return built.session.submitPlan(macroIntent(subject), plan.value, { command: macroCommandName(subject.slug), forcePlan: force && !reads, readsWithoutCard: true });
}

const kinds = (report: TurnReport) => report.cards.map((card) => [card.kind, card.decision]);
const labelOf = (state: ProjectState, id: string) => state.manifest.tree.find((node) => node.id === id)?.label;

describe('a macro of writes shows a card, even for one reversible step', () => {
  it('shows the plan card for a single write-auto step, which runs once the writer approves it', async () => {
    const built = await build();
    const report = await runMacro(built, ONE_WRITE, { doc: 'The Friend' });
    expect(report.status).toBe('applied');
    expect(kinds(report)).toEqual([['plan', 'approved']]);
    expect(built.asked).toHaveLength(1);
    expect(built.asked[0]?.card.steps.map((step) => step.tool)).toEqual(['meta.set']);
    expect(labelOf(built.state, FRIEND)).toBe('act-2');
  });

  it('lists every expanded step on the card, and runs them as one turn in one undo group', async () => {
    const built = await build();
    const report = await runMacro(built, TWO_WRITES, { doc: 'The Landing' });
    expect(report.status).toBe('applied');
    expect(built.asked[0]?.card.steps.map((step) => [step.tool, step.expect])).toEqual([
      ['meta.set', 'The document is labelled.'],
      ['notes.append', 'A note is added.'],
    ]);
    expect(built.asked[0]?.card.steps[1]?.params).toEqual({ doc: 'The Landing', text: 'Tidied.' });
    expect(report.undoGroupId).toBeDefined();
    const undone = built.session.restore(report.turnId);
    expect(undone.ok).toBe(true);
    expect(labelOf(built.state, LANDING)).toBe('act-1');
    expect(built.state.manifest.tree.find((node) => node.id === LANDING)?.notes).not.toContain('Tidied.');
  });

  it('writes nothing when the writer cancels the card', async () => {
    const built = await build({ decision: { action: 'cancel' } });
    const report = await runMacro(built, TWO_WRITES, { doc: 'The Friend' });
    expect(report.status).toBe('cancelled');
    expect(labelOf(built.state, FRIEND)).not.toBe('act-2');
  });
});

describe('a macro of reads runs without a card', () => {
  it('runs at once and shows no card the writer decides', async () => {
    const built = await build();
    const report = await runMacro(built, READS, { doc: 'The Landing' });
    expect(report.status).toBe('replied');
    expect(report.trace.map((row) => [row.tool, row.outcome])).toEqual([['doc.read', 'ok'], ['notes.read', 'ok']]);
    expect(built.asked).toHaveLength(0);
    expect(report.modelCalls).toBe(0);
  });

  it('shows the card submitPlan always showed when the option is not given', async () => {
    const built = await build();
    const plan = expandMacro(READS, { doc: 'The Landing' });
    if (!plan.ok) throw new Error(plan.error.message);
    await built.session.submitPlan('Read it', plan.value);
    expect(built.asked.map((card) => card.kind)).toEqual(['plan']);
  });

  it('still asks when a rule asks about a read', async () => {
    const built = await build({ rules: [{ effect: 'ask', tool: 'doc.read', source: 'project' }] });
    const report = await runMacro(built, READS, { doc: 'The Landing' });
    expect(built.asked.map((card) => card.kind)).toEqual(['confirm']);
    expect(report.status).toBe('replied');
  });
});

describe('a macro’s steps are held to the rules and the modes like any plan step', () => {
  it('refuses a step a deny rule covers, and writes nothing', async () => {
    const built = await build({ rules: [{ effect: 'deny', tool: '*', source: 'project', scope: { subtree: CHAPTER_ONE }, access: 'write' }] });
    const report = await runMacro(built, TWO_WRITES, { doc: 'The Landing' });
    expect(report.status).toBe('failed');
    expect(built.asked).toHaveLength(0);
    expect(labelOf(built.state, LANDING)).toBe('act-1');
  });

  it('refuses a step a deny rule on the tool covers, before the writer is asked', async () => {
    const built = await build({ rules: [{ effect: 'deny', tool: 'notes.append', source: 'project' }] });
    const report = await runMacro(built, TWO_WRITES, { doc: 'The Friend' });
    expect(report.status).toBe('failed');
    expect(built.asked).toHaveLength(0);
    expect(labelOf(built.state, FRIEND)).not.toBe('act-2');
  });

  it('shows a one-step confirm card for a step an ask rule covers, in every mode', async () => {
    for (const mode of ['ask', 'accept-edits', 'auto'] as PermissionMode[]) {
      const built = await build({ mode, rules: [{ effect: 'ask', tool: 'meta.set', source: 'project' }] });
      const report = await runMacro(built, ONE_WRITE, { doc: 'The Friend' });
      expect(built.asked.map((card) => card.kind), mode).toEqual(['confirm']);
      expect(report.status, mode).toBe('applied');
    }
  });

  it('keeps plan-only a mode that refuses every write: the macro’s steps are held to be run later', async () => {
    const built = await build({ mode: 'plan-only' });
    const report = await runMacro(built, TWO_WRITES, { doc: 'The Friend' });
    expect(built.asked).toHaveLength(0);
    expect(report.undoGroupId).toBeUndefined();
    expect(report.heldSteps?.map((step) => step.tool)).toEqual(['meta.set', 'notes.append']);
    expect(labelOf(built.state, FRIEND)).not.toBe('act-2');
  });

  it('runs a macro of reads in plan-only, which refuses only writes', async () => {
    const built = await build({ mode: 'plan-only' });
    const report = await runMacro(built, READS, { doc: 'The Landing' });
    expect(report.status).toBe('replied');
  });

  it('does not let a mode approve a card the mode would not have approved', async () => {
    const built = await build({ mode: 'accept-edits' });
    const report = await runMacro(built, FILTER, { doc: 'The Friend' });
    expect(built.asked).toHaveLength(1);
    expect(kinds(report)).toEqual([['plan', 'approved']]);
  });

  it('lets accept-edits approve the card of the field edits it approves for a plan, as it does for any plan', async () => {
    const built = await build({ mode: 'accept-edits' });
    const report = await runMacro(built, TWO_WRITES, { doc: 'The Friend' });
    expect(built.asked).toHaveLength(0);
    expect(report.status).toBe('applied');
    expect(labelOf(built.state, FRIEND)).toBe('act-2');
  });
});

describe('a macro’s turn is named by the macro in the trace', () => {
  it('records the macro’s intent at the turn’s start and its command on the report the trace ends with', async () => {
    const trace = createTraceStore({ sessionId: 'macro' });
    const built = await build({ trace });
    const report = await runMacro(built, TWO_WRITES, { doc: 'The Friend' });
    const records = trace.records(report.turnId);
    expect(records[0]).toMatchObject({ kind: 'turn.start', intent: 'Run the macro “Tidy up”' });
    expect((records.at(-1) as { report: TurnReport }).report.command).toBe('macro-two-writes');
  });
});

describe('a macro’s turn is named by the macro in the report and the run log', () => {
  it('carries the macro’s name as the intent and its slug as the command, in the report and the log', async () => {
    const log = createMemoryRunLog();
    const built = await build({ runLog: { port: log as RunLogPort, projectId: 'p_MACRO' } });
    const report = await runMacro(built, TWO_WRITES, { doc: 'The Friend' });
    expect(report.command).toBe('macro-two-writes');
    const events = (JSON.parse(log.dump()) as RunEvent[][]).flat();
    const start = events.find((event) => event.t === 'turn.start');
    expect(start).toMatchObject({ t: 'turn.start', command: 'macro-two-writes', intent: 'Run the macro “Tidy up”', wire: 'plan' });
  });

  it('records the expanded steps in the log, so a run that was cut short can resume them', async () => {
    const log = createMemoryRunLog();
    const built = await build({ runLog: { port: log as RunLogPort, projectId: 'p_MACRO' } });
    await runMacro(built, TWO_WRITES, { doc: 'The Friend' });
    const events = (JSON.parse(log.dump()) as RunEvent[][]).flat();
    const intents = events.filter((event) => event.t === 'step.intent');
    expect(intents.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(intents)).toContain('notes.append');
  });
});
