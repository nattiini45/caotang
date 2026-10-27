/**
 * The app-level services, opened once at start-up: the app database, the settings, and the provider services (ui-modules
 * §5, provider-gateway). Opening never throws. A browser that refuses the app database gets the defaults, an in-memory
 * provider and a notice, and the writing surfaces work as they did before.
 */

import { t } from '@lingui/core/macro';
import type { WireFactory } from '@caotang/mcp-client';

/* lingui-set comment="Interpolated values: error" */

import { sweepHistory } from './history-store.js';
import { APP_KEYS, openAppDb, setActiveAppDb, type AppDb } from './app-db.js';
import { McpApp } from './mcp.js';
import { ProviderService } from './providers.js';
import { DEFAULT_SETTINGS, applyPatch, mcpLoadWarnings, normalizeSettings, type AppSettings, type SettingsPatch } from './settings.js';

/** The settings the app keeps: read synchronously by the UI, written through to the app database. */
export class SettingsStore {
  private value: AppSettings;
  private readonly listeners = new Set<() => void>();

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

  /** Applies a patch, announces it, and stores it. Returns why the store refused, or `null` when it was kept. */
  async update(patch: SettingsPatch): Promise<string | null> {
    this.value = applyPatch(this.value, patch);
    for (const listener of this.listeners) listener();
    return this.persist();
  }

  /** Writes the current value. Never throws: a failed write is returned as text for the status line. */
  async persist(): Promise<string | null> {
    if (this.db === null) return null;
    try {
      await this.db.put(APP_KEYS.settings, this.value);
      return null;
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      return t`The settings could not be saved in this browser: ${{ error: errorText }}`;
    }
  }
}

export interface AppServices {
  readonly db: AppDb | null;
  readonly settings: SettingsStore;
  readonly providers: ProviderService;
  /** The MCP & tools client for the session (extensibility §3, §8). Nothing connects until a person asks it to. */
  readonly mcp: McpApp;
  /** What the start-up could not do, phrased for the writer. Empty when everything opened. */
  readonly notices: readonly string[];
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

  const { service, notices: providerNotices } = await ProviderService.open({ db, vault: factory });
  notices.push(...providerNotices);
  const settings = new SettingsStore(db, initial);
  // The active profile is mirrored into the settings record (ui-modules §5.1), so the record names the profile the agent uses.
  const active = service.active();
  if (active !== undefined && settings.current().provider.activeProfileId !== active.id) {
    await settings.update({ provider: { activeProfileId: active.id } });
  }
  const mcp = new McpApp({
    settings: { current: () => settings.current().mcp, update: (patch) => settings.update(patch) },
    keys: service.keys,
    ...(options.mcpWire === undefined ? {} : { wire: options.mcpWire }),
  });
  return { db, settings, providers: service, mcp, notices };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
