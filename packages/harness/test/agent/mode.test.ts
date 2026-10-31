/**
 * Permission modes (agent-harness §4). A mode answers a card; it never reaches the bus gate. These tests drive the real session on
 * the real bus with the mock gateway: what each mode refuses or approves, what stays the writer's in every mode, and where the
 * budgets stop a turn.
 */

import { describe, expect, it } from 'vitest';

import { checkPermission } from '@caotang/bus';
import { createMcpClient, createMockWireFactory, qualifiedNameOf, type McpClient, type McpServerConfig } from '@caotang/mcp-client';
import { addDocument, setBody, type ProjectState } from '@caotang/store';
import type { MockScript } from '@caotang/gateway/mock';
import type { Finding } from '@caotang/coherence';

import {
  ACCEPT_EDITS_TOOLS,
  DEFAULT_TURN_BUDGET,
  ModeError,
  PERMISSION_MODES,
  budgetHit,
  createAgentPorts,
  createAgentSession,
  createContextPort,
  createHarness,
  modePolicy,
  type AgentEvent,
  type AgentSessionOptions,
  type Decision,
  type PendingCard,
  type PermissionMode,
  type PlanStep,
  type TurnReport,
} from '../../src/index.js';
import { CHAPTER_TWO, FRIEND, LANDING, LANDING_BODY, OPENED, STORM, makeHarness, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, prose, steps, transcript } from './scripts.js';

type SessionExtras = Pick<AgentSessionOptions, 'mode' | 'lockAuto' | 'taint' | 'noHuman' | 'budget' | 'sessionBudget' | 'price' | 'beforeAutoApply' | 'maxModelCalls'>;

interface Run {
  readonly report: TurnReport;
  readonly events: readonly AgentEvent[];
  /** The cards the session asked the writer about. */
  readonly asked: readonly PendingCard[];
  readonly state: ProjectState;
  readonly drafts: () => number;
}

interface Setup extends SessionExtras {
  readonly state?: () => ProjectState;
  readonly decisions?: readonly Decision[];
}

/** One turn on a fresh project in a mode. A card the policy leaves to the writer takes the next decision, and is approved when none is left. */
async function turn(intent: string, scripts: readonly MockScript[], setup: Setup = {}): Promise<Run> {
  const state = (setup.state ?? makeState)();
  const harness = createHarness({ state, ports: createAgentPorts() });
  const base = await mockGateway(scripts);
  let drafting = 0;
  const gateway = { ...base, complete: (request: Parameters<typeof base.complete>[0], signal?: AbortSignal) => {
    if (request.responseFormat === 'text') drafting += 1;
    return base.complete(request, signal);
  } };
  const events: AgentEvent[] = [];
  const asked: PendingCard[] = [];
  const queue = [...(setup.decisions ?? [])];
  const { state: _state, decisions: _decisions, ...extras } = setup;
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state }),
    decide: async (card) => {
      asked.push(card);
      return queue.shift() ?? { action: 'approve' };
    },
    emit: (event) => events.push(event),
    sessionId: 'mode',
    ...extras,
  });
  const report = await session.submit(intent);
  return { report, events, asked, state, drafts: () => drafting };
}

const withScenes = (count: number): (() => ProjectState) => () => {
  const state = makeState();
  for (let index = 1; index <= count; index += 1) addDocument(state, { parentId: CHAPTER_TWO, title: `Scene ${index}`, body: 'A short scene.', now: OPENED });
  return state;
};

const record = (report: TurnReport) => report.cards.map((card) => [card.kind, card.tools, card.decision]);

