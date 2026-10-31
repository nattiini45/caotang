/**
 * Settings (ui-modules §5): a dialog with four sections. Providers holds the profiles, the save-time probe, the usage totals
 * and the request log. Writing holds the session target and the autosave debounce. Appearance holds the theme. Data holds the
 * browser's storage answer, the checkpoint figures and their limits.
 *
 * Every field is validated where it is typed, and the store answers the rest. A probe that fails is shown beside the profile
 * it concerns, never as a toast alone (context-assembly §6).
 */
/* lingui-set comment="Interpolated values: DEBOUNCE_MAX_MS, DEBOUNCE_MIN_MS, DEMO_PROFILE_NAME, checkpointCap, checkpointDays, completion, entryCount, error, field, keptCount, keptDocuments, max, min, model, note, number, problem, product, profile, prompt, provider, requestsTotal, role, size" */

import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';
import {
  PRESETS,
  isLocalBase,
  modelRowFor,
  presetFor,
  type ModelInfo,
  type PresetDef,
  type ProfileView,
  type RequestLogEntry,
  type TaskRole,
  type ThinkingLevel,
} from '@caotang/gateway';
import { pictureStorageReport, snapshotBudget, type RuntimeStore, type SnapshotBudget } from '@caotang/store';

import type { AppServices } from '../app/services.js';
import type { Durability, ProjectSession } from '../app/session.js';
import { readDurability, durabilitySentence, formatBytes, usageSentence, type StorageHost, browserStorageHost } from '../app/storage.js';
import {
  CHECKPOINT_DAYS_MAX,
  CHECKPOINT_CAP_MAX,
  DEBOUNCE_MAX_MS,
  DEBOUNCE_MIN_MS,
  TARGET_MAX_WORDS,
  type RoleRef,
  type RoleSettings,
} from '../app/settings.js';
import { activeTheme, applyTheme, rememberTheme, type Theme } from '../app/theme.js';
import { developerLanguageExposure, languageRevision, subscribeLanguage, switchInterfaceLanguage } from '../i18n/language.js';
import { sameLanguageSetting } from '../i18n/catalogues.js';
import { useFormat } from '../i18n/use-format.js';
import { readListedLanguages, recordListedLanguages } from '../i18n/listed-languages.js';
import { activeTag } from '../i18n/runtime.js';
import { guideHref } from '../i18n/guide-links.js';
import { languageChoices, type InterfaceLanguageStats } from '../i18n/picker.js';
import languageStats from '../i18n/locales/stats.json';
import { timeLabel } from '../app/activity-model.js';
import { DEMO_PROFILE_NAME, priceClearedBy, priceFromInputs } from '../app/providers.js';
import { capsLine, modelDetails } from '../app/provider-details.js';
import { CoherenceSection } from './CoherenceSettings.js';
import { AgentModeSettings } from './AgentModeSettings.js';
import { ContextSection } from './ContextSection.js';
import { McpSection } from './McpSection.js';
import { PictureStorageMeter } from './PictureStorageMeter.js';
import { formatCount, useComposingEnter } from './shared.js';

/** The origin of an address, or the text itself when it does not parse (a form being typed). */
function originOf(address: string): string {
  try {
    return new URL(address).origin;
  } catch {
    return address;
  }
}

