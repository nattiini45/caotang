/**
 * Settings (ui-modules §5): a dialog with four sections. Providers holds the profiles, the save-time probe, the usage totals
 * and the request log. Writing holds the session target and the autosave debounce. Appearance holds the theme and the interface (Classic or Modern). Data holds the
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
  isLocalBase,
  presetFor,
  type RequestLogEntry,
  type TaskRole,
  type ThinkingLevel,
} from '@caotang/gateway';
import { pictureStorageReport, snapshotBudget, type RuntimeStore, type SnapshotBudget } from '@caotang/store';
import { AgentSessionData } from './AgentSessionData.js';

import type { AppServices } from '../app/services.js';
import type { Durability, ProjectSession } from '../app/session.js';
import { readDurability, durabilitySentence, formatBytes, usageSentence, type StorageHost, browserStorageHost } from '../app/storage.js';
import {
  CHECKPOINT_DAYS_MAX,
  CHECKPOINT_CAP_MAX,
  DEBOUNCE_MAX_MS,
  DEBOUNCE_MIN_MS,
  TARGET_MAX_WORDS,
  type AgentEditMode,
  type RoleRef,
  type RoleSettings,
  type RoleTargetRef,
} from '../app/settings.js';
import { applyInterface, interfaceStatus, rememberInterface, subscribeInterface, type Interface } from '../app/interface.js';
import { readModernPreferences, setModernPreference, type ModernPreferences } from '../app/modern-preferences.js';
import { activeTheme, applyTheme, rememberTheme, type Theme } from '../app/theme.js';
import { developerLanguageExposure, languageRevision, subscribeLanguage, switchInterfaceLanguage } from '../i18n/language.js';
import { sameLanguageSetting } from '../i18n/catalogues.js';
import { useFormat } from '../i18n/use-format.js';
import { readListedLanguages, recordListedLanguages } from '../i18n/listed-languages.js';
import { activeTag, preloadCatalogues } from '../i18n/runtime.js';
import { guideHref } from '../i18n/guide-links.js';
import { languageChoices, type InterfaceLanguageStats } from '../i18n/picker.js';
import languageStats from '../i18n/locales/stats.json';
import { timeLabel } from '../app/activity-model.js';
import { DEMO_PROFILE_NAME } from '../app/providers.js';
import { ProfileEditor } from './ProfileEditor.js';
import { ProviderSetup } from './ProviderSetup.js';
import { CoherenceSection } from './CoherenceSettings.js';
import { AgentModeSettings } from './AgentModeSettings.js';
import { AgentRulesSettings } from './AgentRulesSettings.js';
import { MacrosPanel } from './MacrosPanel.js';
import { HookSettings } from './HookSettings.js';
import { ContextSection } from './ContextSection.js';
import { McpSection } from './McpSection.js';
import { PictureStorageMeter } from './PictureStorageMeter.js';
import { OpenOnDesktop, useNarrow } from './narrow.js';
import { formatCount, useComposingEnter } from './shared.js';
import { Modal, useModalDialog } from './modal.js';
import { UsagePanel } from './UsagePanel.js';
import { probeFailureMessage } from './provider-probe-message.js';

/** A message beside a form: inline, next to what it is about, and never a toast alone. */
interface FormFeedback {
  readonly text: string;
  readonly tone: 'info' | 'error';
  readonly detail?: { readonly label: string; readonly text: string };
}