describe('modePolicy', () => {
  it('names four modes and defaults to asking', () => {
    expect(PERMISSION_MODES).toEqual(['plan-only', 'ask', 'accept-edits', 'auto']);
    expect(modePolicy('ask').approves({ tools: ['scene.draft'], external: false })).toBe(false);
  });

  it('accept-edits approves only the native edit tools, and auto any native card', () => {
    const edits = modePolicy('accept-edits');
    expect(edits.approves({ tools: ['scene.draft', 'synopsis.fill'], external: false })).toBe(true);
    expect(edits.approves({ tools: ['scene.draft', 'binder.restructure'], external: false })).toBe(false);
    expect(ACCEPT_EDITS_TOOLS.has('export.compile')).toBe(false);
    const auto = modePolicy('auto');
    expect(auto.approves({ tools: ['binder.restructure', 'export.compile'], external: false })).toBe(true);
  });

  it('never approves a card with an external step, in any mode', () => {
    for (const mode of PERMISSION_MODES) expect(modePolicy(mode).approves({ tools: ['mcp__x__write'], external: true })).toBe(false);
  });

  it('refuses to construct auto while it is locked, and falls back to asking while the project is tainted', () => {
    expect(() => modePolicy('auto', { lockAuto: true })).toThrow(ModeError);
    expect(modePolicy('accept-edits', { lockAuto: true }).mode).toBe('accept-edits');
    let tainted = true;
    const policy = modePolicy('auto', { taint: () => tainted });
    expect(policy.decides).toBe(false);
    expect(policy.approves({ tools: ['scene.draft'], external: false })).toBe(false);
    tainted = false;
    expect(policy.approves({ tools: ['scene.draft'], external: false })).toBe(true);
  });

  it('holds a use at a limit exactly: a card may end on it, a model call may not start from it', () => {
    const use = { modelCalls: 0, tokens: 10, wordsChanged: 0, documents: 0, steps: 0 };
    expect(budgetHit(use, { maxTokens: 10 }, true)?.dimension).toBe('tokens');
    expect(budgetHit(use, { maxTokens: 10 }, false)).toBeUndefined();
    expect(budgetHit(use, { maxTokens: 9 }, false)?.dimension).toBe('tokens');
  });
});

describe('ask is the default, and nothing about it changed', () => {
  const intent = 'Draft the opening of The Friend.';
  const scripts = (): MockScript[] => [
    transcript(intent, [steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'drafted' })]),
    prose('Brief: Open.', 'The ferry came in.'),
  ];

  it('an explicit ask turn reads the same as one with no mode: the same cards, trace and steps', async () => {
    const plain = await turn(intent, scripts());
    const asking = await turn(intent, scripts(), { mode: 'ask' });
    expect(asking.report.cards).toEqual(plain.report.cards);
    expect(asking.report.trace).toEqual(plain.report.trace);
    expect(asking.report.steps).toEqual(plain.report.steps);
    expect(record(plain.report)).toEqual([['confirm', ['scene.draft'], 'approved']]);
    expect(plain.report.mode).toBe('ask');
    expect(plain.asked).toHaveLength(1);
  });

  it('takes a mode from a function at each card, so a switch applies from the next card', async () => {
    let mode: PermissionMode = 'ask';
    const run = await turn(intent, scripts(), { mode: () => mode });
    expect(run.asked).toHaveLength(1);
    mode = 'accept-edits';
    const next = await turn(intent, scripts(), { mode: () => mode });
    expect(next.asked).toHaveLength(0);
    expect(next.report.mode).toBe('accept-edits');
  });
});

describe('a switch in the middle of a turn', () => {
  it('applies from the next card: the card shown again after a retry is approved by the mode the writer switched to', async () => {
    const intent = 'Draft the opening of The Friend.';
    let mode: PermissionMode = 'ask';
    const scripts = [
      transcript(intent, [steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'drafted' })]),
      prose('Brief: Open.', 'The ferry came in.'),
    ];
    // The first card is the writer's: they retry the draft, switching to Accept edits as they do.
    const state = makeState();
    const harness = createHarness({ state, ports: createAgentPorts() });
    const gateway = await mockGateway(scripts);
    const asked: PendingCard[] = [];
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async (card) => {
        asked.push(card);
        mode = 'accept-edits';
        return { action: 'retry' };
      },
      mode: () => mode,
      sessionId: 'switch',
    });
    const report = await session.submit(intent);
    expect(asked).toHaveLength(1);
    expect(report.status).toBe('applied');
    expect(record(report)).toEqual([['auto', ['scene.draft'], 'auto']]);
    expect(report.mode).toBe('accept-edits');
    expect(state.documents.get(FRIEND)?.body).toContain('The ferry came in.');
  });
});

