/**
 * Settings (ui-modules §5): a dialog with four sections. Providers holds the profiles, the save-time probe, the usage totals
 * and the request log. Writing holds the session target and the autosave debounce. Appearance holds the theme. Data holds the
 * browser's storage answer, the checkpoint figures and their limits.
 *
 * Every field is validated where it is typed, and the store answers the rest. A probe that fails is shown beside the profile
 * it concerns, never as a toast alone (context-assembly §6).
 */

import { useEffect, useReducer, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
import { snapshotBudget, type RuntimeStore, type SnapshotBudget } from '@caotang/store';

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
import { DEMO_PROFILE_NAME, priceClearedBy, priceFromInputs } from '../app/providers.js';
import { CoherenceSection } from './CoherenceSettings.js';
import { AgentModeSettings } from './AgentModeSettings.js';
import { ContextSection } from './ContextSection.js';
import { McpSection } from './McpSection.js';

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

const SECTIONS: readonly { readonly id: SettingsSection; readonly label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'context', label: 'Context' },
  { id: 'agent', label: 'Agent' },
  { id: 'writing', label: 'Writing' },
  { id: 'coherence', label: 'Coherence' },
  { id: 'mcp', label: 'MCP & tools' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Data' },
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
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="button is-quiet" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`settings-nav-item${section === entry.id ? ' is-current' : ''}`}
                aria-current={section === entry.id ? 'page' : undefined}
                onClick={() => setSection(entry.id)}
              >
                {entry.label}
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
            {section === 'appearance' ? <AppearanceSection /> : null}
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

/** A listed model's context window and price in one line, for the picker. Empty when the endpoint tells neither. */
function modelDetails(model: ModelInfo): string {
  const parts: string[] = [];
  if (model.contextWindow !== undefined) parts.push(`${model.contextWindow.toLocaleString('en-US')} tokens`);
  if (model.pricePer1k !== undefined) {
    const { prompt, completion } = model.pricePer1k;
    parts.push(`$${prompt.toLocaleString('en-US', { maximumFractionDigits: 6 })} in, $${completion.toLocaleString('en-US', { maximumFractionDigits: 6 })} out per 1,000 tokens`);
  }
  return parts.join(' · ');
}

/**
 * What a capability row says a model can do, in one muted line (provider-gateway §2's "the table supplies what a
 * listing does not say"). Nothing is invented: a capability the row does not state is simply absent from the line.
 */
function capsLine(preset: PresetDef, model: string): string {
  if (model.trim() === '') return '';
  // A local server's models are whatever the person pulled, so the row is a fallback and not a statement about this model.
  if (preset.local !== undefined) {
    const window = modelRowFor(preset, model.trim())?.contextWindow;
    return `Until the server says more: ${window === undefined ? 'a small' : `${window.toLocaleString('en-US')}-token`} window, no native tools, no image input.`;
  }
  const row = modelRowFor(preset, model.trim());
  if (row === undefined) {
    return 'Not a documented model for this provider — it is called with conservative defaults (no tools, no thinking level).';
  }
  const parts: string[] = [];
  if (row.contextWindow !== undefined) parts.push(`${row.contextWindow.toLocaleString('en-US')}-token window`);
  if (row.caps.tools === true) parts.push('native tools');
  if (row.caps.vision === true) parts.push('image input');
  if (row.caps.jsonSchema === true) parts.push('JSON-schema replies');
  else if (row.caps.jsonObject === true) parts.push('JSON-object replies');
  if (row.caps.effortLevels !== undefined && row.caps.effortLevels.length > 0) {
    parts.push(`thinking: ${row.caps.effortLevels.join(' / ')}`);
  }
  if (row.caps.streamRequired === true) parts.push('thinking always streams');
  return parts.length === 0 ? 'Text only — no documented capabilities beyond it.' : parts.join(' · ');
}

/** What the key field's label says, for this preset and this form. */
function keyHint(preset: PresetDef | undefined, form: FormState, view: ProfileView | undefined, keyNeeded: boolean): string {
  if (preset?.local !== undefined) {
    return form.id === null ? '(optional — only if you set one on the server)' : '(optional — leave empty to keep the stored key)';
  }
  if (preset?.keyOptional === true) {
    return form.id === null ? '(optional — this provider answers without one)' : '(optional — leave empty to keep the stored key)';
  }
  if (keyNeeded) return '(required: the endpoint has moved to another address, so the stored key is not sent there)';
  // A new profile on a preset that is not key-optional needs one — say so, as the optional presets do.
  if (form.id !== null) return view?.hasKey === true ? '(leave empty to keep the stored key)' : '(required)';
  return '(required)';
}

/** The task roles' display order and what each one is for (provider-gateway §6). */
const ROLE_NAMES: readonly { readonly id: TaskRole; readonly label: string; readonly hint: string }[] = [
  { id: 'chat', label: 'Chat', hint: 'the agent panel' },
  { id: 'drafting', label: 'Drafting', hint: 'the prompt pack’s generations' },
  { id: 'background', label: 'Background', hint: 'checks, encoding work and plans sent to the background' },
];

/** A role row as the form holds it: '' fields mean the role's defaults (follow chat; the profile's own model). */
interface RoleDraft {
  readonly profileId: string;
  readonly model: string;
  readonly thinking: string;
}

const ROLE_LEVEL_NAMES: Readonly<Record<ThinkingLevel, string>> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
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
            ? { text: `Saved “${outcome.view.name}”. Use this profile to make it the one the agent calls.`, tone: 'info' }
            : { text: `Saved “${outcome.view.name}”, but ${outcome.probeError}`, tone: 'error' },
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
          ? { text: `Saved “${outcome.view.name}”.`, tone: 'info' }
          : { text: `Saved “${outcome.view.name}”, but ${outcome.probeError}`, tone: 'error' },
      );
    });
  };

  return (
    <section className="settings-section" aria-labelledby="settings-providers">
      <h3 id="settings-providers">Providers</h3>
      <p className="muted">
        The agent calls the active profile. Keys are encrypted in this browser and never written into a project. The built-in demo
        profile answers only the three demo requests.
      </p>

      <ul className="profile-list" aria-label="Provider profiles">
        {profiles.map((profile) => {
          const card = presetFor(profile.kind === 'mock' ? 'mock' : profile.preset);
          return (
            <li key={profile.id} className={`profile-row${profile.isActive ? ' is-active' : ''}`} data-profile={profile.name}>
              <div className="profile-meta">
                <span className="profile-name">{profile.name}</span>
                {profile.isActive ? <span className="badge is-active">Active</span> : null}
                <span className="muted">
                  {/* The demo profile's model id is an internal name, so the row says what the profile is and nothing more. */}
                  {profile.kind === 'mock'
                    ? 'Demo, no key'
                    : `${card?.name ?? 'OpenAI-compatible endpoint'} · ${profile.baseUrl} · ${profile.defaultModel}`}
                </span>
                {card?.cors === 'blocked' ? <span className="badge">Desktop app or hosted only</span> : null}
                {/* Tied to the profile as it resolves: shown only while its address is this computer's. */}
                {card?.local !== undefined && isLocalBase(profile.baseUrl) ? <span className="badge">Your text stays on this computer</span> : null}
                {profile.responseFormat !== undefined ? (
                  <span className="muted">
                    {profile.responseFormat.supportsJsonObject ? 'Structured output accepted' : 'Structured output not accepted'}
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
                        setMessage({ text: `“${profile.name}” is now the active profile. ${outcome.note ?? ''}`.trim(), tone: 'info' });
                        void services.settings.update({ provider: { activeProfileId: profile.id } });
                      })
                    }
                  >
                    Use this profile
                  </button>
                ) : null}
                <button type="button" className="button is-quiet" disabled={busy} onClick={() => setForm(formFor(profile))}>
                  Edit
                </button>
                <button
                  type="button"
                  className="button is-quiet is-danger"
                  disabled={busy}
                  aria-label={`Remove ${profile.name}`}
                  onClick={() =>
                    void run(async () => {
                      await providers.remove(profile.id);
                      setForm(null);
                      setMessage({ text: `Removed “${profile.name}”, and its key from this browser.`, tone: 'info' });
                      const now = providers.active();
                      if (now !== undefined) void services.settings.update({ provider: { activeProfileId: now.id } });
                    })
                  }
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {form === null ? (
        <button type="button" className="button" disabled={busy} onClick={() => setForm({ ...BLANK })}>
          Add a provider
        </button>
      ) : (
        <form className="profile-form" onSubmit={save} aria-label={form.id === null ? 'New provider' : 'Edit provider'}>
          <label>
            <span>Provider</span>
            {/* The first control is the preset: it fixes the route, the fields and the model catalogue (provider-gateway §2).
                A saved profile's preset is fixed for its life — it is the record, not a preference. A preset whose API does
                not answer a browser stays listed, disabled, with its honest label (provider-gateway §9). */}
            <select value={form.preset} disabled={form.id !== null} onChange={(event) => choosePreset(event.target.value)}>
              {PRESETS.filter((entry) => entry.local === undefined && (entry.id !== 'mock' || form.preset === 'mock')).map((entry) => (
                <option key={entry.id} value={entry.id} disabled={entry.cors === 'blocked'}>
                  {entry.cors === 'blocked' ? `${entry.name} — Desktop app or hosted only` : entry.name}
                </option>
              ))}
              <optgroup label="On this computer">
                {PRESETS.filter((entry) => entry.local !== undefined).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          {preset !== undefined && preset.cors === 'blocked' ? (
            <p className="field-help">Desktop app or hosted only{preset.corsNote === undefined ? '' : ` — ${preset.corsNote}`}</p>
          ) : preset?.corsNote !== undefined ? (
            <p className="field-help">{preset.corsNote}</p>
          ) : null}
          <label>
            <span>Name</span>
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
                <span>
                  {field.label}
                  {field.required === true ? '' : ' (optional)'}
                </span>
                <input type="text" value={form.fields[field.key] ?? ''} onChange={(event) => setField(field.key, event.target.value)} />
              </label>
            ),
          )}
          {isGeneric === true ? (
            <label>
              <span>Endpoint (the base URL, ending in /v1)</span>
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
                <span>Server address (on this computer, ending in /v1)</span>
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
                    {preset.local.product} documentation
                  </a>
                )}
              </p>
              <p className="field-help">
                {/* Said before the first request: Chrome and Edge ask for this permission themselves, in words that do not mention a model. */}
                The first time, Chrome and Edge ask whether this site may connect to apps on your device. Choose Allow; if you decline,
                requests are blocked until you allow them in the site settings. Safari is unverified.
              </p>
              {isLocalBase(form.baseUrl) ? <p className="field-help">Your text stays on this computer.</p> : null}
            </>
          ) : preset !== undefined && preset.id !== 'mock' && preset.baseUrl !== '' ? (
            <p className="field-help">
              Endpoint: <code>{preset.baseUrlFor?.(form.fields) ?? preset.baseUrl}</code>
            </p>
          ) : null}
          <label>
            <span>Model</span>
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
                <p className="field-help">This provider documents no model list — its table below is the catalogue.</p>
              ) : null}
            </>
          ) : null}
          {isMock !== true ? (
            <label>
              <span>API key {keyHint(preset, form, original, keyNeeded)}</span>
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
              <legend>Extra request headers (optional)</legend>
              <p className="field-help">
                Sent with every request, and sealed with the key — they are never shown again.
                {form.id !== null ? ' Leave this list untouched to keep the stored set; empty it again to clear it.' : ''}
              </p>
              {form.headers.map((header, index) => (
                <div className="header-row" key={index}>
                  <input
                    aria-label={`Header ${index + 1} name`}
                    placeholder="x-my-header"
                    value={header.name}
                    onChange={(event) => setHeader(index, { name: event.target.value })}
                  />
                  <input
                    aria-label={`Header ${index + 1} value`}
                    type="password"
                    autoComplete="off"
                    placeholder="the header’s value"
                    value={header.value}
                    onChange={(event) => setHeader(index, { value: event.target.value })}
                  />
                  <button
                    type="button"
                    className="button is-quiet"
                    aria-label={`Remove header ${index + 1}`}
                    onClick={() =>
                      setForm({ ...form, headersTouched: true, headers: form.headers.filter((_, i) => i !== index) })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button is-quiet"
                onClick={() => setForm({ ...form, headersTouched: true, headers: [...form.headers, { name: '', value: '' }] })}
              >
                Add a header
              </button>
            </fieldset>
          ) : null}
          {isMock !== true ? (
            <fieldset className="price-fields">
              <legend>
                Price per 1,000 tokens, in dollars (optional: fill both to see the cost of a step). A saved price stays until you type a new
                one, so clearing these fields does not remove it.
              </legend>
              <label>
                <span>Prompt</span>
                <input type="number" min={0} step="any" value={form.promptPrice} onChange={(event) => setForm({ ...form, promptPrice: event.target.value })} />
              </label>
              <label>
                <span>Reply</span>
                <input type="number" min={0} step="any" value={form.completionPrice} onChange={(event) => setForm({ ...form, completionPrice: event.target.value })} />
              </label>
            </fieldset>
          ) : null}
          <div className="profile-form-actions">
            <button type="submit" className="button is-primary" disabled={busy}>
              Save profile
            </button>
            <button type="button" className="button is-quiet" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {models !== null ? (
        <section
          className="models"
          aria-label={
            presetFor(models.preset)?.noModelsRoute === true ? `Models documented for ${models.profile}` : `Models listed by ${models.profile}`
          }
        >
          <h4>
            {presetFor(models.preset)?.noModelsRoute === true ? `Models documented for ${models.profile}` : `Models listed by ${models.profile}`}
          </h4>
          {presetFor(models.preset)?.noModelsRoute === true ? (
            <p className="muted">This provider documents no model list — these are the models its table knows.</p>
          ) : null}
          {models.list.length === 0 ? <p className="muted">The endpoint listed no models.</p> : null}
          <ul>
            {models.list.slice(0, 40).map((model) => (
              <li key={model.id}>
                <code>{model.id}</code>
                {modelDetails(model) === '' ? null : <span className="muted"> · {modelDetails(model)}</span>}
                {form !== null ? (
                  <button type="button" className="button is-quiet" aria-label={`Use ${model.id} as the model`} onClick={() => setForm({ ...form, model: model.id })}>
                    Use
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
      {active === undefined ? <p className="status-line is-error">No provider is active, so the agent cannot run.</p> : null}
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

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
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
      else onSaved('Saved the task roles.');
    });
  };

  return (
    <section aria-labelledby="settings-roles">
      <h4 id="settings-roles">Task roles</h4>
      <p className="muted">
        Each kind of call can run on its own profile, model and thinking level. Drafting and background follow the chat choice
        unless they are pinned; chat with no pin is the active profile.
      </p>
      <form className="role-rows" onSubmit={save}>
        {ROLE_NAMES.map(({ id, label, hint }) => {
          const draft = drafts[id];
          const pinned = profiles.find((entry) => entry.id === draft.profileId);
          const preset = presetFor(pinned?.kind === 'mock' ? 'mock' : pinned?.preset);
          const modelId = draft.model.trim() !== '' ? draft.model.trim() : (pinned?.defaultModel ?? '');
          const levels = preset !== undefined && modelId !== '' ? (modelRowFor(preset, modelId)?.caps.effortLevels ?? []) : [];
          return (
            <div className="role-row" key={id}>
              <span className="role-title">
                {label} <span className="muted">· {hint}</span>
              </span>
              <select
                aria-label={`${label} profile`}
                value={pinned?.id ?? ''}
                onChange={(event) => setDrafts({ ...drafts, [id]: { profileId: event.target.value, model: '', thinking: '' } })}
              >
                <option value="">{id === 'chat' ? 'Active profile' : 'Follow chat'}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              {pinned !== undefined ? (
                <>
                  <input
                    aria-label={`${label} model`}
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
                      aria-label={`${label} thinking level`}
                      value={levels.includes(draft.thinking as ThinkingLevel) ? draft.thinking : ''}
                      onChange={(event) => setDrafts({ ...drafts, [id]: { ...draft, thinking: event.target.value } })}
                    >
                      <option value="">Provider default</option>
                      {levels.map((level) => (
                        <option key={level} value={level}>
                          {ROLE_LEVEL_NAMES[level]}
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
            Save task roles
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
const ROLE_LABELS: Readonly<Record<TaskRole, string>> = { chat: 'Chat', drafting: 'Drafting', background: 'Background' };

function UsagePanel({ services }: { services: AppServices }): ReactNode {
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
  return (
    <section className="usage" aria-labelledby="settings-usage">
      <h4 id="settings-usage">Usage on this device</h4>
      {rows.length === 0 ? (
        <p className="muted">No requests yet. Usage is counted by day, per profile, model and role, and stays in this browser.</p>
      ) : (
        <>
          <p className="muted">
            {totals.requests} {totals.requests === 1 ? 'request' : 'requests'}, about {totals.prompt} tokens in and {totals.completion} out.
          </p>
          <table className="usage-table">
            <caption className="visually-hidden">Usage by day, profile, model and role</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Profile</th>
                <th scope="col">Model</th>
                <th scope="col">Role</th>
                <th scope="col">Requests</th>
                <th scope="col">Tokens in</th>
                <th scope="col">Tokens out</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.date}:${row.profileId}:${row.model}:${row.role}`}>
                  <td>{row.date}</td>
                  <td>{names.get(row.profileId) ?? 'Removed profile'}</td>
                  <td>{row.model}</td>
                  <td>{ROLE_LABELS[row.role]}</td>
                  <td>{row.requests}</td>
                  <td>{row.promptTokens}</td>
                  <td>{row.completionTokens}</td>
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
  return (
    <section className="request-log" aria-labelledby="settings-requests">
      <h4 id="settings-requests">Request log</h4>
      <p className="muted">
        {entries.length === 0 ? 'Requests, retries included.' : `The last ${entries.length} requests, retries included.`} Nothing here holds a key or a message.
      </p>
      {entries.length === 0 ? (
        <p className="muted">No request has been sent yet.</p>
      ) : (
        <table className="request-table" data-testid="request-log">
          <caption className="visually-hidden">Requests, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Profile</th>
              <th scope="col">Attempt</th>
              <th scope="col">Outcome</th>
              <th scope="col">Status</th>
              <th scope="col">Max tokens</th>
              <th scope="col">Address</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={`${entry.at}:${index}`} data-outcome={entry.outcome}>
                <td>{new Date(entry.at).toLocaleTimeString()}</td>
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
      setMessage(error ?? 'Saved. It applies to the agent’s next request.');
    });
  };

  return (
    <section className="settings-section" aria-labelledby="settings-agent">
      <h3 id="settings-agent">Agent</h3>
      <p className="settings-note">
        The agent starts each request with a short list of tools and finds the others with a search when a task needs them. Some models
        search poorly. Turn this on to give such a model every tool on every request, at the cost of a longer prompt each time.
      </p>
      <label className="settings-check">
        <input type="checkbox" checked={loadEvery} data-testid="agent-load-every-tool" onChange={(event) => change(event.target.checked)} />
        <span>Load every tool on every request</span>
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

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const words = Number(target);
    const ms = Number(debounce);
    if (!Number.isFinite(words) || words < 0 || words > TARGET_MAX_WORDS || !Number.isInteger(words)) {
      setMessage(`The daily target is a whole number of words from 0 to ${TARGET_MAX_WORDS.toLocaleString('en-US')}; 0 means no target.`);
      return;
    }
    if (!Number.isFinite(ms) || ms < DEBOUNCE_MIN_MS || ms > DEBOUNCE_MAX_MS || !Number.isInteger(ms)) {
      setMessage(`The save delay is a whole number of milliseconds from ${DEBOUNCE_MIN_MS} to ${DEBOUNCE_MAX_MS}.`);
      return;
    }
    void services.settings.update({ session: { dailyTargetWords: words }, editor: { autosaveDebounceMs: ms, focusModeHideRails: hideRails } }).then((error) => {
      setMessage(error ?? 'Saved. The save delay applies to the projects you open from now on.');
    });
  };

  return (
    <section className="settings-section" aria-labelledby="settings-writing">
      <h3 id="settings-writing">Writing</h3>
      <form className="settings-form" noValidate onSubmit={save}>
        <label>
          <span>Daily target, in words (0 for none)</span>
          <input type="number" min={0} max={TARGET_MAX_WORDS} step={1} value={target} onChange={(event) => setTarget(event.target.value)} />
        </label>
        <label>
          <span>Save after typing stops, in milliseconds ({DEBOUNCE_MIN_MS}–{DEBOUNCE_MAX_MS})</span>
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
          <span>In focus mode, hide the binder and the inspector</span>
        </label>
        <button type="submit" className="button is-primary">
          Save writing settings
        </button>
      </form>
      <FormMessage message={message === null ? null : { text: message, tone: 'info' }} />
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Appearance
 * ------------------------------------------------------------------ */

function AppearanceSection(): ReactNode {
  const [theme, setTheme] = useState<Theme>(() => activeTheme());
  const choose = (next: Theme): void => {
    applyTheme(next);
    rememberTheme(next);
    setTheme(next);
  };
  return (
    <section className="settings-section" aria-labelledby="settings-appearance">
      <h3 id="settings-appearance">Appearance</h3>
      <fieldset className="settings-radios">
        <legend>Theme</legend>
        <label className="check">
          <input type="radio" name="theme" checked={theme === 'light'} onChange={() => choose('light')} /> Light
        </label>
        <label className="check">
          <input type="radio" name="theme" checked={theme === 'dark'} onChange={() => choose('dark')} /> Dark
        </label>
      </fieldset>
      <p className="muted">The choice is kept in this browser. Until you choose, the page follows the system.</p>
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
        setMessage('Trimmed to the limits. The count below is what is left.');
      },
      (error: unknown) => setMessage(`The trim did not finish: ${error instanceof Error ? error.message : String(error)}`),
    );
  };

  const saveLimits = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const nextCap = Number(cap);
    const nextDays = Number(days);
    if (!Number.isInteger(nextCap) || nextCap < 1 || nextCap > CHECKPOINT_CAP_MAX) {
      setMessage(`The checkpoint limit is a whole number from 1 to ${CHECKPOINT_CAP_MAX.toLocaleString('en-US')}.`);
      return;
    }
    if (!Number.isInteger(nextDays) || nextDays < 1 || nextDays > CHECKPOINT_DAYS_MAX) {
      setMessage(`The retention is a whole number of days from 1 to ${CHECKPOINT_DAYS_MAX}.`);
      return;
    }
    void services.settings.update({ retention: { checkpointCap: nextCap, checkpointDays: nextDays } }).then((error) => {
      setMessage(error ?? 'Saved. The limits apply to the projects you open from now on, and to the next trim.');
    });
  };

  return (
    <section className="settings-section" aria-labelledby="settings-data">
      <h3 id="settings-data">Data</h3>

      <section className="storage-row" aria-labelledby="settings-storage">
        <h4 id="settings-storage">Storage</h4>
        <p data-testid="storage-status">{durability === null ? 'Checking this browser’s storage…' : durabilitySentence(durability)}</p>
        {durability !== null && usageSentence(durability) !== null ? <p className="muted">{usageSentence(durability)}</p> : null}
        <p className="muted" data-testid="storage-location">
          Storage location: this browser (read-only in the browser app).
        </p>
      </section>

      <section aria-labelledby="settings-checkpoints">
        <h4 id="settings-checkpoints">Checkpoints</h4>
        {session === null ? (
          <p className="muted">Open a project to see its checkpoints.</p>
        ) : budgetError !== null ? (
          <p className="muted" role="alert">
            The checkpoints could not be counted: {budgetError}{' '}
            <button
              type="button"
              className="button is-quiet"
              onClick={() => {
                setBudgetError(null);
                bumpBudget();
              }}
            >
              Try again
            </button>
          </p>
        ) : budget === null ? (
          <p className="muted">Counting the checkpoints…</p>
        ) : (
          <dl className="budget" data-testid="snapshot-budget">
            <dt>Kept</dt>
            <dd>
              {budget.count} {budget.count === 1 ? 'checkpoint' : 'checkpoints'} across {budget.documents}{' '}
              {budget.documents === 1 ? 'document' : 'documents'}
            </dd>
            <dt>Size</dt>
            <dd>about {formatBytes(budget.estimatedBytes)}</dd>
            <dt>Limit</dt>
            <dd>
              {session.retentionLimits().checkpointCap} checkpoints, kept {session.retentionLimits().checkpointDays} days
            </dd>
          </dl>
        )}
        {session !== null ? (
          <button type="button" className="button" onClick={trim}>
            Trim to the limits now
          </button>
        ) : null}
        <form className="settings-form" onSubmit={saveLimits}>
          <label>
            <span>Checkpoints kept per project</span>
            <input type="number" min={1} max={CHECKPOINT_CAP_MAX} value={cap} onChange={(event) => setCap(event.target.value)} />
          </label>
          <label>
            <span>Days a checkpoint is kept</span>
            <input type="number" min={1} max={CHECKPOINT_DAYS_MAX} value={days} onChange={(event) => setDays(event.target.value)} />
          </label>
          <button type="submit" className="button">
            Save the limits
          </button>
        </form>
      </section>

      <FormMessage message={message === null ? null : { text: message, tone: 'info' }} />
      <p className="muted">
        The demo profile is named “{DEMO_PROFILE_NAME}”. A bundle export is the copy to keep: browser storage can be cleared.
      </p>
    </section>
  );
}
