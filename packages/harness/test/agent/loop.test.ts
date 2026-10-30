/**
 * The interaction loop's behaviour, beyond what a scenario states: the status-card lifecycle, streamed
 * deltas and the ghost handoff, the checkpoint row and its restore, per-turn token accounting, a failing
 * gateway, the bound on model calls (drafts included), a draft the provider cut or broke, the prompt a card
 * shows, the per-tool budgets, and a draft the user overtook. Each test drives the real session on the real bus.
 *
 * Every scenario here runs through `evaluate`, so the expectation it states is checked, not merely carried.
 */

import { describe, expect, it } from 'vitest';

import { ContextError } from '@caotang/context';
import { addDocument, setBody, type ProjectState } from '@caotang/store';
import type { ChatRequest, Gateway } from '@caotang/gateway';
import { DRAFT_PREFIX, PLANNER_PREFIX, fail, isDraftCall, isPlannerCall, userTextOf } from '@caotang/gateway/mock';
import type { MockScript } from '@caotang/gateway/mock';

import { createAgentSession, createContextPort, createAgentPorts, CHECKPOINT_LABEL, type AgentEvent, type ContextPort, type Decision, type StatusCard } from '../../src/index.js';
import { evaluate, type Scenario, type ScenarioRun } from '../../src/agent/eval.js';
import { CHAPTER_TWO, checkedHarness, FRIEND, LANDING, LANDING_BODY, makeState, OPENED, STORM } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, prose, steps, transcript } from './scripts.js';

const scenario = (name: string, intent: string, scripts: readonly MockScript[], extra: Partial<Scenario> = {}): Scenario => ({
  name,
  category: 'single-op',
  intent,
  project: makeState,
  gateway: () => mockGateway(scripts),
  expect: { status: 'applied' },
  ...extra,
});

/** Runs a scenario and fails the test with every expectation it did not meet. The run is returned for further assertions. */
async function checked(subject: Scenario): Promise<ScenarioRun> {
  const result = await evaluate(subject);
  expect(result.failures).toEqual([]);
  return result.run;
}

/** The status-card states a call moved through, in order, as the event stream reported them. */
function lifecycleOf(events: readonly AgentEvent[], callId: string): string[] {
  return events.flatMap((event) => (event.type === 'card' && event.card.id === callId ? [event.card.status] : []));
}

/** A project with `count` more documents in Chapter 2, titled "Scene 1" onward, each with a short body. */
function withScenes(count: number, body = 'A short scene.'): () => ProjectState {
  return () => {
    const state = makeState();
    for (let index = 1; index <= count; index += 1) addDocument(state, { parentId: CHAPTER_TWO, title: `Scene ${index}`, body, now: OPENED });
    return state;
  };
}

/** The titles of the fixture's three documents and `count` scenes, in the order a synopsis plan names them. */
function titlesOf(count: number): string[] {
  return ['The Landing', 'The Storm', 'The Friend', ...Array.from({ length: count }, (_, index) => `Scene ${index + 1}`)];
}

/** A drafting script that answers each drafting call in turn with the next reply, and the last one after that. */
function draftsInTurn(replies: readonly { readonly content: string; readonly finishReason?: 'stop' | 'length' | 'error' }[]): MockScript {
  let drafted = 0;
  return {
    match: (req) => req.responseFormat === 'text' && userTextOf(req).includes('Brief: Open the friend.'),
    respond: () => {
      const reply = replies[Math.min(drafted, replies.length - 1)] ?? { content: '' };
      drafted += 1;
      return reply;
    },
  };
}

describe('the status-card lifecycle (agent-harness §8)', () => {
  it('a confirmed call moves pending-approval → running → done, and the stream says so in that order', async () => {
    const run = await checked(
      scenario(
        'lifecycle: confirmed call',
        'Draft the opening of The Friend.',
        [
          transcript('Draft the opening of The Friend.', [
            steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'drafted' }),
          ]),
          prose('Brief: Open.', 'The ferry came in.'),
        ],
        { expect: { status: 'applied', trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok' }] } } },
      ),
    );
    const callId = run.report.trace[0]?.callId ?? '';
    expect(callId).not.toBe('');
    expect(lifecycleOf(run.events, callId)).toEqual(['pending-approval', 'running', 'done']);
  });

  it('a cancelled call moves pending-approval → cancelled and nothing runs', async () => {
    const run = await checked(
      scenario(
        'lifecycle: cancelled call',
        'Draft the opening of The Friend.',
        [
          transcript('Draft the opening of The Friend.', [
            steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'drafted' }),
          ]),
          prose('Brief: Open.', 'The ferry came in.'),
        ],
        { decisions: [{ action: 'cancel' }], expect: { status: 'cancelled' } },
      ),
    );
    const cardEvents = run.events.filter((event): event is Extract<AgentEvent, { type: 'card' }> => event.type === 'card');
    expect(cardEvents.map((event) => event.card.status)).toEqual(['pending-approval', 'cancelled']);
    expect(run.report.trace).toEqual([]);
  });

  it('a failed step moves to failed with its reason, and the steps after it are cancelled, not run', async () => {
    const run = await checked(
      scenario(
        'lifecycle: failed plan',
        'Label The Friend, change the anchor on The Landing, then tag The Storm.',
        [
          transcript('Label The Friend, change the anchor on The Landing, then tag The Storm.', [
            steps(
              { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled' },
              {
                tool: 'scene.draft',
                params: {
                  doc: 'The Landing',
                  instruction: 'Tighten it.',
                  mode: 'rewrite_selection',
                  selection: { from: 0, to: 5, exact: 'ghost', prefix: '', suffix: '', capturedRevision: 0 },
                },
                expect: 'the first line is tightened',
              },
              { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged' },
            ),
          ]),
          prose('Brief: Tighten it.', 'Tighter.'),
        ],
        { expect: { status: 'failed', askBack: 'anchor_unresolvable' } },
      ),
    );
    expect(run.report.trace.map((call) => call.outcome)).toEqual(['ok', 'refused', 'not-run']);
    const statuses = run.events.flatMap((event) => (event.type === 'card' ? [event.card.status] : []));
    expect(statuses).toContain('failed');
    expect(statuses).toContain('cancelled');
    // The first step's write is in the turn's undo group, and it is not reversed automatically.
    expect(run.report.undoGroupId).toBeDefined();
    expect(run.state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBe('act-2');
    expect(run.state.manifest.tree.find((node) => node.id === STORM)?.keywords).not.toContain('storm');
  });

  it('the cards are grouped: consecutive calls of one turn share a container that is open while they run', async () => {
    const { groupCards } = await import('../../src/index.js');
    const card = (id: string, status: StatusCard['status']): StatusCard => ({ id, turnId: 't', callId: id, tool: 'doc.read', risk: 'read', status, args: {} });
    const open = groupCards([card('a', 'done'), card('b', 'running')]);
    expect(open).toEqual([{ kind: 'group', turnId: 't', cards: [card('a', 'done'), card('b', 'running')], expanded: true }]);
    const closed = groupCards([card('a', 'done'), card('b', 'done')]);
    expect(closed[0]).toMatchObject({ kind: 'group', expanded: false });
    expect(groupCards([card('a', 'done')])).toEqual([{ kind: 'card', card: card('a', 'done') }]);
  });
});

describe('streaming, and the ghost-preview handoff (agent-harness §8)', () => {
  it('streams the model’s deltas, and hands a draft to the ghost preview with its words and its title', async () => {
    const run = await checked(
      scenario(
        'streaming: ghost preview',
        'Draft the opening of The Friend.',
        [
          transcript('Draft the opening of The Friend.', [
            steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'drafted' }),
          ]),
          prose('Brief: Open.', 'The ferry came in on the tide.'),
        ],
      ),
    );
    // A scene draft streams to its scene's ghost region as `draft.delta` events, not to the panel's `model.delta` tail (§8).
    const drafted = run.events.flatMap((event) => (event.type === 'draft.delta' ? [event.delta] : []));
    expect(drafted.join('')).toBe('The ferry came in on the tide.');
    const panel = run.events.flatMap((event) => (event.type === 'model.delta' ? [event.delta] : []));
    expect(panel.join('')).not.toContain('The ferry came in on the tide.');
    const ghost = run.events.find((event) => event.type === 'ghost');
    expect(ghost).toMatchObject({ type: 'ghost', docTitle: 'The Friend', text: 'The ferry came in on the tide.', words: 7 });
  });
});

