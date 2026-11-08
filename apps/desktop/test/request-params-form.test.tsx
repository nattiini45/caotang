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

import { resolveRoute } from '@caotang/gateway';

import { RequestParamsFields } from '../src/components/RequestParamsFields.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { BLANK_PARAMS, editTemperature, effortSeed, paramsDraftOf, paramsFromDraft, pickTemperatureMode, rowCaps, wireOf, type ParamsDraft } from '../src/app/request-params-form.js';

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
    expect(draft).toMatchObject({ temperatureMode: 'send', temperature: '0.4', temperatureForced: true, strictMode: 'off', effortMode: 'custom', deny: 'top_p, stop' });
    expect(paramsFromDraft(draft)).toEqual({ ok: true, params: view.params, temperature: 0.4 });
  });

  it('reads never, strict on and no thinking back as they were saved', () => {
    const draft = paramsDraftOf({ params: { temperature: false, toolStrict: true, effort: {} } });
    expect(draft).toMatchObject({ temperatureMode: 'never', strictMode: 'on', effortMode: 'none' });
    expect(paramsFromDraft(draft)).toEqual({ ok: true, params: { temperature: false, toolStrict: true, effort: {} } });
  });

  it('reads a stored temperature with no flag as sent where the model takes one — and an unrelated save writes back exactly that', () => {
    // A profile saved before request parameters (or written by the SDK) holds the temperature column and no flag, which
    // the wire reads as send-where-allowed. The form shows 'send' for it, but the save must write the same shape back:
    // a params.temperature flag would be an override the writer never asked for.
    const draft = paramsDraftOf({ temperature: 0.7 });
    expect(draft).toMatchObject({ temperatureMode: 'send', temperature: '0.7', temperatureForced: false });
    expect(paramsFromDraft(draft)).toEqual({ ok: true, temperature: 0.7 });
  });

  it('reads the SDK’s flag-only temperature as its own mode and saves the same shape back', () => {
    // The valid shape an SDK write produces: the allow flag, no stored number. It is not 'send' with a blank
    // value — the value field is required under 'send', so reading it that way failed every unrelated save.
    const draft = paramsDraftOf({ params: { temperature: true } });
    expect(draft).toMatchObject({ temperatureMode: 'request', temperature: '', temperatureForced: false });
    expect(paramsFromDraft(draft)).toEqual({ ok: true, params: { temperature: true } });
    // An unrelated edit round-trips the same stored shape: the flag alone, never a number.
    expect(paramsFromDraft({ ...draft })).toEqual({ ok: true, params: { temperature: true } });
  });

  it('picking the request mode stores the flag alone, and a stored number does not survive the pick', () => {
    expect(paramsFromDraft(pickTemperatureMode(BLANK_PARAMS, 'request'))).toEqual({ ok: true, params: { temperature: true } });
    // The mode holds no value of its own: picking it over a stored temperature clears the number.
    const over = paramsFromDraft(pickTemperatureMode(paramsDraftOf({ temperature: 0.7 }), 'request'));
    expect(over).toEqual({ ok: true, params: { temperature: true } });
  });

  it('a flag-only save keeps letting a request’s own temperature through on a row that takes none', () => {
    // The synthetic request-level behavior the flag-only shape exists for: gpt-6.1-sol denies temperature,
    // the flag lifts the row's denial, and the value a request asks for is what the caps allow.
    const outcome = paramsFromDraft(paramsDraftOf({ params: { temperature: true } }));
    if (!outcome.ok) throw new Error('the flag-only draft must save');
    expect(resolveRoute({ preset: 'openai', baseUrl: 'https://api.openai.com/v1', params: outcome.params }, 'gpt-6.1-sol').caps.denylist ?? []).not.toContain(
      'temperature',
    );
  });

  it('a profile deny of temperature wins over its own allow flag, while the flag alone still lifts the row’s', () => {
    // The owner's precedence decision: an explicit leave-out cannot be overridden by the same profile's allow.
    const denied = resolveRoute(
      { preset: 'openai', baseUrl: 'https://api.openai.com/v1', params: { temperature: true, deny: ['temperature'] } },
      'gpt-6.1-sol',
    ).caps;
    expect(denied.denylist).toContain('temperature');
    const allowed = resolveRoute({ preset: 'openai', baseUrl: 'https://api.openai.com/v1', params: { temperature: true } }, 'gpt-6.1-sol').caps;
    expect(allowed.denylist ?? []).not.toContain('temperature');
  });

  it('keeps a stored temperature off a row that takes none after an unrelated save, on a first-party host pin too', () => {
    // The regression this guards: 'send' used to always write params.temperature: true, which withParams reads as an
    // override — so renaming the profile put a refused temperature on the wire and every later request failed.
    const outcome = paramsFromDraft(paramsDraftOf({ temperature: 0.7 }));
    if (!outcome.ok) throw new Error('the stored draft must save');
    expect(resolveRoute({ preset: 'openai', baseUrl: 'https://api.openai.com/v1', params: outcome.params }, 'gpt-6.1-sol').caps.denylist).toContain('temperature');
    expect(resolveRoute({ preset: 'generic', baseUrl: 'https://api.openai.com/v1', params: outcome.params }, 'gpt-6.1-sol').caps.denylist).toContain('temperature');
    // On a row that takes one the same save still sends it: nothing new is denied.
    expect(resolveRoute({ preset: 'generic', baseUrl: 'https://x.example/v1', params: outcome.params }, 'm').caps.denylist ?? []).not.toContain('temperature');
  });

  it('writes the override flag only when the writer picks send or types a value, never when the draft only shows one', () => {
    const legacy = paramsDraftOf({ temperature: 0.7 });
    // Re-picking 'send' is a choice: the flag is written, and the row's denial lifts for this profile.
    const picked = paramsFromDraft(pickTemperatureMode(legacy, 'send'));
    expect(picked).toEqual({ ok: true, params: { temperature: true }, temperature: 0.7 });
    if (picked.ok) {
      expect(resolveRoute({ preset: 'generic', baseUrl: 'https://api.openai.com/v1', params: picked.params }, 'gpt-6.1-sol').caps.denylist ?? []).not.toContain('temperature');
    }
    // So is typing a different value into the field the form already shows as 'send'.
    const edited = paramsFromDraft(editTemperature(legacy, '0.9'));
    expect(edited).toEqual({ ok: true, params: { temperature: true }, temperature: 0.9 });
    // The other picks never write the flag.
    expect(paramsFromDraft(pickTemperatureMode(legacy, 'never'))).toEqual({ ok: true, params: { temperature: false } });
    expect(paramsFromDraft(pickTemperatureMode(legacy, 'follow'))).toEqual({ ok: true });
  });

  it('keeps a stored zero as sent, and an explicit off still wins over a stored value', () => {
    const zero = paramsDraftOf({ temperature: 0 });
    expect(zero).toMatchObject({ temperatureMode: 'send', temperature: '0', temperatureForced: false });
    expect(paramsFromDraft(zero)).toEqual({ ok: true, temperature: 0 });
    const off = paramsDraftOf({ temperature: 0.7, params: { temperature: false } });
    expect(off).toMatchObject({ temperatureMode: 'never', temperature: '' });
    expect(paramsFromDraft(off)).toEqual({ ok: true, params: { temperature: false } });
  });

  it('refuses a temperature to send that is empty or outside 0 to 2, and reads a decimal comma', () => {
    const send = pickTemperatureMode(BLANK_PARAMS, 'send');
    expect(paramsFromDraft({ ...send, temperature: '' })).toEqual({ ok: false, reason: 'temperature' });
    expect(paramsFromDraft({ ...send, temperature: '2.5' })).toEqual({ ok: false, reason: 'temperature' });
    expect(paramsFromDraft({ ...send, temperature: '0,2' })).toEqual({ ok: true, params: { temperature: true }, temperature: 0.2 });
  });

  it('starts a custom thinking map from what the model sends', () => {
    expect(effortSeed(rowCaps('openai', '', 'gpt-6.1-sol'))).toEqual({ off: '', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
    expect(effortSeed(rowCaps('generic', 'https://x.example/v1', 'm'))).toEqual({ off: '', low: 'low', medium: 'medium', high: 'high', xhigh: '', max: '' });
  });

  it('reads the host-pinned preset’s row for a first-party address (provider-gateway §2)', () => {
    // A generic endpoint at api.anthropic.com speaks Anthropic's route: its row, not the generic one —
    // the same pin `resolveRoute` applies to every request.
    const caps = rowCaps('generic', 'https://api.anthropic.com/v1', 'claude-sonnet-5-5');
    expect(caps.effortStyle).toBe('anthropic');
    expect(caps.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(caps.thinkingShape).toBe('adaptive');
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

  it('offers the request mode as its own option, and says what it does on a row that takes none', () => {
    const draft = paramsDraftOf({ params: { temperature: true } });
    const text = form(draft, 'openai', 'gpt-6.1-sol');
    expect(text).toContain('Send a request’s value');
    expect(text).toContain('A request’s temperature goes out, even on a model that takes none.');
    // The value field belongs to 'send a value' alone: the flag-only mode shows none.
    expect(text).not.toContain('Value, from 0 to 2');
  });

  it('names the profile’s own leave-out list as the reason temperature stays off, whatever the mode', () => {
    // The profile's deny wins over its own allow flag (the owner's precedence decision): the note names the
    // profile's rule, not the model row's, so a forced 'send' on a taking row reads the same suppression.
    const request = form({ ...BLANK_PARAMS, temperatureMode: 'request', deny: 'temperature' }, 'generic', 'm', 'https://x.example/v1');
    expect(request).toContain('The leave-out list below names temperature, so none is sent.');
    const forced = form({ ...BLANK_PARAMS, temperatureMode: 'send', temperature: '0.5', temperatureForced: true, deny: 'temperature' }, 'openai', 'gpt-6.1-sol');
    expect(forced).toContain('The leave-out list below names temperature, so none is sent.');
    expect(forced).not.toContain('takes no temperature');
    // Without the flag the row's own denial still reads as the row's, unchanged.
    expect(form({ ...BLANK_PARAMS, deny: 'top_p' }, 'openai', 'gpt-6.1-sol')).toContain('gpt-6.1-sol takes no temperature, so none is sent.');
  });

  it('names the leave-out list when it turns the thinking control off, instead of claiming levels are sent', () => {
    const text = form({ ...BLANK_PARAMS, deny: 'output_config' }, 'anthropic', 'claude-sonnet-5-5');
    expect(text).not.toContain('Sent as:');
    expect(text).toContain('The leave-out list below turns the thinking control off, so no level is sent.');
    // The row's own offering is untouched: the same model with an unrelated leave-out still reads "Sent as".
    expect(form({ ...BLANK_PARAMS, deny: 'top_p' }, 'anthropic', 'claude-sonnet-5-5')).toContain('Sent as:');
  });

  it('names the field control honestly: fields left out, with the cap sent under its other name', () => {
    const text = form(BLANK_PARAMS, 'generic', 'm', 'https://x.example/v1');
    expect(text).toContain('Leave out these request fields');
    expect(text).not.toContain('Never send these fields');
    expect(text).toContain('max_completion_tokens');
  });

  it('warns that an inherited send is still unsent on a row that takes none, until the send is the writer’s own', () => {
    // A legacy stored value shows 'send' without the override flag: on a denying row nothing goes out, and the
    // same help 'follow' shows says so. Once 'send' is the writer's own (the flag is set), the value is sent and the note goes.
    const inherited = paramsDraftOf({ temperature: 0.7 });
    const pinned = form(inherited, 'generic', 'gpt-6.1-sol', 'https://api.openai.com/v1');
    expect(pinned).toContain('gpt-6.1-sol takes no temperature, so none is sent.');
    expect(form(inherited, 'openai', 'gpt-6.1-sol')).toContain('gpt-6.1-sol takes no temperature, so none is sent.');
    expect(form({ ...inherited, temperatureForced: true }, 'openai', 'gpt-6.1-sol')).not.toContain('takes no temperature');
    // On a row that takes one the inherited send really is sent — no warning.
    expect(form(inherited, 'generic', 'm', 'https://x.example/v1')).not.toContain('takes no temperature');
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
