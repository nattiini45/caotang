/**
 * The app-level services, opened once at start-up: the app database, the settings, and the provider services (ui-modules
 * §5, provider-gateway). Opening never throws. A browser that refuses the app database gets the defaults, an in-memory
 * provider and a notice, and the writing surfaces work as they did before.
 */

import { t } from '@lingui/core/macro';
import type { McpSettings, WireFactory } from '@caotang/mcp-client';

/* lingui-set comment="Interpolated values: error" */

import { isLoopbackHost, originOf } from '@caotang/gateway';
import type { NativeEgressTarget, ProfileView } from '@caotang/gateway';

import { sweepHistory } from './history-store.js';
import { desktopEgress } from './native-egress.js';
import { openDesktopKeys } from './native-vault.js';
import { APP_KEYS, openAppDb, setActiveAppDb, type AppDb } from './app-db.js';
import { McpApp } from './mcp.js';
import { SaveChannel } from './save-channel.js';
import { studioHost } from './studio-host.js';
import { ProviderService } from './providers.js';
import { DEFAULT_SETTINGS, applyPatch, mcpLoadWarnings, normalizeSettings, type AppSettings, type SettingsPatch } from './settings.js';

/** The settings the app keeps: read synchronously by the UI, written through to the app database. */
export class SettingsStore {
  private value: AppSettings;
  private readonly listeners = new Set<() => void>();
  readonly saveChannel = new SaveChannel('settings');

  constructor(
    private readonly db: AppDb | null,
    initial: AppSettings,
  ) {
    this.value = initial;
  }

  /** The current value. An arrow, because the panels hand it to React's store hook unbound. */
  current = (): AppSettings => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Applies a patch and stores it. `publishAfterSave` waits for the commit before notifying. Returns a refusal or `null`. */
  async update(patch: SettingsPatch, options: { readonly publishAfterSave?: boolean } = {}): Promise<string | null> {
    if (options.publishAfterSave) {
      return this.saveChannel.enqueue(async () => {
        const error = await this.write(applyPatch(this.value, patch));
        if (error !== null) return error;
        this.value = applyPatch(this.value, patch);
        for (const listener of this.listeners) listener();
        return null;
      });
    }
    this.value = applyPatch(this.value, patch);
    for (const listener of this.listeners) listener();
    return this.persist();
  }

  /** Writes the current value. Never throws: a failed write is returned as text for the status line. */
  async persist(): Promise<string | null> {
    return this.saveChannel.enqueue(() => this.write(this.value));
  }

  private async write(value: AppSettings): Promise<string | null> {
    if (this.db === null) return null;
    try {
      await this.db.put(APP_KEYS.settings, value);
      return null;
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      return t`The settings could not be saved in this browser: ${{ error: errorText }}`;
    }
  }
}

/**
 * Whether the app database held a settings record the first time this page read it, `undefined` until then. Only the first read
 * counts: start-up writes the record (the active profile mirror below), and a second open in the same page load (React's strict
 * mode runs the effect twice in development) must not take that write for an earlier visit. The interface's default reads it (app/interface.ts).
 */
let settingsKeptAtStart: boolean | undefined;

export interface AppServices {
  readonly db: AppDb | null;
  /** Whether the settings record was there before this page load wrote anything: an existing writer (app/interface.ts). */
  readonly settingsKept: boolean;
  readonly settings: SettingsStore;
  readonly providers: ProviderService;
  /** The MCP & tools client for the session (extensibility §3, §8). Nothing connects until a person asks it to. */
  readonly mcp: McpApp;
  /** What the start-up could not do, phrased for the writer. Empty when everything opened. */
  readonly notices: readonly string[];
  /** Whether this computer's keychain holds the provider keys, rather than this browser's storage. */
  readonly keychain: boolean;
}

export interface OpenServicesOptions {
  /** The MCP transport. Absent in a shipped build, where the SDK's Streamable HTTP wire is used. */
  readonly mcpWire?: WireFactory;
}

/**
 * Opens the app database, the settings and the providers. `factory` is the browser's `indexedDB`, or `null` where there is
 * none. The project store is not opened here; the caller owns it.
 */
