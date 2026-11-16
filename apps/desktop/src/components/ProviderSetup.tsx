/**
 * Adding a provider: paste a key, see the models it can write with, press one (provider-gateway §2, "Adding a provider").
 * Everything else — the model's limits, how many requests run at once, prompt caching — is the gateway's to settle, so no field
 * asks for it. A custom OpenAI-compatible endpoint is the one secondary path, and it has the only "Advanced" disclosure.
 */
/* lingui-set comment="Interpolated values: model, name, provider, total" */

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@ui-sdk/react/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible';
import { Field, FieldDescription, FieldError, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Listbox, ListboxItem } from '@ui-sdk/react/listbox';
import { PasswordInput, PasswordInputControl, PasswordInputToggle } from '@ui-sdk/react/password-input';
import { Radio, RadioGroup, RadioIndicator } from '@ui-sdk/react/radio';
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control';
import { isolate } from '@caotang/i18n';
import { detectProvider, isLocalBase, presetFor, PRESETS, type PresetDef, type ProfileView } from '@caotang/gateway';

import { priceFromInputs, type ProviderService } from '../app/providers.js';
import { paramsFromDraft } from '../app/request-params-form.js';
import { SetupError, type SetupDiscovery, type SetupFailure } from '../app/provider-setup.js';
import { setupFailureText, type SetupFailureText } from '../app/provider-setup-model.js';
import { AdvancedOverrides, BLANK_ADVANCED, ModelList, type AdvancedDraft } from './ProviderFormParts.js';
import { useComposingEnter } from './shared.js';
import './provider-setup.css';

/** A key shorter than this is still being typed or pasted in part; nothing is checked before it. */
const MIN_KEY_LENGTH = 20;
/** The pause after the last change before a recognised key is checked, so a typed key is not sent half-written. */
const CHECK_DELAY_MS = 700;

type Step = 'form' | 'checking' | 'models' | 'saving' | 'done';

/** Providers that can be picked from the key's format: hosted, with a key, reachable from a page. */
const HOSTED: readonly PresetDef[] = PRESETS.filter((entry) => entry.local === undefined && entry.id !== 'mock' && entry.id !== 'generic');
const CUSTOM_KINDS: readonly string[] = ['generic', 'ollama', 'lmstudio', 'llamacpp'];

function headersOf(draft: AdvancedDraft): Record<string, string> | undefined {
  const rows = draft.headers.filter((header) => header.name.trim() !== '');
  return rows.length === 0 ? undefined : Object.fromEntries(rows.map((header) => [header.name, header.value]));
}

