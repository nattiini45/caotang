/**
 * The provider form's "Advanced request parameters" (provider-gateway §2, "Request parameters"). The draft and its round trip are
 * app/request-params-form.ts; this is only the markup, in the form's own classes, so Modern's control kit styles it by selector.
 */
/* lingui-set comment="Interpolated values: model, provider, values" */

import type { ReactNode } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ThinkingLevel } from '@caotang/gateway';

import { PARAM_LEVELS, effortSeed, rowCaps, sentAs, type ParamsDraft } from '../app/request-params-form.js';

/** The level names, as the task roles show them. */
const LEVEL_NAMES: Readonly<Record<ThinkingLevel, MessageDescriptor>> = {
  off: msg`Off`,
  low: msg`Low`,
  medium: msg`Medium`,
  high: msg`High`,
  xhigh: msg`Extra high`,
  max: msg`Max`,
};

/**
 * The provider form's advanced request parameters (provider-gateway §2, "Request parameters"): what each request carries beyond
 * the prompt. Every setting follows what the model row says until it is changed; a custom endpoint has only a conservative row,
 * so this is where its writer says what the server takes. Closed by default, like any help or advanced control.
 */
export function RequestParamsFields({
  draft,
  preset,
  baseUrl,
  model: typed,
  providerName,
  onChange,
}: {
  readonly draft: ParamsDraft;
  readonly preset: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly providerName: string;
  readonly onChange: (params: ParamsDraft) => void;
}): ReactNode {
  const set = (part: Partial<ParamsDraft>): void => onChange({ ...draft, ...part });
  const caps = rowCaps(preset, baseUrl, typed);
  const model = typed.trim();
  const levels = caps.effortLevels ?? [];
  const values = levels.map((level) => `${i18n._(LEVEL_NAMES[level])} → ${sentAs(level, caps)}`).join(', ');
  return (
    <details className="request-params" data-testid="profile-params">
      <summary>
        <Trans>Advanced request parameters</Trans>
      </summary>
      <p className="field-help">
        {preset === 'generic'
          ? t`Say what your endpoint accepts. Left alone, a request carries a temperature only when a feature asks for one, and no strict flag or thinking level.`
          : t`Each setting follows what ${{ provider: providerName }} accepts for the model until you change it.`}
      </p>
      <label>
        <span>
          <Trans>Temperature</Trans>
        </span>
        <select value={draft.temperatureMode} onChange={(event) => set({ temperatureMode: event.target.value as ParamsDraft['temperatureMode'] })}>
          <option value="follow">{t`Follow the model`}</option>
          <option value="send">{t`Send a value`}</option>
          <option value="never">{t`Never send`}</option>
        </select>
      </label>
      {draft.temperatureMode === 'send' ? (
        <label>
          <span>
            <Trans>Value, from 0 to 2</Trans>
          </span>
          <input type="number" min={0} max={2} step="0.1" value={draft.temperature} onChange={(event) => set({ temperature: event.target.value })} />
        </label>
      ) : draft.temperatureMode === 'follow' && model !== '' && caps.denylist?.includes('temperature') === true ? (
        <p className="field-help">{t`${{ model }} takes no temperature, so none is sent.`}</p>
      ) : null}
      <label>
        <span>
          <Trans>Strict tool schemas</Trans>
        </span>
        <select value={draft.strictMode} onChange={(event) => set({ strictMode: event.target.value as ParamsDraft['strictMode'] })}>
          <option value="follow">{t`Follow the model`}</option>
          <option value="on">{t`On (strict: true)`}</option>
          <option value="off">{t`Off (strict: false)`}</option>
        </select>
      </label>
      {draft.strictMode === 'follow' && caps.toolStrict === false ? (
        <p className="field-help">{t`Sent as strict: false, so optional tool parameters stay optional.`}</p>
      ) : null}
      <label>
        <span>
          <Trans>Thinking levels</Trans>
        </span>
        <select
          value={draft.effortMode}
          onChange={(event) => {
            const mode = event.target.value as ParamsDraft['effortMode'];
            // Choosing the values starts from what the model sends, so a change is one field, not six.
            set({ effortMode: mode, ...(mode === 'custom' && draft.effortMode !== 'custom' ? { effort: effortSeed(caps) } : {}) });
          }}
        >
          <option value="follow">{t`Follow the model`}</option>
          <option value="none">{t`Send none`}</option>
          <option value="custom">{t`Choose the values sent`}</option>
        </select>
      </label>
      {draft.effortMode === 'follow' && values !== '' ? <p className="field-help">{t`Sent as: ${{ values }}`}</p> : null}
      {draft.effortMode === 'custom' ? (
        <fieldset className="effort-wire">
          <legend>
            <Trans>The value sent for each level. Leave a level empty to not offer it.</Trans>
          </legend>
          {PARAM_LEVELS.map((level) => (
            <label key={level}>
              <span>{i18n._(LEVEL_NAMES[level])}</span>
              <input type="text" value={draft.effort[level]} onChange={(event) => set({ effort: { ...draft.effort, [level]: event.target.value } })} />
            </label>
          ))}
        </fieldset>
      ) : null}
      <label>
        <span>
          <Trans>Never send these fields</Trans>
        </span>
        <input type="text" placeholder={t`top_p, stop`} value={draft.deny} onChange={(event) => set({ deny: event.target.value })} />
      </label>
    </details>
  );
}

