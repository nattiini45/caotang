/**
 * Provider profiles — [provider-gateway.md §2](docs/architecture/provider-gateway.md).
 *
 * Owns profile CRUD, stable ids, the exactly-one-active invariant, and the validation
 * the spec assigns the gateway ("`settings` owns the UI, gateway owns validation").
 *
 * **The key boundary.** A profile record never holds a key. `create` and `update` seal
 * the key into the `KeyStore` and keep only `hasKey`. Everything this store returns is a
 * `ProfileView`, a copy with no key on it. That is the property the key-leak tests
 * check, and it holds by construction: there is no field to leak.
 *
 * **The invariant.** Once any profile exists, exactly one is active. Every mutation that
 * could break that (create, activate, remove) restores it in the same synchronous step
 * that changes the map, so no reader can observe a state with none or two active.
 *
 * **Persistence.** Profiles are held in memory. The non-secret part is small and belongs
 * to app settings, which persists it; the secret part is already in IndexedDB via the
 * key store. That split is deliberate: the thing that must survive a reload safely is the
 * thing that is sealed.
 */

/**
 * The output cap a request is sent with when its profile sets none: provider-gateway §2's default. It is
 * the number the transport sends and the number the caller's limits report, so the two cannot disagree.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

import { MOCK_BASE_URL, normalizeBaseUrl, normalizeLocalBaseUrl, originOf } from './base-url.js';
import { ProfileError } from './errors.js';
import type { KeyStore } from './keys/key-store.js';
import { presetFor, type PresetDef } from './presets/index.js';
import type { NewProfile, ProfileKind, ProfilePatch, ProfileView, ResponseFormatProbe } from './types.js';

export interface ProfileStore {
  create(input: NewProfile): Promise<ProfileView>;
  update(id: string, patch: ProfilePatch): Promise<ProfileView>;
  remove(id: string): Promise<void>;
  get(id: string): ProfileView | undefined;
  /** Creation order, oldest first. */
  list(): ProfileView[];
  active(): ProfileView | undefined;
  /** Makes `id` the only active profile. Throws `not-found` for an unknown id. */
  activate(id: string): ProfileView;
  /**
   * Caches the §5 probe result on the profile. Ignored for an unknown id, because a
   * probe can finish after its profile was removed, and that is not an error.
   */
  recordProbe(id: string, probe: ResponseFormatProbe): void;
}

export interface ProfileStoreOptions {
  keys: KeyStore;
  /** injected so tests can pin ids; defaults to `crypto.getRandomValues` */
  randomBytes?: (n: number) => Uint8Array<ArrayBuffer>;
}

/** The mock's model id, and the one a mock profile reports when no model is given. */
export const MOCK_DEFAULT_MODEL = 'mock/echo-1';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** `prv_` plus ten Crockford base32 characters: the id family `@caotang/ids` uses, with a provider prefix. */
export const PROFILE_ID_PATTERN = /^prv_[0-9A-HJKMNP-TV-Z]{10}$/;

function defaultRandomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** 256 is a multiple of 32, so `byte % 32` is unbiased over the alphabet. */
export function mintProfileId(randomBytes: (n: number) => Uint8Array<ArrayBuffer> = defaultRandomBytes): string {
  let body = '';
  for (const byte of randomBytes(10)) body += CROCKFORD.charAt(byte % 32);
  return `prv_${body}`;
}

/** What a profile record holds. Deliberately has no key field — keys and custom header values are sealed in the vault. */
interface StoredProfile {
  id: string;
  name: string;
  kind: ProfileKind;
  /** the preset the profile was created under; every endpoint profile has one ('generic' for hand-rolled) */
  preset?: string;
  /** the preset's extra fields the base URL was built from */
  fields?: Record<string, string>;
  baseUrl: string;
  defaultModel: string;
  temperature?: number;
  maxOutputTokens?: number;
  pricePer1k?: { prompt: number; completion: number };
  isActive: boolean;
  hasKey: boolean;
  responseFormat?: ResponseFormatProbe;
}

