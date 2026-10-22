/**
 * The thinking/effort mapper: `effectiveOutput` settles the output cap and the thinking that fits under it
 * once per call, `levelForBudget` maps a token budget to a listed level, and `applyEffort` writes the
 * level (or the settled budget) in each style's wire shape.
 */

import { describe, expect, it } from 'vitest';
import { applyEffort, effectiveOutput, levelForBudget, nominalThinkingTokens } from '../src/adapters/effort.js';
import type { EffortStyle } from '../src/adapters/types.js';
import { anthropicMessagesAdapter } from '../src/adapters/anthropic-messages.js';
import { openaiChatAdapter } from '../src/adapters/openai-chat.js';
import type { ModelCaps, ThinkingLevel } from '../src/types.js';
import { bodyInput } from './helpers.js';

const ALL: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const ON = ALL.filter((l) => l !== 'off');
const CAPS = [256, 1_000, 4_096, 8_192, 32_000, 64_000, 100_000, 128_000];

const budgetRow: ModelCaps = { effortStyle: 'anthropic', thinkingShape: 'budget', effortLevels: ALL };
const qwenRow: ModelCaps = { effortStyle: 'enable_thinking+budget', effortLevels: ALL };

describe('effectiveOutput on a budget route', () => {
  for (const [name, caps] of [['anthropic budget shape', budgetRow], ['enable_thinking+budget', qwenRow]] as const) {
    for (const ceiling of [undefined, 128_000, 16_000, 4_096]) {
      it(`${name}: max_tokens stays above the budget for every level and cap (model ceiling ${ceiling ?? 'none'})`, () => {
        for (const level of ON) {
          for (const cap of CAPS) {
            const out = effectiveOutput({ cap, level, caps, ...(ceiling === undefined ? {} : { modelMaxOutput: ceiling }) });
            expect(out.maxTokens).toBeGreaterThanOrEqual(cap);
            if (out.budget === undefined) {
              // Thinking was left off only because even the smallest budget did not fit.
              expect(out.level).toBeUndefined();
              expect(out.maxTokens).toBe(cap);
            } else {
              expect(out.budget).toBeGreaterThanOrEqual(1_024);
              expect(out.budget).toBeLessThan(out.maxTokens);
              expect(out.level).toBe(level);
              if (ceiling !== undefined && ceiling >= cap) expect(out.maxTokens).toBeLessThanOrEqual(ceiling);
            }
          }
        }
      });
    }
  }

  it('raises the cap to the budget plus the caller’s own cap', () => {
    expect(effectiveOutput({ cap: 4_096, level: 'max', caps: qwenRow })).toEqual({ maxTokens: 36_864, level: 'max', budget: 32_768 });
    expect(effectiveOutput({ cap: 256, level: 'low', caps: budgetRow })).toEqual({ maxTokens: 1_280, level: 'low', budget: 1_024 });
  });

  it('holds the raised cap to the model’s ceiling and lowers the budget rather than 400', () => {
    // 100k answer room + 32k budget would be 132k; the ceiling is 128k and the budget still fits beside half of it.
    expect(effectiveOutput({ cap: 100_000, level: 'max', caps: budgetRow, modelMaxOutput: 128_000 })).toEqual({
      maxTokens: 128_000,
      level: 'max',
      budget: 32_768,
    });
    // A cap the ceiling already meets leaves room only by lowering the budget.
    expect(effectiveOutput({ cap: 4_096, level: 'max', caps: budgetRow, modelMaxOutput: 4_096 })).toEqual({
      maxTokens: 4_096,
      level: 'max',
      budget: 2_048,
    });
  });

  it('leaves thinking off when even the smallest budget does not fit', () => {
    expect(effectiveOutput({ cap: 512, level: 'low', caps: budgetRow, modelMaxOutput: 1_024 })).toEqual({ maxTokens: 512 });
  });

  it('leaves a zero cap (send none) as it is', () => {
    expect(effectiveOutput({ cap: 0, level: 'low', caps: qwenRow })).toEqual({ maxTokens: 0, level: 'low', budget: 1_024 });
  });

  it('sends a reasoningBudget in place of the level’s nominal one, floored at the minimum', () => {
    expect(effectiveOutput({ cap: 4_096, level: 'high', budget: 8_000, caps: qwenRow })).toEqual({ maxTokens: 12_096, level: 'high', budget: 8_000 });
    expect(effectiveOutput({ cap: 4_096, level: 'high', budget: 100, caps: qwenRow })).toMatchObject({ budget: 1_024 });
  });
});

