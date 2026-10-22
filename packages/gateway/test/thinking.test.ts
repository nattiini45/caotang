/**
 * A thinking level through the whole gateway (provider-gateway §3): the body a Claude 5.x profile sends, the output cap a
 * budget route is raised to, the request log line that records it, and the thinking a cost estimate adds.
 */

import { describe, expect, it } from 'vitest';

import { PRESETS } from '../src/index.js';
import { addEndpoint, collect, harness, ScriptedFetch, sseResponse } from './helpers.js';

const stop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
const messageStop = [
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const hi = { messages: [{ role: 'user' as const, content: 'hi' }] };

async function anthropic(h: ReturnType<typeof harness>, model = 'claude-sonnet-5-5', overrides = {}) {
  return addEndpoint(h, { preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: model, ...overrides });
}

async function qwen(h: ReturnType<typeof harness>, overrides = {}) {
  return addEndpoint(h, {
    preset: 'alibaba',
    fields: { workspaceId: 'ws', region: 'ap-southeast-1' },
    baseUrl: 'https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.7-plus',
    ...overrides,
  });
}

describe('an Anthropic profile with a thinking level', () => {
  it('sends adaptive thinking and the effort, never a budget, on every level of every Claude 5 row', async () => {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) {
      const net = new ScriptedFetch();
      const h = harness({ net });
      await anthropic(h, model);
      const levels = (h.gateway.modelCaps(undefined, model).effortLevels ?? []).filter((level) => level !== 'off');
      expect(levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      for (const thinking of levels) {
        net.push(() => sseResponse(messageStop));
        await collect(h.gateway.complete({ ...hi, thinking }));
        const body = net.bodyOf(net.calls.length - 1);
        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body.output_config).toEqual({ effort: thinking });
        expect(JSON.stringify(body)).not.toContain('budget_tokens');
        expect(body).not.toHaveProperty('temperature');
        expect(body.max_tokens).toBe(4_096);
      }
    }
  });

  it('sends Off on Haiku 5.5, the one Claude row that lists it', async () => {
    const net = new ScriptedFetch().push(() => sseResponse(messageStop));
    const h = harness({ net });
    await anthropic(h, 'claude-haiku-5-5');
    await collect(h.gateway.complete({ ...hi, thinking: 'off' }));
    expect(net.bodyOf(0).thinking).toEqual({ type: 'disabled' });
  });

  it('sends nothing on the rows that cannot turn thinking off', async () => {
    const net = new ScriptedFetch().push(() => sseResponse(messageStop));
    const h = harness({ net });
    await anthropic(h, 'claude-opus-5-5');
    await collect(h.gateway.complete({ ...hi, thinking: 'off' }));
    expect(net.bodyOf(0)).not.toHaveProperty('thinking');
  });

  it('maps a reasoningBudget to the nearest listed level', async () => {
    const net = new ScriptedFetch().push(() => sseResponse(messageStop));
    const h = harness({ net });
    await anthropic(h);
    await collect(h.gateway.complete({ ...hi, reasoningBudget: 25_000 }));
    expect(net.bodyOf(0)).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' }, max_tokens: 4_096 });
  });

  it('lists off only on Haiku 5.5, and xhigh between high and max on all four rows', () => {
    const anthropicPreset = PRESETS.find((preset) => preset.id === 'anthropic');
    const rows = (anthropicPreset?.models ?? []).filter((row) => row.pattern.startsWith('claude-'));
    expect(rows.map((row) => row.pattern)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
    for (const row of rows) {
      const levels = row.caps.effortLevels ?? [];
      expect(levels.filter((level) => level !== 'off')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(levels.includes('off')).toBe(row.pattern === 'claude-haiku-5-5');
      expect(row.caps.thinkingShape).toBe('adaptive');
    }
  });
});

describe('a budget route', () => {
  it('raises max_tokens above thinking_budget and records the cap sent on the request log line', async () => {
    const net = new ScriptedFetch().push(() => sseResponse([stop, '[DONE]']));
    const h = harness({ net });
    await qwen(h);
    await collect(h.gateway.complete({ ...hi, thinking: 'max' }));
    const body = net.bodyOf(0);
    expect(body).toMatchObject({ enable_thinking: true, thinking_budget: 32_768, max_tokens: 36_864 });
    expect(h.gateway.requestLog.entries().at(-1)).toMatchObject({ outcome: 'ok', maxTokens: 36_864 });
  });

  it('keeps the profile’s own cap as the answer’s room', async () => {
    const net = new ScriptedFetch().push(() => sseResponse([stop, '[DONE]']));
    const h = harness({ net });
    await qwen(h, { maxOutputTokens: 1_000 });
    await collect(h.gateway.complete({ ...hi, thinking: 'low' }));
    expect(net.bodyOf(0)).toMatchObject({ thinking_budget: 1_024, max_tokens: 2_024 });
  });

  it('records the plain cap when no thinking is asked for', async () => {
    const net = new ScriptedFetch().push(() => sseResponse([stop, '[DONE]']));
    const h = harness({ net });
    await qwen(h);
    await collect(h.gateway.complete(hi));
    expect(net.bodyOf(0).max_tokens).toBe(4_096);
    expect(h.gateway.requestLog.entries().at(-1)?.maxTokens).toBe(4_096);
  });
});

describe('modelLimits with a thinking level', () => {
  it('adds the level’s nominal share on an adaptive row, and nothing without a level', async () => {
    const h = harness();
    const profile = await anthropic(h);
    expect(h.gateway.modelLimits(profile.id)).not.toHaveProperty('thinkingTokens');
    expect(h.gateway.modelLimits(profile.id, undefined, 'high').thinkingTokens).toBe(16_384);
    expect(h.gateway.modelLimits(profile.id, undefined, 'xhigh').thinkingTokens).toBe(24_576);
  });

  it('adds the effective budget on a budget route, and nothing for off or a level the row does not list', async () => {
    const h = harness();
    const profile = await qwen(h);
    expect(h.gateway.modelLimits(profile.id, undefined, 'max').thinkingTokens).toBe(32_768);
    expect(h.gateway.modelLimits(profile.id, undefined, 'off')).not.toHaveProperty('thinkingTokens');
    expect(h.gateway.modelLimits(profile.id, undefined, 'xhigh')).not.toHaveProperty('thinkingTokens');
  });

  it('adds nothing for a profile whose model has no capability row', async () => {
    const h = harness();
    const profile = await addEndpoint(h);
    expect(h.gateway.modelLimits(profile.id, undefined, 'high')).not.toHaveProperty('thinkingTokens');
  });
});