describe('plan-only', () => {
  const intent = 'Tidy the notes, label The Friend, and draft it.';
  const writes: PlanStep[] = [
    { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'labelled' },
    { tool: 'notes.append', params: { doc: 'The Landing', text: 'A note.' }, expect: 'noted' },
    { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'drafted' },
  ];

  it('refuses every write before any draft is asked for, each as a failed status card that names the mode, and holds the steps', async () => {
    const before = JSON.stringify(makeState().manifest.tree);
    const run = await turn(intent, [transcript(intent, [steps(...writes), answer('Plan: label, note, then draft the opening.')]), prose('Brief: Open.', 'Never drafted.')], { mode: 'plan-only' });
    expect(run.report.status).toBe('replied');
    expect(run.report.mode).toBe('plan-only');
    expect(run.drafts()).toBe(0);
    expect(run.asked).toHaveLength(0);
    const failed = run.events.flatMap((event) => (event.type === 'card' && event.card.status === 'failed' ? [event.card] : []));
    expect(failed.map((card) => card.tool)).toEqual(['meta.set', 'notes.append', 'scene.draft']);
    for (const card of failed) expect(card.error).toContain('Plan-only mode');
    expect(run.report.heldSteps?.map((step) => step.tool)).toEqual(['meta.set', 'notes.append', 'scene.draft']);
    expect(JSON.stringify(run.state.manifest.tree)).toBe(before);
    expect(run.report.undoGroupId).toBeUndefined();
  });

  it('still runs reads', async () => {
    const run = await turn('What is in The Storm?', [transcript('What is in The Storm?', [steps({ tool: 'doc.read', params: { doc: 'The Storm' }, expect: 'read' }), answer('Rain.')])], {
      mode: 'plan-only',
    });
    expect(run.report.trace.map((row) => [row.tool, row.outcome])).toEqual([['doc.read', 'ok']]);
    expect(run.report.heldSteps).toBeUndefined();
  });

  it('runs the held steps through submitPlan once the writer is in ask', async () => {
    const state = makeState();
    const harness = createHarness({ state, ports: createAgentPorts() });
    const gateway = await mockGateway([transcript(intent, [steps(writes[0] as PlanStep), answer('Plan: label it.')])]);
    let mode: PermissionMode = 'plan-only';
    const asked: PendingCard[] = [];
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async (card) => {
        asked.push(card);
        return { action: 'approve' };
      },
      mode: () => mode,
      sessionId: 'mode',
    });
    const planned = await session.submit(intent);
    expect(state.manifest.tree.find((node) => node.id === FRIEND)?.label).not.toBe('act-2');
    mode = 'ask';
    const ran = await session.submitPlan(intent, { steps: planned.heldSteps ?? [] });
    expect(ran.status).toBe('applied');
    expect(state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBe('act-2');
  });
});