/** A message beside a form: inline, next to what it is about, and never a toast alone. */
function FormMessage({ message }: { message: { readonly text: string; readonly tone: 'info' | 'error' } | null }): ReactNode {
  if (message === null) return null;
  return (
    <p className={`form-message is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
      {message.text}
    </p>
  );
}

export type SettingsSection = 'providers' | 'context' | 'agent' | 'writing' | 'coherence' | 'mcp' | 'appearance' | 'data';

const SECTIONS: readonly { readonly id: SettingsSection; readonly label: MessageDescriptor }[] = [
  { id: 'providers', label: msg`Providers` },
  { id: 'context', label: msg`Context` },
  { id: 'agent', label: msg`Agent` },
  { id: 'writing', label: msg`Writing` },
  { id: 'coherence', label: msg`Coherence` },
  { id: 'mcp', label: msg`MCP & tools` },
  { id: 'appearance', label: msg`Appearance` },
  { id: 'data', label: msg`Data` },
];

export interface SettingsProps {
  readonly services: AppServices;
  /** The project in view, when there is one: its checkpoints and its storage figures belong to it. */
  readonly session: ProjectSession | null;
  readonly store: RuntimeStore | null;
  readonly initialSection?: SettingsSection;
  readonly onClose: () => void;
  /** Called after a provider changes, so a view that shows the active provider reads it again. */
  readonly onProvidersChanged?: () => void;
  /** The storage bridge; tests pass their own. Defaults to the browser's. */
  readonly storage?: StorageHost | null;
}

export function Settings({
  services,
  session,
  store,
  initialSection = 'providers',
  onClose,
  onProvidersChanged,
  storage,
}: SettingsProps): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  // The control that opened the dialog takes focus back when it closes, so the keyboard is where it was (Menu and ExportDialog do
  // the same). It is read on the first render, before the dialog takes focus. While the dialog is modal the rest of the page is
  // inert, so the focus call made during a development double-mount is a no-op and the dialog keeps focus.
  const [opener] = useState<Element | null>(() => document.activeElement);
  useEffect(
    () => () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    },
    [opener],
  );

  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="settings"
      aria-labelledby="settings-title"
      data-testid="settings"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="settings-frame">
        <header className="settings-head">
          <h2 id="settings-title">
            <Trans>Settings</Trans>
          </h2>
          <button type="button" className="button is-quiet" onClick={onClose}>
            <Trans>Close</Trans>
          </button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t`Settings sections`}>
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                data-section={entry.id}
                className={`settings-nav-item${section === entry.id ? ' is-current' : ''}`}
                aria-current={section === entry.id ? 'page' : undefined}
                onClick={() => setSection(entry.id)}
              >
                {i18n._(entry.label)}
              </button>
            ))}
          </nav>
          <div className="settings-body">
            {section === 'providers' ? <ProvidersSection services={services} onChanged={onProvidersChanged} /> : null}
            {section === 'context' ? <ContextSection services={services} session={session} /> : null}
            {section === 'agent' ? <AgentSection services={services} /> : null}
            {section === 'writing' ? <WritingSection services={services} /> : null}
            {section === 'coherence' ? <CoherenceSection services={services} /> : null}
            {section === 'mcp' ? <McpSection mcp={services.mcp} /> : null}
            {section === 'appearance' ? <AppearanceSection services={services} /> : null}
            {section === 'data' ? <DataSection services={services} session={session} store={store} storage={storage} /> : null}
          </div>
        </div>
      </div>
    </dialog>
  );
}

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

/** A custom header as the editor holds it: a name and a value, both typed. Sealed with the key on save. */
interface HeaderDraft {
  readonly name: string;
  readonly value: string;
}

interface FormState {
  readonly id: string | null;
  /**
   * The preset the profile runs under — provider-gateway §2 fixes it at creation (the record's `preset`), so the
   * picker is a choice only while the profile is new. `'mock'` is the demo profile, which is never created here.
   */
  readonly preset: string;
  readonly name: string;
  /** The base URL, typed only for a generic endpoint; a named preset's URL is its own (derived from its fields). */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  /** The preset's extra fields (region, workspace id), keyed by their declared keys. */
  readonly fields: Readonly<Record<string, string>>;
  /** The generic endpoint's custom headers as typed. Sealed on save; a stored set is never shown again. */
  readonly headers: readonly HeaderDraft[];
  /**
   * Whether the header list was touched on this edit. Untouched sends no patch, so the sealed set is kept; touched
   * and emptied clears it (ProfilePatch's `null`).
   */
  readonly headersTouched: boolean;
  /** The two optional price fields, as typed: dollars per 1,000 prompt tokens and per 1,000 reply tokens. Empty is no price. */
  readonly promptPrice: string;
  readonly completionPrice: string;
}

const BLANK: FormState = {
  id: null,
  preset: 'generic',
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  fields: {},
  headers: [],
  headersTouched: false,
  promptPrice: '',
  completionPrice: '',
};

function formFor(view: ProfileView): FormState {
  return {
    id: view.id,
    preset: view.kind === 'mock' ? 'mock' : (view.preset ?? 'generic'),
    name: view.name,
    baseUrl: view.baseUrl,
    model: view.defaultModel,
    apiKey: '',
    fields: { ...(view.fields ?? {}) },
    headers: [],
    headersTouched: false,
    promptPrice: view.pricePer1k === undefined ? '' : String(view.pricePer1k.prompt),
    completionPrice: view.pricePer1k === undefined ? '' : String(view.pricePer1k.completion),
  };
}

/** The preset field values a fresh pick starts with: each declared default, nothing else. */
function fieldDefaults(preset: PresetDef | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const field of preset?.fields ?? []) {
    if (field.defaultValue !== undefined) fields[field.key] = field.defaultValue;
  }
  return fields;
}

/** What the key field's label says, for this preset and this form. */
function keyHint(preset: PresetDef | undefined, form: FormState, view: ProfileView | undefined, keyNeeded: boolean): string {
  if (preset?.local !== undefined) {
    return form.id === null
      ? t`(optional — only if you set one on the server)`
      : t`(optional — leave empty to keep the stored key)`;
  }
  if (preset?.keyOptional === true) {
    return form.id === null ? t`(optional — this provider answers without one)` : t`(optional — leave empty to keep the stored key)`;
  }
  if (keyNeeded) return t`(required: the endpoint has moved to another address, so the stored key is not sent there)`;
  // A new profile on a preset that is not key-optional needs one — say so, as the optional presets do.
  if (form.id !== null) return view?.hasKey === true ? t`(leave empty to keep the stored key)` : t`(required)`;
  return t`(required)`;
}

/** The task roles' display order and what each one is for (provider-gateway §6). */
const ROLE_NAMES: readonly { readonly id: TaskRole; readonly label: MessageDescriptor; readonly hint: MessageDescriptor }[] = [
  { id: 'chat', label: msg`Chat`, hint: msg`the agent panel` },
  { id: 'drafting', label: msg`Drafting`, hint: msg`the prompt pack’s generations` },
  { id: 'background', label: msg`Background`, hint: msg`checks, encoding work and plans sent to the background` },
];

/** A role row as the form holds it: '' fields mean the role's defaults (follow chat; the profile's own model). */
interface RoleDraft {
  readonly profileId: string;
  readonly model: string;
  readonly thinking: string;
}

const ROLE_LEVEL_NAMES: Readonly<Record<ThinkingLevel, MessageDescriptor>> = {
  off: msg`Off`,
  low: msg`Low`,
  medium: msg`Medium`,
  high: msg`High`,
  xhigh: msg`Extra high`,
  max: msg`Max`,
};

/** The stored routing as the three editable rows carry it: unpinned roles hold an empty draft. */
function roleDraftsFor(roles: RoleSettings | undefined): Record<TaskRole, RoleDraft> {
  const draft = (ref: RoleRef | 'follow' | undefined): RoleDraft =>
    ref === undefined || ref === 'follow'
      ? { profileId: '', model: '', thinking: '' }
      : { profileId: ref.profileId, model: ref.model ?? '', thinking: ref.thinking ?? '' };
  return { chat: draft(roles?.chat), drafting: draft(roles?.drafting), background: draft(roles?.background) };
}

function ProvidersSection({ services, onChanged }: { services: AppServices; onChanged?: () => void }): ReactNode {
  const providers = services.providers;
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  // The last save's model catalogue — `preset` says whether it is the endpoint's live answer or the registry's table.
  const [models, setModels] = useState<{ profile: string; preset?: string; list: ModelInfo[] } | null>(null);
  const profiles = providers.list();
  const active = providers.active();
  const preset = form === null ? undefined : presetFor(form.preset);
  const isMock = form?.preset === 'mock';
  const isGeneric = form?.preset === 'generic';
  // A server on this computer: its address is typed, within loopback, like a generic endpoint's (provider-gateway §2).
  const isLocal = preset?.local !== undefined;
  // A saved endpoint whose origin the form moves to needs its key again: the gateway refuses to send the old one there.
  const original = form === null || form.id === null ? undefined : providers.get(form.id);
  const keyNeeded =
    (isGeneric === true || isLocal) && original !== undefined && form !== null && originOf(form.baseUrl) !== originOf(original.baseUrl);
  // The profile form saves on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from saving it.
  const ime = useComposingEnter();

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setBusy(false);
      refresh();
      onChanged?.();
    }
  };

  /** Picking a preset reseeds the form: its fields to their defaults, its model to the preset's, its headers cleared. */
  const choosePreset = (presetId: string): void => {
    if (form === null) return;
    const next = presetFor(presetId);
    setForm({ ...form, preset: presetId, baseUrl: next?.local === undefined ? '' : next.baseUrl, model: next?.defaultModel ?? '', fields: fieldDefaults(next), headers: [], headersTouched: false });
  };

  const setField = (key: string, value: string): void => {
    if (form !== null) setForm({ ...form, fields: { ...form.fields, [key]: value } });
  };

  const setHeader = (index: number, part: Partial<HeaderDraft>): void => {
    if (form === null) return;
    setForm({
      ...form,
      headersTouched: true,
      headers: form.headers.map((header, i) => (i === index ? { ...header, ...part } : header)),
    });
  };

  /** The headers to send in the save: untouched keeps the sealed set, emptied clears it, rows replace it. */
  const headerPatch = (): Readonly<Record<string, string>> | null | undefined => {
    if (form === null) return undefined;
    if (form.id !== null && !form.headersTouched) return undefined;
    if (form.headers.length === 0) return form.id === null ? undefined : null;
    return Object.fromEntries(form.headers.filter((header) => header.name.trim() !== '').map((header) => [header.name, header.value]));
  };

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    if (form === null) return;
    // A price that does not read is named before anything is saved, so the form keeps what the writer typed.
    const price = priceFromInputs(form.promptPrice, form.completionPrice);
    if (!price.ok) {
      setMessage({ text: price.message, tone: 'error' });
      return;
    }
    const headers = headerPatch();
    void run(async () => {
      if (form.id === null) {
        const outcome = await providers.addProfile({
          name: form.name,
          kind: 'endpoint',
          preset: form.preset,
          // A named preset's URL is its own (built from its fields); only a generic endpoint or a local server types one.
          ...(isGeneric === true || isLocal ? { baseUrl: form.baseUrl } : {}),
          ...(Object.keys(form.fields).length === 0 ? {} : { fields: form.fields }),
          ...(headers === undefined || headers === null ? {} : { customHeaders: headers }),
          defaultModel: form.model,
          ...(form.apiKey === '' ? {} : { apiKey: form.apiKey }),
          ...(price.price === undefined ? {} : { pricePer1k: price.price }),
        });
        setForm(null);
        if (outcome.models !== undefined) setModels({ profile: outcome.view.name, preset: outcome.view.preset, list: outcome.models });
        setMessage(
          outcome.probeError === undefined
            ? {
                text: t`Saved “${{ profile: isolate(outcome.view.name) }}”. Use this profile to make it the one the agent calls.`,
                tone: 'info',
              }
            : { text: t`Saved “${{ profile: isolate(outcome.view.name) }}”, but ${{ problem: outcome.probeError }}`, tone: 'error' },
        );
        return;
      }
      // Both price inputs emptied on a priced profile clears its price; the gateway keeps a price the patch leaves out.
      const saved = providers.get(form.id);
      const priceChange =
        price.price ?? (priceClearedBy(form.promptPrice, form.completionPrice) && saved?.pricePer1k !== undefined ? null : undefined);
      const outcome = await providers.editProfile(form.id, {
        name: form.name,
        ...(isMock === true ? {} : isGeneric === true || isLocal ? { baseUrl: form.baseUrl } : {}),
        // A fields patch on a templated preset rebuilds the profile's base URL from the new fields.
        ...(preset?.fields === undefined ? {} : { fields: form.fields }),
        ...(isGeneric === true ? { customHeaders: headers } : {}),
        defaultModel: form.model,
        ...(form.apiKey === '' ? {} : { apiKey: form.apiKey }),
        ...(priceChange === undefined ? {} : { pricePer1k: priceChange }),
      });
      setForm(null);
      if (outcome.models !== undefined) setModels({ profile: outcome.view.name, preset: outcome.view.preset, list: outcome.models });
      setMessage(
        outcome.probeError === undefined
          ? { text: t`Saved “${{ profile: isolate(outcome.view.name) }}”.`, tone: 'info' }
          : { text: t`Saved “${{ profile: isolate(outcome.view.name) }}”, but ${{ problem: outcome.probeError }}`, tone: 'error' },
      );
    });
  };

  return (
    <section className="settings-section" aria-labelledby="settings-providers">
      <h3 id="settings-providers">
        <Trans>Providers</Trans>
      </h3>
      <p className="muted">
        <Trans>
          The agent calls the active profile. Keys are encrypted in this browser and never written into a project. The built-in demo
          profile answers only the three demo requests.
        </Trans>
      </p>

      <ul className="profile-list" aria-label={t`Provider profiles`}>
        {profiles.map((profile) => {
          const card = presetFor(profile.kind === 'mock' ? 'mock' : profile.preset);
          return (
            <li key={profile.id} className={`profile-row${profile.isActive ? ' is-active' : ''}`} data-profile={profile.name}>
              <div className="profile-meta">
                <span className="profile-name">{profile.name}</span>
                {profile.isActive ? (
                  <span className="badge is-active">
                    <Trans>Active</Trans>
                  </span>
                ) : null}
                <span className="muted">
                  {/* The demo profile's model id is an internal name, so the row says what the profile is and nothing more. */}
                  {profile.kind === 'mock' ? (
                    t`Demo, no key`
                  ) : (
                    <>
                      {card?.name ?? t`OpenAI-compatible endpoint`} · {profile.baseUrl} · {profile.defaultModel}
                    </>
                  )}
                </span>
                {card?.cors === 'blocked' ? (
                  <span className="badge">
                    <Trans>Desktop app or hosted only</Trans>
                  </span>
                ) : null}
                {/* Tied to the profile as it resolves: shown only while its address is this computer's. */}
                {card?.local !== undefined && isLocalBase(profile.baseUrl) ? (
                  <span className="badge">
                    <Trans>Your text stays on this computer</Trans>
                  </span>
                ) : null}
                {profile.responseFormat !== undefined ? (
                  <span className="muted">
                    {profile.responseFormat.supportsJsonObject ? (
                      <Trans>Structured output accepted</Trans>
                    ) : (
                      <Trans>Structured output not accepted</Trans>
                    )}
                  </span>
                ) : null}
              </div>
              <div className="profile-actions">
                {!profile.isActive ? (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const outcome = await providers.activate(profile.id);
                        setMessage({
                          text:
                            outcome.note === undefined
                              ? t`“${{ profile: isolate(profile.name) }}” is now the active profile.`
                              : t`“${{ profile: isolate(profile.name) }}” is now the active profile. ${{ note: outcome.note }}`,
                          tone: 'info',
                        });
                        void services.settings.update({ provider: { activeProfileId: profile.id } });
                      })
                    }
                  >
                    <Trans>Use this profile</Trans>
                  </button>
                ) : null}
                <button type="button" className="button is-quiet" disabled={busy} onClick={() => setForm(formFor(profile))}>
                  <Trans>Edit</Trans>
                </button>
                <button
                  type="button"
                  className="button is-quiet is-danger"
                  disabled={busy}
                  aria-label={t`Remove ${{ profile: profile.name }}`}
                  onClick={() =>
                    void run(async () => {
                      await providers.remove(profile.id);
                      setForm(null);
                      setMessage({
                        text: t`Removed “${{ profile: isolate(profile.name) }}”, and its key from this browser.`,
                        tone: 'info',
                      });
                      const now = providers.active();
                      if (now !== undefined) void services.settings.update({ provider: { activeProfileId: now.id } });
                    })
                  }
                >
                  <Trans>Remove</Trans>
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {form === null ? (
        <button type="button" className="button" disabled={busy} onClick={() => setForm({ ...BLANK })}>
          <Trans>Add a provider</Trans>
        </button>
      ) : (
        <form
          className="profile-form"
          onKeyDown={ime.noteKey}
          onSubmit={save}
          aria-label={form.id === null ? t`New provider` : t`Edit provider`}
        >
          <label>
            <span>
              <Trans>Provider</Trans>
            </span>
            {/* The first control is the preset: it fixes the route, the fields and the model catalogue (provider-gateway §2).
                A saved profile's preset is fixed for its life — it is the record, not a preference. A preset whose API does
                not answer a browser stays listed, disabled, with its honest label (provider-gateway §9). */}
            <select value={form.preset} disabled={form.id !== null} onChange={(event) => choosePreset(event.target.value)}>
              {PRESETS.filter((entry) => entry.local === undefined && (entry.id !== 'mock' || form.preset === 'mock')).map((entry) => (
                <option key={entry.id} value={entry.id} disabled={entry.cors === 'blocked'}>
                  {entry.cors === 'blocked' ? t`${{ provider: entry.name }} — Desktop app or hosted only` : entry.name}
                </option>
              ))}
              <optgroup label={t`On this computer`}>
                {PRESETS.filter((entry) => entry.local !== undefined).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          {preset !== undefined && preset.cors === 'blocked' ? (
            <p className="field-help">
              {preset.corsNote === undefined
                ? t`Desktop app or hosted only`
                : t`Desktop app or hosted only — ${{ note: preset.corsNote }}`}
            </p>
          ) : preset?.corsNote !== undefined ? (
            <p className="field-help">{preset.corsNote}</p>
          ) : null}
          <label>
            <span>
              <Trans>Name</Trans>
            </span>
            <input
              type="text"
              value={form.name}
              maxLength={80}
              placeholder={preset?.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          {/* The preset's extra fields — a region picker or a workspace id — build its base URL (provider-gateway §2). */}
          {preset?.fields?.map((field) =>
            field.options !== undefined ? (
              <label key={field.key}>
                <span>{field.label}</span>
                <select value={form.fields[field.key] ?? field.defaultValue ?? ''} onChange={(event) => setField(field.key, event.target.value)}>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label key={field.key}>
                <span>{field.required === true ? field.label : t`${{ field: field.label }} (optional)`}</span>
                <input type="text" value={form.fields[field.key] ?? ''} onChange={(event) => setField(field.key, event.target.value)} />
              </label>
            ),
          )}
          {isGeneric === true ? (
            <label>
              <span>
                <Trans>Endpoint (the base URL, ending in /v1)</Trans>
              </span>
              <input
                type="url"
                placeholder="https://openrouter.ai/api/v1"
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              />
            </label>
          ) : preset?.local !== undefined ? (
            <>
              <label>
                <span>
                  <Trans>Server address (on this computer, ending in /v1)</Trans>
                </span>
                <input
                  type="url"
                  placeholder={preset.baseUrl}
                  value={form.baseUrl}
                  onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                />
              </label>
              <p className="field-help">
                {preset.local.setup}{' '}
                {preset.docsUrl === undefined ? null : (
                  <a href={preset.docsUrl} target="_blank" rel="noopener noreferrer">
                    {t`${{ product: preset.local.product }} documentation`}
                  </a>
                )}
              </p>
              <p className="field-help">
                {/* Said before the first request: Chrome and Edge ask for this permission themselves, in words that do not mention a model. */}
                <Trans>
                  The first time, Chrome and Edge ask whether this site may connect to apps on your device. Choose Allow; if you decline,
                  requests are blocked until you allow them in the site settings. Safari is unverified.
                </Trans>
              </p>
              {isLocalBase(form.baseUrl) ? (
                <p className="field-help">
                  <Trans>Your text stays on this computer.</Trans>
                </p>
              ) : null}
            </>
          ) : preset !== undefined && preset.id !== 'mock' && preset.baseUrl !== '' ? (
            <p className="field-help">
              <Trans>Endpoint:</Trans> <code>{preset.baseUrlFor?.(form.fields) ?? preset.baseUrl}</code>
            </p>
          ) : null}
          <label>
            <span>
              <Trans>Model</Trans>
            </span>
            <input
              type="text"
              list="provider-models"
              placeholder={preset?.defaultModel}
              value={form.model}
              onChange={(event) => setForm({ ...form, model: event.target.value })}
            />
          </label>
          {preset !== undefined && preset.id !== 'mock' ? (
            <>
              {/* The models to offer: the last probe's live answer first, then the preset's documented ids — a glob row is
                  a pattern, not a name, so it is never offered as one. */}
              <datalist id="provider-models">
                {[...new Set([...(models?.list.map((model) => model.id) ?? []), ...preset.models.filter((row) => !row.pattern.includes('*')).map((row) => row.pattern)])]
                  .slice(0, 40)
                  .map((id) => (
                    <option key={id} value={id} />
                  ))}
              </datalist>
              {capsLine(preset, form.model) !== '' ? <p className="field-help">{capsLine(preset, form.model)}</p> : null}
              {preset.noModelsRoute === true ? (
                <p className="field-help">
                  <Trans>This provider documents no model list — its table below is the catalogue.</Trans>
                </p>
              ) : null}
            </>
          ) : null}
          {isMock !== true ? (
            <label>
              <span>
                <Trans>API key</Trans> {keyHint(preset, form, original, keyNeeded)}
              </span>
              <input
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              />
            </label>
          ) : null}
          {isGeneric === true ? (
            <fieldset className="price-fields">
              <legend>
                <Trans>Extra request headers (optional)</Trans>
              </legend>
              <p className="field-help">
                {form.id === null
                  ? t`Sent with every request, and sealed with the key — they are never shown again.`
                  : t`Sent with every request, and sealed with the key — they are never shown again. Leave this list untouched to keep the stored set; empty it again to clear it.`}
              </p>
              {form.headers.map((header, index) => (
                <div className="header-row" key={index}>
                  <input
                    aria-label={t`Header ${{ number: index + 1 }} name`}
                    placeholder={t`x-my-header`}
                    value={header.name}
                    onChange={(event) => setHeader(index, { name: event.target.value })}
                  />
                  <input
                    aria-label={t`Header ${{ number: index + 1 }} value`}
                    type="password"
                    autoComplete="off"
                    placeholder={t`the header’s value`}
                    value={header.value}
                    onChange={(event) => setHeader(index, { value: event.target.value })}
                  />
                  <button
                    type="button"
                    className="button is-quiet"
                    aria-label={t`Remove header ${{ number: index + 1 }}`}
                    onClick={() =>
                      setForm({ ...form, headersTouched: true, headers: form.headers.filter((_, i) => i !== index) })
                    }
                  >
                    <Trans>Remove</Trans>
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button is-quiet"
                onClick={() => setForm({ ...form, headersTouched: true, headers: [...form.headers, { name: '', value: '' }] })}
              >
                <Trans>Add a header</Trans>
              </button>
            </fieldset>
          ) : null}
          {isMock !== true ? (
            <fieldset className="price-fields">
              <legend>
                <Trans>
                  Price per 1,000 tokens, in dollars (optional: fill both to see the cost of a step). A saved price stays until you type a
                  new one, so clearing these fields does not remove it.
                </Trans>
              </legend>
              <label>
                <span>
                  <Trans>Prompt</Trans>
                </span>
                <input type="number" min={0} step="any" value={form.promptPrice} onChange={(event) => setForm({ ...form, promptPrice: event.target.value })} />
              </label>
              <label>
                <span>
                  <Trans>Reply</Trans>
                </span>
                <input type="number" min={0} step="any" value={form.completionPrice} onChange={(event) => setForm({ ...form, completionPrice: event.target.value })} />
              </label>
            </fieldset>
          ) : null}
          <div className="profile-form-actions">
            <button type="submit" className="button is-primary" disabled={busy}>
              <Trans>Save profile</Trans>
            </button>
            <button type="button" className="button is-quiet" onClick={() => setForm(null)}>
              <Trans>Cancel</Trans>
            </button>
          </div>
        </form>
      )}

      {models !== null ? (
        <section
          className="models"
          aria-label={
            presetFor(models.preset)?.noModelsRoute === true
              ? t`Models documented for ${{ profile: models.profile }}`
              : t`Models listed by ${{ profile: models.profile }}`
          }
        >
          <h4>
            {presetFor(models.preset)?.noModelsRoute === true
              ? t`Models documented for ${{ profile: models.profile }}`
              : t`Models listed by ${{ profile: models.profile }}`}
          </h4>
          {presetFor(models.preset)?.noModelsRoute === true ? (
            <p className="muted">
              <Trans>This provider documents no model list — these are the models its table knows.</Trans>
            </p>
          ) : null}
          {models.list.length === 0 ? (
            <p className="muted">
              <Trans>The endpoint listed no models.</Trans>
            </p>
          ) : null}
          <ul>
            {models.list.slice(0, 40).map((model) => (
              <li key={model.id}>
                <code>{model.id}</code>
                {modelDetails(model) === '' ? null : <span className="muted"> · {modelDetails(model)}</span>}
                {form !== null ? (
                  <button
                    type="button"
                    className="button is-quiet"
                    aria-label={t`Use ${{ model: model.id }} as the model`}
                    onClick={() => setForm({ ...form, model: model.id })}
                  >
                    <Trans>Use</Trans>
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <FormMessage message={message} />

      <RolesPanel services={services} models={models} onSaved={(text) => setMessage({ text, tone: 'info' })} />
      <UsagePanel services={services} />
      <RequestLogPanel services={services} />
      {active === undefined ? (
        <p className="status-line is-error">
          <Trans>No provider is active, so the agent cannot run.</Trans>
        </p>
      ) : null}
    </section>
  );
}

/**
 * The task-role routing (provider-gateway §6): which profile each kind of call runs on, and the model and thinking
 * level its requests default to. Drafting and background follow the chat choice unless they are pinned; chat with no
 * pin is the active profile. The record lives in the settings; the provider service holds the live copy its resolver
 * reads, so both are written here.
 */
function RolesPanel({ services, models, onSaved }: { services: AppServices; models: { profile: string; preset?: string; list: ModelInfo[] } | null; onSaved: (text: string) => void }): ReactNode {
  const providers = services.providers;
  const profiles = providers.list();
  const [drafts, setDrafts] = useState<Record<TaskRole, RoleDraft>>(() => roleDraftsFor(providers.roleSettings));
  const [message, setMessage] = useState<string | null>(null);
  // The role rows save on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from saving them.
  const ime = useComposingEnter();

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    const ref = (draft: RoleDraft): RoleRef | undefined => {
      const profile = profiles.find((entry) => entry.id === draft.profileId);
      if (profile === undefined) return undefined;
      return {
        profileId: profile.id,
        ...(draft.model.trim() === '' ? {} : { model: draft.model.trim() }),
        ...(draft.thinking === '' ? {} : { thinking: draft.thinking as ThinkingLevel }),
      };
    };
    const chat = ref(drafts.chat);
    const drafting = ref(drafts.drafting);
    const background = ref(drafts.background);
    // Nothing pinned anywhere is stored as no record at all — absent is what following already means.
    const roles: RoleSettings | null =
      chat === undefined && drafting === undefined && background === undefined
        ? null
        : { ...(chat === undefined ? {} : { chat }), drafting: drafting ?? 'follow', background: background ?? 'follow' };
    // The service's live cell first, so the next request routes by it; the settings record follows for the next open.
    providers.applyRoleSettings(roles === null ? undefined : roles);
    void services.settings.update({ provider: { roles } }).then((error) => {
      if (error !== null) setMessage(error);
      else onSaved(t`Saved the task roles.`);
    });
  };

  return (
    <section aria-labelledby="settings-roles">
      <h4 id="settings-roles">
        <Trans>Task roles</Trans>
      </h4>
      <p className="muted">
        <Trans>
          Each kind of call can run on its own profile, model and thinking level. Drafting and background follow the chat choice unless
          they are pinned; chat with no pin is the active profile.
        </Trans>
      </p>
      <form className="role-rows" onKeyDown={ime.noteKey} onSubmit={save}>
        {ROLE_NAMES.map(({ id, label, hint }) => {
          const labelText = i18n._(label);
          const draft = drafts[id];
          const pinned = profiles.find((entry) => entry.id === draft.profileId);
          const preset = presetFor(pinned?.kind === 'mock' ? 'mock' : pinned?.preset);
          const modelId = draft.model.trim() !== '' ? draft.model.trim() : (pinned?.defaultModel ?? '');
          const levels = preset !== undefined && modelId !== '' ? (modelRowFor(preset, modelId)?.caps.effortLevels ?? []) : [];
          return (
            <div className="role-row" key={id}>
              <span className="role-title">
                {labelText} <span className="muted">· {i18n._(hint)}</span>
              </span>
              <select
                aria-label={t`${{ role: labelText }} profile`}
                value={pinned?.id ?? ''}
                onChange={(event) => setDrafts({ ...drafts, [id]: { profileId: event.target.value, model: '', thinking: '' } })}
              >
                <option value="">{id === 'chat' ? t`Active profile` : t`Follow chat`}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              {pinned !== undefined ? (
                <>
                  <input
                    aria-label={t`${{ role: labelText }} model`}
                    list={`role-models-${id}`}
                    placeholder={pinned.defaultModel}
                    value={draft.model}
                    onChange={(event) => setDrafts({ ...drafts, [id]: { ...draft, model: event.target.value } })}
                  />
                  <datalist id={`role-models-${id}`}>
                    {[
                      ...new Set([
                        ...(models !== null && (models.preset === pinned.preset || models.profile === pinned.name)
                          ? models.list.map((model) => model.id)
                          : []),
                        ...(preset?.models ?? []).filter((row) => !row.pattern.includes('*')).map((row) => row.pattern),
                      ]),
                    ].map((modelOption) => (
                      <option key={modelOption} value={modelOption} />
                    ))}
                  </datalist>
                  {/* The model's capability row decides whether a thinking control exists at all: no documented levels,
                      no control (provider-gateway §3 — a level the row does not list is never sent). */}
                  {levels.length > 0 ? (
                    <select
                      aria-label={t`${{ role: labelText }} thinking level`}
                      value={levels.includes(draft.thinking as ThinkingLevel) ? draft.thinking : ''}
                      onChange={(event) => setDrafts({ ...drafts, [id]: { ...draft, thinking: event.target.value } })}
                    >
                      <option value="">{t`Provider default`}</option>
                      {levels.map((level) => (
                        <option key={level} value={level}>
                          {i18n._(ROLE_LEVEL_NAMES[level])}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
        <div className="profile-form-actions">
          <button type="submit" className="button">
            <Trans>Save task roles</Trans>
          </button>
        </div>
      </form>
      {message !== null ? (
        <p className="form-message is-error" role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}

/** A task role as the usage table names it (provider-gateway §6: cost is visible per role). */
const ROLE_LABELS: Readonly<Record<TaskRole, MessageDescriptor>> = {
  chat: msg`Chat`,
  drafting: msg`Drafting`,
  background: msg`Background`,
};

function UsagePanel({ services }: { services: AppServices }): ReactNode {
  // The counts are estimates and a mounted panel must follow a language switch, so they are formatted through
  // the live formatter rather than a number written when the panel opened (§4.2).
  const format = useFormat();
  const rows = services.providers.ledger.dayRows();
  const names = new Map(services.providers.list().map((profile) => [profile.id, profile.name]));
  const totals = rows.reduce(
    (sum, row) => ({
      prompt: sum.prompt + row.promptTokens,
      completion: sum.completion + row.completionTokens,
      requests: sum.requests + row.requests,
    }),
    { prompt: 0, completion: 0, requests: 0 },
  );
  const requestsTotal = totals.requests;
  return (
    <section className="usage" aria-labelledby="settings-usage">
      <h4 id="settings-usage">
        <Trans>Usage on this device</Trans>
      </h4>
      {rows.length === 0 ? (
        <p className="muted">
          <Trans>No requests yet. Usage is counted by day, per profile, model and role, and stays in this browser.</Trans>
        </p>
      ) : (
        <>
          <p className="muted">
            {t`${plural(requestsTotal, { one: '# request', other: '# requests' })}, about ${{ prompt: format.number(totals.prompt) }} tokens in and ${{ completion: format.number(totals.completion) }} out.`}
          </p>
          <table className="usage-table">
            <caption className="visually-hidden">
              <Trans>Usage by day, profile, model and role</Trans>
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <Trans>Day</Trans>
                </th>
                <th scope="col">
                  <Trans>Profile</Trans>
                </th>
                <th scope="col">
                  <Trans>Model</Trans>
                </th>
                <th scope="col">
                  <Trans>Role</Trans>
                </th>
                <th scope="col">
                  <Trans>Requests</Trans>
                </th>
                <th scope="col">
                  <Trans>Tokens in</Trans>
                </th>
                <th scope="col">
                  <Trans>Tokens out</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.date}:${row.profileId}:${row.model}:${row.role}`}>
                  <td>{row.date}</td>
                  <td>{names.get(row.profileId) ?? t`Removed profile`}</td>
                  <td>{row.model}</td>
                  <td>{i18n._(ROLE_LABELS[row.role])}</td>
                  <td>{format.number(row.requests)}</td>
                  <td>{format.number(row.promptTokens)}</td>
                  <td>{format.number(row.completionTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function RequestLogPanel({ services }: { services: AppServices }): ReactNode {
  const entries: RequestLogEntry[] = services.providers.requests.entries().slice().reverse();
  const names = new Map(services.providers.list().map((profile) => [profile.id, profile.name]));
  const entryCount = entries.length;
  return (
    <section className="request-log" aria-labelledby="settings-requests">
      <h4 id="settings-requests">
        <Trans>Request log</Trans>
      </h4>
      <p className="muted">
        {entries.length === 0
          ? t`Requests, retries included. Nothing here holds a key or a message.`
          : t`The last ${plural(entryCount, { one: '# request', other: '# requests' })}, retries included. Nothing here holds a key or a message.`}
      </p>
      {entries.length === 0 ? (
        <p className="muted">
          <Trans>No request has been sent yet.</Trans>
        </p>
      ) : (
        <table className="request-table" data-testid="request-log">
          <caption className="visually-hidden">
            <Trans>Requests, newest first</Trans>
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <Trans>Time</Trans>
              </th>
              <th scope="col">
                <Trans>Profile</Trans>
              </th>
              <th scope="col">
                <Trans>Attempt</Trans>
              </th>
              <th scope="col">
                <Trans>Outcome</Trans>
              </th>
              <th scope="col">
                <Trans>Status</Trans>
              </th>
              <th scope="col">
                <Trans>Max tokens</Trans>
              </th>
              <th scope="col">
                <Trans>Address</Trans>
              </th>
              <th scope="col">
                <Trans>Note</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={`${entry.at}:${index}`} data-outcome={entry.outcome}>
                <td>{timeLabel(entry.at)}</td>
                <td>{names.get(entry.profileId) ?? entry.profileId}</td>
                <td>{entry.attempt}</td>
                <td>{entry.outcome}</td>
                <td>{entry.status ?? ''}</td>
                <td>{entry.maxTokens ?? ''}</td>
                <td className="request-url">{entry.url.replace(/^https?:\/\//, '')}</td>
                <td>{entry.note ?? entry.errorKind ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Agent
 * ------------------------------------------------------------------ */

function AgentSection({ services }: { services: AppServices }): ReactNode {
  const [loadEvery, setLoadEvery] = useState(services.settings.current().agent.loadEveryTool);
  const [message, setMessage] = useState<string | null>(null);

  const change = (next: boolean): void => {
    setLoadEvery(next);
    void services.settings.update({ agent: { loadEveryTool: next } }).then((error) => {
      setMessage(error ?? t`Saved. It applies to the agent’s next request.`);
    });
  };

  return (
    <section className="settings-section" aria-labelledby="settings-agent">
      <h3 id="settings-agent">
        <Trans>Agent</Trans>
      </h3>
      <p className="settings-note">
        <Trans>
          The agent starts each request with a short list of tools and finds the others with a search when a task needs them. Some models
          search poorly. Turn this on to give such a model every tool on every request, at the cost of a longer prompt each time.
        </Trans>
      </p>
      <label className="settings-check">
        <input type="checkbox" checked={loadEvery} data-testid="agent-load-every-tool" onChange={(event) => change(event.target.checked)} />
        <Trans>
          <span>Load every tool on every request</span>
        </Trans>
      </label>
      <FormMessage message={message === null ? null : { text: message, tone: 'info' }} />
      <AgentModeSettings services={services} />
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

function WritingSection({ services }: { services: AppServices }): ReactNode {
  const current = services.settings.current();
  const [target, setTarget] = useState(String(current.session.dailyTargetWords ?? 0));
  const [debounce, setDebounce] = useState(String(current.editor.autosaveDebounceMs));
  const [hideRails, setHideRails] = useState(current.editor.focusModeHideRails);
  const [message, setMessage] = useState<string | null>(null);
  // The writing settings save on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from saving them.
  const ime = useComposingEnter();

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    const words = Number(target);
    const ms = Number(debounce);
    if (!Number.isFinite(words) || words < 0 || words > TARGET_MAX_WORDS || !Number.isInteger(words)) {
      setMessage(t`The daily target is a whole number of words from 0 to ${{ max: formatCount(TARGET_MAX_WORDS) }}; 0 means no target.`);
      return;
    }
    if (!Number.isFinite(ms) || ms < DEBOUNCE_MIN_MS || ms > DEBOUNCE_MAX_MS || !Number.isInteger(ms)) {
      setMessage(t`The save delay is a whole number of milliseconds from ${{ min: DEBOUNCE_MIN_MS }} to ${{ max: DEBOUNCE_MAX_MS }}.`);
      return;
    }
    void services.settings.update({ session: { dailyTargetWords: words }, editor: { autosaveDebounceMs: ms, focusModeHideRails: hideRails } }).then((error) => {
      setMessage(error ?? t`Saved. The save delay applies to the projects you open from now on.`);
    });
  };

  return (
    <section className="settings-section" aria-labelledby="settings-writing">
      <h3 id="settings-writing">
        <Trans>Writing</Trans>
      </h3>
      <form className="settings-form" noValidate onKeyDown={ime.noteKey} onSubmit={save}>
        <label>
          <span>
            <Trans>Daily target, in words (0 for none)</Trans>
          </span>
          <input type="number" min={0} max={TARGET_MAX_WORDS} step={1} value={target} onChange={(event) => setTarget(event.target.value)} />
        </label>
        <label>
          <span>
            <Trans>
              Save after typing stops, in milliseconds ({DEBOUNCE_MIN_MS}–{DEBOUNCE_MAX_MS})
            </Trans>
          </span>
          <input
            type="number"
            min={DEBOUNCE_MIN_MS}
            max={DEBOUNCE_MAX_MS}
            step={1}
            value={debounce}
            onChange={(event) => setDebounce(event.target.value)}
          />
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={hideRails} onChange={(event) => setHideRails(event.target.checked)} />
          <span>
            <Trans>In focus mode, hide the binder and the inspector</Trans>
          </span>
        </label>
        <button type="submit" className="button is-primary">
          <Trans>Save writing settings</Trans>
        </button>
      </form>
      <FormMessage message={message === null ? null : { text: message, tone: 'info' }} />
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Appearance
 * ------------------------------------------------------------------ */

function AppearanceSection({ services }: { readonly services: AppServices }): ReactNode {
  // A completion percentage follows the interface language while this section stays mounted.
  const format = useFormat();
  const [theme, setTheme] = useState<Theme>(() => activeTheme());
  const chooseTheme = (next: Theme): void => {
    applyTheme(next);
    rememberTheme(next);
    setTheme(next);
  };

  // The stored preference, the catalogue revision (a switch changes the native name of System), and the
  // status line a switch leaves behind. The radio inputs stay mounted across all three, so focus does not
  // move from the row the writer picked.
  const settings = useSyncExternalStore(services.settings.subscribe, services.settings.current);
  const revision = useSyncExternalStore(subscribeLanguage, languageRevision);
  const [status, setStatus] = useState<
    | { readonly kind: 'idle' }
    | { readonly kind: 'loading' }
    | { readonly kind: 'notice'; readonly tone: 'info' | 'error'; readonly message: string }
  >({ kind: 'idle' });
  const choices = useMemo(
    () =>
      languageChoices({
        setting: settings.interfaceLanguage,
        navigatorLanguages: typeof navigator === 'undefined' ? [] : navigator.languages,
        stats: languageStats as InterfaceLanguageStats,
        exposeDeveloperLanguages: developerLanguageExposure(),
        previouslyListed: readListedLanguages(),
      }),
    [settings.interfaceLanguage, revision],
  );
  useEffect(() => {
    recordListedLanguages(choices.filter((choice) => !choice.pseudo && choice.setting !== 'system').map((choice) => choice.tag));
  }, [choices]);
  // A stored tag this build does not ship falls back to English at start-up; the System row then shows
  // the effective choice instead of leaving every row unticked.
  const selected = choices.some((choice) => sameLanguageSetting(choice.setting, settings.interfaceLanguage))
    ? settings.interfaceLanguage
    : 'system';

  const chooseLanguage = (setting: string): void => {
    setStatus({ kind: 'loading' });
    void switchInterfaceLanguage(setting, services.settings).then((result) => {
      // A superseded request must not overwrite the newer one's status line.
      if (result.status === 'superseded') return;
      if (result.status === 'switched') {
        setStatus({ kind: 'idle' });
        return;
      }
      setStatus({ kind: 'notice', tone: result.status === 'failed' ? 'error' : 'info', message: result.message });
    });
  };

  return (
    <section className="settings-section" aria-labelledby="settings-appearance">
      <h3 id="settings-appearance">
        <Trans>Appearance</Trans>
      </h3>
      <fieldset className="settings-radios">
        <legend>
          <Trans>Theme</Trans>
        </legend>
        <label className="check">
          <input type="radio" name="theme" checked={theme === 'light'} onChange={() => chooseTheme('light')} /> <Trans>Light</Trans>
        </label>
        <label className="check">
          <input type="radio" name="theme" checked={theme === 'dark'} onChange={() => chooseTheme('dark')} /> <Trans>Dark</Trans>
        </label>
      </fieldset>
      <p className="muted">
        <Trans>The choice is kept in this browser. Until you choose, the page follows the system.</Trans>
      </p>

      <fieldset className="settings-radios" data-testid="interface-language">
        <legend>{t`Interface language`}</legend>
        {choices.map((choice) => (
          <label className="check" key={choice.setting}>
            <input
              type="radio"
              name="interface-language"
              value={choice.setting}
              checked={sameLanguageSetting(selected, choice.setting)}
              onChange={() => chooseLanguage(choice.setting)}
            />
            {choice.setting === 'system' ? (
              <>
                {t`Follow the system`} — {choice.nativeName}
              </>
            ) : (
              choice.nativeName
            )}
            {choice.completion === null ? null : (
              <span className="muted">
                {' '}
                {format.number(choice.completion / 100, { style: 'percent', maximumFractionDigits: 1 })}
              </span>
            )}
            {choice.preview ? <span className="muted">{` — ${t`Preview, partly English`}`}</span> : null}
            {choice.tag === 'de' ? <span className="muted">{` — ${t`Machine-assisted translation; not reviewed by a native speaker`}`}</span> : null}
          </label>
        ))}
      </fieldset>
      <p className="muted">
        {t`The interface language changes straight away. The manuscript stays in its own language.`}
      </p>
      <p className="muted">
        <a href={guideHref(activeTag(), 'settings')} target="_blank" rel="noopener noreferrer">
          <Trans>Read the user guide</Trans>
        </a>
      </p>
      {status.kind === 'loading' ? <p role="status">{t`Changing the interface language…`}</p> : null}
      {status.kind === 'notice' ? (
        <p className={`form-message is-${status.tone}`} role={status.tone === 'error' ? 'alert' : 'status'}>
          {status.message}
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

function DataSection({
  services,
  session,
  store,
  storage,
}: {
  services: AppServices;
  session: ProjectSession | null;
  store: RuntimeStore | null;
  storage?: StorageHost | null;
}): ReactNode {
  const host = storage === undefined ? browserStorageHost() : storage;
  const [loaded, setLoaded] = useState<Durability | null>(null);
  const [budget, setBudget] = useState<SnapshotBudget | null>(null);
  // Why the count failed, if it did. Without it the section says "Counting" for ever, which is a lie about a read that has ended.
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const current = services.settings.current();
  const [cap, setCap] = useState(String(current.retention.checkpointCap));
  const [days, setDays] = useState(String(current.retention.checkpointDays));
  // The limits save on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from saving them.
  const ime = useComposingEnter();

  // With a project open, its session holds the browser's answer. From the projects screen the browser is asked again.
  useEffect(() => {
    if (session !== null) return;
    let alive = true;
    void readDurability(host).then((next) => {
      if (alive) setLoaded(next);
    });
    return () => {
      alive = false;
    };
  }, [session, host]);
  const durability = session === null ? loaded : session.durability();

  const [budgetVersion, bumpBudget] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let alive = true;
    if (session === null || store === null) return;
    void snapshotBudget(store, session.projectId).then(
      (next) => {
        if (!alive) return;
        setBudget(next);
        setBudgetError(null);
      },
      (error: unknown) => {
        if (!alive) return;
        setBudget(null);
        setBudgetError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [session, store, budgetVersion]);

  const trim = (): void => {
    if (session === null) return;
    setMessage(null);
    void session.trimSnapshots().then(
      () => {
        bumpBudget();
        setMessage(t`Trimmed to the limits. The count below is what is left.`);
      },
      (error: unknown) =>
        setMessage(t`The trim did not finish: ${{ error: error instanceof Error ? error.message : String(error) }}`),
    );
  };

  const saveLimits = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    const nextCap = Number(cap);
    const nextDays = Number(days);
    if (!Number.isInteger(nextCap) || nextCap < 1 || nextCap > CHECKPOINT_CAP_MAX) {
      setMessage(t`The checkpoint limit is a whole number from 1 to ${{ max: formatCount(CHECKPOINT_CAP_MAX) }}.`);
      return;
    }
    if (!Number.isInteger(nextDays) || nextDays < 1 || nextDays > CHECKPOINT_DAYS_MAX) {
      setMessage(t`The retention is a whole number of days from 1 to ${{ max: CHECKPOINT_DAYS_MAX }}.`);
      return;
    }
    void services.settings.update({ retention: { checkpointCap: nextCap, checkpointDays: nextDays } }).then((error) => {
      setMessage(error ?? t`Saved. The limits apply to the projects you open from now on, and to the next trim.`);
    });
  };

  // Counted lines take bare names: an ICU plural selector written as a member expression would reach the
  // catalogue as a positional `{0}` instead of `{count, plural, …}`.
  const keptCount = budget?.count ?? 0;
  const keptDocuments = budget?.documents ?? 0;
  const retention = session?.retentionLimits() ?? { checkpointCap: 0, checkpointDays: 0 };
  const checkpointCap = retention.checkpointCap;
  const checkpointDays = retention.checkpointDays;

  return (
    <section className="settings-section" aria-labelledby="settings-data">
      <h3 id="settings-data">
        <Trans>Data</Trans>
      </h3>

      <section className="storage-row" aria-labelledby="settings-storage">
        <h4 id="settings-storage">
          <Trans>Storage</Trans>
        </h4>
        <p data-testid="storage-status">
          {durability === null ? t`Checking this browser’s storage…` : durabilitySentence(durability)}
        </p>
        {durability !== null && usageSentence(durability) !== null ? <p className="muted">{usageSentence(durability)}</p> : null}
        <p className="muted" data-testid="storage-location">
          <Trans>Storage location: this browser (read-only in the browser app).</Trans>
        </p>
      </section>

      {session === null ? null : <PictureStorageMeter report={pictureStorageReport(session.state)} durability={durability} />}

      <section aria-labelledby="settings-checkpoints">
        <h4 id="settings-checkpoints">
          <Trans>Checkpoints</Trans>
        </h4>
        {session === null ? (
          <p className="muted">
            <Trans>Open a project to see its checkpoints.</Trans>
          </p>
        ) : budgetError !== null ? (
          <p className="muted" role="alert">
            {t`The checkpoints could not be counted: ${{ error: budgetError }}`}{' '}
            <button
              type="button"
              className="button is-quiet"
              onClick={() => {
                setBudgetError(null);
                bumpBudget();
              }}
            >
              <Trans>Try again</Trans>
            </button>
          </p>
        ) : budget === null ? (
          <p className="muted">
            <Trans>Counting the checkpoints…</Trans>
          </p>
        ) : (
          <dl className="budget" data-testid="snapshot-budget">
            <dt>
              <Trans>Kept</Trans>
            </dt>
            <dd>
              {t`${plural(keptCount, { one: '# checkpoint', other: '# checkpoints' })} across ${plural(keptDocuments, { one: '# document', other: '# documents' })}`}
            </dd>
            <dt>
              <Trans>Size</Trans>
            </dt>
            <dd>{t`about ${{ size: formatBytes(budget.estimatedBytes) }}`}</dd>
            <dt>
              <Trans>Limit</Trans>
            </dt>
            <dd>
              {t`${plural(checkpointCap, { one: '# checkpoint', other: '# checkpoints' })}, kept ${plural(checkpointDays, { one: '# day', other: '# days' })}`}
            </dd>
          </dl>
        )}
        {session !== null ? (
          <button type="button" className="button" onClick={trim}>
            <Trans>Trim to the limits now</Trans>
          </button>
        ) : null}
        <form className="settings-form" onKeyDown={ime.noteKey} onSubmit={saveLimits}>
          <label>
            <span>
              <Trans>Checkpoints kept per project</Trans>
            </span>
            <input type="number" min={1} max={CHECKPOINT_CAP_MAX} value={cap} onChange={(event) => setCap(event.target.value)} />
          </label>
          <label>
            <span>
              <Trans>Days a checkpoint is kept</Trans>
            </span>
            <input type="number" min={1} max={CHECKPOINT_DAYS_MAX} value={days} onChange={(event) => setDays(event.target.value)} />
          </label>
          <button type="submit" className="button">
            <Trans>Save the limits</Trans>
          </button>
        </form>
      </section>

      <FormMessage message={message === null ? null : { text: message, tone: 'info' }} />
      <p className="muted">
        <Trans>
          The demo profile is named “{DEMO_PROFILE_NAME}”. A bundle export is the copy to keep: browser storage can be cleared.
        </Trans>
      </p>
    </section>
  );
}