describe('the checkpoint row and its restore (command-bus §5, agent-harness §5)', () => {
  it('names the turn’s undo group, and restoring it puts the project back as it was', async () => {
    const harness = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const gateway = await mockGateway([
      transcript('Label The Friend and give The Storm a synopsis.', [
        steps(
          { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' },
          { tool: 'synopsis.fill', params: { docs: [STORM], source: 'text', max_words: 20 }, expect: 'The Storm has a synopsis' },
        ),
      ]),
      prose('Document "The Storm":', 'A storm takes the lamp.'),
    ]);
    const events: AgentEvent[] = [];
    const decisions: Decision[] = [{ action: 'approve' }];
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state: harness.state }),
      decide: async () => decisions.shift() ?? { action: 'approve' },
      emit: (event) => events.push(event),
    });
    const before = JSON.stringify(harness.state.manifest.tree);
    const report = await session.submit('Label The Friend and give The Storm a synopsis.');
    expect(report.status).toBe('applied');
    const row = events.find((event) => event.type === 'checkpoint');
    expect(row).toEqual({ type: 'checkpoint', turnId: report.turnId, undoGroupId: report.undoGroupId, label: CHECKPOINT_LABEL, mode: 'ask' });
    expect(JSON.stringify(harness.state.manifest.tree)).not.toBe(before);

    const restored = session.restore(report.turnId);
    expect(restored.ok).toBe(true);
    expect(JSON.stringify(harness.state.manifest.tree)).toBe(before);
    expect(session.reports()).toHaveLength(1);
  });

  it('a turn that wrote nothing has no checkpoint, and cannot be restored', async () => {
    const harness = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const gateway = await mockGateway([transcript('What is in The Storm?', [answer('Rain, and a failed lamp.')])]);
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state: harness.state }),
      decide: async () => ({ action: 'approve' }),
    });
    const report = await session.submit('What is in The Storm?');
    expect(report.undoGroupId).toBeUndefined();
    const restored = session.restore(report.turnId);
    expect(restored.ok).toBe(false);
  });

  it('a turn cancelled after an applied step keeps its undo group and one checkpoint, and restore reverts the applied steps', async () => {
    const intent = 'Label The Friend, then draft it twice.';
    const run = await checked(
      scenario(
        'checkpoint: cancel after a ladder retry',
        intent,
        [
          transcript(intent, [
            steps(
              { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' },
              { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'The Friend is drafted' },
              // The Friend is empty when the plan is checked, so this step passes the preflight. The step before it fills the scene,
              // so the apply refuses this one (a needs_input refusal that changed nothing), and the model adjusts it.
              { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'The Friend is drafted again' },
            ),
            // The adjusted step the model sends after the refusal: continue, not draft.
            steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'continue' }, expect: 'The Friend continues' }),
          ]),
          prose('Brief: Open.', 'The ferry came in.'),
        ],
        {
          decisions: [{ action: 'approve' }, { action: 'cancel' }],
          expect: {
            status: 'cancelled',
            summaryIncludes: ['Written before the cancel'],
            restores: true,
            state: (state) => ((state.manifest.tree.find((node) => node.id === FRIEND)?.label ?? null) === null ? [] : ['the applied label survived the restore']),
          },
        },
      ),
    );
    expect(run.report.undoGroupId).toBeDefined();
    expect(run.events.filter((event) => event.type === 'checkpoint')).toHaveLength(1);
    expect(run.report.trace.map((entry) => entry.outcome)).toEqual(['ok', 'ok', 'refused']);
  });

  it('a draft that would replace a scene with text is refused before its model call, and the planner is told why', async () => {
    const intent = 'Draft a new opening for The Storm.';
    const seen: ChatRequest[] = [];
    const run = await checked(
      scenario(
        'draft mode: refused before the draft is made',
        intent,
        [
          // The first plan drafts over The Storm, which has text: refused before any draft call, so the planner is asked again.
          transcript(
            intent,
            [
              steps({ tool: 'scene.draft', params: { doc: STORM, instruction: 'Open.', mode: 'draft' }, expect: 'a new opening' }),
              steps({ tool: 'scene.draft', params: { doc: STORM, instruction: 'Open.', mode: 'continue' }, expect: 'the text carries on' }),
            ],
            seen,
          ),
          prose('Brief: Open.', 'The lamp failed again.'),
        ],
        // Three model calls: the refused plan, the corrected plan, and the one draft. A draft made before the refusal would make four.
        { expect: { status: 'applied', maxModelCalls: 3, trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok' }] } } },
      ),
    );
    expect(run.report.trace).toHaveLength(1);
    // The refusal went back to the planner in words the writer's card repeats, with the choice the card offers.
    const told = userTextOf(seen[1] as ChatRequest);
    expect(told).toContain(`Step 1 (scene.draft) was refused: Mode draft needs an empty document, and this one already has`);
    expect(told).toContain('Set mode to continue to add to the end, or select a passage to rewrite it');
  });

  it('a draft refused before its model call is a failed status card in the turn, with the refusal in the words the planner reads', async () => {
    const intent = 'Draft a new opening for The Storm, and then carry it on.';
    const run = await checked(
      scenario(
        'refused draft: a status card for the refusal',
        intent,
        [
          transcript(intent, [
            steps({ tool: 'scene.draft', params: { doc: STORM, instruction: 'Open.', mode: 'draft' }, expect: 'a new opening' }),
            steps({ tool: 'scene.draft', params: { doc: STORM, instruction: 'Open.', mode: 'continue' }, expect: 'the text carries on' }),
          ]),
          prose('Brief: Open.', 'The lamp failed again.'),
        ],
        { expect: { status: 'applied', maxModelCalls: 3 } },
      ),
    );
    // The refused step is a card of its own, failed before any draft was made for it, and it names the choice the planner is given.
    const failed = run.events.flatMap((event) => (event.type === 'card' && event.card.tool === 'scene.draft' && event.card.status === 'failed' ? [event.card] : []));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain('Mode draft needs an empty document');
    expect(failed[0]?.error).toContain('Set mode to continue to add to the end, or select a passage to rewrite it');
    // The card reaches the failed state from running, as every card does, and the applied step has its own card.
    expect(lifecycleOf(run.events, failed[0]?.id ?? '')).toEqual(['running', 'failed']);
    expect(run.events.filter((event) => event.type === 'card' && event.card.tool === 'scene.draft' && event.card.status === 'done')).toHaveLength(1);
  });

  it('a draft in a mode the schema does not name is refused before its model call, even on an empty document, by the modes it may be', async () => {
    const intent = 'Draft the opening of The Friend, somehow, then draft it.';
    const seen: ChatRequest[] = [];
    let drafted = 0;
    const run = await checked(
      scenario(
        'draft: an unknown mode is refused by name, so no call is spent on it',
        intent,
        [
          // The Friend is empty, so a mode read as draft would pass the placement rule and spend a call before the schema refused it.
          transcript(
            intent,
            [
              steps({ tool: 'scene.draft', params: { doc: FRIEND, instruction: 'Open.', mode: 'overwrite' }, expect: 'a new opening' }),
              steps({ tool: 'scene.draft', params: { doc: FRIEND, instruction: 'Open.', mode: 'draft' }, expect: 'a new opening' }),
            ],
            seen,
          ),
          {
            match: (req) => req.responseFormat === 'text' && userTextOf(req).includes('Brief: Open.'),
            respond: () => {
              drafted += 1;
              return { content: 'The ferry came in.' };
            },
          },
        ],
        { expect: { status: 'applied', maxModelCalls: 3 } },
      ),
    );
    // One draft call, for the corrected step: the step with the unknown mode was refused before its own call.
    expect(drafted).toBe(1);
    expect(run.events.some((event) => event.type === 'card' && event.card.status === 'failed' && event.card.tool === 'scene.draft')).toBe(true);
    // The planner is told the modes the step may take, not a rule about a mode it never sent.
    const told = userTextOf(seen[1] as ChatRequest);
    expect(told).toContain('mode must be draft, continue or rewrite_selection, and this step has "overwrite"');
    expect(told).not.toContain('draft needs an empty document');
  });

  it('a single write-auto step refused by its preflight is a failed status card in the turn, and the planner is asked again', async () => {
    const intent = 'Label The Friend with a label the project does not have, then with act-2.';
    const run = await checked(
      scenario(
        'single write-auto refusal: a status card, then a corrected step',
        intent,
        [
          transcript(intent, [
            steps({ tool: 'meta.set', params: { targets: [FRIEND], label: 'act-9' }, expect: 'The Friend is labelled act-9' }),
            steps({ tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' }),
          ]),
        ],
        { expect: { status: 'applied', maxModelCalls: 2, trace: { matcher: 'strict', calls: [{ tool: 'meta.set', outcome: 'ok' }] } } },
      ),
    );
    // The refused step had no card to refuse on, so its status card carries the refusal, and the run that followed is its own card.
    const failed = run.events.flatMap((event) => (event.type === 'card' && event.card.tool === 'meta.set' && event.card.status === 'failed' ? [event.card] : []));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain('act-9');
    expect(run.report.trace.map((entry) => entry.outcome)).toEqual(['ok']);
  });

  it('a model error after an applied step keeps its undo group, and the report says what was written before the stop', async () => {
    const intent = 'Label The Friend, then draft the storm.';
    // The planner answers its first call with the plan, and every later call with a provider error.
    const planThenFail: MockScript = {
      match: (req) => isPlannerCall(req) && userTextOf(req).includes(`Request: ${intent}`),
      respond: (req) =>
        req.messages.filter((message) => message.role === 'assistant').length === 0
          ? {
              // The second draft fills The Friend, which is empty when the plan is checked, so the apply refuses the third step and the
              // model is asked to adjust it. The first two steps have applied by then, so the stop has something written before it.
              content: steps(
                { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' },
                { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'The lamp fails.', mode: 'draft' }, expect: 'The Friend is drafted' },
                { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'The lamp fails.', mode: 'draft' }, expect: 'The Friend is drafted again' },
              ),
            }
          : { content: '', error: { kind: 'auth', status: 401 } },
    };
    const run = await checked(
      scenario('checkpoint: model error after an applied step', intent, [planThenFail, prose('Brief: The lamp fails.', 'The keeper rows out.')], {
        expect: {
          status: 'failed',
          askBack: 'needs_input',
          summaryIncludes: ['the model call failed', 'Written before the stop'],
          restores: true,
          state: (state) => ((state.manifest.tree.find((node) => node.id === FRIEND)?.label ?? null) === null ? [] : ['the applied label survived the restore']),
        },
      }),
    );
    expect(run.report.undoGroupId).toBeDefined();
    expect(run.events.filter((event) => event.type === 'checkpoint')).toHaveLength(1);
  });
});

describe('token accounting, per turn (provider-gateway §6)', () => {
  it('each turn’s tokens are its own, read from the ledger rows the turn’s requests wrote', async () => {
    const harness = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const gateway = await mockGateway([
      transcript('Tag The Storm.', [steps({ tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'tagged' })]),
      transcript('What is in The Storm?', [answer('Rain.')]),
    ]);
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state: harness.state }),
      decide: async () => ({ action: 'approve' }),
    });
    const first = await session.submit('Tag The Storm.');
    const second = await session.submit('What is in The Storm?');
    expect(first.tokens.requests).toBe(first.modelCalls);
    expect(second.tokens.requests).toBe(second.modelCalls);
    expect(first.tokens.promptTokens).toBeGreaterThan(0);
    // The second turn is not the running total: its tokens are its own single request, as the ledger's row for that turn says.
    expect(second.tokens.requests).toBe(1);
    expect(gateway.ledger.turnTotals(second.turnId)).toEqual({ promptTokens: second.tokens.promptTokens, completionTokens: second.tokens.completionTokens, requests: 1 });
    expect(gateway.ledger.turnTotals(first.turnId).requests).toBe(first.tokens.requests);
  });

  it('two sessions on one gateway keep their turns apart: the second session’s first turn reports only its own request', async () => {
    const gateway = await mockGateway([
      transcript('Tag The Storm.', [steps({ tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'tagged' })]),
      transcript('What is in The Friend?', [answer('Nothing yet.')]),
    ]);
    const first = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const sessionA = createAgentSession({
      harness: first,
      gateway,
      context: createContextPort({ state: first.state }),
      decide: async () => ({ action: 'approve' }),
    });
    const reportA = await sessionA.submit('Tag The Storm.');

    const second = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const sessionB = createAgentSession({
      harness: second,
      gateway,
      context: createContextPort({ state: second.state }),
      decide: async () => ({ action: 'approve' }),
    });
    const reportB = await sessionB.submit('What is in The Friend?');

    // Each session counts its turns from one, so the turn ids are only unique because each session names them.
    expect(reportB.turnId).not.toBe(reportA.turnId);
    expect(reportB.modelCalls).toBe(1);
    expect(reportB.tokens.requests).toBe(1);
    expect(gateway.ledger.turnTotals(reportB.turnId).requests).toBe(1);
  });
});