describe('accept-edits', () => {
  it('applies a synopsis.fill over five documents and a scene.draft with no decision, as one undo group and one checkpoint, after the draft reached the ghost', async () => {
    const intent = 'Fill the synopses and draft the opening.';
    const docs = ['Scene 1', 'Scene 2', 'Scene 3', 'Scene 4', 'Scene 5'];
    const run = await turn(
      intent,
      [
        transcript(intent, [
          steps(
            { tool: 'synopsis.fill', params: { docs, source: 'text', max_words: 20 }, expect: 'synopses' },
            { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'drafted' },
          ),
        ]),
        prose('Brief: Open.', 'The ferry came in.'),
        prose('Document "Scene', 'A quiet scene.'),
      ],
      { mode: 'accept-edits', state: withScenes(5) },
    );
    expect(run.report.status).toBe('applied');
    expect(run.asked).toHaveLength(0);
    expect(record(run.report)).toEqual([['auto', ['synopsis.fill', 'scene.draft'], 'auto']]);
    expect(run.events.filter((event) => event.type === 'checkpoint')).toHaveLength(1);
    expect(run.report.undoGroupId).toBeDefined();
    const kinds = run.events.map((event) => event.type);
    expect(kinds.indexOf('ghost')).toBeGreaterThan(-1);
    expect(kinds.indexOf('ghost')).toBeLessThan(kinds.indexOf('checkpoint'));
    const plan = run.events.find((event) => event.type === 'plan');
    expect(plan?.type === 'plan' && plan.auto).toBe(true);
    expect(run.state.documents.get(FRIEND)?.body).toContain('The ferry came in.');
    expect(run.state.manifest.tree.find((node) => node.title === 'Scene 3')?.synopsis).toBe('A quiet scene.');
  });

  it('leaves a restructure to the writer', async () => {
    const intent = 'Add a chapter.';
    const reply = steps({ tool: 'binder.restructure', params: { ops: [{ action: 'create', parent: 'manuscript', type: 'folder', title: 'Chapter 3' }] }, expect: 'a chapter' });
    const run = await turn(intent, [transcript(intent, [reply])], { mode: 'accept-edits' });
    expect(run.asked).toHaveLength(1);
    expect(record(run.report)).toEqual([['confirm', ['binder.restructure'], 'approved']]);
  });

  it('falls back to asking while the project is tainted', async () => {
    const intent = 'Fill the synopsis of The Storm.';
    const scripts = [transcript(intent, [steps({ tool: 'synopsis.fill', params: { docs: ['The Storm'], source: 'text', max_words: 20 }, expect: 'a synopsis' })]), prose('Document "The Storm"', 'A storm.')];
    const run = await turn(intent, scripts, { mode: 'accept-edits', taint: () => true });
    expect(run.asked).toHaveLength(1);
  });

  it('puts a draft the document has moved on from back to the writer, and never applies it again by itself', async () => {
    const intent = 'Continue The Landing.';
    const scripts = [
      transcript(intent, [steps({ tool: 'scene.draft', params: { doc: 'The Landing', instruction: 'Go on.', mode: 'continue' }, expect: 'continued' })]),
      prose('Brief: Go on.', 'And then the storm.'),
    ];
    const state = makeState();
    const run = await turn(intent, scripts, {
      mode: 'accept-edits',
      state: () => state,
      // The writer types in the document after the draft was staged and before the card is applied.
      beforeAutoApply: async () => {
        setBody(state, LANDING, `${LANDING_BODY} Typed.`);
      },
      decisions: [{ action: 'cancel' }],
    });
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0]?.card.approvable).toBe(false);
    expect(run.asked[0]?.card.steps[0]?.stale).toBe(true);
    expect(run.state.documents.get(LANDING)?.body).toBe(`${LANDING_BODY} Typed.`);
    expect(run.report.status).toBe('cancelled');
  });
});

describe('auto', () => {
  it('approves a restructure as shown, and records the card as the policy’s', async () => {
    const intent = 'Add a chapter.';
    const reply = steps({ tool: 'binder.restructure', params: { ops: [{ action: 'create', parent: 'manuscript', type: 'folder', title: 'Chapter 3' }] }, expect: 'a chapter' });
    const run = await turn(intent, [transcript(intent, [reply])], { mode: 'auto' });
    expect(run.asked).toHaveLength(0);
    expect(record(run.report)).toEqual([['auto', ['binder.restructure'], 'auto']]);
    expect(run.state.manifest.tree.some((node) => node.title === 'Chapter 3')).toBe(true);
  });

  it('is asked for like ask while auto is locked', async () => {
    const intent = 'Add a chapter.';
    const reply = steps({ tool: 'binder.restructure', params: { ops: [{ action: 'create', parent: 'manuscript', type: 'folder', title: 'Chapter 3' }] }, expect: 'a chapter' });
    const run = await turn(intent, [transcript(intent, [reply])], { mode: 'auto', lockAuto: true });
    expect(run.asked).toHaveLength(1);
    expect(run.report.mode).toBe('ask');
  });

  it('cancels a card it does not approve when there is nobody to ask', async () => {
    const intent = 'Add a chapter.';
    const reply = steps({ tool: 'binder.restructure', params: { ops: [{ action: 'create', parent: 'manuscript', type: 'folder', title: 'Chapter 3' }] }, expect: 'a chapter' });
    const run = await turn(intent, [transcript(intent, [reply])], { mode: 'ask', noHuman: true });
    expect(run.asked).toHaveLength(0);
    expect(run.report.status).toBe('cancelled');
    expect(run.state.manifest.tree.some((node) => node.title === 'Chapter 3')).toBe(false);
  });
});

