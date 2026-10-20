/**
 * The provider services of the app: the profile store, the key vault, the gateway, the usage ledger and the request log,
 * wired once, and persisted to the app database (provider-gateway §2, §6, §7; ui-modules §5.2).
 *
 * ## What persists, and where
 *
 * - **Keys** are sealed in the vault (`caotang-provider-keys`), keyed by profile id. Nothing else holds them.
 * - **Profile records** (no key on them) are kept in the app database. On the next open they are created again, under
 *   the same ids: a profile id is a function of ten random bytes, so the bytes the stored id was minted from are handed
 *   back to the generator. The key is revealed from the vault and sealed again under that id, because the vault binds
 *   each key to its profile id.
 * - **Usage** (the ledger's day rows) and the **request log** (its last 50 entries) are kept in the app database. Turn
 *   rows are not: they belong to a session, and an agent turn does not survive a reload in the activity log either.
 *
 * ## The probes
 *
 * The gateway's egress guard compares every request with the endpoint of the profile it *resolved to*
 * (provider-gateway §4), so a probe can name its profile directly. The list-models probe at save time is
 * therefore a call on that profile; the response-format probe runs after a real activation
 * (provider-gateway §5).
 */

import {
  PROFILE_ID_PATTERN,
  createGateway,
  createIndexedDbVaultPort,
  createKeyStore,
  createMemoryVaultPort,
  createProfileStore,
  type Clock,
  type DayUsageRow,
  type FetchLike,
  type Gateway,
  type KeyStore,
  type ModelInfo,
  type NewProfile,
  type ProfilePatch,
  type ProfileStore,
  type ProfileView,
  type RequestLogEntry,
  RequestLog,
  type TaskRole,
  type ThinkingLevel,
  UsageLedger,
} from '@caotang/gateway';
import { DEMO_REFUSAL, createMockProvider, demoScripts, echo, plannerScript, type MockProvider } from '@caotang/gateway/mock';

import { APP_KEYS, type AppDb } from './app-db.js';
import { normalizeSettings, type RoleSettings } from './settings.js';

/** The name the first-run profile carries. It answers the three demo intents and nothing else. */
export const DEMO_PROFILE_NAME = 'Demo (no key)';

/**
 * What the demo provider says to anything outside its three demo intents: the same words the gateway's demo refuses a drafting call
 * with, held once in the gateway's mock (`DEMO_REFUSAL`), so a copy change cannot leave the planner's reply and the refusal apart.
 */
export const DEMO_FALLBACK_REPLY = DEMO_REFUSAL;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The request-log entries kept across reloads: the log's own cap (provider-gateway §4). */
const REQUEST_LOG_KEEP = 50;

/**
 * A profile as the app database may hold it: the current view, or a record written
 * before presets, whose kind is `openai-compatible` and whose `preset` is absent.
 * The key is never on it — the vault holds the sealed payload.
 */
type PersistedProfile = Omit<ProfileView, 'kind'> & { kind: ProfileView['kind'] | 'openai-compatible' };

/** The provider's mock: the demo intents, a fixed answer for anything else from the planner, and the echo fallback. */
export function appMockProvider(): MockProvider {
  return createMockProvider({
    scripts: [...demoScripts, plannerScript(() => JSON.stringify({ reply: DEMO_FALLBACK_REPLY })), echo],
  });
}

/** A profile's id as the ten random bytes that generate it. The generator maps a byte with `% 32`, so an index is its own byte. */
function bytesForId(id: string): Uint8Array<ArrayBuffer> | null {
  if (!PROFILE_ID_PATTERN.test(id)) return null;
  return Uint8Array.from([...id.slice(4)].map((char) => CROCKFORD.indexOf(char)));
}

/** A day row's local noon, so the ledger files a restored row under the same local day it was recorded on. */
function noonOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12).getTime();
}

export interface SaveOutcome {
  readonly view: ProfileView;
  /** The models the endpoint listed, when a list-models probe ran and answered. */
  readonly models?: ModelInfo[];
  /** Why the probe did not answer, in words the writer can act on. The profile is saved either way. */
  readonly probeError?: string;
}

/**
 * What a task role's calls run on (provider-gateway §6): the profile it sends through, and the model and thinking
 * level a request under it defaults to — the role's own when it names one, else the profile's.
 */
export interface RoleResolution {
  readonly profile: ProfileView;
  readonly model: string;
  readonly thinking?: ThinkingLevel;
}