describe('failures are reported in words the user can act on', () => {
  it('a gateway failure ends the turn as a failed report, and writes nothing', async () => {
    const run = await checked(
      scenario('failure: provider rejects the key', 'Tag The Storm.', [fail('auth')], {
        expect: { status: 'failed', askBack: 'needs_input', summaryIncludes: ['the model call failed'] },
      }),
    );
    expect(run.report.status).toBe('failed');
    expect(run.report.trace).toEqual([]);
    expect(run.state.documents.get(LANDING)?.body).toBe(LANDING_BODY);
  });

  it('a turn that keeps asking for reads stops at the model-call bound, and says so', async () => {
    const run = await checked(
      scenario(
        'bound: reads without end',
        'Read everything, forever.',
        [transcript('Read everything, forever.', [steps({ tool: 'binder.read_tree', params: {}, expect: 'read' })])],
        { expect: { status: 'failed', summaryIncludes: ['made 8 model calls'], maxModelCalls: 8 } },
      ),
    );
    expect(run.report.modelCalls).toBe(8);
  });

  it('the planner is told only the tools this build can call, and never the protocol step agent.plan', async () => {
    const run = await checked(
      scenario('tools in the system message', 'What can you do?', [transcript('What can you do?', [answer('Read, draft and tidy.')])], {
        expect: {
          status: 'replied',
          requests: [{ system: "You are Caotang's agent.", systemIncludes: ['scene.draft [write-confirm]', 'codex.read [read]'], systemExcludes: ['- agent.plan'] }],
        },
      }),
    );
    expect(run.report.text).toBe('Read, draft and tidy.');
  });

  it('a card that keeps being approved while it refuses a step ends the turn, rather than asking forever', async () => {
    const run = await checked(
      scenario(
        'stall: an unapprovable card, approved by default',
        'Add a second Elena and label The Friend.',
        [
          transcript('Add a second Elena and label The Friend.', [
            steps(
              { tool: 'codex.write', params: { entries: [{ action: 'create', name: 'Elena', type: 'character', description: 'Another.' }] }, expect: 'a second Elena' },
              { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'labelled' },
            ),
          ]),
        ],
        { expect: { status: 'failed', askBack: 'needs_input', summaryIncludes: ['decided 5 times'] } },
      ),
    );
    expect(run.pending.length).toBeLessThanOrEqual(6);
    expect(run.state.manifest.tree.find((node) => node.id === FRIEND)?.label ?? null).toBeNull();
  });
});