describe('effectiveOutput elsewhere', () => {
  const adaptive: ModelCaps = { effortStyle: 'anthropic', thinkingShape: 'adaptive', effortLevels: ALL };

  it('keeps the cap and sends no budget on an adaptive row or an effort-only style', () => {
    expect(effectiveOutput({ cap: 4_096, level: 'max', caps: adaptive })).toEqual({ maxTokens: 4_096, level: 'max' });
    expect(effectiveOutput({ cap: 4_096, level: 'max', caps: { effortStyle: 'reasoning_effort', effortLevels: ALL } })).toEqual({
      maxTokens: 4_096,
      level: 'max',
    });
  });

  it('drops a level the row does not list, and never raises the cap for it', () => {
    expect(effectiveOutput({ cap: 4_096, level: 'xhigh', caps: { ...qwenRow, effortLevels: ['low', 'medium', 'high', 'max'] } })).toEqual({ maxTokens: 4_096 });
    expect(effectiveOutput({ cap: 4_096, level: 'low', caps: {} })).toEqual({ maxTokens: 4_096 });
  });

  it('answers off as off only where the row lists it, and ignores a budget beside it', () => {
    expect(effectiveOutput({ cap: 4_096, level: 'off', budget: 8_000, caps: qwenRow })).toEqual({ maxTokens: 4_096, level: 'off' });
    expect(effectiveOutput({ cap: 4_096, level: 'off', budget: 8_000, caps: { ...qwenRow, effortLevels: ['low'] } })).toEqual({ maxTokens: 4_096 });
  });

  it('ignores a budget that is not a positive number', () => {
    for (const budget of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveOutput({ cap: 4_096, budget, caps: qwenRow })).toEqual({ maxTokens: 4_096 });
    }
  });

  it('takes the style a route supplies when the row names none', () => {
    const bare: ModelCaps = { effortLevels: ['low'] };
    expect(effectiveOutput({ cap: 4_096, level: 'low', caps: bare })).toEqual({ maxTokens: 4_096, level: 'low' });
    expect(effectiveOutput({ cap: 4_096, level: 'low', caps: bare, style: 'anthropic' })).toMatchObject({ budget: 1_024 });
  });
});

describe('levelForBudget', () => {
  it.each([
    [1, 'low'],
    [1_024, 'low'],
    [2_560, 'low'],
    [2_561, 'medium'],
    [4_096, 'medium'],
    [10_240, 'medium'],
    [10_241, 'high'],
    [16_384, 'high'],
    [20_480, 'high'],
    [20_481, 'xhigh'],
    [24_576, 'xhigh'],
    [28_672, 'xhigh'],
    [28_673, 'max'],
    [1_000_000, 'max'],
  ] as const)('maps %i tokens to %s when every level is listed', (budget, expected) => {
    expect(levelForBudget(budget, ALL)).toBe(expected);
  });

  it('maps to the nearest listed level, never to off or an unlisted level', () => {
    const levels: ThinkingLevel[] = ['off', 'low', 'high', 'max'];
    expect(levelForBudget(4_096, levels)).toBe('low');
    expect(levelForBudget(10_000, levels)).toBe('high');
    expect(levelForBudget(24_576, levels)).toBe('high');
    expect(levelForBudget(28_000, levels)).toBe('max');
    expect(levelForBudget(5_000, ['off'])).toBeUndefined();
    expect(levelForBudget(5_000, [])).toBeUndefined();
  });

  it('does not depend on the order the row lists its levels in', () => {
    expect(levelForBudget(10_000, ['max', 'low', 'high'])).toBe(levelForBudget(10_000, ['low', 'high', 'max']));
  });
});

describe('nominalThinkingTokens', () => {
  it('is strictly increasing across the on-levels and zero for off', () => {
    const tokens = ON.map(nominalThinkingTokens);
    expect([...tokens].sort((a, b) => a - b)).toEqual(tokens);
    expect(new Set(tokens).size).toBe(ON.length);
    expect(nominalThinkingTokens('off')).toBe(0);
  });
});