/**
 * The chain a role resolves by: its own `RoleRef` when the named profile still exists, else 'chat', and 'chat'
 * resolves to the active profile. A role pinned to a profile that is gone falls back to following rather than
 * failing — the settings tolerate the stale id. Undefined only when no profile exists at all.
 */
function resolveRole(profiles: ProfileStore, roles: RoleSettings | undefined, role: TaskRole): RoleResolution | undefined {
  const ref = roles?.[role] === 'follow' ? undefined : roles?.[role];
  if (ref !== undefined) {
    const profile = profiles.get(ref.profileId);
    if (profile !== undefined) {
      return {
        profile,
        model: ref.model ?? profile.defaultModel,
        ...(ref.thinking === undefined ? {} : { thinking: ref.thinking }),
      };
    }
  }
  if (role !== 'chat') return resolveRole(profiles, roles, 'chat');
  const active = profiles.active();
  return active === undefined ? undefined : { profile: active, model: active.defaultModel };
}

export interface ProviderOpenOptions {
  readonly db: AppDb | null;
  /** The browser's `indexedDB` for the vault, or `null` for an in-memory vault (no keys survive a reload then). */
  readonly vault: IDBFactory | null;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly mock?: MockProvider;
}

export class ProviderService {
  readonly profiles: ProfileStore;
  readonly keys: KeyStore;
  readonly gateway: Gateway;
  readonly ledger: UsageLedger;
  readonly requests: RequestLog;
  private readonly db: AppDb | null;
  /**
   * The task-role routing in force, in one cell the gateway's resolver reads at request time (provider-gateway
   * §6). Restored from the settings record at open and kept through {@link roleSettings}; a service that never
   * hears one has every role following.
   */
  private readonly roleState: { current: RoleSettings | undefined };

  private constructor(parts: {
    profiles: ProfileStore;
    keys: KeyStore;
    gateway: Gateway;
    ledger: UsageLedger;
    requests: RequestLog;
    db: AppDb | null;
    roleState: { current: RoleSettings | undefined };
  }) {
    this.profiles = parts.profiles;
    this.keys = parts.keys;
    this.gateway = parts.gateway;
    this.ledger = parts.ledger;
    this.requests = parts.requests;
    this.db = parts.db;
    this.roleState = parts.roleState;
  }

  /**
   * The routing record as the settings slice holds it — absent or `'follow'` roles resolve through 'chat'. Set by
   * whoever holds the settings record (the Providers section, or a test); the gateway reads it at request time.
   * The method is the same write as the setter, named for call sites a property assignment cannot reach: a JSX
   * handler may not mutate an object it was handed.
   */
  get roleSettings(): RoleSettings | undefined {
    return this.roleState.current;
  }
  set roleSettings(roles: RoleSettings | undefined) {
    this.roleState.current = roles;
  }
  applyRoleSettings(roles: RoleSettings | undefined): void {
    this.roleState.current = roles;
  }

  /**
   * What a task role's calls run on (provider-gateway §6): its own profile, model and thinking level when the role
   * names one that still exists, else whatever 'chat' resolves to — and 'chat' resolves to the active profile.
   * Undefined only when no profile exists at all.
   */
  resolveForRole(role: TaskRole): RoleResolution | undefined {
    return resolveRole(this.profiles, this.roleState.current, role);
  }

  /**
   * Whether `profileId` is one a request under `role` may send through: the profile the role resolves to, so a
   * following role allows what 'chat' — and under 'chat', the active profile — resolves to (provider-gateway §6, P9).
   */
  roleAllows(role: TaskRole, profileId: string): boolean {
    return resolveRole(this.profiles, this.roleState.current, role)?.profile.id === profileId;
  }