describe('the bound on model calls covers every draft (command-bus §5, context-assembly §3)', () => {
  const nineDocs = titlesOf(6);

  it('a synopsis batch the turn cannot afford is refused before any draft is asked for, and the model is told to split it', async () => {
    const intent = 'Synopsize everything in the act.';
    const run = await checked(
      scenario(
        'bound: nine documents against the default bound',
        intent,
        [transcript(intent, [steps({ tool: 'synopsis.fill', params: { docs: nineDocs, source: 'text', max_words: 20 }, expect: 'every doc has a synopsis' })])],
        {
          project: withScenes(6),
          expect: { status: 'failed', askBack: 'needs_input', summaryIncludes: ['made 8 model calls'], maxModelCalls: 8 },
        },
      ),
    );
    expect(run.report.modelCalls).toBe(8);
    expect(run.requests.filter((request) => isDraftCall(request))).toHaveLength(0);
    expect(run.requests.at(-1)?.messages.map((message) => message.content).join('\n')).toContain('split the rest into another turn');
  });

  it('a split that fits the bound is applied, and the calls the turn makes stay within it', async () => {
    const intent = 'Synopsize the act, in two goes.';
    const run = await checked(
      scenario(
        'bound: a split batch that fits',
        intent,
        [
          transcript(intent, [
            steps({ tool: 'synopsis.fill', params: { docs: nineDocs, source: 'text', max_words: 20 }, expect: 'every doc has a synopsis' }),
            steps({ tool: 'synopsis.fill', params: { docs: ['The Landing', 'The Storm', 'The Friend'], source: 'text', max_words: 20 }, expect: 'three docs have a synopsis' }),
          ]),
          prose('Document "', 'A quiet synopsis.'),
        ],
        { project: withScenes(6), expect: { status: 'applied', maxModelCalls: 8 } },
      ),
    );
    expect(run.report.modelCalls).toBe(5);
    expect(run.report.modelCalls).toBeLessThanOrEqual(8);
  });

  it('a retry the turn cannot afford is a notice on the card, and the card keeps the draft it has', async () => {
    const intent = 'Synopsize the act.';
    const run = await checked(
      scenario(
        'bound: retry over the bound',
        intent,
        [transcript(intent, [steps({ tool: 'synopsis.fill', params: { docs: ['The Landing', 'The Storm', 'The Friend'], source: 'text', max_words: 20 }, expect: 'three synopses' })]), prose('Document "', 'A quiet synopsis.')],
        {
          modelCallBound: 5,
          decisions: [{ action: 'retry' }, { action: 'approve' }],
          // Four calls are spent (the planner and three drafts), so a retry of three drafts cannot be afforded.
          expect: { status: 'applied', maxModelCalls: 5 },
        },
      ),
    );
    expect(run.pending[1]?.card.notice).toContain('model calls');
    expect(run.report.modelCalls).toBe(4);
  });
});