export function ProviderSetup({
  providers,
  onDone,
  onClose,
}: {
  readonly providers: ProviderService;
  readonly onDone: (view: ProfileView, note?: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [custom, setCustom] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [fields, setFields] = useState<Readonly<Record<string, string>>>({});
  const [customKind, setCustomKind] = useState('generic');
  const [address, setAddress] = useState('');
  const [advanced, setAdvanced] = useState<AdvancedDraft>(BLANK_ADVANCED);
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<SetupFailureText | null>(null);
  const [typedModel, setTypedModel] = useState('');
  const [discovery, setDiscovery] = useState<SetupDiscovery | null>(null);
  const [done, setDone] = useState<{ readonly name: string; readonly model: string; readonly note?: string } | null>(null);

  const ime = useComposingEnter();
  const run = useRef(0);
  const lastChecked = useRef('');
  const open = useRef<SetupDiscovery | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const keyField = useRef<HTMLInputElement>(null);

  const detection = useMemo(() => detectProvider(apiKey), [apiKey]);
  const presetId = custom ? customKind : (chosen ?? detection.preset);
  const preset = presetId === undefined ? undefined : presetFor(presetId);
  const keyReady = apiKey.trim().length >= MIN_KEY_LENGTH;
  const needsFields = !custom && preset?.fields !== undefined;
  const fieldsOk = preset?.fields?.every((field) => field.required !== true || (fields[field.key] ?? '').trim() !== '') ?? true;
  const isLocal = preset?.local !== undefined;
  const canCheck = custom
    ? address.trim() !== '' && (isLocal || customKind === 'generic')
    : apiKey.trim() !== '' && preset !== undefined && fieldsOk;

  useEffect(() => {
    open.current = discovery;
  }, [discovery]);

  useEffect(() => () => {
    run.current += 1;
    if (open.current !== null) void providers.cancelSetup(open.current.draftId);
  }, [providers]);

  useEffect(() => {
    if (step === 'models' || step === 'done') heading.current?.focus();
    if (step === 'form') keyField.current?.focus();
  }, [step]);

  /** Setup inputs changed: the run in flight belongs to the old inputs, so its draft is abandoned when it lands. */
  const invalidate = (): void => {
    run.current += 1;
    setError(null);
    setStep('form');
  };

  const check = async (): Promise<void> => {
    if (preset === undefined || !canCheck) return;
    const token = ++run.current;
    lastChecked.current = `${preset.id}\n${apiKey.trim()}`;
    setStep('checking');
    setError(null);
    try {
      const found = await providers.beginSetup({
        preset: preset.id,
        apiKey: apiKey.trim(),
        ...(custom ? { baseUrl: address.trim() } : {}),
        ...(Object.keys(fields).length === 0 ? {} : { fields }),
        ...(custom && customKind === 'generic' && headersOf(advanced) !== undefined ? { customHeaders: headersOf(advanced) } : {}),
      });
      if (token !== run.current) {
        void providers.cancelSetup(found.draftId);
        return;
      }
      setDiscovery(found);
      setStep('models');
    } catch (failure) {
      if (token !== run.current) return;
      const failed: SetupFailure = failure instanceof SetupError ? failure.failure : { kind: 'probe', failure: { cause: 'unknown' } };
      setError(setupFailureText(preset.name, failed));
      setStep('form');
    }
  };

  useEffect(() => {
    if (custom || step !== 'form' || !keyReady || preset === undefined || needsFields) return;
    if (lastChecked.current === `${preset.id}\n${apiKey.trim()}`) return;
    const timer = setTimeout(() => void check(), CHECK_DELAY_MS);
    return () => clearTimeout(timer);
    // check reads the current state; the key, the provider and the step are what decide when to run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, presetId, custom, step, keyReady, needsFields]);

  const finish = async (model: string): Promise<void> => {
    if (discovery === null) return;
    const price = custom ? priceFromInputs(advanced.promptPrice, advanced.completionPrice) : ({ ok: true } as const);
    const request = custom ? paramsFromDraft(advanced.params) : ({ ok: true } as const);
    if (!price.ok) return setError({ text: price.message, canTypeModel: false, aboutKey: false });
    if (!request.ok) return setError({ text: t`Temperature must be a number from 0 to 2.`, canTypeModel: false, aboutKey: false });
    setStep('saving');
    setError(null);
    try {
      const { view, note } = await providers.finishSetup(discovery.draftId, model, {
        ...(price.price === undefined ? {} : { pricePer1k: price.price }),
        ...(request.params === undefined ? {} : { params: request.params }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      });
      setDiscovery(null);
      setDone({ name: view.name, model: view.defaultModel, ...(note === undefined ? {} : { note }) });
      setStep('done');
      onDone(view, note);
    } catch (failure) {
      setError({ text: failure instanceof Error ? failure.message : String(failure), canTypeModel: false, aboutKey: false });
      setStep('models');
    }
  };

  const submitTypedModel = async (): Promise<void> => {
    if (preset === undefined || typedModel.trim() === '') return;
    const price = priceFromInputs(advanced.promptPrice, advanced.completionPrice);
    const request = paramsFromDraft(advanced.params);
    if (!price.ok) return setError({ text: price.message, canTypeModel: true, aboutKey: false });
    if (!request.ok) return setError({ text: t`Temperature must be a number from 0 to 2.`, canTypeModel: true, aboutKey: false });
    setStep('saving');
    try {
      const outcome = await providers.addProfile({
        name: providers.freeName(preset.name),
        kind: 'endpoint',
        preset: preset.id,
        baseUrl: address.trim(),
        apiKey: apiKey.trim(),
        defaultModel: typedModel.trim(),
        ...(headersOf(advanced) === undefined ? {} : { customHeaders: headersOf(advanced) }),
        ...(price.price === undefined ? {} : { pricePer1k: price.price }),
        ...(request.params === undefined ? {} : { params: request.params }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      });
      const { note } = await providers.activate(outcome.view.id);
      setDone({ name: outcome.view.name, model: outcome.view.defaultModel, ...(note === undefined ? {} : { note }) });
      setStep('done');
      onDone(providers.get(outcome.view.id) ?? outcome.view, note);
    } catch (failure) {
      setError({ text: failure instanceof Error ? failure.message : String(failure), canTypeModel: true, aboutKey: false });
      setStep('form');
    }
  };

  const back = (): void => {
    run.current += 1;
    if (discovery !== null) void providers.cancelSetup(discovery.draftId);
    setDiscovery(null);
    setError(null);
    setStep('form');
  };

  const reset = (): void => {
    setApiKey('');
    setChosen(null);
    setPicking(false);
    setFields({});
    setAdvanced(BLANK_ADVANCED);
    setTypedModel('');
    setAddress('');
    setCustomKind('generic');
    setCustom(false);
    setDone(null);
    setError(null);
    lastChecked.current = '';
    setStep('form');
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    if (step === 'form') void check();
  };

  if (step === 'done' && done !== null) {
    const doneName = isolate(done.name);
    const doneModel = done.model;
    return (
      <section className="provider-setup profile-form" aria-labelledby="provider-setup-title">
        <h4 id="provider-setup-title" ref={heading} tabIndex={-1}>
          <Trans>{doneName} is ready</Trans>
        </h4>
        <p role="status">
          <Trans>The agent now uses <bdi>{doneModel}</bdi>.</Trans>
        </p>
        {done.note === undefined ? null : <p className="field-help">{done.note}</p>}
        <div className="profile-form-actions">
          <Button className="button is-primary" onClick={onClose}><Trans>Done</Trans></Button>
          <Button className="button is-quiet" onClick={reset}><Trans>Add another provider</Trans></Button>
        </div>
      </section>
    );
  }

  if ((step === 'models' || step === 'saving') && discovery !== null) {
    const acceptedBy = isolate(discovery.preset.name);
    return (
      <section className="provider-setup profile-form" aria-labelledby="provider-setup-title">
        <h4 id="provider-setup-title" ref={heading} tabIndex={-1}>
          <Trans>Choose a model</Trans>
        </h4>
        <p className="provider-accepted" role="status">
          {step === 'saving' ? <Trans>Setting up…</Trans> : <Trans>{acceptedBy} accepted the key.</Trans>}
        </p>
        {discovery.source === 'table' ? (
          <p className="field-help"><Trans>This provider documents no model list, so these are the models Caotang knows for it.</Trans></p>
        ) : null}
        <ModelList models={discovery.models} disabled={step === 'saving'} label={t`Models you can use with ${{ provider: discovery.preset.name }}`} onPick={(id) => void finish(id)} />
        {error === null ? null : <p className="form-message is-error" role="alert">{error.text}</p>}
        <div className="profile-form-actions">
          <Button className="button is-quiet" disabled={step === 'saving'} onClick={back}><Trans>Use a different key</Trans></Button>
          <Button className="button is-quiet" disabled={step === 'saving'} onClick={onClose}><Trans>Cancel</Trans></Button>
        </div>
      </section>
    );
  }

  const checking = step === 'checking' || step === 'saving';
  const candidates = detection.candidates.map((id) => presetFor(id)).filter((entry): entry is PresetDef => entry !== undefined);
  const rest = HOSTED.filter((entry) => !candidates.includes(entry));
  const showProviders = !custom && keyReady && (detection.preset === undefined || picking);
  const provider = preset === undefined ? undefined : isolate(preset.name);
  const detectedName = preset?.name ?? '';

  return (
    <form className="provider-setup profile-form" aria-labelledby="provider-setup-title" onKeyDown={ime.noteKey} onSubmit={submit}>
      <h4 id="provider-setup-title" ref={heading} tabIndex={-1}>
        {custom ? <Trans>Custom endpoint</Trans> : <Trans>Add a provider</Trans>}
      </h4>

      {custom ? (
        <>
          <Field className="field">
            <FieldLabel><Trans>Endpoint type</Trans></FieldLabel>
            <SegmentedControl
              value={customKind}
              onValueChange={(kind) => {
                if (typeof kind !== 'string') return;
                const next = presetFor(kind);
                setCustomKind(kind);
                setAddress(next?.local === undefined ? '' : next.baseUrl);
                invalidate();
              }}
            >
              <SegmentedControlIndicator />
              {CUSTOM_KINDS.map((id) => (
                <SegmentedControlItem key={id} value={id}>{id === 'generic' ? t`Custom URL` : (presetFor(id)?.name ?? id)}</SegmentedControlItem>
              ))}
            </SegmentedControl>
          </Field>
          <Field className="field">
            <FieldLabel>{isLocal ? <Trans>Server address (on this computer, ending in /v1)</Trans> : <Trans>Endpoint (the base URL, ending in /v1)</Trans>}</FieldLabel>
            <Input type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder={preset?.local === undefined ? 'https://openrouter.ai/api/v1' : preset.baseUrl} value={address} onValueChange={(value) => { setAddress(value); invalidate(); }} />
          </Field>
          {preset?.local === undefined ? null : (
            <>
              <p className="field-help">
                {preset.local.setup}{' '}
                {preset.docsUrl === undefined ? null : (
                  <a href={preset.docsUrl} target="_blank" rel="noopener noreferrer">
                    {t`${{ product: preset.local.product }} documentation`}
                  </a>
                )}
              </p>
              <p className="field-help">
                <Trans>
                  The first time, Chrome and Edge ask whether this site may connect to apps on your device. Choose Allow; if you decline,
                  requests are blocked until you allow them in the site settings. Safari is unverified.
                </Trans>
              </p>
              {isLocalBase(address) ? <p className="field-help"><Trans>Your text stays on this computer.</Trans></p> : null}
            </>
          )}
        </>
      ) : null}

      <Field className="field" invalid={error?.aboutKey === true || undefined}>
        <FieldLabel>{custom ? <Trans>API key (optional — only if the endpoint needs one)</Trans> : <Trans>API key</Trans>}</FieldLabel>
        <PasswordInput
          value={apiKey}
          autoComplete="off"
          onValueChange={(value) => {
            setApiKey(value);
            setChosen(null);
            setPicking(false);
            invalidate();
          }}
        >
          <PasswordInputControl ref={keyField} placeholder={custom ? undefined : t`Paste your API key`} spellCheck={false} autoCapitalize="off" />
          <PasswordInputToggle aria-label={t`Show the key`}>{(state) => (state.visible ? <Trans>Hide</Trans> : <Trans>Show</Trans>)}</PasswordInputToggle>
        </PasswordInput>
        {custom || apiKey !== '' ? null : (
          <FieldDescription><Trans>Caotang recognises the provider from the key. The key is encrypted in this browser and never written into a project.</Trans></FieldDescription>
        )}
        {error?.aboutKey === true ? <FieldError match>{error.text}</FieldError> : null}
      </Field>

      {!custom && keyReady && detection.preset !== undefined && !picking && preset !== undefined ? (
        <p className="provider-detected" role="status">
          <span><Trans>Looks like a key from <bdi>{detectedName}</bdi>.</Trans></span>
          <Button className="button is-quiet" onClick={() => setPicking(true)}><Trans>Not right? Choose a provider</Trans></Button>
        </p>
      ) : null}

      {showProviders ? (
        <>
        <Field className="field">
          <FieldLabel><Trans>Which provider is this key from?</Trans></FieldLabel>
          <RadioGroup value={chosen ?? ''} onValueChange={(next) => { if (typeof next === 'string' && next !== '') { setChosen(next); invalidate(); } }}>
            {candidates.map((entry) => (
              <label data-slot="label" key={entry.id}>
                <Radio value={entry.id}><RadioIndicator /></Radio>
                {entry.name}
              </label>
            ))}
          </RadioGroup>
        </Field>
          <Collapsible className="more-providers">
            <CollapsibleTrigger className="button is-quiet"><Trans>More providers</Trans></CollapsibleTrigger>
            <CollapsiblePanel>
              <Listbox aria-label={t`More providers`} activation="manual" value={rest.some((entry) => entry.id === chosen) ? chosen : null} onValueChange={(next) => { if (typeof next === 'string') { setChosen(next); invalidate(); } }}>
                {rest.map((entry) => (
                  <ListboxItem key={entry.id} value={entry.id}>
                    {entry.cors === 'blocked' ? t`${{ provider: entry.name }} — Desktop app or hosted only` : entry.name}
                  </ListboxItem>
                ))}
              </Listbox>
            </CollapsiblePanel>
          </Collapsible>
        </>
      ) : null}

      {needsFields && preset !== undefined && keyReady ? (
        <div className="preset-fields">
          {preset.fields?.map((field) =>
            field.options === undefined ? (
              <Field className="field" key={field.key}>
                <FieldLabel>{field.required === true ? field.label : t`${{ field: field.label }} (optional)`}</FieldLabel>
                <Input value={fields[field.key] ?? ''} autoComplete="off" spellCheck={false} onValueChange={(value) => { setFields({ ...fields, [field.key]: value }); invalidate(); }} />
              </Field>
            ) : (
              <Field className="field" key={field.key}>
                <FieldLabel>{field.label}</FieldLabel>
                <Listbox aria-label={field.label} activation="manual" value={fields[field.key] ?? field.defaultValue ?? null} onValueChange={(next) => { if (typeof next === 'string') { setFields({ ...fields, [field.key]: next }); invalidate(); } }}>
                  {field.options.map((option) => <ListboxItem key={option.value} value={option.value}>{option.label}</ListboxItem>)}
                </Listbox>
              </Field>
            ),
          )}
        </div>
      ) : null}

      {preset?.cors === 'blocked' ? (
        <p className="field-help"><Trans>Desktop app or hosted only</Trans>{preset.corsNote === undefined ? null : ` — ${preset.corsNote}`}</p>
      ) : null}

      {checking ? (
        <p className="provider-checking" role="status">
          {provider === undefined ? <Trans>Checking the key…</Trans> : <Trans>Checking the key with {provider}…</Trans>}
        </p>
      ) : null}

      {error !== null && error.aboutKey !== true ? (
        <p className="form-message is-error" role="alert">
          {error.text}
          {error.detail === undefined ? null : <><br /><strong>{error.detail.label}</strong> <bdi>{error.detail.text}</bdi></>}
        </p>
      ) : null}

      {custom && error?.canTypeModel === true ? (
        <Field className="field">
          <FieldLabel><Trans>Model name the endpoint expects</Trans></FieldLabel>
          <Input value={typedModel} autoComplete="off" spellCheck={false} placeholder="openai/gpt-4.1-mini" onValueChange={setTypedModel} />
          <Button className="button" disabled={typedModel.trim() === '' || checking} onClick={() => void submitTypedModel()}><Trans>Use this model</Trans></Button>
        </Field>
      ) : null}

      {custom ? (
        <AdvancedOverrides
          draft={advanced}
          onChange={setAdvanced}
          preset={customKind}
          baseUrl={address}
          model={typedModel}
          providerName={preset?.name ?? ''}
          headers={customKind === 'generic'}
        />
      ) : null}

      <div className="profile-form-actions">
        <Button type="submit" className="button is-primary" disabled={checking || !canCheck}>
          {custom ? <Trans>Connect and list models</Trans> : <Trans>Check key</Trans>}
        </Button>
        <Button className="button is-quiet" disabled={checking} onClick={onClose}><Trans>Cancel</Trans></Button>
      </div>

      <p className="provider-secondary">
        {custom ? (
          <Button className="button is-quiet" disabled={checking} onClick={() => { setCustom(false); invalidate(); }}><Trans>Back to a key from a provider</Trans></Button>
        ) : (
          <Button className="button is-quiet" disabled={checking} onClick={() => { setCustom(true); setCustomKind('generic'); setAddress(''); invalidate(); }}><Trans>Custom endpoint</Trans></Button>
        )}
      </p>
    </form>
  );
}
