import { describe, expect, it } from 'vitest';
import { textOf, type ChatRequest, type Gateway } from '@caotang/gateway';

import { createAgentPorts, createAgentSession, createBudgetMeter, createContextPort, createMemoryRunLog, type RuleSet } from '../../src/index.js';
import { FRIEND, LANDING, makeHarness } from '../fixtures.js';
import { mockGateway } from './gateway.js';

const summaryReply = JSON.stringify({ standingRequests: 'Keep the ferry.', decisions: 'Use the island.', done: 'Read the opening.', openThreads: 'Find the letter.' });
const history = Array.from({ length: 7 }, (_, index) => ({ turnId: `boundary.turn-${index + 1}`, intent: `Request ${index + 1}`, outcome: `Earlier restricted answer ${index + 1}` }));
const summary = { version: 1 as const, covers: { from: 'boundary.turn-1', to: 'boundary.turn-5', turns: 5 }, text: 'Earlier restricted summary.', origin: 'auto' as const, external: false };
const deny: RuleSet = { rules: [{ source: 'app', tool: 'doc.read', effect: 'deny', access: 'read', scope: { subtree: FRIEND } }] };

describe('the provider request read boundary', () => {
  for (const native of [false, true]) {
    it.each(['planner', 'auto', 'manual'] as const)('refuses a %s request if read rules change during its pre-request storage sync (native: ' + native + ')', async (kind) => {
      let rules: RuleSet = { rules: [] };
      const harness = makeHarness({ rules: () => rules });
      const log = createMemoryRunLog();
      const requests: ChatRequest[] = [];
      const real = await mockGateway([{ match: () => true, respond: (request) => ({ content: request.role === 'background' ? summaryReply : native ? 'Noted.' : '{"reply":"Noted."}' }) }]);
      const gateway: Gateway = { ...real, modelCaps: () => ({ tools: native }), complete: (request, signal) => { requests.push(request); return real.complete(request, signal); } };
      let release = (): void => {};
      let stored = (): void => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { stored = resolve; });
      let waiting = false;
      const meter = createBudgetMeter({ maxModelCalls: 5, maxTokens: 100_000 });
      const session = createAgentSession({
        harness, gateway, history, ...(kind === 'auto' ? {} : { summary }), role: 'chat', sessionId: 'boundary', meter,
        decide: async () => ({ action: 'cancel' }),
        runLog: { projectId: 'project', port: { ...log, append: async (id, events, patch) => {
          await log.append(id, events, patch);
          if (!waiting && events.some((event) => event.t === 'spend' && event.reservedCalls === 1)) {
            waiting = true;
            stored();
            await held;
          }
        } } },
      });
      try {
        const pending = kind === 'manual'
          ? session.compact().then(() => undefined, (error: unknown) => error)
          : session.submit('Continue.');
        await ready;
        expect(requests).toEqual([]);
        rules = deny;
        release();
        await pending;

        const report = session.reports().at(-1)!;
        expect(report).toMatchObject({ status: 'failed', modelCalls: 0, tokens: { requests: 0 }, askBack: { code: 'needs_input' } });
        expect(report.askBack?.reason).toContain('read boundary');
        expect(report.readPolicy).toBeUndefined();
        expect(report.compactions).toBeUndefined();
        expect(requests).toEqual([]);
        expect(gateway.ledger.turnRows()).toEqual([]);
        expect(meter.spend()).toMatchObject({ modelCalls: 0, promptTokens: 0, completionTokens: 0 });
        expect(session.summary()).toEqual(kind === 'auto' ? undefined : summary);

        if (kind === 'planner') {
          expect((await session.submit('Try again under the current read rules.')).status).toBe('replied');
          expect(requests).toHaveLength(1);
          const sent = requests[0]!.messages.map((message) => textOf(message.content)).join('\n');
          expect(sent).not.toContain('Earlier restricted');
        }
      } finally {
        release();
        meter.dispose();
      }
    });

    it('does not resend a tool result after the read boundary changes before the next planner request (native: ' + native + ')', async () => {
      let rules: RuleSet = { rules: [] };
      const log = createMemoryRunLog();
      const requests: ChatRequest[] = [];
      const real = await mockGateway([{ match: () => true, respond: () => requests.length === 1
        ? native
          ? { content: '', toolCalls: [{ id: 'read', name: 'doc.read', argumentsJson: JSON.stringify({ doc: LANDING }) }], finishReason: 'tool_calls' }
          : { content: JSON.stringify({ steps: [{ tool: 'doc.read', params: { doc: LANDING }, expect: 'The opening is read.' }] }) }
        : { content: native ? 'Noted.' : '{"reply":"Noted."}' },
      }]);
      const gateway: Gateway = { ...real, modelCaps: () => ({ tools: native }), complete: (request, signal) => { requests.push(request); return real.complete(request, signal); } };
      const session = createAgentSession({
        harness: makeHarness({ rules: () => rules }), gateway, role: 'chat', decide: async () => ({ action: 'cancel' }),
        runLog: { projectId: 'project', port: { ...log, append: async (id, events, patch) => {
          await log.append(id, events, patch);
          if (requests.length === 1 && events.some((event) => event.t === 'spend' && event.reservedCalls === 1)) rules = deny;
        } } },
      });

      const report = await session.submit('Read the opening.');

      expect(report).toMatchObject({ status: 'failed', modelCalls: 1, tokens: { requests: 1 }, askBack: { code: 'needs_input' } });
      expect(report.askBack?.reason).toContain('read boundary');
      expect(requests).toHaveLength(1);
      expect(report.steps).toContainEqual(expect.objectContaining({ tool: 'doc.read', status: 'done' }));
    });

    it('checks delegated requests against the live boundary after their own context assembly (native: ' + native + ')', async () => {
      let rules: RuleSet = { rules: [] };
      const harness = makeHarness({ ports: createAgentPorts(), rules: () => rules });
      const port = createContextPort({ state: harness.state });
      const requests: ChatRequest[] = [];
      const params = { agent: 'reader', brief: 'Read the opening.', scope: [LANDING] };
      const real = await mockGateway([{ match: () => true, respond: () => native
        ? { content: '', toolCalls: [{ id: 'delegate', name: 'agent.delegate', argumentsJson: JSON.stringify(params) }], finishReason: 'tool_calls' }
        : { content: JSON.stringify({ steps: [{ tool: 'agent.delegate', params, expect: 'The opening is read.' }] }) },
      }]);
      let assembledDelegate = false;
      const gateway: Gateway = { ...real, modelCaps: () => ({ tools: native }), complete: (request, signal) => { requests.push(request); return real.complete(request, signal); } };
      const session = createAgentSession({
        harness, gateway, maxModelCalls: 6, role: 'chat', decide: async () => ({ action: 'cancel' }),
        context: { assemble: (request) => {
          const call = port.assemble(request);
          if (request.task.tool === 'delegate') {
            assembledDelegate = true;
            rules = deny;
          }
          return call;
        } },
      });

      const report = await session.submit('Read the opening with the reader.', { preload: ['agent.delegate'] });

      expect(assembledDelegate).toBe(true);
      expect(report).toMatchObject({ status: 'failed', tokens: { requests: 1 }, askBack: { code: 'needs_input' } });
      expect(report.askBack?.reason).toContain('read boundary');
      expect(requests).toHaveLength(1);
      expect(gateway.ledger.turnRows().some((row) => row.agentPath !== undefined)).toBe(false);
    });
  }
});