describe('a draft the provider cut or broke (provider-gateway §3)', () => {
  it('a draft cut at the output limit cannot be approved, and approval needs the explicit acceptance', async () => {
    const intent = 'Open The Friend.';
    const run = await checked(
      scenario(
        'finish: a cut draft needs acceptance',
        intent,
        [
          transcript(intent, [steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open the friend.', mode: 'draft' }, expect: 'drafted' })]),
          draftsInTurn([{ content: 'The ferry came in on the evening tide, slow to', finishReason: 'length' }]),
        ],
        { decisions: [{ action: 'approve' }, { action: 'approve', acceptTruncated: true }], expect: { status: 'applied' } },
      ),
    );
    expect(run.pending[0]?.card).toMatchObject({ approvable: false, canAcceptCut: true, cut: true });
    expect(run.pending[0]?.card.steps[0]).toMatchObject({ cut: true });
    expect(run.state.documents.get(FRIEND)?.body).toBe('The ferry came in on the evening tide, slow to');
    expect(run.events.find((event) => event.type === 'ghost')).toMatchObject({ cut: true });
  });

  it('retrying a cut draft drafts it again, and the whole draft is the one that can be approved', async () => {
    const intent = 'Open The Friend.';
    const run = await checked(
      scenario(
        'finish: a retry replaces the cut draft',
        intent,
        [
          transcript(intent, [steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open the friend.', mode: 'draft' }, expect: 'drafted' })]),
          draftsInTurn([
            { content: 'The ferry came in on the evening tide, slow to', finishReason: 'length' },
            { content: 'The ferry came in on the evening tide, slow to answer the rope.' },
          ]),
        ],
        { decisions: [{ action: 'retry' }, { action: 'approve' }], expect: { status: 'applied' } },
      ),
    );
    expect(run.pending[0]?.card.cut).toBe(true);
    expect(run.pending[1]?.card).toMatchObject({ approvable: true, cut: false });
    expect(run.state.documents.get(FRIEND)?.body).toBe('The ferry came in on the evening tide, slow to answer the rope.');
  });

  it('a stream the provider ended on an error stages nothing: the turn stops, and the document is unchanged', async () => {
    const intent = 'Open The Friend.';
    const run = await checked(
      scenario(
        'finish: an errored stream stages nothing',
        intent,
        [
          transcript(intent, [steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open the friend.', mode: 'draft' }, expect: 'drafted' })]),
          draftsInTurn([{ content: 'The ferry came in', finishReason: 'error' }]),
        ],
        { expect: { status: 'failed', askBack: 'needs_input', summaryIncludes: ['stopped before its answer was finished'] } },
      ),
    );
    expect(run.events.filter((event) => event.type === 'ghost')).toHaveLength(0);
    expect(run.report.trace).toEqual([]);
    expect(run.state.documents.get(FRIEND)?.body).toBe('');
  });
});

describe('the turns a session has run are L6 (context-assembly §2)', () => {
  it('a later turn’s drafting call carries the intents of the two turns before it, and not of an older one', async () => {
    const harness = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const gateway = await mockGateway([
      transcript('Name the ferryman.', [answer('Named.')]),
      transcript('Name the lamp.', [answer('Named.')]),
      transcript('Name the storm.', [answer('Named.')]),
      transcript('Draft the lamp.', [
        steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'The lamp fails.', mode: 'continue' }, expect: 'The Storm continues' }),
        answer('Drafted.'),
      ]),
      prose('Brief: The lamp fails.', 'It fails.'),
    ]);
    // Every request the session sends, in order, so the drafting call can be found among the planner's.
    const sent: ChatRequest[] = [];
    const recording: Gateway = {
      ...gateway,
      complete: (request, signal) => {
        sent.push(request);
        return gateway.complete(request, signal);
      },
    };
    const session = createAgentSession({ harness, gateway: recording, decide: async () => ({ action: 'approve' }) });
    for (const intent of ['Name the ferryman.', 'Name the lamp.', 'Name the storm.', 'Draft the lamp.']) await session.submit(intent);

    const draft = sent.find((request) => request.responseFormat === 'text' && userTextOf(request).includes('Brief: The lamp fails.'));
    expect(draft).toBeDefined();
    const text = userTextOf(draft!);
    expect(text).toContain('Intent: Name the lamp.');
    expect(text).toContain('Intent: Name the storm.');
    expect(text).not.toContain('Intent: Name the ferryman.');
  });
});

describe('the outcome a turn leaves for L6 does not depend on the activity log (context-assembly §2)', () => {
  /** Every request the session sends, in order. */
  function recording(gateway: Gateway): { readonly gateway: Gateway; readonly sent: ChatRequest[] } {
    const sent: ChatRequest[] = [];
    return {
      sent,
      gateway: {
        ...gateway,
        complete: (request, signal) => {
          sent.push(request);
          return gateway.complete(request, signal);
        },
      },
    };
  }

  const draftIntent = 'Draft the lamp.';
  const draftScripts = [
    transcript(draftIntent, [
      steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'The lamp fails.', mode: 'continue' }, expect: 'The Storm continues' }),
      answer('Drafted.'),
    ]),
    prose('Brief: The lamp fails.', 'It fails.'),
  ];
  const draftText = (sent: readonly ChatRequest[]): string => {
    const draft = sent.find((request) => request.responseFormat === 'text' && userTextOf(request).includes('Brief: The lamp fails.'));
    expect(draft).toBeDefined();
    return userTextOf(draft!);
  };

  it('a turn that only replied leaves its clipped answer as the outcome, since a reply writes no activity row', async () => {
    const harness = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const { gateway, sent } = recording(await mockGateway([transcript('Who rows the ferry?', [answer('Oren rows the ferry.\n\nHe has done so for years.')]), ...draftScripts]));
    const session = createAgentSession({ harness, gateway, decide: async () => ({ action: 'approve' }) });
    for (const intent of ['Who rows the ferry?', draftIntent]) await session.submit(intent);

    const text = draftText(sent);
    expect(text).toContain('Intent: Who rows the ferry?');
    expect(text).toContain('Outcome: Oren rows the ferry. He has done so for years.');
    expect(text).toContain('Undo group: none');
  });

  it('a long answer is held to one clipped line', async () => {
    const harness = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const { gateway, sent } = recording(await mockGateway([transcript('Tell me everything.', [answer('word '.repeat(200))]), ...draftScripts]));
    const session = createAgentSession({ harness, gateway, decide: async () => ({ action: 'approve' }) });
    for (const intent of ['Tell me everything.', draftIntent]) await session.submit(intent);

    const outcome = draftText(sent)
      .split('\n')
      .find((line) => line.startsWith('  Outcome: '));
    expect(outcome).toBeDefined();
    expect(outcome!.length).toBeLessThanOrEqual('  Outcome: '.length + 240);
    expect(outcome!.endsWith('…')).toBe(true);
  });

  it('turn ids follow the session id, in order', async () => {
    const harness = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const gateway = await mockGateway([transcript('One.', [answer('A.')]), transcript('Two.', [answer('B.')])]);
    const session = createAgentSession({ harness, gateway, decide: async () => ({ action: 'approve' }), sessionId: 'panel' });
    const first = await session.submit('One.');
    const second = await session.submit('Two.');

    expect([first.turnId, second.turnId]).toEqual(['panel.turn-1', 'panel.turn-2']);
  });
});

describe('a turn’s own pins, over the session’s (agent-harness §2)', () => {
  it('each turn’s model calls carry that turn’s model and thinking level, and the session keeps its conversation across them', async () => {
    const harness = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const gateway = await mockGateway([transcript('Name the ferryman.', [answer('Named.')]), transcript('Name the lamp.', [answer('Named.')]), transcript('Name the storm.', [answer('Named.')])]);
    const sent: ChatRequest[] = [];
    const recording: Gateway = {
      ...gateway,
      complete: (request, signal) => {
        sent.push(request);
        return gateway.complete(request, signal);
      },
    };
    const profileId = gateway.profiles.active()?.id;
    const session = createAgentSession({ harness, gateway: recording, decide: async () => ({ action: 'approve' }), model: 'session-model' });
    await session.submit('Name the ferryman.', { profileId, model: 'first-model', thinking: 'low' });
    await session.submit('Name the lamp.', { profileId, model: 'second-model', thinking: 'high' });
    await session.submit('Name the storm.');

    const planner = sent.filter((request) => isPlannerCall(request));
    expect(planner.map((request) => [request.model, request.thinking])).toEqual([
      ['first-model', 'low'],
      ['second-model', 'high'],
      ['session-model', undefined],
    ]);
    expect(planner[0]?.profileId).toBe(profileId);
    // The third turn's planner reads the same one session: its turn is the third, not a new session's first.
    expect(session.reports().map((report) => report.turnId.split('.').pop())).toEqual(['turn-1', 'turn-2', 'turn-3']);
  });
});

