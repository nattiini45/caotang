/**
 * The wire protocol: a reply is one of two shapes, a malformed reply is answered with the shape it
 * should have had, a step's keys are closed, and the two system-message prefixes the harness sends
 * are the ones the gateway's mock scripts match on.
 */

import { describe, expect, it } from 'vitest';

import * as mock from '@caotang/gateway/mock';

import { createAgentPorts, DRAFT_SYSTEM_PREFIX, PLANNER_SYSTEM_PREFIX, SUBAGENT_SYSTEM_PREFIX, parseReply, plannerSystem, REPLY_SCHEMA_HINT } from '../../src/index.js';
import { errorSummary, refusalSentence } from '../../src/agent/protocol.js';
import { PLAN_STEPS_MAX } from '../../src/plan.js';
import { checkedHarness, makeState } from '../fixtures.js';

describe('parseReply: the two reply shapes', () => {
  it('reads a list of steps as a plan, with each step’s tool, params and expectation', () => {
    const parsed = parseReply('{"steps":[{"tool":"meta.set","params":{"targets":["x"],"label":"act-2"},"expect":"labelled"}]}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.kind !== 'steps') throw new Error('expected steps');
    expect(parsed.value.plan.steps).toEqual([{ tool: 'meta.set', params: { targets: ['x'], label: 'act-2' }, expect: 'labelled' }]);
  });

  it('reads a reply with no tool call as an answer', () => {
    expect(parseReply('{"reply":"Chapter 1 has two scenes."}')).toEqual({ ok: true, value: { kind: 'reply', text: 'Chapter 1 has two scenes.' } });
  });

  it('accepts a reply wrapped in a code fence, which some models add', () => {
    const parsed = parseReply('```json\n{"reply":"ok"}\n```');
    expect(parsed).toEqual({ ok: true, value: { kind: 'reply', text: 'ok' } });
  });

  it('unwraps fences the way the old pattern did, whatever whitespace sits around the body', () => {
    const reply = { ok: true, value: { kind: 'reply', text: 'ok' } };
    expect(parseReply('```{"reply":"ok"}```')).toEqual(reply);
    expect(parseReply('```json{"reply":"ok"}```')).toEqual(reply);
    expect(parseReply('  ```json \r\n {"reply":"ok"} \r\n ```  ')).toEqual(reply);
    const odd = String.fromCharCode(0xa0, 0x2028);
    expect(parseReply(`${'`'.repeat(3)}${odd}{"reply":"ok"}${odd}${'`'.repeat(3)}`)).toEqual(reply);
  });

  it('leaves what is not a whole fence as it is', () => {
    for (const content of ['', '   ', '``````', '```json```', '`````', '```{"reply":"ok"}', '{"reply":"ok"}```']) {
      const parsed = parseReply(content);
      expect(parsed.ok).toBe(false);
    }
  });

  it('reads a long run of blanks after an opening fence in linear time', () => {
    const started = performance.now();
    const parsed = parseReply('```' + ' '.repeat(50_000) + 'x');
    expect(parsed.ok).toBe(false);
    expect(parseReply('```json' + ' '.repeat(50_000) + '{"reply":"ok"}' + ' '.repeat(50_000) + '```').ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('parseReply: refusals name the shape the reply should have had', () => {
  it('refuses prose, with the shape the model must use', () => {
    const parsed = parseReply('Sure, I will do that.');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('not valid JSON');
  });

  it('refuses a JSON value that is not an object', () => {
    const parsed = parseReply('[1,2,3]');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('not a JSON object');
  });

  it('refuses an object with neither key', () => {
    const parsed = parseReply('{"answer":"no"}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('neither "steps" nor "reply"');
  });

  it('refuses an empty step list and a step with a key the schema does not declare', () => {
    expect(parseReply('{"steps":[]}').ok).toBe(false);
    const extra = parseReply('{"steps":[{"tool":"meta.set","params":{},"expect":"x","proposal":"injected"}]}');
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error).toContain('refused');
  });

  it('refuses a blank reply', () => {
    expect(parseReply('{"reply":"   "}').ok).toBe(false);
  });

  it('refuses a step list over the plan bound, and the schema hint sent with the request declares the same bound', () => {
    const steps = Array.from({ length: PLAN_STEPS_MAX + 1 }, () => ({ tool: 'meta.set', params: { targets: ['x'], label: 'act-2' }, expect: 'labelled' }));
    const parsed = parseReply(JSON.stringify({ steps }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(`at most ${PLAN_STEPS_MAX}`);
    // The hint the model reads states the cap too, so a reply aiming at its own schema never trips it.
    const hint = REPLY_SCHEMA_HINT.oneOf[0];
    expect(hint.properties.steps.maxItems).toBe(PLAN_STEPS_MAX);
  });
});

describe('the planner’s system message', () => {
  it('lists the tools this build can call, with their risk and their schema, and never agent.plan', () => {
    const harness = checkedHarness({ state: makeState(), ports: createAgentPorts() });
    const system = plannerSystem(harness.tools());
    expect(system.startsWith(PLANNER_SYSTEM_PREFIX)).toBe(true);
    expect(system).toContain('scene.draft [write-confirm]');
    expect(system).toContain('codex.read [read]');
    expect(system).toContain('"properties"');
    expect(system).not.toContain('- agent.plan');
  });

  it('lists a port tool only when its implementation is injected', () => {
    const bare = checkedHarness({ state: makeState() });
    expect(plannerSystem(bare.tools())).not.toContain('- scene.draft');
    expect(plannerSystem(checkedHarness({ state: makeState(), ports: createAgentPorts() }).tools())).toContain('- scene.draft');
  });
});

describe('the prefixes the gateway’s mock scripts match on', () => {
  it('are the same strings the harness sends, so a demo script answers the harness’s own calls', () => {
    expect(mock.PLANNER_PREFIX).toBe(PLANNER_SYSTEM_PREFIX);
    expect(mock.DRAFT_PREFIX).toBe(DRAFT_SYSTEM_PREFIX);
    expect(mock.SUBAGENT_PREFIX).toBe(SUBAGENT_SYSTEM_PREFIX);
  });
});

describe('a refusal, as the card and the model read it (agent-harness §2, §7)', () => {
  it('opens the message as a sentence, ends it with a full stop, and starts the hint as its own sentence', () => {
    expect(refusalSentence('mode draft needs an empty document, so nothing was written', 'set mode to continue to add to the end')).toBe(
      'Mode draft needs an empty document, so nothing was written. Set mode to continue to add to the end',
    );
  });

  it('does not add a second full stop to a message that already ends one, and leaves a message or hint that opens with a name as written', () => {
    expect(refusalSentence('the step is refused.', 'binder.rename accepts only: nodeId, title')).toBe('The step is refused. binder.rename accepts only: nodeId, title');
    expect(refusalSentence('the step is refused', undefined)).toBe('The step is refused');
    expect(refusalSentence('rewrite_selection needs a selection', 'select text first')).toBe('rewrite_selection needs a selection. Select text first');
  });

  it('is what the card shows for a refused step, so the two sentences read apart', () => {
    const error = { code: 'invalid-params' as const, message: 'mode draft needs an empty document, so nothing was written', correctiveHint: 'set mode to continue to add to the end, or select a passage to rewrite it' };
    expect(errorSummary(error)).toBe('Mode draft needs an empty document, so nothing was written. Set mode to continue to add to the end, or select a passage to rewrite it');
  });
});