function FormMessage({ message }: { message: FormFeedback | null }): ReactNode {
  if (message === null) return null;
  return (
    <p className={`form-message is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
      {message.text}
      {message.detail === undefined ? null : <><br /><strong>{message.detail.label}</strong> <bdi>{message.detail.text}</bdi></>}
    </p>
  );
}

export type SettingsSection = 'providers' | 'context' | 'agent' | 'macros' | 'hooks' | 'writing' | 'coherence' | 'mcp' | 'appearance' | 'data';

const SECTIONS: readonly { readonly id: SettingsSection; readonly label: MessageDescriptor }[] = [
  { id: 'providers', label: msg`Providers` },
  { id: 'context', label: msg`Context` },
  { id: 'agent', label: msg`Agent` },
  { id: 'macros', label: msg`Macros` },
  { id: 'hooks', label: msg`Hooks` },
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
  /** Called when a macro's run has started, so the agent panel is open for the card it shows. */
  readonly onOpenAgent?: () => void;
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
  onOpenAgent,
  onProvidersChanged,
  storage,
}: SettingsProps): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const narrow = useNarrow();
  useModalDialog(ref);
  // The language picker lives here; warm the lazy catalogues while the writer reads the sections, so a
  // choice resolves from the module cache instead of waiting on a cold download (i18n.md §3.3).
  useEffect(() => {
    void preloadCatalogues();
  }, []);

  return (
    <Modal
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
            {section === 'agent' ? <AgentSection services={services} session={session} /> : null}
            {section === 'macros' ? (
              <MacrosPanel
                session={session}
                onRan={() => {
                  onOpenAgent?.();
                  onClose();
                }}
              />
            ) : null}
            {section === 'writing' ? <WritingSection services={services} /> : null}
            {section === 'hooks' ? <HookSettings session={session} services={services} /> : null}
            {section === 'coherence' ? <CoherenceSection services={services} /> : null}
            {section === 'mcp' ? narrow ? <OpenOnDesktop feature="mcp" /> : <McpSection mcp={services.mcp} /> : null}
            {section === 'appearance' ? <AppearanceSection services={services} /> : null}
            {section === 'data' ? <DataSection services={services} session={session} store={store} storage={storage} /> : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

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
  /** The role's fallbacks, in order: at most two, and none until the writer picks one. */
  readonly fallbacks: readonly { readonly profileId: string }[];
}

const EMPTY_FALLBACK = { profileId: '' };

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
      ? { profileId: '', model: '', thinking: '', fallbacks: [] }
      : {
          profileId: ref.profileId,
          model: ref.model ?? '',
          thinking: ref.thinking ?? '',
          fallbacks: (ref.fallbacks ?? []).map((target) => ({ profileId: target.profileId })),
        };
  return { chat: draft(roles?.chat), drafting: draft(roles?.drafting), background: draft(roles?.background) };
}

/** One role's fallbacks as the form writes them: the picked profiles in order, unsaved slots left out. */
function fallbacksOf(draft: RoleDraft): readonly RoleTargetRef[] {
  const seen = new Set<string>();
  const kept: RoleTargetRef[] = [];
  for (const entry of draft.fallbacks) {
    if (entry.profileId === '' || entry.profileId === draft.profileId || seen.has(entry.profileId)) continue;
    seen.add(entry.profileId);
    kept.push({ profileId: entry.profileId });
    if (kept.length === 2) break;
  }
  return kept;
}

function ProvidersSection({ services, onChanged }: { services: AppServices; onChanged?: () => void }): ReactNode {
  const providers = services.providers;
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => providers.subscribeVerification(refresh), [providers]);
  const [adding, setAdding] = useState(() => providers.list().every((profile) => profile.kind === 'mock'));
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<FormFeedback | null>(null);
  const profiles = providers.list();
  const active = providers.active();
  const editedProfile = editing === null ? undefined : providers.get(editing);

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

  return (
    <section className="settings-section" aria-labelledby="settings-providers" data-panel-state={busy ? 'working' : 'idle'}>
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
            <li key={profile.id} className={`profile-row${profile.isActive ? ' is-active' : ''}`} data-profile={profile.name} data-state={profile.kind === 'mock' ? 'demo' : (profile.verification?.kind ?? 'unknown')}>
              <div className="profile-meta">
                <span className="profile-name">{profile.name}</span>
                {profile.isActive ? (
                  <span className="badge is-active">
                    <Trans>Active</Trans>
                  </span>
                ) : null}
                {profile.kind === 'endpoint' && profile.verification?.kind !== 'verified' ? (
                  <span className="badge"><Trans>Not verified</Trans></span>
                ) : null}
                {profile.verification?.kind === 'checking' ? (
                  <span className="muted" role="status"><Trans>Checking this profile…</Trans></span>
                ) : profile.verification?.kind === 'failed' ? (
                  <span className="muted"><Trans>Edit and save this profile to check it again.</Trans></span>
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
                <button type="button" className="button is-quiet" disabled={busy} onClick={() => { setAdding(false); setEditing(profile.id); }}>
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
                      if (editing === profile.id) setEditing(null);
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

      {adding ? (
        <ProviderSetup
          providers={providers}
          onDone={(view) => {
            void services.settings.update({ provider: { activeProfileId: view.id } });
            refresh();
            onChanged?.();
          }}
          onClose={() => setAdding(false)}
        />
      ) : editedProfile !== undefined ? (
        <ProfileEditor
          key={editedProfile.id}
          providers={providers}
          profile={editedProfile}
          onClose={() => setEditing(null)}
          onSaved={(outcome) => {
            setEditing(null);
            setMessage(
              outcome.probeError === undefined
                ? { text: t`Saved “${{ profile: isolate(outcome.view.name) }}”.`, tone: 'info' }
                : { ...probeFailureMessage(outcome.view.name, outcome.probeFailure), tone: 'error' },
            );
            refresh();
            onChanged?.();
          }}
        />
      ) : (
        <button type="button" className="button" disabled={busy} onClick={() => setAdding(true)}>
          <Trans>Add a provider</Trans>
        </button>
      )}

      <FormMessage message={message} />

      <RolesPanel services={services} onSaved={(text) => setMessage({ text, tone: 'info' })} />
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
function RolesPanel({ services, onSaved }: { services: AppServices; onSaved: (text: string) => void }): ReactNode {
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
      const fallbacks = fallbacksOf(draft);
      return {
        profileId: profile.id,
        ...(draft.model.trim() === '' ? {} : { model: draft.model.trim() }),
        ...(draft.thinking === '' ? {} : { thinking: draft.thinking as ThinkingLevel }),
        ...(fallbacks.length === 0 ? {} : { fallbacks }),
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
      <p className="muted">
        <Trans>
          A role can name up to two fallbacks. One answers only when the role’s own profile is rate-limited, overloaded or unreachable,
          and only before any of the reply has arrived; the request, context included, then goes to that profile.
        </Trans>
      </p>
      <form className="role-rows" onKeyDown={ime.noteKey} onSubmit={save}>
        {ROLE_NAMES.map(({ id, label, hint }) => {
          const labelText = i18n._(label);
          const draft = drafts[id];
          const pinned = profiles.find((entry) => entry.id === draft.profileId);
          const preset = presetFor(pinned?.kind === 'mock' ? 'mock' : pinned?.preset);
          const modelId = draft.model.trim() !== '' ? draft.model.trim() : (pinned?.defaultModel ?? '');
          // The levels the profile resolves to: the row's, with the profile's own request parameters over them.
          const levels = pinned !== undefined && modelId !== '' ? (providers.gateway.modelCaps(pinned.id, modelId).effortLevels ?? []) : [];
          return (
            <div className="role-row" key={id}>
              <span className="role-title">
                {labelText} <span className="muted">· {i18n._(hint)}</span>
              </span>
              <select
                aria-label={t`${{ role: labelText }} profile`}
                value={pinned?.id ?? ''}
                // The row keeps the fallbacks it already lists: picking a profile resets the model and level, never the order.
                onChange={(event) => setDrafts({ ...drafts, [id]: { ...draft, profileId: event.target.value, model: '', thinking: '' } })}
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
                    {[...new Set((preset?.models ?? []).filter((row) => !row.pattern.includes('*')).map((row) => row.pattern))].map((modelOption) => (
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
              <div className="role-fallbacks">
                <span className="muted">{t`Fallbacks, in order`}</span>
                {[0, 1].map((slot) => {
                  const value = draft.fallbacks[slot]?.profileId ?? '';
                  // The other slot's profile and the role's own are never offered: a list names each destination once.
                  const taken = new Set([pinned?.id ?? '', draft.fallbacks[slot === 0 ? 1 : 0]?.profileId ?? '']);
                  return (
                    <select
                      key={slot}
                      aria-label={t`${{ role: labelText }} fallback ${{ slot: slot + 1 }}`}
                      value={value}
                      onChange={(event) => {
                        const next = [draft.fallbacks[0] ?? EMPTY_FALLBACK, draft.fallbacks[1] ?? EMPTY_FALLBACK];
                        next[slot] = { profileId: event.target.value };
                        setDrafts({ ...drafts, [id]: { ...draft, fallbacks: next } });
                      }}
                    >
                      <option value="">{t`No fallback`}</option>
                      {profiles.filter((profile) => !taken.has(profile.id)).map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                  );
                })}
              </div>
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


function RequestLogPanel({ services }: { services: AppServices }): ReactNode {
  const narrow = useNarrow();
  const entries: RequestLogEntry[] = services.providers.requests.entries().slice().reverse();
  const names = new Map(services.providers.list().map((profile) => [profile.id, profile.name]));
  const entryCount = entries.length;
  const profileName = (entry: RequestLogEntry): string => names.get(entry.profileId) ?? entry.profileId;
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
      ) : narrow ? (
        // A phone's Settings pane is narrower than these eight columns, so each request is a labelled record instead of a row of a
        // table that would scroll the whole pane sideways (ui-modules §0.6, the shape the usage records share).
        <ul className="records" data-testid="request-log" aria-label={t`Requests, newest first`}>
          {entries.map((entry, index) => (
            <li key={`${entry.at}:${index}`} data-outcome={entry.outcome}>
              <h5>
                <bdi>{timeLabel(entry.at)}</bdi> · {entry.outcome}
              </h5>
              <dl className="record-values">
                <div>
                  <dt><Trans>Profile</Trans></dt>
                  <dd><bdi>{profileName(entry)}</bdi></dd>
                </div>
                <div>
                  <dt><Trans>Attempt</Trans></dt>
                  <dd>{entry.attempt}</dd>
                </div>
                <div>
                  <dt><Trans>Outcome</Trans></dt>
                  <dd>{entry.outcome}</dd>
                </div>
                {entry.status === undefined ? null : (
                  <div>
                    <dt><Trans>Status</Trans></dt>
                    <dd>{entry.status}</dd>
                  </div>
                )}
                {entry.maxTokens === undefined ? null : (
                  <div>
                    <dt><Trans>Max tokens</Trans></dt>
                    <dd>{entry.maxTokens}</dd>
                  </div>
                )}
                <div>
                  <dt><Trans>Address</Trans></dt>
                  <dd className="request-url">{entry.url.replace(/^https?:\/\//, '')}</dd>
                </div>
                {entry.note === undefined && entry.errorKind === undefined ? null : (
                  <div>
                    <dt><Trans>Note</Trans></dt>
                    <dd>{entry.note ?? entry.errorKind}</dd>
                  </div>
                )}
              </dl>
            </li>
          ))}
        </ul>
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
                <td>{profileName(entry)}</td>
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

function AgentSection({ services, session }: { services: AppServices; session: ProjectSession | null }): ReactNode {
  const [loadEvery, setLoadEvery] = useState(services.settings.current().agent.loadEveryTool);
  // Read live, so the Trace tab's own switch and this one never disagree.
  const keepTraces = useSyncExternalStore(services.settings.subscribe, services.settings.current).agent.keepTraces;
  const [message, setMessage] = useState<string | null>(null);
  const [traceMessage, setTraceMessage] = useState<{ readonly text: string; readonly tone: 'info' | 'error' } | null>(null);

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
      <p className="settings-note">
        The Trace tab shows what each turn sent to the model and got back. It holds your prompts and manuscript text, only in this tab’s memory, and a
        reload clears it. Turn it off to gather nothing.
      </p>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={keepTraces}
          data-testid="agent-keep-traces"
          onChange={(event) => {
            void services.settings.update({ agent: { keepTraces: event.target.checked } }).then((error) => {
              setTraceMessage(error === null ? { text: 'Saved. It applies to what the agent records next.', tone: 'info' } : { text: error, tone: 'error' });
            });
          }}
        />
        <span>Keep agent traces for this tab</span>
      </label>
      <FormMessage message={traceMessage} />
      <AgentModeSettings services={services} />
      <AgentRulesSettings services={services} session={session} />
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
  const [agentEditMode, setAgentEditMode] = useState<AgentEditMode>(current.editor.agentEditMode);
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
    void services.settings.update({ session: { dailyTargetWords: words }, editor: { autosaveDebounceMs: ms, focusModeHideRails: hideRails, agentEditMode } }).then((error) => {
      setMessage(error ?? t`Saved. The save delay applies to the projects you open from now on, and the agent-edit choice to the next document you open.`);
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
        <label>
          <span>When you apply an agent edit</span>
          <select
            value={agentEditMode}
            aria-describedby="agent-edit-help"
            onChange={(event) => setAgentEditMode(event.target.value === 'suggestions' ? 'suggestions' : 'ghost')}
          >
            <option value="ghost">Replace the text</option>
            <option value="suggestions">Mark the changes for review</option>
          </select>
        </label>
        <p className="muted" id="agent-edit-help">
          Marking keeps the agent’s new text in the scene and underlines or strikes only the words that changed, so you can keep or put back
          each change. The agent’s text is already saved when the marks appear, so other tools and git see the accepted version, and rejecting
          a change is what edits the file. It covers prose scenes only, not Ink or Fountain. Closing the tab with changes still marked keeps
          the agent’s text. A new agent edit accepts any earlier marks first. The choice applies the next time you open a document.
        </p>
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

  const shellStatus = useSyncExternalStore(subscribeInterface, interfaceStatus);
  const shellChoices = useRef<HTMLFieldSetElement>(null);
  const shell = shellStatus.chosen;
  const chooseShell = (next: Interface): void => {
    void applyInterface(next).catch(() => undefined);
    rememberInterface(next);
  };
  // Modern's two switches (modern-interface.md §9.4), shown while Modern is chosen; they apply to Modern only.
  const [modernPrefs, setModernPrefs] = useState<ModernPreferences>(() => readModernPreferences());
  const chooseModernPref = (name: keyof ModernPreferences, on: boolean): void => setModernPrefs(setModernPreference(name, on));
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
      <fieldset ref={shellChoices} className="settings-radios" data-state={shellStatus.kind} data-testid="interface-choice">
        <legend>{t`Interface`}</legend>
        <label className="check">
          <input type="radio" name="shell" checked={shell === 'classic'} onChange={() => chooseShell('classic')} /> <Trans>Classic</Trans>
        </label>
        <label className="check">
          <input type="radio" name="shell" checked={shell === 'modern'} onChange={() => chooseShell('modern')} />{' '}
          {t`Modern`}
        </label>
      </fieldset>
      {shellStatus.kind === 'loading' ? <p role="status">{t`Loading the interface…`}</p> : null}
      {shellStatus.kind === 'failed' ? (
        <div>
          <p className="form-message is-error" role="alert">
            {shell === 'modern'
              ? t`Modern could not load. The current interface is still in use. Try again or choose Classic.`
              : t`Classic could not finish loading. Try again.`}
          </p>
          <button type="button" className="button" onClick={() => {
            shellChoices.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
            chooseShell(shell);
          }}>{t`Try again`}</button>
        </div>
      ) : null}
      <p className="muted">
        {t`Classic is the interface Caotang has had so far. Modern shows the page and a few controls, and brings the rest in when you ask for it. New writers start in Modern; if you used Caotang before, it stays Classic until you choose. The choice is kept in this browser and applies at once.`}
      </p>
      {shell === 'modern' ? (
        <fieldset className="settings-radios" data-testid="modern-preferences">
          <legend>{t`Modern interface`}</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={modernPrefs.reduceTransparency}
              onChange={(event) => chooseModernPref('reduceTransparency', event.currentTarget.checked)}
            />{' '}
            {t`Reduce transparency`}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={modernPrefs.reduceMotion}
              onChange={(event) => chooseModernPref('reduceMotion', event.currentTarget.checked)}
            />{' '}
            {t`Reduce motion`}
          </label>
          <p className="muted">
            {t`These apply to the Modern interface: glass becomes solid, and nothing slides or grows. Your system’s own settings for transparency and motion are always followed as well.`}
          </p>
        </fieldset>
      ) : null}

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
      <AgentSessionData services={services} session={session} store={store} />
      <p className="muted">
        <Trans>
          The demo profile is named “{DEMO_PROFILE_NAME}”. A bundle export is the copy to keep: browser storage can be cleared.
        </Trans>
      </p>
    </section>
  );
}
