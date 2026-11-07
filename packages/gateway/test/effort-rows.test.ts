/**
 * Each preset row offers only the thinking levels its provider documents, and sends each under the value the provider takes
 * (effort audit and DeepSeek live audit, 2026-11-07): max and xhigh under their own names, Off as the route's own off, and
 * `thinking.type` as 'enabled' everywhere but MiniMax's 'adaptive'.
 */

import { describe, expect, it } from 'vitest';
import { applyEffort, effortWireValue } from '../src/adapters/effort.js';
import { modelRowFor, presetFor, resolveRoute } from '../src/index.js';
import type { ThinkingLevel } from '../src/types.js';

const caps = (preset: string, model: string) => resolveRoute({ preset, baseUrl: 'https://example.test/v1' }, model).caps;

/** The effort fields a level writes on a row. */
function sent(preset: string, model: string, level: ThinkingLevel): Record<string, unknown> {
  const c = caps(preset, model);
  const body: Record<string, unknown> = {};
  applyEffort(body, c.effortStyle, level, c);
  return body;
}

const ROWS: readonly (readonly [string, string, readonly ThinkingLevel[]])[] = [
  ['deepseek', 'deepseek-flash', ['off', 'low', 'high', 'max']],
  ['deepseek', 'deepseek-v4-pro', ['off', 'low', 'high', 'max']],
  ['deepseek', 'deepseek-v4-flash', ['off', 'low', 'high', 'max']],
  ['deepseek', 'deepseek-v4-flash-vision-exp', ['off', 'low', 'high', 'max']],
  ['xai', 'grok-4.7', ['low', 'medium', 'high', 'xhigh']],
  ['xai', 'grok-4.5', ['low', 'medium', 'high']],
  ['xai', 'grok-4.3', ['off', 'low', 'medium', 'high']],
  ['muse', 'muse-spark-1.3', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['muse', 'muse-spark-1.2', ['low', 'medium', 'high', 'xhigh']],
  ['mistral', 'mistral-large-4-0', ['low', 'medium', 'high']],
  ['mistral', 'zai-glm-5-3', ['low', 'high', 'max']],
  ['alibaba', 'qwen3.7-plus', ['off', 'low', 'medium', 'high', 'max']],
  ['alibaba', 'qwen3.8-max', ['off', 'low', 'medium', 'xhigh']],
  ['tencent-hunyuan', 'hy3', ['off', 'low', 'high']],
  ['tencent-hunyuan', 'hy4-preview', ['off', 'high']],
  ['moonshot', 'kimi-k2.6', ['off', 'high']],
  ['zhipu-zai', 'glm-5.2', ['off', 'high', 'max']],
  ['zhipu-zai', 'glm-4.7', ['off', 'high']],
  ['minimax', 'MiniMax-M3.1-Flash-Preview', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['xiaomi-mimo', 'mimo-v2.6-pro', ['off', 'high']],
  ['nanogpt', 'anthropic/claude-opus-5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['openrouter', 'openai/gpt-6-sol', ['off', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['openrouter', 'deepseek/deepseek-v4.1-flash', ['off', 'low', 'high', 'max']],
  ['opencode', 'kimi-k3', ['off', 'low', 'high', 'max']],
  ['opencode', 'gpt-6-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['opencode', 'claude-haiku-5-5', ['off', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['together', 'MiniMaxAI/MiniMax-M3', ['off', 'high']],
  ['fireworks', 'accounts/fireworks/models/kimi-k3', ['off', 'low', 'high', 'max']],
  ['fireworks', 'accounts/fireworks/models/minimax-m3', ['off', 'high']],
];

describe('per-row effort levels', () => {
  it.each(ROWS)('%s %s offers the documented levels', (preset, model, levels) => {
    expect(caps(preset, model).effortLevels).toEqual(levels);
  });
});

describe('wire values', () => {
  it('sends max and xhigh under their own names', () => {
    expect(sent('deepseek', 'deepseek-v4-pro', 'max')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'max' });
    expect(sent('zhipu-zai', 'glm-5.3', 'max')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'max' });
    expect(sent('moonshot', 'kimi-k3', 'max')).toEqual({ reasoning_effort: 'max' });
    expect(sent('xai', 'grok-4.7', 'xhigh')).toEqual({ reasoning: { effort: 'xhigh' } });
    expect(sent('openrouter', 'anthropic/claude-opus-5.5', 'max')).toEqual({ reasoning: { effort: 'max' } });
    expect(sent('alibaba', 'qwen3.8-max', 'xhigh')).toEqual({ reasoning_effort: 'xhigh' });
  });

  it('sends Off as the route’s own off', () => {
    expect(sent('deepseek', 'deepseek-flash', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(sent('alibaba', 'qwen3.8-max', 'off')).toEqual({ reasoning_effort: 'none' });
    expect(sent('xai', 'grok-4.3', 'off')).toEqual({ reasoning: { effort: 'none' } });
    expect(sent('together', 'Qwen/Qwen3.5-9B', 'off')).toEqual({ reasoning: { enabled: false } });
  });

  it('sends thinking.type enabled, and adaptive only where the row names it', () => {
    for (const [preset, model] of [['moonshot', 'kimi-k2.6'], ['zhipu-zai', 'glm-5.1'], ['zhipu-zai', 'glm-4.6'], ['xiaomi-mimo', 'mimo-v2.6-flash']] as const) {
      expect(sent(preset, model, 'high')).toEqual({ thinking: { type: 'enabled' } });
    }
    expect(sent('minimax', 'MiniMax-M3', 'high')).toEqual({ thinking: { type: 'adaptive' } });
    expect(sent('minimax', 'MiniMax-M3', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(sent('fireworks', 'accounts/fireworks/models/minimax-m3', 'high')).toEqual({ reasoning_effort: 'adaptive' });
  });

  it('names what the body carries for every level of every row', () => {
    for (const [preset, model, levels] of ROWS) {
      const c = caps(preset, model);
      for (const level of levels) {
        const value = effortWireValue(level, c);
        const body = JSON.stringify(sent(preset, model, level));
        // Messages-route rows write their pair in the Anthropic adapter, not here.
        if (c.effortStyle !== 'anthropic') expect(body, `${preset} ${model} ${level}`).toContain(value);
      }
    }
  });
});

describe('DeepSeek rows', () => {
  const row = (model: string) => modelRowFor(presetFor('deepseek')!, model)!;

  it('carry peak prices, automatic caching and the documented limits', () => {
    expect(row('deepseek-flash')).toMatchObject({ pricePer1k: { prompt: 0.0003, completion: 0.0012 }, caps: { cache: 'automatic', cacheReadMultiplier: 0.02, vision: true } });
    expect(row('deepseek-v4-pro')).toMatchObject({ pricePer1k: { prompt: 0.00132, completion: 0.00396 }, caps: { cache: 'automatic', cacheReadMultiplier: 0.0333 } });
    expect(row('deepseek-v4-pro').caps.vision).toBeUndefined();
    for (const model of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      expect(row(model)).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 393_216 });
      expect(row(model).caps.denylist).toEqual(['presence_penalty', 'frequency_penalty']);
      expect(row(model).caps.toolStrict).toBeUndefined();
    }
  });
});
