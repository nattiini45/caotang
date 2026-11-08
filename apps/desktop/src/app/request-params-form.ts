/**
 * The provider form's "Advanced request parameters" (provider-gateway §2, "Request parameters"), as pure functions: the draft the
 * form holds, read from a saved profile, and turned back into the profile's `params` and temperature on save. A test can pin
 * the round trip without a render.
 */

import { effortWireValue, resolveRoute, type ModelCaps, type ProfileView, type RequestParams, type ThinkingLevel } from '@caotang/gateway';

/** The levels in the order the form lists them. */
export const PARAM_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** What the form holds. 'follow' leaves the field to the model row; 'request' is the flag alone. */
export interface ParamsDraft {
  readonly temperatureMode: 'follow' | 'send' | 'request' | 'never';
  /** The temperature as typed; read only when `temperatureMode` is 'send'. */
  readonly temperature: string;
  /**
   * Whether 'send' is the writer's own override (`params.temperature: true` plus a value — sent even where the
   * model row takes none). A stored temperature with no flag shows 'send' without it: the value goes out only
   * where the row allows one, so a save the writer did not aim at this control writes the same shape back. The
   * flag with no stored value is its own mode, 'request', and does not need this marker.
   */
  readonly temperatureForced: boolean;
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
  temperatureForced: false,
  strictMode: 'follow',
  effortMode: 'follow',
  effort: NO_EFFORT,
  deny: '',
};

/** The draft for a saved profile: its params, and its temperature when it sends one. */
export function paramsDraftOf(view: Pick<ProfileView, 'params' | 'temperature'>): ParamsDraft {
  const params = view.params;
  // A stored temperature with no flag is a profile from before request parameters (or the SDK's): the gateway
  // still sends it, so the draft shows it as sent — only an explicit 'never' turns it off. The flag with no
  // stored value is the valid SDK flag-only shape: it reads as its own mode, 'request', not 'send' with a blank
  // value (the value field is required under 'send', so that reading failed every unrelated save).
  const sends = params?.temperature === true || (params?.temperature === undefined && view.temperature !== undefined);
  return {
    temperatureMode: params?.temperature === false ? 'never' : params?.temperature === true ? (view.temperature === undefined ? 'request' : 'send') : sends ? 'send' : 'follow',
    temperature: sends && view.temperature !== undefined ? String(view.temperature) : '',
    // 'send' is the override only with a value to send: the flag alone is 'request', which needs no marker.
    temperatureForced: params?.temperature === true && view.temperature !== undefined,
    strictMode: params?.toolStrict === true ? 'on' : params?.toolStrict === false ? 'off' : 'follow',
    effortMode: params?.effort === undefined ? 'follow' : Object.values(params.effort).some((v) => v !== undefined && v !== '') ? 'custom' : 'none',
    effort: { ...NO_EFFORT, ...(params?.effort ?? {}) },
    deny: (params?.deny ?? []).join(', '),
  };
}

/**
 * The draft after the writer picks a temperature mode. Picking 'send' is their own choice — the value then goes out
 * even on a row that takes none (`params.temperature: true`); a draft that only shows a stored value keeps its
 * send-where-allowed meaning instead. 'request' is the flag alone, and the other picks store nothing of it.
 */
export function pickTemperatureMode(draft: ParamsDraft, mode: ParamsDraft['temperatureMode']): ParamsDraft {
  return { ...draft, temperatureMode: mode, temperatureForced: mode === 'send' };
}

/**
 * The draft after the writer types into the value field — the field exists only under 'send', so changing it is
 * their own choice like picking 'send' is: the value then goes out even on a row that takes none.
 */
export function editTemperature(draft: ParamsDraft, value: string): ParamsDraft {
  return { ...draft, temperature: value, temperatureForced: draft.temperatureMode === 'send' ? true : draft.temperatureForced };
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

/**
 * The params a save sends for this draft — every control but the temperature number, which the save validates on
 * its own. The form's effective-caps preview reads the same object, so the help and the wire cannot disagree.
 */
function paramsOf(draft: ParamsDraft): RequestParams | undefined {
  const params: { -readonly [K in keyof RequestParams]: RequestParams[K] } = {};
  // 'request' is the flag alone: a temperature a request asks for goes out even where the row takes none. Under
  // 'send' the flag is written only when the send is the writer's own — a stored one, or 'send' picked this session.
  if (draft.temperatureMode === 'request' || (draft.temperatureMode === 'send' && draft.temperatureForced)) params.temperature = true;
  else if (draft.temperatureMode === 'never') params.temperature = false;
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
  return Object.keys(params).length === 0 ? undefined : params;
}

/** The draft as a save sends it. A temperature is kept only when it is sent; following or never clears it. */
export function paramsFromDraft(draft: ParamsDraft): ParamsOutcome {
  let temperature: number | undefined;
  if (draft.temperatureMode === 'send') {
    const typed = draft.temperature.trim().replace(',', '.');
    const value = typed === '' ? Number.NaN : Number(typed);
    if (!Number.isFinite(value) || value < 0 || value > 2) return { ok: false, reason: 'temperature' };
    temperature = value;
  }
  return { ok: true, params: paramsOf(draft), temperature };
}

/**
 * The caps this draft's profile would actually speak: the model row's with the draft's own params laid over — the
 * same overlay `resolveRoute` applies to a saved profile (`withParams`), so a suppression the help names is the one
 * the wire sees, not a guess from the row alone.
 */
export function effectiveCaps(draft: ParamsDraft, preset: string, baseUrl: string, model: string): ModelCaps {
  return resolveRoute({ preset, baseUrl, params: paramsOf(draft) }, model.trim()).caps;
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
