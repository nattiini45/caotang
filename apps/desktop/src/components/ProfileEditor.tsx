/**
 * Editing a saved provider: its name, a replacement key, and the model, chosen from what the provider lists now. A custom endpoint
 * or local server also has its address, and a profile with saved overrides shows them under the one "Advanced" disclosure.
 */
/* lingui-set comment="Interpolated values: model, profile" */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@ui-sdk/react/button';
import { Field, FieldDescription, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { PasswordInput, PasswordInputControl, PasswordInputToggle } from '@ui-sdk/react/password-input';
import { chooseModels, presetFor, presetForProfile, type ModelChoice, type ProfileView } from '@caotang/gateway';

import { priceClearedBy, priceFromInputs, type ProviderService, type SaveOutcome } from '../app/providers.js';
import { paramsDraftOf, paramsFromDraft } from '../app/request-params-form.js';
import { AdvancedOverrides, ModelList, type AdvancedDraft } from './ProviderFormParts.js';
import { useComposingEnter } from './shared.js';
import './provider-setup.css';

function advancedOf(view: ProfileView): AdvancedDraft {
  return {
    headers: [],
    headersTouched: false,
    params: paramsDraftOf(view),
    promptPrice: view.pricePer1k === undefined ? '' : String(view.pricePer1k.prompt),
    completionPrice: view.pricePer1k === undefined ? '' : String(view.pricePer1k.completion),
  };
}

export function ProfileEditor({
  providers,
  profile,
  onSaved,
  onClose,
}: {
  readonly providers: ProviderService;
  readonly profile: ProfileView;
  readonly onSaved: (outcome: SaveOutcome) => void;
  readonly onClose: () => void;
}): ReactNode {
  const preset = presetFor(profile.kind === 'mock' ? 'mock' : profile.preset);
  const effective = presetForProfile(profile) ?? preset;
  const isMock = profile.kind === 'mock';
  const typedAddress = !isMock && (profile.preset === undefined || profile.preset === 'generic' || preset?.local !== undefined);
  const showAdvanced = !isMock;

  const [name, setName] = useState(profile.name);
  const [apiKey, setApiKey] = useState('');
  const [address, setAddress] = useState(profile.baseUrl);
  const [fields, setFields] = useState<Readonly<Record<string, string>>>(profile.fields ?? {});
  const [model, setModel] = useState(profile.defaultModel);
  const [advanced, setAdvanced] = useState<AdvancedDraft>(() => advancedOf(profile));
  const [listed, setListed] = useState<readonly ModelChoice[] | 'loading' | 'failed'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ime = useComposingEnter();

  useEffect(() => {
    if (isMock) return;
    let current = true;
    providers.listModels(profile.id).then(
      (models) => { if (current) setListed(chooseModels(effective, models)); },
      () => { if (current) setListed('failed'); },
    );
    return () => { current = false; };
  }, [providers, profile.id, isMock, effective]);

  const choices: readonly ModelChoice[] =
    listed === 'loading' || listed === 'failed' ? [] : listed.some((choice) => choice.id === profile.defaultModel) ? listed : [{ id: profile.defaultModel, recommended: false }, ...listed];

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    const price = showAdvanced ? priceFromInputs(advanced.promptPrice, advanced.completionPrice) : ({ ok: true } as const);
    const request = showAdvanced ? paramsFromDraft(advanced.params) : ({ ok: true } as const);
    if (!price.ok) return setError(price.message);
    if (!request.ok) return setError(t`Temperature must be a number from 0 to 2.`);
    const priceChange = price.price ?? (priceClearedBy(advanced.promptPrice, advanced.completionPrice) && profile.pricePer1k !== undefined ? null : undefined);
    const rows = advanced.headers.filter((header) => header.name.trim() !== '');
    const headersPatch = !showAdvanced || profile.preset !== 'generic' || !advanced.headersTouched ? undefined : rows.length === 0 ? null : Object.fromEntries(rows.map((header) => [header.name, header.value]));
    setBusy(true);
    setError(null);
    void providers
      .editProfile(profile.id, {
        name,
        ...(typedAddress ? { baseUrl: address } : {}),
        ...(preset?.fields === undefined ? {} : { fields }),
        ...(headersPatch === undefined ? {} : { customHeaders: headersPatch }),
        ...(isMock ? {} : { defaultModel: model }),
        ...(apiKey === '' ? {} : { apiKey }),
        ...(showAdvanced ? { ...(priceChange === undefined ? {} : { pricePer1k: priceChange }), params: request.params ?? null, temperature: request.temperature ?? null } : {}),
      })
      .then(onSaved, (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(false));
  };

  const keyOptional = preset?.keyOptional === true || preset?.local !== undefined;
  const label = t`Models you can use with ${{ provider: profile.name }}`;
  return (
    <form className="provider-setup profile-form" aria-label={t`Edit provider`} onKeyDown={ime.noteKey} onSubmit={save}>
      <h4><Trans>Edit provider</Trans></h4>
      <Field className="field">
        <FieldLabel><Trans>Name</Trans></FieldLabel>
        <Input value={name} maxLength={80} onValueChange={setName} />
      </Field>
      {typedAddress ? (
        <Field className="field">
          <FieldLabel>{preset?.local === undefined ? <Trans>Endpoint (the base URL, ending in /v1)</Trans> : <Trans>Server address (on this computer, ending in /v1)</Trans>}</FieldLabel>
          <Input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={address} onValueChange={setAddress} />
        </Field>
      ) : null}
      {preset?.fields?.map((field) => (
        <Field className="field" key={field.key}>
          <FieldLabel>{field.label}</FieldLabel>
          <Input value={fields[field.key] ?? field.defaultValue ?? ''} autoComplete="off" spellCheck={false} onValueChange={(value) => setFields({ ...fields, [field.key]: value })} />
        </Field>
      ))}
      {isMock ? null : (
        <Field className="field">
          <FieldLabel><Trans>Replace the API key</Trans></FieldLabel>
          <PasswordInput value={apiKey} autoComplete="off" onValueChange={setApiKey}>
            <PasswordInputControl spellCheck={false} autoCapitalize="off" />
            <PasswordInputToggle aria-label={t`Show the key`}>{(state) => (state.visible ? <Trans>Hide</Trans> : <Trans>Show</Trans>)}</PasswordInputToggle>
          </PasswordInput>
          <FieldDescription>
            {keyOptional ? <Trans>Optional. Leave empty to keep the stored key.</Trans> : <Trans>Leave empty to keep the stored key.</Trans>}
          </FieldDescription>
        </Field>
      )}
      {isMock ? null : listed === 'loading' ? (
        <p className="provider-checking" role="status"><Trans>Loading the models…</Trans></p>
      ) : listed === 'failed' ? (
        <Field className="field">
          <FieldLabel><Trans>Model name the endpoint expects</Trans></FieldLabel>
          <Input value={model} autoComplete="off" spellCheck={false} onValueChange={setModel} />
          <FieldDescription><Trans>The provider did not list its models just now, so the name stays as it is unless you change it.</Trans></FieldDescription>
        </Field>
      ) : (
        <Field className="field">
          <FieldLabel><Trans>Model</Trans></FieldLabel>
          <ModelList models={choices} value={model} label={label} onPick={setModel} />
        </Field>
      )}
      {showAdvanced ? (
        <AdvancedOverrides
          draft={advanced}
          onChange={setAdvanced}
          preset={profile.preset ?? 'generic'}
          baseUrl={address}
          model={model}
          providerName={preset?.name ?? ''}
          headers={profile.preset === 'generic'}
          keepHeaders
        />
      ) : null}
      {error === null ? null : <p className="form-message is-error" role="alert">{error}</p>}
      <div className="profile-form-actions">
        <Button type="submit" className="button is-primary" disabled={busy}><Trans>Save changes</Trans></Button>
        <Button className="button is-quiet" disabled={busy} onClick={onClose}><Trans>Cancel</Trans></Button>
      </div>
    </form>
  );
}