  /**
   * Builds the services and restores what the app database holds. Never throws: a profile that cannot be restored (its key
   * is no longer in the vault) is named in `notices` and left out, and an app with nothing stored gets the demo profile,
   * which is active, so the agent works with no key from the first run (context-assembly §6).
   */
  static async open(options: ProviderOpenOptions): Promise<{ service: ProviderService; notices: string[] }> {
    const notices: string[] = [];
    const vault = options.vault === null ? createMemoryVaultPort() : createIndexedDbVaultPort({ factory: options.vault });
    const keys = createKeyStore(vault);

    // The ids of new profiles are random. A restored profile's id is handed back through this one slot.
    let pinned: Uint8Array<ArrayBuffer> | null = null;
    const randomBytes = (n: number): Uint8Array<ArrayBuffer> => {
      if (pinned !== null && pinned.length === n) {
        const out = pinned;
        pinned = null;
        return out;
      }
      const out = new Uint8Array(n);
      globalThis.crypto.getRandomValues(out);
      return out;
    };
    const profiles = createProfileStore({ keys, randomBytes });
    const ledger = new UsageLedger(options.clock);
    const requests = new RequestLog();
    // The role routing lives in this one cell: the service owns it, and the gateway's resolver reads it at request
    // time, so a settings change applies to the next call without the gateway being built again.
    const roleState: { current: RoleSettings | undefined } = { current: undefined };
    const gateway = createGateway({
      profiles,
      keys,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ledger,
      requestLog: requests,
      mock: options.mock ?? appMockProvider(),
      // §6's resolver seam, over the shared cell: `resolve` is `resolveForRole` in the gateway's shape, and
      // `allowed` is the role-referenced set — the one profile the role resolves to.
      roles: {
        resolve: (role) => {
          const resolved = resolveRole(profiles, roleState.current, role);
          return resolved === undefined
            ? undefined
            : {
                profileId: resolved.profile.id,
                model: resolved.model,
                ...(resolved.thinking === undefined ? {} : { thinking: resolved.thinking }),
              };
        },
        allowed: (role) => {
          const resolved = resolveRole(profiles, roleState.current, role);
          return resolved === undefined ? [] : [resolved.profile.id];
        },
      },
    });
    const service = new ProviderService({ profiles, keys, gateway, ledger, requests, db: options.db, roleState });

    if (options.db !== null) {
      await service.restore(options.db, notices, (id) => {
        pinned = id === null ? null : bytesForId(id);
      });
      // The routing rides the settings record, so it is read back at open; a record that cannot be read leaves
      // every role following, and a failed read is the store's notice, not this service's.
      try {
        roleState.current = normalizeSettings(await options.db.get<unknown>(APP_KEYS.settings)).provider.roles;
      } catch {
        roleState.current = undefined;
      }
    }
    if (profiles.list().length === 0) {
      await profiles.create({ name: DEMO_PROFILE_NAME, kind: 'mock', isActive: true });
      await service.persist();
    }
    return { service, notices };
  }

  /** Reads the stored profiles, usage and log back into the services. Each part is independent: one failing keeps the rest. */
  private async restore(db: AppDb, notices: string[], pin: (id: string | null) => void): Promise<void> {
    try {
      const stored = (await db.get<PersistedProfile[]>(APP_KEYS.profiles)) ?? [];
      let activeId: string | null = null;
      for (const record of stored) {
        try {
          // Records written before presets say 'openai-compatible'; that kind is now 'endpoint',
          // and a record with no preset id runs under 'generic' (the hand-rolled route).
          const kind: ProfileView['kind'] = (record.kind as string) === 'openai-compatible' ? 'endpoint' : (record.kind as ProfileView['kind']);
          // The sealed payload holds the key and any custom headers; both come back together.
          const payload = kind === 'endpoint' ? await this.keys.revealPayload(record.id) : undefined;
          if (kind === 'endpoint' && record.hasKey && (payload === undefined || payload.apiKey === '')) {
            notices.push(`The key for “${record.name}” is no longer in this browser, so the profile was not restored. Add it again in Settings.`);
            continue;
          }
          pin(record.id);
          const view = await this.profiles.create({
            name: record.name,
            kind,
            baseUrl: record.baseUrl,
            defaultModel: record.defaultModel,
            ...(record.preset === undefined ? {} : { preset: record.preset }),
            ...(record.fields === undefined ? {} : { fields: record.fields }),
            ...(payload === undefined || payload.apiKey === '' ? {} : { apiKey: payload.apiKey }),
            ...(payload?.customHeaders === undefined ? {} : { customHeaders: payload.customHeaders }),
            ...(record.temperature === undefined ? {} : { temperature: record.temperature }),
            ...(record.maxOutputTokens === undefined ? {} : { maxOutputTokens: record.maxOutputTokens }),
            ...(record.pricePer1k === undefined ? {} : { pricePer1k: record.pricePer1k }),
          });
          if (view.id !== record.id) {
            notices.push(`“${record.name}” came back under a new id, so its saved usage is not attached to it.`);
          }
          if (record.responseFormat !== undefined) this.profiles.recordProbe(view.id, record.responseFormat);
          if (record.isActive) activeId = view.id;
        } catch (error) {
          notices.push(`“${record.name}” could not be restored: ${messageOf(error)}`);
        } finally {
          pin(null);
        }
      }
      if (activeId !== null) this.profiles.activate(activeId);
    } catch (error) {
      notices.push(`Your provider profiles could not be read: ${messageOf(error)}`);
    }

    try {
      const usage = (await db.get<DayUsageRow[]>(APP_KEYS.usage)) ?? [];
      for (const row of usage) {
        this.ledger.record(
          { profileId: row.profileId, model: row.model, at: noonOf(row.date) },
          { promptTokens: row.promptTokens, completionTokens: row.completionTokens },
          row.requests,
        );
      }
    } catch (error) {
      notices.push(`The usage totals could not be read: ${messageOf(error)}`);
    }

    try {
      const entries = (await db.get<RequestLogEntry[]>(APP_KEYS.requests)) ?? [];
      for (const entry of entries.slice(-REQUEST_LOG_KEEP)) this.requests.append(entry);
    } catch (error) {
      notices.push(`The request log could not be read: ${messageOf(error)}`);
    }
  }