export async function openAppServices(factory: IDBFactory | null, options: OpenServicesOptions = {}): Promise<AppServices> {
  const notices: string[] = [];
  let db: AppDb | null = null;
  let stored: unknown = undefined;
  if (factory !== null) {
    try {
      db = await openAppDb(factory);
    } catch (error) {
      const message = errorText(error);
      notices.push(t`The app settings could not be opened here, so they will not be kept: ${{ error: message }}`);
    }
  } else {
    notices.push(t`This browser has no IndexedDB, so provider settings and usage are kept for this visit only.`);
  }

  let initial = DEFAULT_SETTINGS;
  if (db !== null) {
    try {
      stored = await db.get<unknown>(APP_KEYS.settings);
      settingsKeptAtStart ??= stored !== undefined;
      initial = normalizeSettings(stored);
    } catch (error) {
      const message = errorText(error);
      notices.push(t`The settings could not be read, so the defaults are in use: ${{ error: message }}`);
    }
  }
  // An MCP server that did not load is named, and the rest of the settings are kept (extensibility §8).
  notices.push(...mcpLoadWarnings(stored));
  setActiveAppDb(db);
  // The undo journals not written for 30 days go (history-store.ts). Not awaited: the app opens without them.
  void sweepHistory(db);

  const host = studioHost();
  // In the desktop shell, provider calls are made by the main process: a provider that sends no CORS headers answers the app
  // where a browser could not read it (desktop.md). Published addresses come from the profiles themselves, read before each
  // call, so a profile saved a moment ago is reachable on its first request.
  const egress = desktopEgress();
  // A key from an earlier build moves in for the address its profile names; a profile that is gone leaves its key where it is,
  // because a host that cannot bind a key could never send it (native-vault.ts, #864).
  const persisted = ((await db?.get<readonly { id: string; baseUrl?: string }[]>(APP_KEYS.profiles)) ?? []);
  const profileOrigins = new Map<string, string>();
  for (const record of persisted) {
    if (typeof record.baseUrl !== 'string') continue;
    try {
      profileOrigins.set(record.id, originOf(record.baseUrl));
    } catch {
      // An address that does not parse names no origin, so its key is not moved.
    }
  }
  const keys = await openDesktopKeys(factory, (id) => profileOrigins.get(id));
  const { service, notices: providerNotices } = await ProviderService.open({
    db,
    vault: factory,
    ...(host === null ? {} : { host }),
    ...(keys.kind === 'keychain' ? { keys: keys.store } : {}),
    ...(egress === undefined ? {} : { fetch: egress.fetch }),
  });
  if (keys.kind === 'unavailable') {
    notices.push(t`The operating system's keychain could not be used on this computer, so keys stay encrypted in this browser. Add them again from Settings if you expect one there.`);
  } else if (keys.kind === 'keychain') {
    if (keys.moved > 0) notices.push(t`Your provider keys are now kept by this computer's keychain instead of this browser.`);
    if (keys.failed) notices.push(t`Some keys could not be moved into this computer's keychain. Settings names each profile without one, and entering the key again keeps it there.`);
  }
  notices.push(...providerNotices);
  const settings = new SettingsStore(db, initial);
  // The agent trace follows its setting (agent-harness §5.2): on, the gateway is observed; off, nothing is gathered and what was is cleared.
  const traceOn = (): void => service.trace.keep(settings.current().agent.keepTraces);
  traceOn();
  settings.subscribe(traceOn);
  // The active profile is mirrored into the settings record (ui-modules §5.1), so the record names the profile the agent uses.
  const active = service.active();
  if (active !== undefined && settings.current().provider.activeProfileId !== active.id) {
    await settings.update({ provider: { activeProfileId: active.id } });
  }
  egress?.points(() => egressTargets(service.profiles.list(), settings.current().mcp));
  const mcp = new McpApp({
    settings: { current: () => settings.current().mcp, update: (patch, options) => settings.update(patch, options) },
    keys: service.keys,
    ...(options.mcpWire === undefined ? {} : { wire: options.mcpWire }),
    // A server's token lives in the keychain with the provider keys, so a call to it is made by the process that holds it. Where
    // the fetch is the page's own there is nothing to hand over and no CORS refusal to explain away.
    ...(egress === undefined ? {} : {
      fetch: (url: string | URL, init?: RequestInit) => egress.fetch(typeof url === 'string' ? url : url.href, init ?? {}),
      probe: () => Promise.resolve(true),
    }),
  });
  return { db, settingsKept: settingsKeptAtStart === true, settings, providers: service, mcp, keychain: keys.kind === 'keychain', notices };
}

/**
 * The addresses the desktop port may reach, and the key each may carry: a provider profile's origin with that profile's key,
 * and a connected MCP server's origin with its bearer token.
 *
 * A provider profile is never local, so a model server on this computer keeps the browser's path and its own prompts. An MCP
 * server may be local, because a server on this computer is where a bearer token most often lives, and the main process is
 * where the token is.
 */
function egressTargets(profiles: readonly ProfileView[], mcp: McpSettings): NativeEgressTarget[] {
  const targets: NativeEgressTarget[] = [];
  /** A record whose address does not parse cannot be reached anyway; the form that saved it reported the address. */
  // The page says which addresses the app is configured for, and nothing about keys: the shell reads each key's address from
  // the binding it recorded when the writer stored it (#864).
  const add = (url: string, local = false): void => {
    try {
      targets.push({ origin: originOf(url), ...(local ? { local } : {}) });
    } catch {
      // A record whose address does not parse is not an address, so it adds nothing to the list.
    }
  };
  for (const profile of profiles) {
    if (profile.kind !== 'mock') add(profile.baseUrl);
  }
  for (const server of mcp.servers) {
    let local = false;
    try {
      local = isLoopbackHost(new URL(server.url).hostname);
    } catch {
      continue;
    }
    add(server.url, local);
  }
  return targets;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