/** The fields a save validates and stores. `kind` is fixed at create and never updated. */
interface CheckedFields {
  name: string;
  baseUrl: string;
  defaultModel: string;
  fields?: Record<string, string>;
  customHeaders?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
  pricePer1k?: { prompt: number; completion: number };
}

interface RawFields {
  name?: string;
  preset?: string;
  baseUrl?: string;
  defaultModel?: string;
  fields?: Readonly<Record<string, string>>;
  customHeaders?: Readonly<Record<string, string>> | null;
  temperature?: number;
  maxOutputTokens?: number;
  pricePer1k?: { prompt: number; completion: number };
}

/** RFC 9110 token — what a request header name may be. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_CUSTOM_HEADERS = 16;
const MAX_HEADER_VALUE = 1_024;

/**
 * A generic profile's extra headers. Names must be header names and values printable —
 * a newline would let a header smuggle another header. `null` clears the set.
 * Only the generic preset takes them: a named preset's route is fixed, and headers
 * beyond its quirks are not part of what it documents.
 */
function checkHeaders(kind: ProfileKind, preset: PresetDef | undefined, raw: Readonly<Record<string, string>> | null | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (kind === 'mock' || (preset !== undefined && preset.id !== 'generic')) {
    throw new ProfileError('invalid', 'Custom headers are only available on a generic OpenAI-compatible endpoint.', 'customHeaders');
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    throw new ProfileError('invalid', `At most ${MAX_CUSTOM_HEADERS} custom headers can be set.`, 'customHeaders');
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim().toLowerCase();
    if (!HEADER_NAME.test(name)) throw new ProfileError('invalid', `"${rawName}" is not a valid header name.`, 'customHeaders');
    const value = rawValue.trim();
    if (value === '') throw new ProfileError('invalid', `The ${name} header is empty.`, 'customHeaders');
    const hasControl = [...value].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    });
    if (value.length > MAX_HEADER_VALUE || hasControl) {
      throw new ProfileError('invalid', `The ${name} header contains characters a request header cannot carry.`, 'customHeaders');
    }
    headers[name] = value;
  }
  return headers;
}