describe('the prompt a card shows, and the budgets it is held to (context-assembly §3, §5)', () => {
  it('a codex entry dropped for budget appears on the card with its reason, and the included entries say why they are there', async () => {
    const intent = 'Draft the storm with Elena and Kestrel in it.';
    const run = await checked(
      scenario(
        'preview: a dropped codex entry is on the card',
        intent,
        [
          transcript(intent, [
            steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'Elena and Kestrel watch the lamp fail.', mode: 'continue' }, expect: 'The Storm continues' }),
          ]),
          prose('Brief: Elena and Kestrel', 'They watch it go.'),
        ],
        // Twelve tokens holds Elena's block and not Kestrel's, so one entry is dropped and one is kept.
        { contextOptions: { config: { layerBudgets: { L2: 12 } } }, expect: { status: 'applied' } },
      ),
    );
    const context = run.pending[0]?.card.steps[0]?.context;
    expect(context?.codex.dropped).toContainEqual(expect.objectContaining({ name: 'Kestrel', reason: expect.stringContaining('budget (L2') }));
    expect(context?.codex.included).toEqual([expect.objectContaining({ name: 'Elena', reason: expect.stringContaining('matched') })]);
    expect(context?.layers.find((layer) => layer.id === 'L2')).toMatchObject({ budget: 12 });
    expect(context?.focus?.summary).toContain('chars');
    expect(context?.promptTokens).toBeGreaterThan(0);
    // The completion is estimated at the output cap, because the reply is not known before the call (context-assembly §5).
    expect(context?.completionTokens).toBe(4_096);
  });

  it('a document longer than the synopsis budget is cut from its end, and the card names the cut', async () => {
    // The synopsis budget is 25,000 tokens (context-assembly §3), and the unused L3 budget flows up to it, so a
    // 120,000-character document is cut at about 104,500 characters.
    const long = 'x'.repeat(120_000);
    const intent = 'Synopsize the long scene.';
    const run = await checked(
      scenario(
        'budget: a long document is cut for the synopsis',
        intent,
        [transcript(intent, [steps({ tool: 'synopsis.fill', params: { docs: ['Long Scene'], source: 'text', max_words: 20 }, expect: 'a synopsis' })]), prose('Document "Long Scene"', 'A long scene.')],
        {
          project: () => {
            const state = makeState();
            addDocument(state, { parentId: CHAPTER_TWO, title: 'Long Scene', body: long, now: OPENED });
            return state;
          },
          expect: { status: 'applied' },
        },
      ),
    );
    const focus = run.pending[0]?.card.steps[0]?.context?.layers.find((layer) => layer.id === 'L5');
    expect(focus?.notes.join(' ')).toContain('of 120,000 characters.');
    const draft = run.requests.find((request) => isDraftCall(request));
    expect(draft === undefined ? 0 : userTextOf(draft).length).toBeGreaterThan(0);
    expect(draft === undefined ? 0 : userTextOf(draft).length).toBeLessThan(110_000);
  });

  it('continuity reads each document’s last 4,000 characters (1,000 tokens, context-assembly §3), and says so in the scope', async () => {
    const intent = 'Check the manuscript for continuity problems.';
    const run = await checked(
      scenario(
        'budget: continuity reads the tail',
        intent,
        [
          transcript(intent, [steps({ tool: 'continuity.scan', params: {}, expect: 'the findings are listed' }), answer('Nothing found.')]),
          draftScriptFindings(),
        ],
        {
          project: () => {
            const state = makeState();
            addDocument(state, { parentId: CHAPTER_TWO, title: 'Long Scene', body: `HEAD${'x'.repeat(5000)}TAIL-END`, now: OPENED });
            return state;
          },
          expect: { status: 'replied' },
        },
      ),
    );
    const scan = run.requests.find((request) => isDraftCall(request));
    const text = scan === undefined ? '' : userTextOf(scan);
    expect(text).toContain('TAIL-END');
    expect(text).not.toContain('HEAD');
    // The scope names the clip to the model itself (context-assembly §7): a read has no card to show it.
    expect(text).toContain('the last 4,000 characters of each');
  });

  it('a continuity scope over twenty documents is refused with the split named, and the model is asked again', async () => {
    const intent = 'Check the manuscript for continuity problems.';
    const run = await checked(
      scenario(
        'budget: continuity over twenty documents',
        intent,
        [transcript(intent, [steps({ tool: 'continuity.scan', params: {}, expect: 'the findings are listed' }), answer('I will split it.')])],
        { project: withScenes(18), expect: { status: 'replied', summaryIncludes: ['split'] } },
      ),
    );
    const retry = run.requests.at(-1)?.messages.map((message) => message.content).join('\n') ?? '';
    expect(retry).toContain('split it into runs of at most 20 documents');
    expect(run.requests.filter((request) => isDraftCall(request))).toHaveLength(0);
  });
});

describe('a draft the user overtook (agent-harness §8, command-bus §6)', () => {
  const USER_TEXT = 'Rain.\n\n***\n\nThe lamp failed.\n\nThe user typed this while the card was up.';

  it('a document changed after the draft was staged is a conflict: the draft is kept on the card, and nothing is written over the edit', async () => {
    let storm: ProjectState | undefined;
    const run = await checked(
      scenario(
        'revision: a user edit while the draft card is open',
        'Continue the storm.',
        [
          transcript('Continue the storm.', [
            steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'The keeper rows out.', mode: 'continue' }, expect: 'the storm continues' }),
          ]),
          prose('Brief: The keeper rows out.', 'He rows out.'),
        ],
        {
          project: () => (storm = makeState()),
          decisions: [
            () => {
              setBody(storm as ProjectState, STORM, USER_TEXT);
              return { action: 'approve' };
            },
            { action: 'cancel' },
          ],
          expect: {
            status: 'cancelled',
            trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'refused', params: { mode: 'continue' } }] },
            state: (state) => (state.documents.get(STORM)?.body === USER_TEXT ? [] : ['the draft was written over the user’s edit']),
          },
        },
      ),
    );
    const second = run.pending[1]?.card.steps[0];
    expect(second?.stale).toBe(true);
    expect(run.pending[1]?.card.approvable).toBe(false);
    expect(run.pending[1]?.card.notice).toContain('doc was modified since plan (rev 0 → 1)');
    expect(second?.preview).toMatchObject({ text: 'He rows out.' });
    expect(run.report.trace[0]?.code).toBe('revision-conflict');
  });

  it('retrying a conflicted draft drafts it against the current text, and applies it after the user’s text', async () => {
    let storm: ProjectState | undefined;
    const run = await checked(
      scenario(
        'revision: retry after a conflict',
        'Continue the storm.',
        [
          transcript('Continue the storm.', [
            steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'The keeper rows out.', mode: 'continue' }, expect: 'the storm continues' }),
          ]),
          prose('Brief: The keeper rows out.', 'He rows out.'),
        ],
        {
          project: () => (storm = makeState()),
          decisions: [
            () => {
              setBody(storm as ProjectState, STORM, USER_TEXT);
              return { action: 'approve' };
            },
            { action: 'retry' },
            { action: 'approve' },
          ],
          expect: { status: 'applied', state: (state) => (state.documents.get(STORM)?.body === `${USER_TEXT}\n\nHe rows out.` ? [] : ['the retried draft did not follow the user’s text']) },
        },
      ),
    );
    expect(run.pending[2]?.card.approvable).toBe(true);
  });
});

