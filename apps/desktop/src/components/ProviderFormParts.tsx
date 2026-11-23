/**
 * The pieces the add-a-provider flow and the profile editor share (provider-gateway §2, "Adding a provider"): the list a person
 * picks a model from, and the one collapsed "Advanced" disclosure that holds what Caotang cannot learn by itself.
 */
/* lingui-set comment="Interpolated values: count, number, total" */

import { useId, useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@ui-sdk/react/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible';
import { Field, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Listbox, ListboxItem } from '@ui-sdk/react/listbox';
import type { ModelChoice } from '@caotang/gateway';

import { BLANK_PARAMS, type ParamsDraft } from '../app/request-params-form.js';
import { choiceFacts } from '../app/provider-details.js';
import { FILTER_MODEL_COUNT, visibleModels } from '../app/provider-setup-model.js';
import { RequestParamsFields } from './RequestParamsFields.js';
import './provider-setup.css';

/** A custom header as the editor holds it: a name and a value, both typed. Sealed with the key on save. */
export interface HeaderDraft {
  readonly name: string;
  readonly value: string;
}

export interface AdvancedDraft {
  readonly headers: readonly HeaderDraft[];
  /** Whether the header list was touched on this edit. Untouched sends no patch, so the sealed set is kept; touched and emptied clears it. */
  readonly headersTouched: boolean;
  readonly params: ParamsDraft;
  /** Dollars per 1,000 prompt and reply tokens, as typed. Empty is no price. */
  readonly promptPrice: string;
  readonly completionPrice: string;
}

export const BLANK_ADVANCED: AdvancedDraft = { headers: [], headersTouched: false, params: BLANK_PARAMS, promptPrice: '', completionPrice: '' };

/**
 * The models a key can write with, any number of them picked (provider-gateway §2, "One connection, many models"). The list keeps
 * the focus on the option and toggles on Enter, Space or a press, never on an arrow key (`activation="manual"`), so moving through a
 * long list does not change what the connection holds by accident. `value` is the picked list in the order it was picked, and its
 * first entry is the model a new conversation starts on.
 */
export function ModelList({
  models,
  value,
  disabled,
  label,
  onChange,
}: {
  readonly models: readonly ModelChoice[];
  readonly value: readonly string[];
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (next: readonly string[]) => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const { shown, hidden } = visibleModels(models, query, showAll);
  const filterable = models.length > FILTER_MODEL_COUNT;
  return (
    <div className="model-list">
      {filterable ? (
        <Field className="field">
          <FieldLabel><Trans>Filter models</Trans></FieldLabel>
          <Input type="search" value={query} autoComplete="off" spellCheck={false} onValueChange={setQuery} />
        </Field>
      ) : null}
      {shown.length === 0 ? (
        <p className="muted" role="status"><Trans>No model matches that filter.</Trans></p>
      ) : (
        <Listbox
          aria-label={label}
          activation="manual"
          multiple
          disabled={disabled}
          value={[...value]}
          onValueChange={(next) => onChange((Array.isArray(next) ? next : next === null ? [] : [next]) as readonly string[])}
        >
          {shown.map((model) => (
            <ListboxItem key={model.id} value={model.id} className="model-option">
              <span className="model-option-main">
                <code className="model-option-id">{model.id}</code>
                {model.recommended ? <span className="badge is-active"><Trans>Recommended</Trans></span> : null}
                {value[0] === model.id ? <span className="badge"><Trans>Default</Trans></span> : null}
              </span>
              {choiceFacts(model).length === 0 ? null : <span className="model-option-facts muted">{choiceFacts(model).join(' · ')}</span>}
            </ListboxItem>
          ))}
        </Listbox>
      )}
      {hidden > 0 ? (
        <Button className="button is-quiet" onClick={() => setShowAll(true)}>
          {t`Show all ${{ total: models.length }} models`}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Everything Caotang cannot work out for itself, closed by default. Each part is here because nothing else can say it:
 * extra headers (a gateway's own authentication), the request parameters (what a server it has no table row for takes) and the
 * price (no listing states one for a server of your own).
 */
export function AdvancedOverrides({
  draft,
  onChange,
  preset,
  baseUrl,
  model,
  providerName,
  headers,
  keepHeaders,
}: {
  readonly draft: AdvancedDraft;
  readonly onChange: (draft: AdvancedDraft) => void;
  readonly preset: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly providerName: string;
  readonly headers: boolean;
  /** An edit that has not touched the headers keeps the sealed set, which is never shown again. */
  readonly keepHeaders?: boolean;
}): ReactNode {
  const id = useId();
  const setHeader = (index: number, part: Partial<HeaderDraft>): void =>
    onChange({ ...draft, headersTouched: true, headers: draft.headers.map((header, i) => (i === index ? { ...header, ...part } : header)) });
  return (
    <Collapsible className="advanced">
      <CollapsibleTrigger className="button is-quiet advanced-trigger"><Trans>Advanced</Trans></CollapsibleTrigger>
      <CollapsiblePanel keepMounted className="advanced-panel">
        {headers ? (
          <fieldset className="price-fields">
            <legend><Trans>Extra request headers (optional)</Trans></legend>
            <p className="field-help">
              {keepHeaders === true
                ? t`Sent with every request, and sealed with the key — they are never shown again. Leave this list untouched to keep the stored set; empty it again to clear it.`
                : t`Sent with every request, and sealed with the key — they are never shown again.`}
            </p>
            {draft.headers.map((header, index) => (
              <div className="header-row" key={index}>
                <Input aria-label={t`Header ${{ number: index + 1 }} name`} placeholder={t`x-my-header`} value={header.name} autoComplete="off" onValueChange={(name) => setHeader(index, { name })} />
                <Input aria-label={t`Header ${{ number: index + 1 }} value`} type="password" autoComplete="off" placeholder={t`the header’s value`} value={header.value} onValueChange={(value) => setHeader(index, { value })} />
                <Button className="button is-quiet" aria-label={t`Remove header ${{ number: index + 1 }}`} onClick={() => onChange({ ...draft, headersTouched: true, headers: draft.headers.filter((_, i) => i !== index) })}>
                  <Trans>Remove</Trans>
                </Button>
              </div>
            ))}
            <Button className="button is-quiet" onClick={() => onChange({ ...draft, headersTouched: true, headers: [...draft.headers, { name: '', value: '' }] })}>
              <Trans>Add a header</Trans>
            </Button>
          </fieldset>
        ) : null}
        <RequestParamsFields draft={draft.params} preset={preset} baseUrl={baseUrl} model={model} providerName={providerName} onChange={(params) => onChange({ ...draft, params })} />
        <fieldset className="price-fields" aria-describedby={`${id}-price`}>
          <legend><Trans>Price per 1,000 tokens, in dollars (optional)</Trans></legend>
          <p className="field-help" id={`${id}-price`}>
            <Trans>Fill both to see the cost of a step. Empty both to remove a saved price.</Trans>
          </p>
          <Field className="field">
            <FieldLabel><Trans>Prompt</Trans></FieldLabel>
            <Input type="number" min={0} step="any" inputMode="decimal" value={draft.promptPrice} onValueChange={(promptPrice) => onChange({ ...draft, promptPrice })} />
          </Field>
          <Field className="field">
            <FieldLabel><Trans>Reply</Trans></FieldLabel>
            <Input type="number" min={0} step="any" inputMode="decimal" value={draft.completionPrice} onValueChange={(completionPrice) => onChange({ ...draft, completionPrice })} />
          </Field>
        </fieldset>
      </CollapsiblePanel>
    </Collapsible>
  );
}
