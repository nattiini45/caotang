/**
 * The provider form's "Advanced request parameters" (provider-gateway §2, "Request parameters"), as pure functions: the draft the
 * form holds, read from a saved profile, and turned back into the profile's `params` and temperature on save. A test can pin
 * the round trip without a render.
 */

import { effortWireValue, resolveRoute, type ModelCaps, type ProfileView, type RequestParams, type ThinkingLevel } from '@caotang/gateway';

/** The levels in the order the form lists them. */
export const PARAM_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** What the form holds. 'follow' leaves the field to the model row. */
export interface ParamsDraft {
  readonly temperatureMode: 'follow' | 'send' | 'never';
  /** The temperature as typed; read only when `temperatureMode` is 'send'. */
  readonly temperature: string;
  readonly strictMode: 'follow' | 'on' | 'off';
  readonly effortMode: 'follow' | 'none' | 'custom';
  /** The wire value per level as typed; an empty one is not offered. Read only when `effortMode` is 'custom'. */
  readonly effort: Readonly<Record<ThinkingLevel, string>>;
  /** More fields never to send, comma separated as typed. */
  readonly deny: string;
}

const NO_EFFORT: Readonly<Record<ThinkingLevel, string>> = { off: '', low: '', medium: '', high: '', xhigh: '', max: '' };

export const BLANK_PARAMS: ParamsDraft = {
  temperatureMode: 'follow',
  temperature: '',
  strictMode: 'follow',
  effortMode: 'follow',
  effort: NO_EFFORT,
  deny: '',
};

/** The draft for a saved profile: its params, and its temperature when it sends one. */
export function paramsDraftOf(view: Pick<ProfileView, 'params' | 'temperature'>): ParamsDraft {
  const params = view.params;
  return {
    temperatureMode: params?.temperature === true ? 'send' : params?.temperature === false ? 'never' : 'follow',
    temperature: params?.temperature === true && view.temperature !== undefined ? String(view.temperature) : '',
    strictMode: params?.toolStrict === true ? 'on' : params?.toolStrict === false ? 'off' : 'follow',
    effortMode: params?.effort === undefined ? 'follow' : Object.values(params.effort).some((v) => v !== undefined && v !== '') ? 'custom' : 'none',
    effort: { ...NO_EFFORT, ...(params?.effort ?? {}) },
    deny: (params?.deny ?? []).join(', '),
  };
}

/** The caps the model row gives a (preset, address, model), before any profile params: what "follow" means on the form. */
export function rowCaps(preset: string, baseUrl: string, model: string): ModelCaps {
  return resolveRoute({ preset, baseUrl }, model.trim()).caps;
}

/**
 * The wire values a custom effort map starts from: the row's levels with the values it sends, or low, medium and high by name
 * when the row offers none (a custom endpoint).
 */
export function effortSeed(caps: ModelCaps): Record<ThinkingLevel, string> {
  const seed: Record<ThinkingLevel, string> = { ...NO_EFFORT };
  const levels = caps.effortLevels !== undefined && caps.effortLevels.length > 0 ? caps.effortLevels : (['low', 'medium', 'high'] as const);
  for (const level of levels) seed[level] = wireOf(level, caps);
  return seed;
}

/** What a save sends: the params (undefined is none) and the temperature (undefined is none), or the reason it cannot. */
export type ParamsOutcome =
  | { readonly ok: true; readonly params?: RequestParams; readonly temperature?: number }
  | { readonly ok: false; readonly reason: 'temperature' };

/** The draft as a save sends it. A temperature is kept only when it is sent; following or never clears it. */
export function paramsFromDraft(draft: ParamsDraft): ParamsOutcome {
  const params: { -readonly [K in keyof RequestParams]: RequestParams[K] } = {};
  let temperature: number | undefined;
  if (draft.temperatureMode === 'send') {
    const typed = draft.temperature.trim().replace(',', '.');
    const value = typed === '' ? Number.NaN : Number(typed);
    if (!Number.isFinite(value) || value < 0 || value > 2) return { ok: false, reason: 'temperature' };
    params.temperature = true;
    temperature = value;
  } else if (draft.temperatureMode === 'never') params.temperature = false;
  if (draft.strictMode !== 'follow') params.toolStrict = draft.strictMode === 'on';
  if (draft.effortMode === 'none') params.effort = {};
  if (draft.effortMode === 'custom') {
    const effort: Partial<Record<ThinkingLevel, string>> = {};
    for (const level of PARAM_LEVELS) {
      const value = draft.effort[level].trim();
      if (value !== '') effort[level] = value;
    }
    params.effort = effort;
  }
  const deny = draft.deny
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '');
  if (deny.length > 0) params.deny = deny;
  return {
    ok: true,
    ...(Object.keys(params).length === 0 ? {} : { params }),
    ...(temperature === undefined ? {} : { temperature }),
  };
}

/**
 * The value a level goes out as: the same function the adapters write the body with (effort.ts), so the form never says one
 * thing and sends another. A row with no style is sent as the chat route's `reasoning_effort` once a profile turns levels on.
 */
export function wireOf(level: ThinkingLevel, caps: ModelCaps): string {
  return effortWireValue(level, caps, caps.effortStyle ?? 'reasoning_effort');
}

/** The form's "Sent as" text for a level: the wire value, named by its field where the value alone would not say what it is. */
export function sentAs(level: ThinkingLevel, caps: ModelCaps): string {
  const value = wireOf(level, caps);
  switch (caps.effortStyle) {
    case 'thinking.type':
      return `thinking ${value}`;
    case 'thinking.type+effort':
    case 'anthropic':
      return level === 'off' ? `thinking ${value}` : value;
    case 'enable_thinking+budget':
      return level === 'off' ? 'enable_thinking false' : `thinking_budget ${value}`;
    case 'reasoning.enabled':
      return `reasoning.enabled ${value}`;
    default:
      return value;
  }
}