describe('the synopsis source names what the drafting call reads (agent-harness §3, row 7)', () => {
  // A distinctive phrase of The Landing's body, and of its notes, as the fixture holds them.
  const BODY = 'The ferry was late';
  const NOTES = 'Fix pacing in the last three paragraphs.';
  const cases: readonly { readonly source: 'text' | 'notes' | 'both'; readonly sent: readonly string[]; readonly left: readonly string[] }[] = [
    { source: 'text', sent: [BODY], left: [NOTES] },
    { source: 'notes', sent: [NOTES], left: [BODY] },
    { source: 'both', sent: [BODY, NOTES], left: [] },
  ];

  for (const { source, sent, left } of cases) {
    it(`source "${source}" sends what it names, and leaves out what it does not`, async () => {
      const intent = `Synopsize The Landing from its ${source}.`;
      await checked(
        scenario(
          `synopsis source: ${source}`,
          intent,
          [
            transcript(intent, [steps({ tool: 'synopsis.fill', params: { docs: [LANDING], source, max_words: 20 }, expect: 'The Landing has a synopsis' })]),
            prose('Document "The Landing":', 'A synopsis.'),
          ],
          { expect: { status: 'applied', requests: [{ system: DRAFT_PREFIX, includes: sent, excludes: left }] } },
        ),
      );
    });
  }

  it('a notes-only synopsis of a document with no notes is refused to the model, which can draft it from the text instead', async () => {
    // The Friend has neither notes nor synopsis (fixtures.ts), so a notes-only draft would be invented from its title.
    const intent = 'Synopsize The Friend from its notes.';
    await checked(
      scenario(
        'synopsis source notes: no notes is refused, then drafted from the text',
        intent,
        [
          transcript(intent, [
            steps({ tool: 'synopsis.fill', params: { docs: [FRIEND], source: 'notes', max_words: 20 }, expect: 'The Friend has a synopsis' }),
            steps({ tool: 'synopsis.fill', params: { docs: [FRIEND], source: 'text', max_words: 20 }, expect: 'The Friend has a synopsis' }),
          ]),
          prose('Document "The Friend":', 'A synopsis.'),
        ],
        { expect: { status: 'applied', requests: [{ system: PLANNER_PREFIX, includes: ['The Friend has no notes, and source "notes"'] }] } },
      ),
    );
  });
});

describe('a step the turn cannot ground is refused back to the model, not thrown (agent-harness §3, row 8)', () => {
  it('a rewrite with no selection is refused with the missing selection named, and the model corrects the step', async () => {
    const intent = 'Tighten The Landing.';
    const run = await checked(
      scenario(
        'rewrite with no selection: refused, then corrected',
        intent,
        [
          transcript(intent, [
            steps({ tool: 'scene.draft', params: { doc: LANDING, instruction: 'Tighten it.', mode: 'rewrite_selection' }, expect: 'the first line is tightened' }),
            steps({ tool: 'scene.draft', params: { doc: LANDING, instruction: 'Tighten it.', mode: 'continue' }, expect: 'the text continues' }),
          ]),
          prose('Brief: Tighten it.', 'Tighter.'),
        ],
        {
          expect: {
            status: 'applied',
            // The corrective hint, not only the refusal: it names the missing selection and the two ways out of it.
            requests: [
              {
                system: PLANNER_PREFIX,
                includes: ['was refused: rewrite_selection needs a selection with text, and this step has none:', 'To write new text instead, use mode "draft" or "continue".'],
              },
            ],
          },
        },
      ),
    );
    // Planner, planner, and the one draft the corrected step needs: the refused step drafted nothing.
    expect(run.report.modelCalls).toBe(3);
  });

  it('a context assembly that refuses a step is a refusal to the model too, and the turn goes on', async () => {
    const intent = 'Continue The Landing.';
    const harness = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const real = createContextPort({ state: harness.state });
    let refused = false;
    // The assembly refuses the first scene.draft it is asked for. The step must come back to the model, not end the turn.
    const context: ContextPort = {
      assemble: (request) => {
        if (!refused && request.task.tool === 'scene.draft') {
          refused = true;
          throw new ContextError('missing-selection', 'rewrite_selection needs a selection with text (refused by the assembly)');
        }
        return real.assemble(request);
      },
    };
    const gateway = await mockGateway([
      transcript(intent, [steps({ tool: 'scene.draft', params: { doc: LANDING, instruction: 'Continue it.', mode: 'continue' }, expect: 'the text continues' })]),
      prose('Brief: Continue it.', 'And then the rain.'),
    ]);
    const sent: ChatRequest[] = [];
    const recording: Gateway = {
      ...gateway,
      complete: (request, signal) => {
        sent.push(request);
        return gateway.complete(request, signal);
      },
    };
    const session = createAgentSession({ harness, gateway: recording, context, decide: async () => ({ action: 'approve' }) });
    const report = await session.submit(intent);
    expect(report.status).toBe('applied');
    expect(report.askBack).toBeUndefined();
    expect(sent.some((request) => request.messages.some((message) => message.content.includes('was refused: rewrite_selection needs a selection with text (refused by the assembly)')))).toBe(true);
  });
});

/** A drafting script for the continuity check: one findings reply, with no findings. */
function draftScriptFindings(): MockScript {
  return {
    match: (req) => isDraftCall(req) && req.responseFormat !== undefined && typeof req.responseFormat !== 'string',
    respond: () => ({ content: JSON.stringify({ findings: [] }) }),
  };
}

/* ------------------------------------------------------------------ *
 * A planner reply the provider cut (issue #97), on the JSON wire.
 * ------------------------------------------------------------------ */

interface PlannerReply {
  readonly content: string;
  readonly finishReason?: 'stop' | 'length';
}

/** A half JSON object, as a provider that stopped at its cap sends it: 56 characters, so 14 tokens on the mock's count. */
const CUT_REPLY = '{"steps": [{"tool": "meta.set", "params": {"targets": ["';