function checkFields(kind: ProfileKind, raw: RawFields): CheckedFields {
  const name = (raw.name ?? '').trim();
  if (name === '') throw new ProfileError('invalid', 'Give the profile a name.', 'name');
  if (name.length > 80) throw new ProfileError('invalid', 'The profile name is longer than 80 characters.', 'name');

  let baseUrl: string;
  let defaultModel: string;
  let preset: PresetDef | undefined;
  let fields: Record<string, string> | undefined;
  if (kind === 'mock') {
    const given = (raw.baseUrl ?? '').trim();
    if (given !== '' && given !== MOCK_BASE_URL) {
      throw new ProfileError('invalid', `A mock profile uses ${MOCK_BASE_URL} as its base URL.`, 'baseUrl');
    }
    baseUrl = MOCK_BASE_URL;
    defaultModel = (raw.defaultModel ?? '').trim() || MOCK_DEFAULT_MODEL;
  } else {
    preset = presetFor(raw.preset ?? 'generic');
    if (preset === undefined) {
      throw new ProfileError('invalid', `"${raw.preset ?? ''}" is not one of the provider presets.`, 'preset');
    }
    // The extra fields a preset declares; unknown keys in `fields` are ignored.
    if (preset.fields !== undefined || raw.fields !== undefined) {
      fields = {};
      for (const field of preset.fields ?? []) {
        const value = (raw.fields?.[field.key] ?? field.defaultValue ?? '').trim();
        if (field.required && value === '') {
          throw new ProfileError('invalid', `Enter the ${field.label.toLowerCase()} for this provider.`, `fields.${field.key}`);
        }
        if (value !== '') fields[field.key] = value;
      }
      if (Object.keys(fields).length === 0) fields = undefined;
    }
    // The base URL: the save's own when given, else the preset's (templated from fields).
    const candidate = (raw.baseUrl ?? '').trim() !== '' ? raw.baseUrl : (preset.baseUrlFor?.(fields ?? {}) ?? preset.baseUrl);
    // A local model preset may use http to this computer; every other endpoint is https only.
    baseUrl = preset.local === undefined ? normalizeBaseUrl(candidate ?? '') : normalizeLocalBaseUrl(candidate ?? '');
    defaultModel = (raw.defaultModel ?? '').trim() || preset.defaultModel;
    if (defaultModel === '') {
      throw new ProfileError('invalid', 'Enter the model name, for example openai/gpt-4.1-mini.', 'defaultModel');
    }
  }

  const checked: CheckedFields = { name, baseUrl, defaultModel };
  if (fields !== undefined) checked.fields = fields;
  const headers = checkHeaders(kind, preset, raw.customHeaders);
  if (headers !== undefined) checked.customHeaders = headers;

  if (raw.temperature !== undefined) {
    if (!Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2) {
      throw new ProfileError('invalid', 'Temperature must be a number from 0 to 2.', 'temperature');
    }
    checked.temperature = raw.temperature;
  }
  if (raw.maxOutputTokens !== undefined) {
    if (!Number.isInteger(raw.maxOutputTokens) || raw.maxOutputTokens < 1) {
      throw new ProfileError('invalid', 'The output limit must be a whole number of tokens, at least 1.', 'maxOutputTokens');
    }
    checked.maxOutputTokens = raw.maxOutputTokens;
  }
  if (raw.pricePer1k !== undefined) {
    const { prompt, completion } = raw.pricePer1k;
    if (![prompt, completion].every((n) => Number.isFinite(n) && n >= 0)) {
      throw new ProfileError('invalid', 'Prices must be zero or more.', 'pricePer1k');
    }
    checked.pricePer1k = { prompt, completion };
  }
  return checked;
}

/**
 * Validates a key for an `endpoint` profile. Whitespace is refused because a key
 * pasted with a line break makes every request fail with a confusing 401.
 */
function checkKey(raw: string, keyOptional: boolean): string {
  const key = raw.trim();
  if (/\s/.test(key)) throw new ProfileError('invalid', 'The API key contains a space or a line break. Paste it again.', 'apiKey');
  requireKeyFor(key !== '', keyOptional);
  return key;
}

/**
 * An endpoint needs a key unless its preset documents keyless calls (`keyOptional`,
 * per the registry: OpenCode's free models, a hand-rolled generic endpoint, a server on this
 * computer). There is no other exemption.
 */
function requireKeyFor(hasKey: boolean, keyOptional: boolean): void {
  if (!hasKey && !keyOptional) throw new ProfileError('invalid', 'Enter the API key for this endpoint.', 'apiKey');
}

function toView(rec: StoredProfile): ProfileView {
  const view: ProfileView = {
    id: rec.id,
    name: rec.name,
    kind: rec.kind,
    ...(rec.preset === undefined ? {} : { preset: rec.preset }),
    ...(rec.fields === undefined ? {} : { fields: { ...rec.fields } }),
    baseUrl: rec.baseUrl,
    defaultModel: rec.defaultModel,
    isActive: rec.isActive,
    hasKey: rec.hasKey,
  };
  if (rec.temperature !== undefined) view.temperature = rec.temperature;
  if (rec.maxOutputTokens !== undefined) view.maxOutputTokens = rec.maxOutputTokens;
  if (rec.pricePer1k !== undefined) view.pricePer1k = { ...rec.pricePer1k };
  if (rec.responseFormat !== undefined) view.responseFormat = { ...rec.responseFormat };
  return view;
}

