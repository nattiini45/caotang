/**
 * Rules in the agent loop (agent-harness §4, "Rules"): a deny and an ask hold in every permission mode, a refusal is a failed
 * status card before any draft is made, and a read-deny keeps the withheld nodes out of what the planner is sent. The real session
 * on the real bus with the mock gateway.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest } from '@caotang/gateway';
import { subagentScript } from '@caotang/gateway/mock';
import type { MockScript } from '@caotang/gateway/mock';
import type { ProjectState } from '@caotang/store';

import {
  createAgentPorts,
  createAgentSession,
  createHarness,
  type AgentEvent,
  type Decision,
  type PendingCard,
  type PermissionMode,
  type RuleSet,
  type SourcedRule,
  type TurnReport,
} from '../../src/index.js';
import { CHAPTER_ONE, FRIEND, LANDING, STORM, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, prose, steps, transcript } from './scripts.js';

const rule = (effect: 'deny' | 'ask', fields: Partial<SourcedRule> = {}): SourcedRule => ({ effect, tool: '*', source: 'project', ...fields });

interface Run {
  readonly report: TurnReport;
  readonly events: readonly AgentEvent[];
  readonly asked: readonly PendingCard[];
  readonly state: ProjectState;
  readonly drafts: () => number;
  readonly planner: readonly ChatRequest[];
}

async function turn(
  intent: string,
  scripts: readonly MockScript[],
  rules: readonly SourcedRule[],
  setup: { readonly mode?: PermissionMode; readonly decisions?: readonly Decision[] } = {},
): Promise<Run> {
  const state = makeState();
  const set: RuleSet = { rules };
  const harness = createHarness({ state, ports: createAgentPorts(), rules: () => set });
  const base = await mockGateway(scripts);
  let drafting = 0;
  const planner: ChatRequest[] = [];
  const gateway = {
    ...base,
    complete: (request: Parameters<typeof base.complete>[0], signal?: AbortSignal) => {
      if (request.responseFormat === 'text') drafting += 1;
      else planner.push(request as ChatRequest);
      return base.complete(request, signal);
    },
  };
  const events: AgentEvent[] = [];
  const asked: PendingCard[] = [];
  const queue = [...(setup.decisions ?? [])];
  const session = createAgentSession({
    harness,
    gateway,
    decide: async (card) => {
      asked.push(card);
      return queue.shift() ?? { action: 'approve' };
    },
    emit: (event) => events.push(event),
    sessionId: 'rules',
    ...(setup.mode === undefined ? {} : { mode: setup.mode }),
  });
  const report = await session.submit(intent);
  return { report, events, asked, state, drafts: () => drafting, planner };
}

const failedCards = (run: Run) => run.events.flatMap((event) => (event.type === 'card' && event.card.status === 'failed' ? [event.card] : []));
const record = (report: TurnReport) => report.cards.map((card) => [card.kind, card.tools, card.decision]);

describe('a deny', () => {
  const intent = 'Continue The Landing.';
  const draft = steps({ tool: 'scene.draft', params: { doc: 'The Landing', instruction: 'Go on.', mode: 'continue' }, expect: 'continued' });
  const locked = [rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'write', note: 'Locked for my editor' })];

  for (const mode of ['ask', 'accept-edits', 'auto'] as const) {
    it(`refuses the step as a failed status card in ${mode} mode, before any draft is made, and writes nothing`, async () => {
      const run = await turn(intent, [transcript(intent, [draft, answer('I could not change The Landing; it is locked.')]), prose('Brief: Go on.', 'Never drafted.')], locked, { mode });
      expect(run.drafts()).toBe(0);
      expect(run.asked).toHaveLength(0);
      const failed = failedCards(run);
      expect(failed.map((card) => card.tool)).toEqual(['scene.draft']);
      expect(failed[0]?.error).toContain('Locked for my editor');
      expect(failed[0]?.error).toContain('this project’s file');
      expect(run.report.trace.find((row) => row.tool === 'scene.draft')).toMatchObject({ outcome: 'refused', code: 'permission-denied' });
      expect(run.state.documents.get(LANDING)?.body).toBe('The ferry was late, as always.');
      expect(run.report.status).toBe('replied');
    });
  }

  it('refuses a write-auto step the same way, and leaves the other documents to be changed', async () => {
    const run = await turn(
      'Note on The Landing.',
      [transcript('Note on The Landing.', [steps({ tool: 'notes.append', params: { doc: 'The Landing', text: 'x' }, expect: 'noted' }), answer('Locked.')])],
      locked,
      { mode: 'auto' },
    );
    expect(failedCards(run).map((card) => card.tool)).toEqual(['notes.append']);
    const free = await turn(
      'Note on The Friend.',
      [transcript('Note on The Friend.', [steps({ tool: 'notes.append', params: { doc: 'The Friend', text: 'x' }, expect: 'noted' })])],
      locked,
      { mode: 'auto' },
    );
    expect(free.report.status).toBe('applied');
  });
});

describe('an ask', () => {
  const asking = [rule('ask', { tool: 'meta.set', note: 'Check statuses with me' })];
  const intent = 'Mark The Friend final.';
  const mark = steps({ tool: 'meta.set', params: { targets: ['The Friend'], status: 'final' }, expect: 'marked' });

  it('is a write-auto step that runs with no card when no rule asks, as it always did', async () => {
    const run = await turn(intent, [transcript(intent, [mark])], [], { mode: 'auto' });
    expect(run.asked).toHaveLength(0);
    expect(record(run.report)).toEqual([['auto', ['meta.set'], 'auto']]);
  });

  for (const mode of ['ask', 'accept-edits', 'auto'] as const) {
    it(`gives it a one-step confirm card in ${mode} mode, which the mode does not approve`, async () => {
      const run = await turn(intent, [transcript(intent, [mark])], asking, { mode });
      expect(run.asked).toHaveLength(1);
      expect(run.asked[0]?.card.kind).toBe('confirm');
      expect(record(run.report)).toEqual([['confirm', ['meta.set'], 'approved']]);
      expect(run.state.manifest.tree.find((node) => node.id === FRIEND)?.status).toBe('final');
    });
  }

  it('writes nothing when the writer cancels the card', async () => {
    const run = await turn(intent, [transcript(intent, [mark])], asking, { mode: 'auto', decisions: [{ action: 'cancel' }] });
    expect(run.report.status).toBe('cancelled');
    expect(run.state.manifest.tree.find((node) => node.id === FRIEND)?.status).not.toBe('final');
  });

  it('stops a write-confirm step from being approved by auto mode', async () => {
    const draftIntent = 'Draft The Friend.';
    const run = await turn(
      draftIntent,
      [transcript(draftIntent, [steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'drafted' })]), prose('Brief: Open.', 'The ferry came in.')],
      [rule('ask', { tool: 'scene.draft' })],
      { mode: 'auto' },
    );
    expect(run.asked).toHaveLength(1);
    expect(record(run.report)).toEqual([['confirm', ['scene.draft'], 'approved']]);
  });

  describe('on agent.delegate', () => {
    const intent = 'Who knows about the lamp?';
    const delegate = steps({
      tool: 'agent.delegate',
      params: { agent: 'reader', brief: 'Note who knows the lamp failed.', scope: ['The Storm'] },
      expect: 'notes on who knows the lamp failed',
    });
    const reader = subagentScript((req) => (req.messages.some((message) => message.role === 'assistant') ? answer('Only the keeper knows.') : steps({ tool: 'doc.read', params: { doc: 'The Storm' }, expect: 'read' })));
    const scripts = [transcript(intent, [delegate, answer('Only the keeper knows.')]), reader];

    for (const [name, tool] of [['the tool', 'agent.delegate'], ['every tool', '*']] as const) {
      it(`starts the agent once the writer approves a card from an ask rule on ${name}`, async () => {
        const run = await turn(intent, scripts, [rule('ask', { tool })], { mode: 'auto' });
        expect(run.asked).toHaveLength(1);
        expect(run.asked[0]?.card.kind).toBe('confirm');
        expect(run.report.trace.map((row) => [row.tool, row.outcome])).toContainEqual(['agent.delegate', 'ok']);
        expect(run.report.trace.some((row) => row.agentPath !== undefined && row.tool === 'doc.read')).toBe(true);
        expect(failedCards(run)).toEqual([]);
        expect(run.state.documents.get(LANDING)?.revision).toBe(0);
      });
    }

    it('starts no agent when the writer cancels the card', async () => {
      const run = await turn(intent, scripts, [rule('ask', { tool: 'agent.delegate' })], { mode: 'auto', decisions: [{ action: 'cancel' }] });
      expect(run.report.status).toBe('cancelled');
      expect(run.report.trace).toEqual([]);
    });
  });

  it('gives a read the writer’s card first, and runs it once approved', async () => {
    const readIntent = 'Read The Storm.';
    const reader = steps({ tool: 'doc.read', params: { doc: 'The Storm' }, expect: 'read' });
    const run = await turn(readIntent, [transcript(readIntent, [reader, answer('Rain.')])], [rule('ask', { tool: 'doc.read' })], { mode: 'auto' });
    expect(run.asked).toHaveLength(1);
    expect(run.report.trace.map((row) => [row.tool, row.outcome])).toEqual([['doc.read', 'ok']]);
    const declined = await turn(readIntent, [transcript(readIntent, [reader, answer('Rain.')])], [rule('ask', { tool: 'doc.read' })], { mode: 'auto', decisions: [{ action: 'cancel' }] });
    expect(declined.report.status).toBe('cancelled');
    expect(declined.report.trace).toEqual([]);
  });
});

describe('a read-deny', () => {
  it('keeps the withheld nodes out of the planner’s request, and says in the report what it left out', async () => {
    const intent = 'What is in the manuscript?';
    const open = await turn(intent, [transcript(intent, [answer('Everything.')])], []);
    expect(open.planner.map((request) => JSON.stringify(request.messages)).join('\n')).toContain('Chapter 1');
    const run = await turn(intent, [transcript(intent, [answer('Chapter 2 only.')])], [rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'read' })]);
    const sent = run.planner.map((request) => JSON.stringify(request.messages)).join('\n');
    expect(sent).toContain('Chapter 2');
    expect(sent).not.toContain('Chapter 1');
    expect(sent).not.toContain('The Landing');
    expect(sent).not.toContain('The Storm');
    expect(run.report.dropped.join('\n')).toContain('Chapter 1 (folder)');
  });

  it('refuses a read of a withheld document as a failed card without naming it', async () => {
    const intent = 'Read The Storm.';
    const run = await turn(
      intent,
      [transcript(intent, [steps({ tool: 'doc.read', params: { doc: STORM }, expect: 'read' }), answer('I cannot read it.')])],
      [rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'read' })],
    );
    const failed = failedCards(run);
    expect(failed.map((card) => card.tool)).toEqual(['doc.read']);
    expect(failed[0]?.error).not.toContain('The Storm');
  });
});