/**
 * A gateway whose planner answers one intent with `replies` in turn (the last repeats), recording each planner request, and whose
 * `modelLimits` reports the given caps: the cap a request is sent with, and the cap the model advertises.
 */
function cutGateway(intent: string, replies: readonly PlannerReply[], seen: ChatRequest[], limits: { readonly maxOutputTokens: number; readonly modelMaxOutputTokens?: number }) {
  return async (): Promise<Gateway> => {
    const base = await mockGateway([
      {
        match: (req) => isPlannerCall(req) && userTextOf(req).includes(`Request: ${intent}`),
        respond: (req) => {
          seen.push(req);
          const calls = req.messages.filter((message) => message.role === 'assistant').length;
          return replies[Math.min(calls, replies.length - 1)] ?? { content: '' };
        },
      },
    ]);
    return {
      ...base,
      modelLimits: (profileId, model, thinking) => {
        const { modelMaxOutputTokens: _drop, ...rest } = base.modelLimits(profileId, model, thinking);
        return { ...rest, ...limits };
      },
    };
  };
}

/** The last user message a request carries: what the model reads before it replies. */
const lastUserOf = (req: ChatRequest | undefined): string => [...(req?.messages ?? [])].reverse().find((message) => message.role === 'user')?.content ?? '';

describe('a planner reply the provider cut (issue #97)', () => {
  const intent = 'Label The Friend act-2.';

  it('a cut reply that does not parse is answered with words that name the cut, not a JSON syntax error, and asked again with more room', async () => {
    const seen: ChatRequest[] = [];
    const run = await checked(
      scenario('cut planner reply: named and retried', intent, [], {
        gateway: cutGateway(intent, [{ content: CUT_REPLY, finishReason: 'length' }, { content: answer('Labelled nothing yet.') }], seen, { maxOutputTokens: 10, modelMaxOutputTokens: 40 }),
        expect: { status: 'replied', maxModelCalls: 2 },
      }),
    );
    expect(seen).toHaveLength(2);
    const words = lastUserOf(seen[1]);
    expect(words).toContain('cut off at the model’s output limit');
    expect(words).toContain('Send a shorter reply');
    expect(words).not.toContain('not valid JSON');
    // The first request went with the profile's cap; the retry asks for twice it, inside the model's advertised cap.
    expect(seen[0]?.maxOutputTokens).toBeUndefined();
    expect(seen[1]?.maxOutputTokens).toBe(20);
    expect(run.report.cutReplies).toBe(1);
  });

  it('a cut reply that parses is planned as it is: a cut is not a failure on its own', async () => {
    const seen: ChatRequest[] = [];
    const run = await checked(
      scenario('cut planner reply: parses', intent, [], {
        gateway: cutGateway(intent, [{ content: answer('Nothing to label.'), finishReason: 'length' }], seen, { maxOutputTokens: 10, modelMaxOutputTokens: 40 }),
        expect: { status: 'replied', maxModelCalls: 1 },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(run.report.text).toBe('Nothing to label.');
    expect(run.report.cutReplies).toBe(1);
  });

  it('the retry’s cap never passes the model’s advertised cap, and is not raised without one', async () => {
    const bounded: ChatRequest[] = [];
    await checked(
      scenario('cut planner reply: bounded cap', intent, [], {
        gateway: cutGateway(intent, [{ content: CUT_REPLY, finishReason: 'length' }, { content: answer('ok') }], bounded, { maxOutputTokens: 10, modelMaxOutputTokens: 15 }),
        expect: { status: 'replied' },
      }),
    );
    expect(bounded[1]?.maxOutputTokens).toBe(15);

    const unknown: ChatRequest[] = [];
    await checked(
      scenario('cut planner reply: no advertised cap', intent, [], {
        gateway: cutGateway(intent, [{ content: CUT_REPLY, finishReason: 'length' }, { content: answer('ok') }], unknown, { maxOutputTokens: 10 }),
        expect: { status: 'replied' },
      }),
    );
    expect(unknown[1]?.maxOutputTokens).toBeUndefined();
    expect(lastUserOf(unknown[1])).toContain('cut off at the model’s output limit');
  });

  it('a reply cut short of its request’s cap is said to be cut, not to have hit the output limit, and keeps its cap', async () => {
    const seen: ChatRequest[] = [];
    await checked(
      scenario('cut planner reply: below the cap', intent, [], {
        gateway: cutGateway(intent, [{ content: CUT_REPLY, finishReason: 'length' }, { content: answer('ok') }], seen, { maxOutputTokens: 4_096, modelMaxOutputTokens: 32_000 }),
        expect: { status: 'replied' },
      }),
    );
    const words = lastUserOf(seen[1]);
    expect(words).toContain('cut off before it ended');
    expect(words).not.toContain('output limit');
    expect(seen[1]?.maxOutputTokens).toBeUndefined();
  });

  it('a second cut ends the turn on an ask-back that names the output limit, not the budget', async () => {
    const seen: ChatRequest[] = [];
    const run = await checked(
      scenario('cut planner reply: cut twice', intent, [], {
        gateway: cutGateway(intent, [{ content: CUT_REPLY, finishReason: 'length' }], seen, { maxOutputTokens: 10, modelMaxOutputTokens: 40 }),
        expect: { status: 'failed', askBack: 'needs_input', summaryIncludes: ['output limit'], maxModelCalls: 2 },
      }),
    );
    expect(seen).toHaveLength(2);
    // The retry was cut short of its raised cap, but it followed a reply that reached the profile's: that is the limit named.
    expect(run.report.askBack?.reason).toContain('output limit (10 tokens)');
    expect(run.report.askBack?.reason).not.toContain('model calls');
    expect(run.report.cutReplies).toBe(2);
  });

  it('a cut with no model call left for the retry ends on the output limit too, and never passes the model-call bound', async () => {
    const seen: ChatRequest[] = [];
    const run = await checked(
      scenario('cut planner reply: no call left', intent, [], {
        gateway: cutGateway(intent, [{ content: CUT_REPLY, finishReason: 'length' }, { content: answer('ok') }], seen, { maxOutputTokens: 10, modelMaxOutputTokens: 40 }),
        modelCallBound: 1,
        expect: { status: 'failed', askBack: 'needs_input', summaryIncludes: ['output limit'], maxModelCalls: 1 },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(run.report.askBack?.reason).not.toContain('model calls');
  });

  it('a malformed reply the provider did not cut still reads as malformed', async () => {
    const seen: ChatRequest[] = [];
    const run = await checked(
      scenario('malformed planner reply', intent, [], {
        gateway: cutGateway(intent, [{ content: CUT_REPLY }, { content: answer('ok') }], seen, { maxOutputTokens: 10, modelMaxOutputTokens: 40 }),
        expect: { status: 'replied' },
      }),
    );
    expect(lastUserOf(seen[1])).toContain('not valid JSON');
    expect(seen[1]?.maxOutputTokens).toBeUndefined();
    expect(run.report.cutReplies).toBeUndefined();
  });
});