export function createProfileStore(options: ProfileStoreOptions): ProfileStore {
  const { keys } = options;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  const records = new Map<string, StoredProfile>();

  const requireRecord = (id: string): StoredProfile => {
    const rec = records.get(id);
    if (rec === undefined) throw new ProfileError('not-found', `No provider profile has the id ${id}.`);
    return rec;
  };

  const freshId = (): string => {
    let id = mintProfileId(randomBytes);
    while (records.has(id)) id = mintProfileId(randomBytes);
    return id;
  };

  return {
    async create(input) {
      // The retired kind name still arrives in data written before presets; it is the endpoint kind.
      const kind: ProfileKind = (input.kind as string) === 'openai-compatible' ? 'endpoint' : input.kind;
      const preset = kind === 'endpoint' ? presetFor(input.preset ?? 'generic') : undefined;
      const fields = checkFields(kind, input);
      const key = kind === 'endpoint' ? checkKey(input.apiKey ?? '', preset?.keyOptional === true) : '';
      const id = freshId();
      // The key is sealed before the record exists, so a failed seal leaves no profile
      // that claims a key it does not have. Custom headers ride inside the same payload —
      // they are secrets, and the vault is where secrets live.
      if (key !== '' || fields.customHeaders !== undefined) {
        await keys.putPayload(id, { apiKey: key, ...(fields.customHeaders === undefined ? {} : { customHeaders: fields.customHeaders }) });
      }

      // Re-read the active state after the await: another create may have landed meanwhile.
      const anyActive = [...records.values()].some((r) => r.isActive);
      const activate = input.isActive === true || !anyActive;
      if (activate) for (const r of records.values()) r.isActive = false;
      records.set(id, {
        id,
        kind,
        ...(preset === undefined ? {} : { preset: preset.id }),
        ...(fields.fields === undefined ? {} : { fields: fields.fields }),
        name: fields.name,
        baseUrl: fields.baseUrl,
        defaultModel: fields.defaultModel,
        ...(fields.temperature === undefined ? {} : { temperature: fields.temperature }),
        ...(fields.maxOutputTokens === undefined ? {} : { maxOutputTokens: fields.maxOutputTokens }),
        ...(fields.pricePer1k === undefined ? {} : { pricePer1k: fields.pricePer1k }),
        isActive: activate,
        hasKey: key !== '',
      });
      return toView(requireRecord(id));
    },

    async update(id, patch) {
      const rec = requireRecord(id);
      const preset = rec.kind === 'endpoint' ? presetFor(rec.preset ?? 'generic') : undefined;
      // `null` clears the saved price; an absent price keeps it (ProfilePatch).
      const price = patch.pricePer1k === null ? undefined : (patch.pricePer1k ?? rec.pricePer1k);
      const mergedFields = patch.fields === undefined ? rec.fields : { ...(rec.fields ?? {}), ...patch.fields };
      const fields = checkFields(rec.kind, {
        name: patch.name ?? rec.name,
        preset: rec.preset,
        // A fields patch on a templated preset rebuilds the base URL from the new fields.
        baseUrl: patch.baseUrl ?? (patch.fields !== undefined && preset?.baseUrlFor !== undefined ? '' : rec.baseUrl),
        defaultModel: patch.defaultModel ?? rec.defaultModel,
        fields: mergedFields,
        // `null` clears the headers; an absent field keeps what is sealed.
        customHeaders: patch.customHeaders === null ? undefined : patch.customHeaders,
        temperature: patch.temperature ?? rec.temperature,
        maxOutputTokens: patch.maxOutputTokens ?? rec.maxOutputTokens,
        pricePer1k: price,
      });

      let hasKey = rec.hasKey;
      let keyChanged = false;
      if (rec.kind === 'endpoint') {
        const keyOptional = preset?.keyOptional === true;
        // A secret belongs to the origin it was entered for. Keeping it across an origin change would
        // send it to an origin the user has not entered it for, so the save is refused before anything
        // is written, and the stored secret stays where it was. This holds for the key and for custom
        // headers alike, whichever of them the patch re-enters.
        const originMoved = originOf(fields.baseUrl) !== originOf(rec.baseUrl);
        if (patch.apiKey !== undefined || patch.customHeaders !== undefined) {
          // The payload holds key and headers together, so either edit opens it once and
          // re-seals both — a key change cannot drop the headers, and a header change
          // cannot drop the key.
          const existing = await keys.revealPayload(id);
          const key = patch.apiKey !== undefined ? checkKey(patch.apiKey, keyOptional) : (existing?.apiKey ?? '');
          const headers =
            patch.customHeaders === null
              ? undefined
              : patch.customHeaders !== undefined
                ? fields.customHeaders
                : existing?.customHeaders;
          if (originMoved) {
            if (patch.apiKey === undefined && (existing?.apiKey ?? '') !== '') {
              throw new ProfileError('invalid', 'Enter the API key again for the new endpoint.', 'apiKey');
            }
            if (patch.customHeaders === undefined && existing?.customHeaders !== undefined && Object.keys(existing.customHeaders).length > 0) {
              throw new ProfileError('invalid', 'Enter the extra headers again for the new endpoint.', 'customHeaders');
            }
          }
          if (key === '' && (headers === undefined || Object.keys(headers).length === 0)) await keys.remove(id);
          else await keys.putPayload(id, { apiKey: key, ...(headers === undefined ? {} : { customHeaders: headers }) });
          hasKey = key !== '';
          keyChanged = true;
        } else {
          if (originMoved && rec.hasKey) {
            throw new ProfileError('invalid', 'Enter the API key again for the new endpoint.', 'apiKey');
          }
          if (originMoved) {
            const existing = await keys.revealPayload(id);
            if (existing?.customHeaders !== undefined && Object.keys(existing.customHeaders).length > 0) {
              throw new ProfileError('invalid', 'Enter the extra headers again for the new endpoint.', 'customHeaders');
            }
          }
          requireKeyFor(rec.hasKey, keyOptional);
        }
      }

      // A profile removed during the seal is not resurrected by the update.
      if (records.get(id) !== rec) throw new ProfileError('not-found', `No provider profile has the id ${id}.`);

      const endpointChanged = fields.baseUrl !== rec.baseUrl || fields.defaultModel !== rec.defaultModel;
      const { customHeaders: _sealed, ...stored } = fields;
      Object.assign(rec, stored, { hasKey });
      // `Object.assign` cannot clear a key it was not given, so a cleared price is removed from the record here.
      if (fields.pricePer1k === undefined) delete rec.pricePer1k;
      if (fields.fields === undefined) delete rec.fields;
      // §5's probe is about one endpoint and one model with one key. Any of those
      // changing makes the cached answer a guess, so it goes.
      if (endpointChanged || keyChanged) rec.responseFormat = undefined;
      return toView(rec);
    },

    async remove(id) {
      const rec = requireRecord(id);
      // A headers-only payload has no key, so `hasKey` alone would leave it behind.
      if (rec.kind === 'endpoint') await keys.remove(id);
      // Record removal and promotion happen in one synchronous step, so the invariant
      // never has a gap.
      records.delete(id);
      if (rec.isActive) {
        const next = records.values().next().value;
        if (next !== undefined) next.isActive = true;
      }
    },

    get(id) {
      const rec = records.get(id);
      return rec === undefined ? undefined : toView(rec);
    },

    list() {
      return [...records.values()].map(toView);
    },

    active() {
      for (const rec of records.values()) if (rec.isActive) return toView(rec);
      return undefined;
    },

    activate(id) {
      const target = requireRecord(id);
      for (const rec of records.values()) rec.isActive = rec === target;
      return toView(target);
    },

    recordProbe(id, probe) {
      const rec = records.get(id);
      if (rec !== undefined) rec.responseFormat = { supportsJsonObject: probe.supportsJsonObject, probedAt: probe.probedAt };
    },
  };
}
