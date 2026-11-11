import { describe, expect, it } from 'vitest';
import { assemble, meterOf, DEFAULT_MAX_OUTPUT_TOKENS, RESERVED_TOKENS, type AssembledPrompt } from '../src/index.js';
import { buildApp } from './fixtures.js';

const base = assemble({ tool: 'meta', instruction: 'Plan.' }, buildApp());
const prompt = (tokens: number, overrides: Partial<AssembledPrompt> = {}): AssembledPrompt => ({ ...base, estimate: { ...base.estimate, promptTokens: tokens }, totalBudget: 100, ...overrides });

describe('pure context meter', () => {
  it.each([[79, 'ok'], [80, 'near'], [100, 'near'], [101, 'over']] as const)('classifies %i tokens as %s against the configured budget', (tokens, level) => {
    expect(meterOf(prompt(tokens)).level).toBe(level);
  });

  it('omits unknown windows and uses the actual output default plus reserved tokens', () => {
    const meter = meterOf(base);
    expect(meter).not.toHaveProperty('windowTokens');
    expect(meter.reserveTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS + RESERVED_TOKENS);
    expect(meter.budgetTokens).toBe(base.totalBudget);
    expect(meter.byLayer).toEqual(base.estimate.byLayer);
    expect(meter.conversationTokens).toBe(0);
  });

  it('uses the smaller nonnegative capacity after output, thinking and system reserve', () => {
    const model = { contextWindow: RESERVED_TOKENS + 60, maxOutputTokens: 5, thinkingTokens: 5 };
    expect(meterOf(prompt(39, { model })).level).toBe('ok');
    expect(meterOf(prompt(40, { model })).level).toBe('near');
    expect(meterOf(prompt(51, { model })).level).toBe('over');
    expect(meterOf(prompt(1, { model: { ...model, contextWindow: 1 } })).level).toBe('over');
    expect(meterOf(prompt(100, { model: { ...model, contextWindow: 10_000 } })).level).toBe('near');
  });

  it('adds conversation tokens once, ignores negative extras and never mutates the prompt', () => {
    const input = prompt(70);
    const before = structuredClone(input);
    expect(meterOf(input, { conversationTokens: 10 })).toMatchObject({ promptTokens: 80, conversationTokens: 10, level: 'near' });
    expect(meterOf(input, { conversationTokens: 31 }).level).toBe('over');
    expect(meterOf(input, { conversationTokens: -20 })).toMatchObject({ promptTokens: 70, conversationTokens: 0, level: 'ok' });
    expect(input).toEqual(before);
  });
});