describe('applyEffort per style and xhigh', () => {
  const written = (style: EffortStyle, level: ThinkingLevel, caps: ModelCaps = {}, budget?: number): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    applyEffort(body, style, level, { effortLevels: ALL, ...caps }, budget);
    return body;
  };

  it('maps xhigh to high where the style tops out at high', () => {
    expect(written('reasoning_effort', 'xhigh')).toEqual({ reasoning_effort: 'high' });
    expect(written('reasoning.effort', 'xhigh')).toEqual({ reasoning: { effort: 'high' } });
    expect(written('thinking.type+effort', 'xhigh')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });

  it('sends xhigh as itself on the styles that take the whole scale', () => {
    expect(written('max_effort', 'xhigh')).toEqual({ max_effort: 'xhigh' });
    expect(written('thinking.type', 'xhigh')).toEqual({ thinking: { type: 'enabled' } });
    expect(written('enable_thinking+budget', 'xhigh')).toEqual({ enable_thinking: true, thinking_budget: 24_576 });
  });

  it('sends nothing for xhigh where the row does not list it', () => {
    const noXhigh: ModelCaps = { effortLevels: ['low', 'medium', 'high', 'max'] };
    for (const style of ['reasoning_effort', 'reasoning.effort', 'thinking.type', 'thinking.type+effort', 'enable_thinking+budget', 'reasoning.enabled', 'max_effort'] as const) {
      expect(written(style, 'xhigh', noXhigh)).toEqual({});
    }
  });

  it('writes the settled budget over the level’s nominal one', () => {
    expect(written('enable_thinking+budget', 'high', {}, 5_000)).toEqual({ enable_thinking: true, thinking_budget: 5_000 });
  });
});

describe('reasoningBudget through the adapters (table)', () => {
  const chat = (caps: ModelCaps, budget: number | undefined, thinking?: ThinkingLevel, maxTokens = 4_096): Record<string, unknown> =>
    openaiChatAdapter.buildBody(
      bodyInput(
        { messages: [], ...(thinking === undefined ? {} : { thinking }), ...(budget === undefined ? {} : { reasoningBudget: budget }) },
        { baseUrl: 'https://x', model: 'm', quirks: {}, caps },
        { maxTokens },
      ),
    );

  it('is a number on enable_thinking+budget, with max_tokens above it', () => {
    expect(chat(qwenRow, 8_000)).toMatchObject({ enable_thinking: true, thinking_budget: 8_000, max_tokens: 12_096 });
    expect(chat(qwenRow, 8_000, 'low')).toMatchObject({ enable_thinking: true, thinking_budget: 8_000 });
  });

  it('maps to the nearest listed level on an effort-only style', () => {
    const effort: ModelCaps = { effortStyle: 'reasoning_effort', effortLevels: ['low', 'medium', 'high'] };
    expect(chat(effort, 1_000)).toMatchObject({ reasoning_effort: 'low' });
    expect(chat(effort, 5_000)).toMatchObject({ reasoning_effort: 'medium' });
    expect(chat(effort, 50_000)).toMatchObject({ reasoning_effort: 'high', max_tokens: 4_096 });
  });

  it('is ignored beside off, and beside a row that lists no level', () => {
    expect(chat(qwenRow, 8_000, 'off')).toMatchObject({ enable_thinking: false });
    expect(chat(qwenRow, 8_000, 'off')).not.toHaveProperty('thinking_budget');
    expect(chat({ effortStyle: 'reasoning_effort', effortLevels: [] }, 8_000)).not.toHaveProperty('reasoning_effort');
  });

  it('never sends thinking_budget at or above max_tokens', () => {
    for (const level of ON) {
      for (const cap of CAPS) {
        const built = chat(qwenRow, undefined, level, cap);
        expect(built.thinking_budget as number).toBeLessThan(built.max_tokens as number);
      }
    }
  });

  it('gives the Anthropic adapter the same answer for the same budget on its budget shape', () => {
    const built = anthropicMessagesAdapter.buildBody(
      bodyInput({ messages: [], reasoningBudget: 5_000 }, { baseUrl: 'https://x', model: 'm', quirks: {}, caps: budgetRow }, { maxTokens: 4_096 }),
    );
    expect(built).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 5_000 }, max_tokens: 9_096, output_config: { effort: 'medium' } });
  });
});