describe('what no mode takes from the writer or the bus', () => {
  const KEY = 's_STORYB0002';
  const WRITE = qualifiedNameOf(KEY, 'write_note');
  const server: McpServerConfig = {
    key: KEY,
    name: 'Story Bible',
    transport: 'http',
    url: 'https://s-storyb0002.fixture.test/mcp',
    auth: { kind: 'none' },
    enabled: true,
    trustReads: false,
    pinnedTools: {},
    addedAt: '2026-10-08T09:00:00.000Z',
  };

  async function connected(calls: string[]): Promise<McpClient> {
    const client = createMcpClient({
      settings: { enabled: true, servers: [server] },
      wire: createMockWireFactory({
        [KEY]: {
          listTools: [
            {
              name: 'write_note',
              description: 'Write a note into the story bible.',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
            },
          ],
          respond: (tool) => {
            calls.push(tool);
            return { content: [{ type: 'text', text: 'ok' }], isError: false };
          },
        },
      }),
      probe: async () => false,
      now: () => '2026-10-08T09:00:00.000Z',
      listTimeoutMs: 2_000,
      callTimeoutMs: 2_000,
    });
    await client.connect(KEY);
    const card = client.review(KEY);
    if (card !== undefined) client.approveReview(KEY, card.fingerprint);
    return client;
  }

  // Name the external tool: a broad "write" query exercises the native-first search cap, not the permission gate under test.
  const FIND = steps({ tool: 'tool.search', params: { query: 'write_note' }, expect: 'the write tool is loaded' });

  it('an external write asks the writer in accept-edits and auto, and is refused outright in plan-only', async () => {
    const intent = 'Note the lore.';
    for (const mode of PERMISSION_MODES) {
      const calls: string[] = [];
      const harness = makeHarness({ mcp: { client: await connected(calls) } }, makeState());
      const gateway = await mockGateway([transcript(intent, [FIND, steps({ tool: WRITE, params: { text: 'A note.' }, expect: 'written' }), answer('Done.')])]);
      const asked: PendingCard[] = [];
      const session = createAgentSession({
        harness,
        gateway,
        decide: async (card) => {
          asked.push(card);
          return { action: 'approve' };
        },
        mode,
        sessionId: 'sweep',
      });
      const report = await session.submit(intent);
      if (mode === 'plan-only') {
        expect(calls, mode).toEqual([]);
        expect(report.heldSteps?.map((step) => step.tool), mode).toEqual([WRITE]);
      } else {
        expect(asked.map((card) => card.kind), mode).toEqual(['confirm']);
        expect(calls, mode).toEqual(['write_note']);
      }
    }
  });

  it('a dismissal stays hard-denied, and project.deleteNode stays denied to every flow, in every mode', async () => {
    const finding = 'f_AAAAAAAAAA';
    const quote = 'The lamp failed.';
    for (const mode of PERMISSION_MODES) {
      const state = makeState();
      const from = (state.documents.get(STORM)?.body ?? '').indexOf(quote);
      const seeded: Finding = {
        id: finding,
        runId: 'r_RUN0000000',
        class: 'llm',
        checkId: 'llm:factual',
        type: 'factual',
        severity: 'error',
        status: 'open',
        factGroup: 'the lamp|state',
        evidence: [{ docId: STORM, quote, from, to: from + quote.length }],
        createdAt: '2026-10-08T09:00:00.000Z',
        updatedAt: '2026-10-08T09:00:00.000Z',
        message: 'The lamp is said to fail twice.',
      };
      const file = (state.coherence ?? (state.coherence = { formatVersion: 1, findings: [], runs: [], sceneMeta: {}, worldRules: [], knowledge: [], reviewState: {} })) as unknown as { findings: Finding[] };
      file.findings.push(seeded);
      const intent = 'Dismiss the lamp finding.';
      const harness = createHarness({ state, ports: createAgentPorts() });
      const gateway = await mockGateway([
        transcript(intent, [steps({ tool: 'coherence.setFindingStatus', params: { findingId: finding, status: 'dismissed', note: 'Fine.' }, expect: 'dismissed' }), answer('It stays open.')]),
      ]);
      const session = createAgentSession({ harness, gateway, decide: async () => ({ action: 'approve' }), mode, sessionId: 'deny' });
      const report = await session.submit(intent, { preload: ['coherence.setFindingStatus'] });
      expect(report.trace.filter((row) => row.outcome === 'ok' && row.tool === 'coherence.setFindingStatus'), mode).toEqual([]);
      expect(file.findings[0]?.status, mode).toBe('open');
      // The bus gate takes no mode: whatever approval rides on the flow, the deletion is refused.
      const denied = checkPermission({ agentRisk: 'never' }, { name: 'project.deleteNode', params: { nodeId: STORM }, issuedBy: 'agent' }, { approvedPlan: true, confirmed: true });
      expect(denied.ok, mode).toBe(false);
    }
  });
});