  /** Every profile, oldest first, without keys. */
  list(): ProfileView[] {
    return this.profiles.list();
  }

  active(): ProfileView | undefined {
    return this.profiles.active();
  }

  /**
   * The built-in demo profile, which the demo intents run on whichever profile is active (context-assembly §6).
   * It is made again when the writer has removed it, and it is never made active here: a demo run names it by id, and a
   * mock profile never reaches the egress guard (provider-gateway §4).
   */
  async demoProfile(): Promise<ProfileView> {
    const existing = this.profiles.list().find((profile) => profile.kind === 'mock');
    if (existing !== undefined) return existing;
    const made = await this.profiles.create({ name: DEMO_PROFILE_NAME, kind: 'mock' });
    await this.persist();
    return made;
  }

  get(id: string): ProfileView | undefined {
    return this.profiles.get(id);
  }

  /** Stores what the services hold, so the next open finds it (profiles, usage and the request log). Never throws. */
  async persist(): Promise<string | null> {
    if (this.db === null) return null;
    try {
      await this.db.put(APP_KEYS.profiles, this.profiles.list());
      await this.db.put(APP_KEYS.usage, this.ledger.dayRows());
      await this.db.put(APP_KEYS.requests, this.requests.entries().slice(-REQUEST_LOG_KEEP));
      return null;
    } catch (error) {
      return `Your provider settings could not be saved in this browser: ${messageOf(error)}`;
    }
  }

  /**
   * Adds a profile. For an endpoint profile the list-models probe runs at save time (context-assembly §6): a failure keeps
   * the saved profile and reports why, so the writer can correct the URL or the key where they are.
   */
  async addProfile(input: NewProfile): Promise<SaveOutcome> {
    const view = await this.profiles.create(input);
    const probe = view.kind === 'endpoint' ? await this.probeModels(view.id) : { models: undefined, error: undefined };
    if (view.kind === 'endpoint' && probe.error === undefined) await this.probeFormat(view.id);
    await this.persist();
    return {
      view: this.profiles.get(view.id) ?? view,
      ...(probe.models === undefined ? {} : { models: probe.models }),
      ...(probe.error === undefined ? {} : { probeError: probe.error }),
    };
  }

  /** Edits a profile. Changing its endpoint, key or model runs the list-models probe again, as adding one does. */
  async editProfile(id: string, patch: ProfilePatch): Promise<SaveOutcome> {
    const before = this.profiles.get(id);
    const view = await this.profiles.update(id, patch);
    const probe =
      view.kind === 'endpoint' && before !== undefined && (before.baseUrl !== view.baseUrl || patch.apiKey !== undefined || before.defaultModel !== view.defaultModel)
        ? await this.probeModels(id)
        : { models: undefined, error: undefined };
    if (view.kind === 'endpoint' && probe.models !== undefined) await this.probeFormat(id);
    await this.persist();
    return {
      view: this.profiles.get(id) ?? view,
      ...(probe.models === undefined ? {} : { models: probe.models }),
      ...(probe.error === undefined ? {} : { probeError: probe.error }),
    };
  }

  /**
   * Makes a profile the active one and says which response format it takes (provider-gateway §5). The probe runs once, when the
   * profile is saved, and its answer is cached on the profile; activation reads that answer and does not probe again. A profile
   * with no cached answer (its save-time probe failed) is probed here, and a probe that fails leaves the profile active, with the
   * schema sent in the system message instead of `response_format`, and says so.
   */
  async activate(id: string): Promise<{ note?: string }> {
    this.profiles.activate(id);
    const view = this.profiles.get(id);
    let note: string | undefined;
    if (view !== undefined && view.kind === 'endpoint') {
      if (view.responseFormat !== undefined) {
        note = formatNote(view.responseFormat.supportsJsonObject);
      } else {
        try {
          note = formatNote(await this.gateway.probeResponseFormat(id));
        } catch (error) {
          note = `The endpoint did not answer the format check, so the agent asks for JSON in the prompt: ${messageOf(error)}`;
        }
      }
    }
    await this.persist();
    return note === undefined ? {} : { note };
  }

