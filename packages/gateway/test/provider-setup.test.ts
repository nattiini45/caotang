import { describe, expect, it } from 'vitest';
import { chooseModels, detectProvider, FEATURED_PROVIDERS, PRESETS, presetFor, type ModelInfo } from '../src/index.js';
import { parseModels } from '../src/adapters/models.js';

describe('detecting a provider from a key', () => {
  it.each([
    [('sk-ant-' + 'api03-abcdefghijklmnop'), 'anthropic'],
    [('sk-or-v1-' + '0123456789abcdef'), 'openrouter'],
    [('sk-proj-' + 'abcdefghijklmnop'), 'openai'],
    [('sk-svcacct-' + 'abcdefghijklmnop'), 'openai'],
    [('sk-' + 'abcdefghijklmnopT3BlbkFJabcdefghijklmnop'), 'openai'],
    [('gsk_' + 'abcdefghijklmnopqrstuvwxyz'), 'groq'],
    [('xai-' + 'abcdefghijklmnopqrstuvwxyz'), 'xai'],
    [('AIzaSyA-' + 'bcdefghijklmnopqrstuvwxyz012345'), 'gemini'],
    [('hf_' + 'abcdefghijklmnopqrstuvwxyz'), 'huggingface'],
    [('pplx-' + 'abcdefghijklmnopqrstuvwxyz'), 'perplexity'],
    [('csk-' + 'abcdefghijklmnopqrstuvwxyz'), 'cerebras'],
    [('fw_' + 'abcdefghijklmnopqrstuvwxyz'), 'fireworks'],
  ])('recognises %s as %s', (key, preset) => {
    expect(detectProvider(key)).toEqual({ preset, candidates: [preset] });
    expect(detectProvider(`  ${key}\n`).preset).toBe(preset);
  });

  it('offers a short list, never a guess, where more than one provider uses the shape', () => {
    const hex = detectProvider(`sk-${'a1'.repeat(16)}`);
    expect(hex.preset).toBeUndefined();
    expect(hex.candidates.slice(0, 2)).toEqual(['deepseek', 'alibaba']);
    expect(detectProvider(`sk-${'Ab3'.repeat(16)}`).preset).toBeUndefined();
    expect(detectProvider('A'.repeat(32)).candidates[0]).toBe('mistral');
    expect(detectProvider('anything else entirely').candidates).toEqual(FEATURED_PROVIDERS);
    expect(detectProvider('').candidates).toEqual(FEATURED_PROVIDERS);
  });

  it('only ever names presets that exist and need a key', () => {
    for (const key of ['sk-ant-x', 'sk-or-x', 'sk-proj-x', 'gsk_x', 'xai-x', 'hf_x', 'pplx-x', 'csk-x', 'fw_x', `sk-${'a1'.repeat(16)}`, 'sk-zzz', 'A'.repeat(32), 'A'.repeat(40), 'a'.repeat(64)]) {
      for (const id of detectProvider(key).candidates) expect(presetFor(id)).toBeDefined();
    }
    for (const id of FEATURED_PROVIDERS) expect(PRESETS.find((preset) => preset.id === id)?.keyOptional).not.toBe(true);
  });
});

describe('choosing models from a listing', () => {
  const info = (id: string, more: Partial<ModelInfo> = {}): ModelInfo => ({ id, ...more });

  it('drops models that cannot write, keeps vision and instruct models, and trusts the listing when it says', () => {
    const openai = presetFor('openai');
    const ids = chooseModels(openai, [
      info('gpt-6-sol'), info('text-embedding-3-small'), info('whisper-1'), info('tts-1-hd'), info('dall-e-3'), info('gpt-image-1'),
      info('omni-moderation-latest'), info('llama-3.2-11b-vision-instruct'), info('davinci-002'), info('gpt-realtime-mini'),
      info('some-odd-model', { writes: true }), info('chatty-image-model', { writes: true }), info('writer-lite', { writes: false }),
    ]).map((model) => model.id);
    expect(ids).toEqual(['gpt-6-sol', 'some-odd-model', 'llama-3.2-11b-vision-instruct', 'chatty-image-model']);
  });

  it('marks the preset default as recommended and lists it first, then table rows, then newest', () => {
    const anthropic = presetFor('anthropic');
    const choices = chooseModels(anthropic, [
      info('claude-opus-5-5', { created: 5 }), info('zz-unlisted-old', { created: 1 }), info('claude-sonnet-5-5', { created: 3 }), info('aa-unlisted-new', { created: 9 }),
    ]);
    expect(choices.map((choice) => choice.id)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'aa-unlisted-new', 'zz-unlisted-old']);
    expect(choices.map((choice) => choice.recommended)).toEqual([true, false, false, false]);
    expect(choices[0]).toMatchObject({ contextWindow: 1_000_000, tools: true, vision: true });
  });

  it('recommends the first known model when the default is not listed, and nothing when none is known', () => {
    const openai = presetFor('openai');
    expect(chooseModels(openai, [info('gpt-6-luna'), info('mystery')])[0]).toMatchObject({ id: 'gpt-6-luna', recommended: true });
    const generic = chooseModels(presetFor('generic'), [info('alpha'), info('beta')]);
    expect(generic.some((choice) => choice.recommended)).toBe(false);
    expect(chooseModels(undefined, [info('only')])).toEqual([{ id: 'only', recommended: false }]);
  });

  it('hides a dated snapshot only when its undated name is listed, and de-duplicates', () => {
    const generic = presetFor('generic');
    expect(chooseModels(generic, [info('m-2025-01-02'), info('m'), info('m'), info('n-20250929')]).map((choice) => choice.id).sort()).toEqual(['m', 'n-20250929']);
  });

  it("strips Gemini's models/ prefix so the table and the wire see the documented id", () => {
    const choices = chooseModels(presetFor('gemini'), [info('models/gemini-3.8-flash'), info('models/text-embedding-004')]);
    expect(choices.map((choice) => choice.id)).toEqual(['gemini-3.8-flash']);
    expect(choices[0]?.recommended).toBe(true);
  });

  it('takes the window and price from the listing before the table', () => {
    const choice = chooseModels(presetFor('openrouter'), [info('vendor/model', { contextWindow: 32_000, pricePer1k: { prompt: 1, completion: 2 } })])[0];
    expect(choice).toMatchObject({ contextWindow: 32_000, pricePer1k: { prompt: 1, completion: 2 } });
  });
});

describe('what a models listing says about a model', () => {
  it('reads output modalities and a publication time from the shapes providers use', () => {
    const models = parseModels({
      data: [
        { id: 'a', created: 1_700_000_000, architecture: { output_modalities: ['image'] } },
        { id: 'b', created_at: '2025-09-29T00:00:00Z', architecture: { modality: 'text+image->text' } },
        { id: 'c', architecture: { output_modalities: ['text', 'image'] } },
        { id: 'd' },
      ],
    });
    expect(models).toEqual([
      { id: 'a', writes: false, created: 1_700_000_000_000 },
      { id: 'b', writes: true, created: Date.parse('2025-09-29T00:00:00Z') },
      { id: 'c', writes: true },
      { id: 'd' },
    ]);
  });
});
