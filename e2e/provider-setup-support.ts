/**
 * Adding a provider through the key-first flow (provider-gateway §2, "Adding a provider"), for specs that need a profile on the
 * fake endpoint. The flow is the one a person takes: open the form, choose Custom endpoint, give the address, press Connect and list
 * models, press a model. It finishes with the profile saved and active, so a spec that used to add a profile and then press
 * Use this profile starts from the end.
 */

import { expect, type Locator } from '@playwright/test';

import { FAKE_ENDPOINT } from './endpoint.js';

/** The name the custom path gives a profile; the writer renames it with Edit. */
export const CUSTOM_PROFILE_NAME = 'OpenAI-compatible endpoint';

/** Opens the add-a-provider form: already open on a fresh install (only the demo profile exists), else behind its button. */
export async function openProviderSetup(settings: Locator): Promise<Locator> {
  const form = settings.getByRole('form', { name: 'Add a provider' });
  const button = settings.getByRole('button', { name: 'Add a provider', exact: true });
  await expect(form.or(button)).toBeVisible();
  if (await button.isVisible()) await button.click();
  await expect(form).toBeVisible();
  return form;
}

export interface CustomEndpointOptions {
  /** Renames the profile with Edit once it exists. */
  readonly name?: string;
  readonly model?: string;
  readonly url?: string;
  readonly key?: string;
  /** Dollars per 1,000 tokens, typed under Advanced. */
  readonly prices?: { readonly prompt: string; readonly reply: string };
  /** Several models picked under the one key, after `model` or in its place. */
  readonly models?: readonly string[];
}

/** Opens the Custom endpoint path and lists the models of the address, stopping on the model list. */
export async function listCustomEndpoint(settings: Locator, options: CustomEndpointOptions = {}): Promise<Locator> {
  const form = await openProviderSetup(settings);
  await form.getByRole('button', { name: 'Custom endpoint' }).click();
  const custom = settings.getByRole('form', { name: 'Custom endpoint' });
  await custom.getByLabel('Endpoint (the base URL, ending in /v1)').fill(options.url ?? FAKE_ENDPOINT);
  if (options.key !== undefined) await custom.getByLabel('API key (optional — only if the endpoint needs one)').fill(options.key);
  if (options.prices !== undefined) {
    await custom.getByRole('button', { name: 'Advanced' }).click();
    await custom.getByLabel('Prompt', { exact: true }).fill(options.prices.prompt);
    await custom.getByLabel('Reply', { exact: true }).fill(options.prices.reply);
  }
  await custom.getByRole('button', { name: 'Connect and list models' }).click();
  await expect(settings.getByRole('heading', { name: 'Choose the models' })).toBeVisible();
  return settings.getByRole('listbox');
}

/**
 * Leaves exactly `names` picked under the connection, in that order, so the first is the model a new conversation starts on. The list
 * opens on the recommended model, so a spec that wants another one has to unpick it: a press on an option toggles it.
 */
export async function pickModels(settings: Locator, names: readonly string[]): Promise<void> {
  const list = settings.getByRole('listbox');
  const optionOf = (id: string) => list.getByRole('option', { name: new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) });
  for (const before of await list.getByRole('option', { selected: true }).all()) {
    const id = (await before.locator('.model-option-id').innerText()).trim();
    await optionOf(id).click();
    await expect(optionOf(id)).toHaveAttribute('aria-selected', 'false');
  }
  for (const id of names) {
    await optionOf(id).click();
    await expect(optionOf(id)).toHaveAttribute('aria-selected', 'true');
  }
}

/**
 * Adds the fake endpoint as a custom endpoint and finishes the setup; the profile is saved and active when this returns. The model
 * list starts on the recommended model, so the ordinary spec finishes with the one button; `models` picks several under one key.
 */
export async function addCustomEndpoint(settings: Locator, options: CustomEndpointOptions = {}): Promise<string> {
  await listCustomEndpoint(settings, options);
  await pickModels(settings, options.models ?? [options.model ?? 'test-model']);
  await finishModelPick(settings);
  if (options.name === undefined) return CUSTOM_PROFILE_NAME;
  await renameProfile(settings, CUSTOM_PROFILE_NAME, options.name);
  return options.name;
}

/** Presses the models step's finish button and waits for the ready screen, then closes the setup. */
export async function finishModelPick(settings: Locator): Promise<void> {
  await settings.getByRole('button', { name: /^Use (this model|these \d+ models)$/ }).click();
  await expect(settings.getByRole('heading', { name: /is ready$/ })).toBeVisible();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
}

/** Adds a hosted provider from its key: pastes the key, picks the provider when the key does not name it, presses a model. */
export async function addHostedProvider(settings: Locator, options: { readonly key: string; readonly provider?: string; readonly model: string; readonly name?: string; readonly prices?: { readonly prompt: string; readonly reply: string } }): Promise<string> {
  const form = await openProviderSetup(settings);
  await form.getByLabel('API key', { exact: true }).fill(options.key);
  if (options.provider !== undefined) await form.getByRole('radio', { name: options.provider }).check();
  await expect(settings.getByRole('heading', { name: 'Choose the models' })).toBeVisible();
  await pickModels(settings, [options.model]);
  await settings.getByRole('button', { name: /^Use (this model|these \d+ models)$/ }).click();
  await expect(settings.getByRole('heading', { name: /is ready$/ })).toBeVisible();
  const ready = await settings.getByRole('heading', { name: /is ready$/ }).innerText();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  const made = ready.replace(/[\u2066-\u2069]/g, '').replace(/ is ready$/, '');
  if (options.name === undefined && options.prices === undefined) return made;
  const name = options.name ?? made;
  await editProfile(settings, made, { name, ...(options.prices === undefined ? {} : { prices: options.prices }) });
  return name;
}

/** Changes a saved profile with Edit: a new name, a price under Advanced, or both. */
export async function editProfile(settings: Locator, from: string, change: { readonly name?: string; readonly prices?: { readonly prompt: string; readonly reply: string } }): Promise<void> {
  await settings.locator('[data-profile="' + from + '"]').getByRole('button', { name: 'Edit' }).click();
  const form = settings.getByRole('form', { name: 'Edit provider' });
  if (change.name !== undefined) await form.getByLabel('Name').fill(change.name);
  if (change.prices !== undefined) {
    await form.getByRole('button', { name: 'Advanced' }).click();
    await form.getByLabel('Prompt', { exact: true }).fill(change.prices.prompt);
    await form.getByLabel('Reply', { exact: true }).fill(change.prices.reply);
  }
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(settings.locator('[data-profile="' + (change.name ?? from) + '"]')).toBeVisible();
  await expect(form).toHaveCount(0);
}

/** Renames a profile with Edit. */
export async function renameProfile(settings: Locator, from: string, to: string): Promise<void> {
  await editProfile(settings, from, { name: to });
}
