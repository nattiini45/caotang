import { describe, expect, it } from 'vitest';

import { textOf, type ChatRequest, type Gateway } from '@caotang/gateway';
import { isPlannerCall, type MockResponse, type MockScript } from '@caotang/gateway/mock';
import { setBody } from '@caotang/store';

import { PLANNER_SYSTEM_PREFIX, createAgentPorts, createAgentSession, createBudgetMeter, createContextPort, createGoalRunner, createGoalVerifierPort, createMemoryRunLog, type Goal, type GoalCheckpoint, type GoalVerifierPort, type RulesProvider } from '../../src/index.js';
import { mockGateway } from '../agent/gateway.js';
import { answer, steps } from '../agent/scripts.js';
import { checkedHarness, clock, FRIEND, LANDING, makeState, STORM } from '../fixtures.js';

describe.each(['json', 'native'] as const)('independent verification on the %s actor wire', wire => {
  it.each(['denied', 'archived', 'missing'] as const)('refuses goal-derived intent when its target becomes %s during actor setup', async change => {
    const state = makeState();
    const node = state.manifest.tree.find(candidate => candidate.id === LANDING);
    if (node === undefined) throw new Error('missing fixture document');
    node.synopsis = '';
    node.title = 'ACTOR_PRIVATE_TARGET';
    let denied = false;
    let sent = 0;
    const base = await mockGateway([{ match: () => true, respond: () => ({ content: wire === 'json' ? answer('Done.') : 'Done.' }) }]);
    const gateway: Gateway = {
      ...base, ...(wire === 'native' ? { modelCaps: () => ({ tools: true }) } : {}),
      complete: (request, signal, beforeSend) => base.complete(request, signal, () => { beforeSend?.(); sent += 1; }),
    };
    const rules: RulesProvider = () => ({ rules: denied ? [{ effect: 'deny', tool: '*', access: 'read', scope: { subtree: LANDING }, source: 'app' }] : [] });
    const harness = checkedHarness({ state, ports: createAgentPorts(), clock: clock.now, rules });
    const meter = createBudgetMeter({ maxModelCalls: 8 });
    const actor = createAgentSession({ harness, gateway, context: createContextPort({ state, withheld: tool => harness.withheld(tool) }), meter, loadEveryTool: () => true, decide: async () => ({ action: 'approve' }) });
    const scope = { mode: 'doc', docIds: [LANDING] } as const;
    const goal: Goal = { id: 'actor-boundary-goal', intent: 'Clarify the departure.', limits: meter.limits, checks: [{ kind: 'synopsis.filled', scope }, { kind: 'verifier', scope, rubric: 'The departure is clear.', gate: true }] };
    const run = await createGoalRunner().start(goal, {
      state, meter, withheld: () => harness.withheldAnywhere(),
      saveIteration: async () => {}, saveCheckpoint: async () => {},
      session: {
        ...actor,
        submit: async (intent, options) => {
          expect(intent).toContain('ACTOR_PRIVATE_TARGET');
          await Promise.resolve();
          if (change === 'denied') denied = true;
          else if (change === 'archived') node.status = 'archived';
          else state.documents.delete(node.id);
          return actor.submit(intent, options);
        },
      },
    });
    expect(sent).toBe(0);
    expect(run.status).toBe('failed');
    expect(run.iterations[0]?.report.askBack?.code).toBe('needs_input');
    meter.dispose();
  });

  it.each([false, true])('isolates a real Background call and shares durable admission/accounting (gate %s)', async gate => {
    const state = makeState();
    const landing = state.manifest.tree.find(node => node.id === LANDING);
    const archived = state.manifest.tree.find(node => node.id === FRIEND);
    if (landing === undefined || archived === undefined) throw new Error('missing fixture documents');
    landing.synopsis = '';
    archived.status = 'archived';
    setBody(state, STORM, 'WITHHELD_BEFORE_PASSAGE');
    setBody(state, FRIEND, 'ARCHIVED_BEFORE_PASSAGE');
    state.agentFiles = { instructions: { path: 'CAOTANG.md', text: 'ACTOR_ONLY_INSTRUCTIONS' }, index: 'ACTOR_ONLY_MEMORY', memory: [], declined: new Map(), unreadable: [] };
    const requests: ChatRequest[] = [];
    const checkpoints: GoalCheckpoint[] = [];
    let actorCommitted = false;
    let verifierCalls = 0;
    const synopsis = 'The ferry departs at dawn.';
    const call = { tool: 'synopsis.set', params: { doc: LANDING, synopsis } };
    const scripts: MockScript[] = [{
      match: request => request.role === 'background',
      respond: request => {
        verifierCalls += 1;
        expect(actorCommitted).toBe(true);
        expect(checkpoints.at(-1)?.pendingVerification?.phase).toBe('reserved');
        expect(request.messages.map(message => message.role)).toEqual(['system', 'user']);
        expect(request.tools).toBeUndefined();
        expect(request.toolChoice).toBeUndefined();
        expect(request.responseFormat).toBeUndefined();
        const messages = request.messages.map(message => textOf(message.content)).join('\n');
        expect(messages).toContain(synopsis);
        expect(messages).toContain('The synopsis names the departure time.');
        expect(messages).toContain('Give at most 8 reasons');
        for (const forbidden of ['ACTOR_ONLY_', 'WITHHELD_', 'ARCHIVED_', STORM, FRIEND, LANDING]) expect(messages).not.toContain(forbidden);
        return { content: JSON.stringify({ pass: gate, reasons: gate ? [] : ['The departure could be clearer.'] }) };
      },
    }, {
      match: request => request.role !== 'background' && (wire === 'native'
        ? (request.tools?.length ?? 0) > 0 && textOf(request.messages[0]?.content ?? '').startsWith(PLANNER_SYSTEM_PREFIX)
        : isPlannerCall(request)),
      respond: (request): MockResponse => {
        if (request.messages.some(message => message.role === 'assistant')) return { content: wire === 'json' ? answer('ACTOR_ONLY_FINAL_REPLY') : 'ACTOR_ONLY_FINAL_REPLY' };
        return wire === 'json'
          ? { content: steps({ ...call, expect: 'The synopsis is filled.' }), reasoning: 'ACTOR_ONLY_REASONING' }
          : { content: '', toolCalls: [{ id: 'set-synopsis', name: call.tool, argumentsJson: JSON.stringify(call.params) }], reasoning: 'ACTOR_ONLY_REASONING' };
      },
    }];
    const base = await mockGateway(scripts);
    const gateway: Gateway = {
      ...base, ...(wire === 'native' ? { modelCaps: () => ({ tools: true }) } : {}),
      complete: (request, signal, beforeSend) => { requests.push(request); return base.complete(request, signal, beforeSend); },
    };
    const limits = { maxModelCalls: 10 };
    const meter = createBudgetMeter(limits);
    const rules: RulesProvider = () => ({ rules: [{ effect: 'deny', tool: '*', access: 'read', scope: { subtree: STORM }, note: 'The scene is withheld.', source: 'app' }] });
    const harness = checkedHarness({ state, ports: createAgentPorts(), clock: clock.now, rules });
    const context = createContextPort({ state, withheld: tool => harness.withheld(tool) });
    const session = createAgentSession({
      harness, gateway, context, meter, sessionId: 'verified-actor', loadEveryTool: () => true,
      history: [{ turnId: 'older-actor-turn', intent: 'ACTOR_ONLY_CONVERSATION', outcome: 'ACTOR_ONLY_OLD_OUTCOME' }],
      decide: async () => {
        setBody(state, STORM, 'WITHHELD_AFTER_PASSAGE');
        setBody(state, FRIEND, 'ARCHIVED_AFTER_PASSAGE');
        return { action: 'approve' };
      },
      runLog: { projectId: 'verified-project', required: () => true, port: createMemoryRunLog() },
    });
    const profile = gateway.profiles.active();
    if (profile === undefined) throw new Error('missing mock route');
    const port = createGoalVerifierPort({ gateway, context, meter, route: () => ({ profileId: profile.id, model: profile.defaultModel }), sessionId: 'verified-actor', turnId: 'independent-verifier', languages: () => ({ ui: 'en', project: 'en' }), fence: () => undefined });
    const verifier: GoalVerifierPort = (input, save, fence) => {
      expect(input.excerpts).toEqual([{ docId: LANDING, title: landing.title, field: 'synopsis', before: '', after: synopsis, truncated: false }]);
      return port(input, save, fence);
    };
    const goal: Goal = {
      id: 'independent-goal', intent: 'ACTOR_ONLY_INTENT. Write the departure synopsis.', limits,
      checks: [{ kind: 'synopsis.filled', scope: { mode: 'doc', docIds: [LANDING] } }, { kind: 'verifier', rubric: 'The synopsis names the departure time.', scope: { mode: 'full' }, gate }],
    };
    const run = await createGoalRunner().start(goal, {
      session, state, meter, verifier, withheld: () => harness.withheldAnywhere(),
      saveCheckpoint: async checkpoint => { checkpoints.push(structuredClone(checkpoint)); },
      saveIteration: async checkpoint => { actorCommitted = true; checkpoints.push(structuredClone(checkpoint)); },
    });
    expect(run.status, run.reason).toBe('passed');
    expect(verifierCalls).toBe(1);
    expect(run.verification).toMatchObject({ status: 'complete', verdict: { pass: gate } });
    expect(meter.spend().modelCalls).toBe(requests.length);
    expect(meter.spend().modelCalls).toBeGreaterThan(1);
    expect(checkpoints.at(-1)?.spend.modelCalls).toBe(meter.spend().modelCalls);
    expect(requests.some(request => request.role !== 'background' && (request.tools?.length ?? 0) > 0)).toBe(wire === 'native');
    expect(run.results.every(result => result.spec.kind !== ('verifier' as string))).toBe(true);
    meter.dispose();
  });

  it('refuses previous review feedback whose sources change during the next actor setup', async () => {
    const state = makeState();
    const node = state.manifest.tree.find(candidate => candidate.id === LANDING);
    if (node === undefined) throw new Error('missing fixture document');
    node.synopsis = '';
    const call = { tool: 'synopsis.set', params: { doc: LANDING, synopsis: 'The ferry departs at dawn.' }, expect: 'The synopsis is filled.' };
    const base = await mockGateway([{
      match: () => true,
      respond: request => {
        if (request.messages.some(message => message.role === 'assistant')) return { content: wire === 'json' ? answer('Done.') : 'Done.' };
        return wire === 'json' ? { content: steps(call) } : { content: '', toolCalls: [{ id: 'synopsis-call', name: call.tool, argumentsJson: JSON.stringify(call.params) }] };
      },
    }]);
    let sent = 0;
    let beforeSecond = 0;
    let actors = 0;
    let reviews = 0;
    const gateway: Gateway = {
      ...base, ...(wire === 'native' ? { modelCaps: () => ({ tools: true }) } : {}),
      complete: (request, signal, beforeSend) => base.complete(request, signal, () => { beforeSend?.(); sent += 1; }),
    };
    const harness = checkedHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const meter = createBudgetMeter({ maxModelCalls: 20 });
    const actor = createAgentSession({ harness, gateway, context: createContextPort({ state, withheld: tool => harness.withheld(tool) }), meter, loadEveryTool: () => true, decide: async () => ({ action: 'approve' }) });
    const scope = { mode: 'doc', docIds: [LANDING] } as const;
    const run = await createGoalRunner().start({ id: 'feedback-boundary-goal', intent: 'Clarify the departure.', limits: meter.limits, checks: [{ kind: 'synopsis.filled', scope }, { kind: 'verifier', scope, rubric: 'The departure is clear.', gate: true }] }, {
      state, meter, withheld: () => harness.withheldAnywhere(),
      saveIteration: async () => {}, saveCheckpoint: async () => {},
      verifier: async () => { reviews += 1; return { kind: 'complete', content: JSON.stringify({ pass: false, reasons: ['PREVIOUS_PASSAGE_REVIEW_DETAIL'] }) }; },
      session: {
        ...actor,
        submit: async (intent, options) => {
          actors += 1;
          if (actors === 2) {
            expect(intent).toContain('PREVIOUS_PASSAGE_REVIEW_DETAIL');
            beforeSecond = sent;
            await Promise.resolve();
            setBody(state, LANDING, 'A different current passage.');
          }
          return actor.submit(intent, options);
        },
      },
    });
    expect(actors).toBe(2);
    expect(beforeSecond).toBeGreaterThan(0);
    expect(sent).toBe(beforeSecond);
    expect(reviews).toBe(1);
    expect(run.status).toBe('failed');
    expect(run.iterations[1]?.report.askBack?.code).toBe('needs_input');
    meter.dispose();
  });
});
