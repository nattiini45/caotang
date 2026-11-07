/**
 * The provider form's "Advanced request parameters" (provider-gateway §2, "Request parameters"): the draft read from a saved
 * profile, the params and temperature a save sends, what "follow the model" shows for the OpenAI and Anthropic rows, and the
 * form's markup. No DOM: the markup is read from a static render.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { RequestParamsFields } from '../src/components/RequestParamsFields.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { BLANK_PARAMS, effortSeed, paramsDraftOf, paramsFromDraft, rowCaps, wireOf, type ParamsDraft } from '../src/app/request-params-form.js';

beforeEach(() => activateEnglish());

function markup(node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>);
}

function words(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/[\u2066-\u2069]/g, '').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
}

const form = (draft: ParamsDraft, preset: string, model: string, baseUrl = ''): string =>
  words(markup(<RequestParamsFields draft={draft} preset={preset} baseUrl={baseUrl} model={model} providerName={preset === 'openai' ? 'OpenAI' : 'Anthropic (Claude)'} onChange={() => undefined} />));

describe('the request parameters draft', () => {
  it('follows the model on every field when nothing is set, and a save sends nothing', () => {
    expect(paramsDraftOf({})).toEqual(BLANK_PARAMS);
    expect(paramsFromDraft(BLANK_PARAMS)).toEqual({ ok: true });
  });

  it('round-trips a profile’s params and the temperature it sends', () => {
    const view = { temperature: 0.4, params: { temperature: true, toolStrict: false, effort: { low: 'low', max: 'xhigh' }, deny: ['top_p', 'stop'] } };
    const draft = paramsDraftOf(view);
    expect(draft).toMatchObject({ temperatureMode: 'send', temperature: '0.4', strictMode: 'off', effortMode: 'custom', deny: 'top_p, stop' });
    expect(paramsFromDraft(draft)).toEqual({ ok: true, params: view.params, temperature: 0.4 });
  });

  it('reads never, strict on and no thinking back as they were saved', () => {
    const draft = paramsDraftOf({ params: { temperature: false, toolStrict: true, effort: {} } });
    expect(draft).toMatchObject({ temperatureMode: 'never', strictMode: 'on', effortMode: 'none' });
    expect(paramsFromDraft(draft)).toEqual({ ok: true, params: { temperature: false, toolStrict: true, effort: {} } });
  });

  it('refuses a temperature to send that is empty or outside 0 to 2, and reads a decimal comma', () => {
    expect(paramsFromDraft({ ...BLANK_PARAMS, temperatureMode: 'send', temperature: '' })).toEqual({ ok: false, reason: 'temperature' });
    expect(paramsFromDraft({ ...BLANK_PARAMS, temperatureMode: 'send', temperature: '2.5' })).toEqual({ ok: false, reason: 'temperature' });
    expect(paramsFromDraft({ ...BLANK_PARAMS, temperatureMode: 'send', temperature: '0,2' })).toEqual({ ok: true, params: { temperature: true }, temperature: 0.2 });
  });

  it('starts a custom thinking map from what the model sends', () => {
    expect(effortSeed(rowCaps('openai', '', 'gpt-6.1-sol'))).toEqual({ off: '', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
    expect(effortSeed(rowCaps('generic', 'https://x.example/v1', 'm'))).toEqual({ off: '', low: 'low', medium: 'medium', high: 'high', xhigh: '', max: '' });
  });

  it('names the wire value of each level as the gateway sends it', () => {
    const openai = rowCaps('openai', '', 'gpt-6-sol');
    expect(wireOf('off', openai)).toBe('none');
    expect(wireOf('max', openai)).toBe('max');
    expect(wireOf('max', { effortStyle: 'reasoning_effort' })).toBe('high');
    expect(wireOf('max', { effortStyle: 'anthropic' })).toBe('max');
    const deepseek = rowCaps('deepseek', '', 'deepseek-flash');
    expect(wireOf('off', deepseek)).toBe('disabled');
    expect(wireOf('max', deepseek)).toBe('max');
    expect(effortSeed(deepseek)).toEqual({ off: 'disabled', low: 'low', medium: '', high: 'high', xhigh: '', max: 'max' });
  });
});

describe('the Advanced request parameters form', () => {
  it('shows what an OpenAI model takes while every field follows it', () => {
    const text = form(BLANK_PARAMS, 'openai', 'gpt-6.1-sol');
    expect(text).toContain('Advanced request parameters');
    expect(text).toContain('Each setting follows what OpenAI accepts for the model until you change it.');
    expect(text).toContain('gpt-6.1-sol takes no temperature, so none is sent.');
    expect(text).toContain('Sent as strict: false, so optional tool parameters stay optional.');
    expect(text).toContain('Sent as: Low → low, Medium → medium, High → high, Extra high → xhigh, Max → max');
  });

  it('says DeepSeek’s Off turns thinking off rather than sending none, and MiniMax’s On is adaptive', () => {
    expect(form(BLANK_PARAMS, 'deepseek', 'deepseek-flash')).toContain('Sent as: Off → thinking disabled, Low → low, High → high, Max → max');
    expect(form(BLANK_PARAMS, 'minimax', 'MiniMax-M3')).toContain('Sent as: Off → thinking disabled, High → thinking adaptive');
  });

  it('asks a custom endpoint what it accepts and offers a value field when a temperature is sent', () => {
    const text = form({ ...BLANK_PARAMS, temperatureMode: 'send', temperature: '0.3' }, 'generic', 'my-model', 'https://x.example/v1');
    expect(text).toContain('Say what your endpoint accepts.');
    expect(text).toContain('Value, from 0 to 2');
    expect(text).not.toContain('Sent as');
  });

  it('lists one field per level when the values are chosen', () => {
    const text = form({ ...BLANK_PARAMS, effortMode: 'custom', effort: effortSeed(rowCaps('anthropic', '', 'claude-haiku-5-5')) }, 'anthropic', 'claude-haiku-5-5');
    expect(text).toContain('The value sent for each level. Leave a level empty to not offer it.');
    for (const level of ['Off', 'Low', 'Medium', 'High', 'Extra high', 'Max']) expect(text).toContain(level);
  });

  it('never calls the built-ins a kit or a preset', () => {
    for (const preset of ['openai', 'anthropic', 'generic']) {
      const text = form({ ...BLANK_PARAMS, effortMode: 'custom' }, preset, 'm', 'https://x.example/v1').toLowerCase();
      expect(text).not.toMatch(/\bkit\b|\bpreset/);
    }
  });
});