describe('budgets, while a mode decides the cards', () => {
  const read = (doc: string) => steps({ tool: 'doc.read', params: { doc }, expect: `read ${doc}` });
  const label = (value: string) => ({ tool: 'meta.set', params: { targets: [FRIEND], label: value }, expect: `labelled ${value}` });
  const askBack = (run: Run): string => run.report.askBack?.reason ?? '';

  it('pauses on the model-call bound exactly, with the words the bound has always used', async () => {
    const intent = 'Read three documents.';
    const scripts = [transcript(intent, [read('The Storm'), read('The Landing'), read('The Friend'), answer('Done.')])];
    const run = await turn(intent, scripts, { mode: 'auto', maxModelCalls: 2 });
    expect(run.report.status).toBe('failed');
    expect(run.report.modelCalls).toBe(2);
    expect(askBack(run)).toBe('the turn made 2 model calls without finishing, so it stopped');
  });

  it('pauses before the call that would start from the token limit, and not before', async () => {
    const intent = 'Read two documents.';
    const scripts = (): MockScript[] => [transcript(intent, [read('The Storm'), read('The Landing'), answer('Done.')])];
    const first = await turn(intent, scripts(), { mode: 'auto', budget: { maxTokens: 1 } });
    const spent = first.report.tokens.promptTokens + first.report.tokens.completionTokens;
    expect(first.report.modelCalls).toBe(1);
    expect(askBack(first)).toContain('token budget');
    const atLimit = await turn(intent, scripts(), { mode: 'auto', budget: { maxTokens: spent } });
    expect(atLimit.report.modelCalls).toBe(1);
    expect(atLimit.report.status).toBe('failed');
    const over = await turn(intent, scripts(), { mode: 'auto', budget: { maxTokens: spent + 1 } });
    expect(over.report.modelCalls).toBeGreaterThan(1);
  });

  it('pauses at the cost limit the same way, at the price the session reads', async () => {
    const intent = 'Read two documents.';
    const scripts = (): MockScript[] => [transcript(intent, [read('The Storm'), read('The Landing'), answer('Done.')])];
    // A price of 1,000 per 1,000 tokens makes a turn's dollars its tokens.
    const price = () => ({ prompt: 1000, completion: 1000 });
    const first = await turn(intent, scripts(), { mode: 'auto', price, budget: { maxCostUsd: 0.5 } });
    const spent = first.report.tokens.promptTokens + first.report.tokens.completionTokens;
    expect(first.report.modelCalls).toBe(1);
    const atLimit = await turn(intent, scripts(), { mode: 'auto', price, budget: { maxCostUsd: spent } });
    expect(atLimit.report.modelCalls).toBe(1);
    expect(askBack(atLimit)).toContain('cost budget');
    const over = await turn(intent, scripts(), { mode: 'auto', price, budget: { maxCostUsd: spent + 1 } });
    expect(over.report.modelCalls).toBeGreaterThan(1);
    const unpriced = await turn(intent, scripts(), { mode: 'auto', budget: { maxCostUsd: 0.5 } });
    expect(unpriced.report.modelCalls).toBeGreaterThan(1);
  });

  it('stops a card that would pass the step limit before anything is applied, and lets one end on it', async () => {
    const intent = 'Label it three times.';
    const reply = steps(label('act-1'), label('act-2'), label('act-1'));
    const scripts = (): MockScript[] => [transcript(intent, [reply])];
    const over = await turn(intent, scripts(), { mode: 'auto', budget: { maxSteps: 2 } });
    expect(over.report.status).toBe('failed');
    expect(askBack(over)).toContain('step budget (3 of 2)');
    expect(over.report.undoGroupId).toBeUndefined();
    expect((await turn(intent, scripts(), { mode: 'auto', budget: { maxSteps: 3 } })).report.status).toBe('applied');
  });

  it('stops a card that would touch more documents than the limit, and lets one touch exactly that many', async () => {
    const intent = 'Fill three synopses.';
    const reply = steps({ tool: 'synopsis.fill', params: { docs: ['Scene 1', 'Scene 2', 'Scene 3'], source: 'text', max_words: 20 }, expect: 'synopses' });
    const scripts = (): MockScript[] => [transcript(intent, [reply]), prose('Document "Scene', 'A scene.')];
    const over = await turn(intent, scripts(), { mode: 'auto', state: withScenes(3), budget: { maxDocuments: 2 } });
    expect(askBack(over)).toContain('documents-touched budget (3 of 2)');
    expect(over.state.manifest.tree.find((node) => node.title === 'Scene 1')?.synopsis).not.toBe('A scene.');
    const exact = await turn(intent, scripts(), { mode: 'auto', state: withScenes(3), budget: { maxDocuments: 3 } });
    expect(exact.report.status).toBe('applied');
    expect(exact.report.budgetUse.documents).toBe(3);
  });

  it('stops a draft that would change more words than the limit, and lets one change exactly that many', async () => {
    const intent = 'Draft the opening.';
    const reply = steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'drafted' });
    const scripts = (): MockScript[] => [transcript(intent, [reply]), prose('Brief: Open.', 'One two three four five.')];
    const over = await turn(intent, scripts(), { mode: 'auto', budget: { maxWordsChanged: 4 } });
    expect(askBack(over)).toContain('words-changed budget (5 of 4)');
    expect(over.state.documents.get(FRIEND)?.body ?? '').toBe('');
    const exact = await turn(intent, scripts(), { mode: 'auto', budget: { maxWordsChanged: 5 } });
    expect(exact.report.status).toBe('applied');
    expect(exact.report.budgetUse.wordsChanged).toBe(5);
  });

  it('holds the session to its own limits across turns', async () => {
    const state = makeState();
    const harness = createHarness({ state, ports: createAgentPorts() });
    const gateway = await mockGateway([
      transcript('First label.', [steps(label('act-1'))]),
      transcript('Second label.', [steps(label('act-2'))]),
    ]);
    const session = createAgentSession({ harness, gateway, decide: async () => ({ action: 'approve' }), mode: 'auto', sessionBudget: { maxSteps: 1 }, sessionId: 'session' });
    expect((await session.submit('First label.')).status).toBe('applied');
    const second = await session.submit('Second label.');
    expect(second.status).toBe('failed');
    expect(second.askBack?.reason).toContain('session reached its step budget (2 of 1)');
    expect(state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBe('act-1');
  });

  it('pauses on the third identical call, and not before', async () => {
    const intent = 'Keep reading.';
    const run = await turn(intent, [transcript(intent, [read('The Storm')])], { mode: 'auto' });
    expect(run.report.status).toBe('failed');
    expect(run.report.trace.filter((row) => row.tool === 'doc.read')).toHaveLength(2);
    expect(askBack(run)).toContain('doc.read with the same parameters 3 times');
    expect(DEFAULT_TURN_BUDGET.doomLoopRepeats).toBe(3);
  });

  it('is not enforced while the writer decides each card', async () => {
    const intent = 'Keep reading.';
    const run = await turn(intent, [transcript(intent, [read('The Storm'), read('The Storm'), read('The Storm'), read('The Storm'), answer('Done.')])], { mode: 'ask', budget: { maxSteps: 1 } });
    expect(run.report.status).toBe('replied');
  });
});