  /** Removes a profile and its key. The active profile moves to another one, or the demo profile is made again. */
  async remove(id: string): Promise<void> {
    await this.profiles.remove(id);
    if (this.profiles.list().length === 0) {
      await this.profiles.create({ name: DEMO_PROFILE_NAME, kind: 'mock', isActive: true });
    }
    await this.persist();
  }

  /** The models a profile lists, probed on demand (the Providers section's refresh). */
  async listModels(id: string): Promise<ModelInfo[]> {
    const probe = await this.probeModels(id);
    if (probe.error !== undefined) throw new Error(probe.error);
    return probe.models ?? [];
  }

  /**
   * The response-format probe, run at save time as the list-models probe is (provider-gateway §5): the gateway caches its answer
   * on the profile, so the first request after a save already knows whether the endpoint takes `response_format`. It is a trial
   * activation, like the list-models call. A failure keeps the fallback, the schema in the prompt, which the activation note
   * already names, so nothing is reported here.
   */
  private async probeFormat(id: string): Promise<void> {
    const previous = this.profiles.active();
    try {
      if (previous?.id !== id) this.profiles.activate(id);
      await this.gateway.probeResponseFormat(id);
    } catch {
      // The fallback applies until a later probe answers, and the activation note says which one is in use.
    } finally {
      if (previous !== undefined && previous.id !== id && this.profiles.get(previous.id) !== undefined) {
        this.profiles.activate(previous.id);
      }
    }
  }

  /**
   * One list-models call as a trial activation: the profile is active for the call, and the previously active profile is
   * active again afterwards, whatever the answer. Nothing is persisted here.
   */
  private async probeModels(id: string): Promise<{ models?: ModelInfo[]; error?: string }> {
    const previous = this.profiles.active();
    try {
      if (previous?.id !== id) this.profiles.activate(id);
      const models = await this.gateway.listModels(id);
      return { models };
    } catch (error) {
      return { error: `The endpoint did not list its models, so the profile was saved but is not verified: ${messageOf(error)}` };
    } finally {
      if (previous !== undefined && previous.id !== id && this.profiles.get(previous.id) !== undefined) {
        this.profiles.activate(previous.id);
      }
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The activation note for a profile's response-format answer, in the words the Settings section shows. */
function formatNote(supported: boolean): string {
  return supported
    ? 'This endpoint accepts structured output.'
    : 'This endpoint does not take a JSON response format, so the agent asks for JSON in the prompt instead.';
}

/** The profile's price per 1,000 tokens, as the form's two optional fields carry it (provider-gateway §2). */
export type PriceResult = { readonly ok: true; readonly price?: { prompt: number; completion: number } } | { readonly ok: false; readonly message: string };

/**
 * Reads a profile's price from its two optional inputs. Both empty gives no price: a new profile is saved unpriced, and an edit
 * leaves out `pricePer1k`, so the gateway keeps the price the profile already has. A price needs both halves, each zero or more
 * dollars per 1,000 tokens, as the gateway checks it. Anything else is named and not stored. An edit that clears the inputs
 * clears a saved price instead (`priceClearedBy`).
 */
export function priceFromInputs(promptText: string, completionText: string): PriceResult {
  const prompt = promptText.trim();
  const completion = completionText.trim();
  if (prompt === '' && completion === '') return { ok: true };
  if (prompt === '' || completion === '') {
    return { ok: false, message: 'A price needs both the prompt price and the reply price, per 1,000 tokens. Fill both, or leave both empty.' };
  }
  const numeric = /^(\d+\.?\d*|\.\d+)$/;
  if (!numeric.test(prompt) || !numeric.test(completion)) {
    return { ok: false, message: 'Prices are dollars per 1,000 tokens, written as a number of zero or more.' };
  }
  return { ok: true, price: { prompt: Number(prompt), completion: Number(completion) } };
}

/**
 * Whether both price inputs are empty. An edit that reads so clears the profile's saved price, by sending `null` in its patch
 * (provider-gateway §2): the form has no other way to say "no price". A new profile with both empty is saved unpriced.
 */
export function priceClearedBy(promptText: string, completionText: string): boolean {
  return promptText.trim() === '' && completionText.trim() === '';
}
