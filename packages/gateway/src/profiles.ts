// i18n: package-refs

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
import { ProfileError, providerRefs } from './errors.js';
import type { KeyPayload, KeyStore } from './keys/key-store.js';
import { presetFor, type PresetDef } from './presets/index.js';
import { providerVerificationMachine } from './verification.js';
import type { NewProfile, ProfileKind, ProfilePatch, ProfileVerification, ProfileView, RequestParams, ResponseFormatProbe, ThinkingLevel } from './types.js';

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
  recordProbe(id: string, probe: ResponseFormatProbe, attempt?: number): void;
  recordVerification(id: string, verification: ProfileVerification): void;
}

/** What changed for one profile's key: where that key may be sent, and the payload now sealed for it. */
export interface KeyChange {
  readonly origin: string;
  readonly payload: KeyPayload;
}

/**
 * Told after a profile's key payload is written or removed, so a host that keeps a copy of the writer's keys somewhere
 * else — the account vault of a hosted instance — can follow what changed here. It is a notification, not a transaction:
 * the key is already stored when it runs, so it must not throw, and its own work cannot undo the save. It carries the
 * endpoint origin because the copy elsewhere is sealed against it, and only this store knows where a profile points.
 */
export interface KeyMirror {
  changed(profileId: string, change: KeyChange | null): void;
}

export interface ProfileStoreOptions {
  keys: KeyStore;
  /** injected so tests can pin ids; defaults to `crypto.getRandomValues` */
  randomBytes?: (n: number) => Uint8Array<ArrayBuffer>;
  /** A host following this device's provider keys elsewhere. */
  mirror?: KeyMirror;
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
  /** every model picked under this connection, `defaultModel` first; absent when the connection holds only its default */
  pickedModels?: readonly string[];
  temperature?: number;
  maxOutputTokens?: number;
  params?: RequestParams;
  pricePer1k?: { prompt: number; completion: number };
  isActive: boolean;
  hasKey: boolean;
  responseFormat?: ResponseFormatProbe;
  verification?: ProfileVerification;
}

/** The fields a save validates and stores. `kind` is fixed at create and never updated. */
interface CheckedFields {
  name: string;
  baseUrl: string;
  defaultModel: string;
  pickedModels?: readonly string[];
  fields?: Record<string, string>;
  customHeaders?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
  params?: RequestParams;
  pricePer1k?: { prompt: number; completion: number };
}

interface RawFields {
  name?: string;
  preset?: string;
  baseUrl?: string;
  defaultModel?: string;
  pickedModels?: readonly string[] | null;
  fields?: Readonly<Record<string, string>>;
  customHeaders?: Readonly<Record<string, string>> | null;
  temperature?: number;
  maxOutputTokens?: number;
  params?: RequestParams;
  pricePer1k?: { prompt: number; completion: number };
}

/** RFC 9110 token — what a request header name may be. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_CUSTOM_HEADERS = 16;
const MAX_HEADER_VALUE = 1_024;

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function trimString(raw: string, field: string): string {
  if (typeof raw !== 'string') throw new ProfileError('invalid', 'Enter a text value for this field.', { field, messageRef: { id: 'gateway.invalid.textValue', message: 'Enter a text value for this field.' } });
  return raw.trim();
}

/**
 * A generic profile's extra headers. Names must be header names and values printable —
 * a newline would let a header smuggle another header. `null` clears the set.
 * Only the generic preset takes them: a named preset's route is fixed, and headers
 * beyond its quirks are not part of what it documents.
 */
function checkHeaders(kind: ProfileKind, preset: PresetDef | undefined, raw: Readonly<Record<string, string>> | null | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new ProfileError('invalid', 'Enter custom headers as a name-to-value object.', { field: 'customHeaders', messageRef: { id: 'gateway.invalid.customHeadersObject', message: 'Enter custom headers as a name-to-value object.' } });
  if (kind === 'mock' || (preset !== undefined && preset.id !== 'generic')) {
    throw new ProfileError('invalid', 'Custom headers are only available on a generic OpenAI-compatible endpoint.', { field: 'customHeaders', messageRef: { id: 'gateway.invalid.customHeadersGeneric', message: 'Custom headers are only available on a generic OpenAI-compatible endpoint.' } });
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    throw new ProfileError('invalid', `At most ${MAX_CUSTOM_HEADERS} custom headers can be set.`, { field: 'customHeaders', messageRef: { id: 'gateway.invalid.customHeadersMax', message: 'At most {max} custom headers can be set.', values: { max: MAX_CUSTOM_HEADERS } } });
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim().toLowerCase();
    if (!HEADER_NAME.test(name)) throw new ProfileError('invalid', `"${rawName}" is not a valid header name.`, { field: 'customHeaders', messageRef: { id: 'gateway.invalid.headerName', message: '"{name}" is not a valid header name.', values: { name: rawName } } });
    const value = trimString(rawValue, 'customHeaders');
    if (value === '') throw new ProfileError('invalid', `The ${name} header is empty.`, { field: 'customHeaders', messageRef: { id: 'gateway.invalid.headerEmpty', message: 'The {name} header is empty.', values: { name } } });
    const hasControl = [...value].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    });
    if (value.length > MAX_HEADER_VALUE || hasControl) {
      throw new ProfileError('invalid', `The ${name} header contains characters a request header cannot carry.`, { field: 'customHeaders', messageRef: { id: 'gateway.invalid.headerChars', message: 'The {name} header contains characters a request header cannot carry.', values: { name } } });
    }
    headers[name] = value;
  }
  return headers;
}

/** The most models one connection may hold. A provider list is long; a saved connection is not a catalogue. */
const MAX_PICKED_MODELS = 200;

/**
 * The models picked under one connection (provider-gateway §2, "One connection, many models"): the default first, then the rest
 * in the order given, each a model id, duplicates dropped. `null` or absent means the connection holds only its default, and a
 * single model stores no list at all. A mock profile holds exactly its one model, because its answer does not depend on a model.
 */
function checkPickedModels(kind: ProfileKind, raw: readonly string[] | null | undefined, defaultModel: string): readonly string[] | undefined {
  if (kind === 'mock') return undefined;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ProfileError('invalid', 'The models for this provider could not be read.', { field: 'pickedModels', messageRef: { id: 'gateway.invalid.pickedModelsRead', message: 'The models for this provider could not be read.' } });
  }
  const kept: string[] = [defaultModel];
  const seen = new Set(kept);
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new ProfileError('invalid', 'The models for this provider could not be read.', { field: 'pickedModels', messageRef: { id: 'gateway.invalid.pickedModelsRead', message: 'The models for this provider could not be read.' } });
    }
    const id = entry.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  if (kept.length > MAX_PICKED_MODELS) {
    throw new ProfileError('invalid', `A provider can hold at most ${MAX_PICKED_MODELS} models.`, { field: 'pickedModels', messageRef: { id: 'gateway.invalid.pickedModelsMax', message: 'A provider can hold at most {max} models.', values: { max: MAX_PICKED_MODELS } } });
  }
  return kept.length === 1 ? undefined : kept;
}

function checkFields(kind: ProfileKind, raw: RawFields): CheckedFields {
  const name = trimString(raw.name ?? '', 'name');
  if (name === '') throw new ProfileError('invalid', 'Give the profile a name.', { field: 'name', messageRef: { id: 'gateway.invalid.nameRequired', message: 'Give the profile a name.' } });
  if (name.length > 80) throw new ProfileError('invalid', 'The profile name is longer than 80 characters.', { field: 'name', messageRef: { id: 'gateway.invalid.nameTooLong', message: 'The profile name is longer than 80 characters.' } });

  let baseUrl: string;
  let defaultModel: string;
  let preset: PresetDef | undefined;
  let fields: Record<string, string> | undefined;
  if (kind === 'mock') {
    const given = trimString(raw.baseUrl ?? '', 'baseUrl');
    if (given !== '' && given !== MOCK_BASE_URL) {
      throw new ProfileError('invalid', `A mock profile uses ${MOCK_BASE_URL} as its base URL.`, { field: 'baseUrl', messageRef: { id: 'gateway.invalid.mockBaseUrl', message: 'A mock profile uses {baseUrl} as its base URL.', values: { baseUrl: MOCK_BASE_URL } } });
    }
    baseUrl = MOCK_BASE_URL;
    defaultModel = trimString(raw.defaultModel ?? '', 'defaultModel') || MOCK_DEFAULT_MODEL;
  } else {
    if (raw.preset !== undefined && raw.preset !== null && typeof raw.preset !== 'string') {
      throw new ProfileError('invalid', 'Choose one of the provider presets.', { field: 'preset', messageRef: { id: 'gateway.invalid.presetRequired', message: 'Choose one of the provider presets.' } });
    }
    preset = presetFor(raw.preset ?? 'generic');
    if (preset === undefined) {
      throw new ProfileError('invalid', `"${raw.preset ?? ''}" is not one of the provider presets.`, { field: 'preset', messageRef: { id: 'gateway.invalid.presetUnknown', message: '"{preset}" is not one of the provider presets.', values: { preset: raw.preset ?? '' } } });
    }
    // The extra fields a preset declares; unknown keys in `fields` are ignored.
    if (raw.fields !== undefined && raw.fields !== null && !isRecord(raw.fields)) {
      throw new ProfileError('invalid', 'Enter provider fields as a name-to-value object.', { field: 'fields', messageRef: { id: 'gateway.invalid.fieldsObject', message: 'Enter provider fields as a name-to-value object.' } });
    }
    if (preset.fields !== undefined || raw.fields !== undefined) {
      fields = {};
      for (const field of preset.fields ?? []) {
        const value = trimString(raw.fields?.[field.key] ?? field.defaultValue ?? '', `fields.${field.key}`);
        if (field.required && value === '') {
          throw new ProfileError('invalid', `Enter the ${field.label.toLowerCase()} for this provider.`, { field: `fields.${field.key}`, messageRef: { id: 'gateway.invalid.fieldRequired', message: 'Enter the {label} for this provider.', values: { label: field.label.toLowerCase() } } });
        }
        if (value !== '') fields[field.key] = value;
      }
      if (Object.keys(fields).length === 0) fields = undefined;
    }
    // The base URL: the save's own when given, else the preset's (templated from fields).
    const candidate = trimString(raw.baseUrl ?? '', 'baseUrl') !== '' ? raw.baseUrl : (preset.baseUrlFor?.(fields ?? {}) ?? preset.baseUrl);
    // A local model preset may use http to this computer; every other endpoint is https only.
    baseUrl = preset.local === undefined ? normalizeBaseUrl(candidate ?? '') : normalizeLocalBaseUrl(candidate ?? '');
    defaultModel = trimString(raw.defaultModel ?? '', 'defaultModel') || preset.defaultModel;
    if (defaultModel === '') {
      throw new ProfileError('invalid', 'Enter the model name, for example openai/gpt-4.1-mini.', { field: 'defaultModel', messageRef: { id: 'gateway.invalid.modelName', message: 'Enter the model name, for example openai/gpt-4.1-mini.' } });
    }
  }

  const checked: CheckedFields = { name, baseUrl, defaultModel };
  const picked = checkPickedModels(kind, raw.pickedModels, defaultModel);
  if (picked !== undefined) checked.pickedModels = picked;
  if (fields !== undefined) checked.fields = fields;
  const headers = checkHeaders(kind, preset, raw.customHeaders);
  if (headers !== undefined) checked.customHeaders = headers;

  if (raw.temperature !== undefined) {
    if (!Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2) {
      throw new ProfileError('invalid', 'Temperature must be a number from 0 to 2.', { field: 'temperature', messageRef: { id: 'gateway.invalid.temperature', message: 'Temperature must be a number from 0 to 2.' } });
    }
    checked.temperature = raw.temperature;
  }
  if (raw.maxOutputTokens !== undefined) {
    if (!Number.isInteger(raw.maxOutputTokens) || raw.maxOutputTokens < 1) {
      throw new ProfileError('invalid', 'The output limit must be a whole number of tokens, at least 1.', { field: 'maxOutputTokens', messageRef: { id: 'gateway.invalid.maxOutputTokens', message: 'The output limit must be a whole number of tokens, at least 1.' } });
    }
    checked.maxOutputTokens = raw.maxOutputTokens;
  }
  if (raw.pricePer1k !== undefined) {
    if (!isRecord(raw.pricePer1k)) throw new ProfileError('invalid', 'Prices must be zero or more.', { field: 'pricePer1k', messageRef: { id: 'gateway.invalid.pricesZero', message: 'Prices must be zero or more.' } });
    const { prompt, completion } = raw.pricePer1k;
    if (![prompt, completion].every((n) => Number.isFinite(n) && n >= 0)) {
      throw new ProfileError('invalid', 'Prices must be zero or more.', { field: 'pricePer1k', messageRef: { id: 'gateway.invalid.pricesZero', message: 'Prices must be zero or more.' } });
    }
    checked.pricePer1k = { prompt, completion };
  }
  if (raw.params !== undefined) {
    const params = checkParams(raw.params);
    if (params !== undefined) checked.params = params;
  }
  return checked;
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
/** A wire value or a field name: a short identifier, never free text that could reshape a body. */
const WIRE_WORD = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_DENIED = 24;

/**
 * A profile's request parameters, checked (provider-gateway §2, "Request parameters"): the container itself is an object —
 * an array is refused rather than read as "nothing set" and silently clearing stored rules — booleans stay booleans, effort
 * keys are thinking levels and their values short wire words, denied fields are field names. An object with nothing set is
 * no override.
 */
function checkParams(raw: RequestParams): RequestParams | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ProfileError('invalid', 'The request parameters could not be read.', { field: 'params', messageRef: { id: 'gateway.invalid.paramsRead', message: 'The request parameters could not be read.' } });
  const out: { -readonly [K in keyof RequestParams]: RequestParams[K] } = {};
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== 'boolean') throw new ProfileError('invalid', 'Sending a temperature is either on or off.', { field: 'params', messageRef: { id: 'gateway.invalid.temperatureToggle', message: 'Sending a temperature is either on or off.' } });
    out.temperature = raw.temperature;
  }
  if (raw.toolStrict !== undefined) {
    if (typeof raw.toolStrict !== 'boolean') throw new ProfileError('invalid', 'Strict tool schemas are either on or off.', { field: 'params', messageRef: { id: 'gateway.invalid.toolStrictToggle', message: 'Strict tool schemas are either on or off.' } });
    out.toolStrict = raw.toolStrict;
  }
  if (raw.effort !== undefined) {
    // SDK input the types cannot see: anything that is not a level-to-value object is refused, never thrown on.
    if (typeof raw.effort !== 'object' || raw.effort === null || Array.isArray(raw.effort)) {
      throw new ProfileError('invalid', 'The request parameters could not be read.', { field: 'params', messageRef: { id: 'gateway.invalid.paramsRead', message: 'The request parameters could not be read.' } });
    }
    const effort: Partial<Record<ThinkingLevel, string>> = {};
    for (const [level, value] of Object.entries(raw.effort)) {
      if (value === undefined) continue;
      if (typeof value !== 'string') {
        throw new ProfileError('invalid', 'The request parameters could not be read.', { field: 'params', messageRef: { id: 'gateway.invalid.paramsRead', message: 'The request parameters could not be read.' } });
      }
      if (value.trim() === '') continue;
      if (!THINKING_LEVELS.has(level) || !WIRE_WORD.test(value.trim())) {
        throw new ProfileError('invalid', `"${value}" is not a thinking value a request can carry.`, { field: 'params', messageRef: { id: 'gateway.invalid.thinkingValue', message: '"{value}" is not a thinking value a request can carry.', values: { value } } });
      }
      effort[level as ThinkingLevel] = value.trim();
    }
    out.effort = effort;
  }
  if (raw.deny !== undefined) {
    if (!Array.isArray(raw.deny) || raw.deny.some((field) => typeof field !== 'string')) {
      throw new ProfileError('invalid', 'The request parameters could not be read.', { field: 'params', messageRef: { id: 'gateway.invalid.paramsRead', message: 'The request parameters could not be read.' } });
    }
    const deny = [...new Set(raw.deny.map((field) => field.trim()).filter((field) => field !== ''))];
    if (deny.length > MAX_DENIED) throw new ProfileError('invalid', `At most ${MAX_DENIED} fields can be left out.`, { field: 'params', messageRef: { id: 'gateway.invalid.denyMax', message: 'At most {max} fields can be left out.', values: { max: MAX_DENIED } } });
    const bad = deny.find((field) => !WIRE_WORD.test(field));
    if (bad !== undefined) throw new ProfileError('invalid', `"${bad}" is not a request field name.`, { field: 'params', messageRef: { id: 'gateway.invalid.denyField', message: '"{name}" is not a request field name.', values: { name: bad } } });
    if (deny.length > 0) out.deny = deny;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Validates a key for an `endpoint` profile. Whitespace is refused because a key
 * pasted with a line break makes every request fail with a confusing 401.
 */
function checkKey(raw: string, keyOptional: boolean): string {
  const key = trimString(raw, 'apiKey');
  if (/\s/.test(key)) throw new ProfileError('invalid', 'The API key contains a space or a line break. Paste it again.', { field: 'apiKey', messageRef: { id: 'gateway.invalid.apiKeySpace', message: 'The API key contains a space or a line break. Paste it again.' } });
  requireKeyFor(key !== '', keyOptional);
  return key;
}

/**
 * An endpoint needs a key unless its preset documents keyless calls (`keyOptional`,
 * per the registry: OpenCode's free models, a hand-rolled generic endpoint, a server on this
 * computer). There is no other exemption.
 */
function requireKeyFor(hasKey: boolean, keyOptional: boolean): void {
  if (!hasKey && !keyOptional) throw new ProfileError('invalid', 'Enter the API key for this endpoint.', { field: 'apiKey', messageRef: { id: 'gateway.invalid.apiKeyRequired', message: 'Enter the API key for this endpoint.' } });
}

/** A copy a caller cannot mutate the record through. */
function copyParams(params: RequestParams): RequestParams {
  return {
    ...params,
    ...(params.effort === undefined ? {} : { effort: { ...params.effort } }),
    ...(params.deny === undefined ? {} : { deny: [...params.deny] }),
  };
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
  if (rec.pickedModels !== undefined) view.pickedModels = [...rec.pickedModels];
  if (rec.temperature !== undefined) view.temperature = rec.temperature;
  if (rec.maxOutputTokens !== undefined) view.maxOutputTokens = rec.maxOutputTokens;
  if (rec.params !== undefined) view.params = copyParams(rec.params);
  if (rec.pricePer1k !== undefined) view.pricePer1k = { ...rec.pricePer1k };
  if (rec.responseFormat !== undefined) view.responseFormat = { ...rec.responseFormat };
  if (rec.verification !== undefined) view.verification = { ...rec.verification };
  return view;
}

export function createProfileStore(options: ProfileStoreOptions): ProfileStore {
  const { keys } = options;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  const records = new Map<string, StoredProfile>();
  const mirror = options.mirror;
  // `null` says the key went away, so a host can drop its copy. The origin is read off the record the write just made,
  // which is why every report below runs after that write rather than beside it.
  const report = (record: StoredProfile, payload: KeyPayload | null): void => {
    mirror?.changed(record.id, payload === null ? null : { origin: originOf(record.baseUrl), payload });
  };

  const requireRecord = (id: string): StoredProfile => {
    const rec = records.get(id);
    if (rec === undefined) throw new ProfileError('not-found', `No provider profile has the id ${id}.`, { messageRef: providerRefs.notFound(id) });
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
      const fields = checkFields(kind, input);
      const preset = kind === 'endpoint' ? presetFor(input.preset ?? 'generic') : undefined;
      const key = kind === 'endpoint' ? checkKey(input.apiKey ?? '', preset?.keyOptional === true) : '';
      const id = freshId();
      // The key is sealed before the record exists, so a failed seal leaves no profile
      // that claims a key it does not have. Custom headers ride inside the same payload —
      // they are secrets, and the vault is where secrets live.
      const payload: KeyPayload | null =
        key !== '' || fields.customHeaders !== undefined
          ? { apiKey: key, ...(fields.customHeaders === undefined ? {} : { customHeaders: fields.customHeaders }) }
          : null;
      if (payload !== null) await keys.putPayload(id, payload);

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
        ...(fields.pickedModels === undefined ? {} : { pickedModels: fields.pickedModels }),
        ...(fields.temperature === undefined ? {} : { temperature: fields.temperature }),
        ...(fields.maxOutputTokens === undefined ? {} : { maxOutputTokens: fields.maxOutputTokens }),
        ...(fields.params === undefined ? {} : { params: fields.params }),
        ...(fields.pricePer1k === undefined ? {} : { pricePer1k: fields.pricePer1k }),
        isActive: activate,
        hasKey: key !== '',
      });
      const created = requireRecord(id);
      if (payload !== null) report(created, payload);
      return toView(created);
    },

    async update(id, patch) {
      const rec = requireRecord(id);
      const preset = rec.kind === 'endpoint' ? presetFor(rec.preset ?? 'generic') : undefined;
      // `null` clears the saved price; an absent price keeps it (ProfilePatch).
      const price = patch.pricePer1k === null ? undefined : (patch.pricePer1k ?? rec.pricePer1k);
      if (rec.kind === 'endpoint' && patch.fields !== undefined && patch.fields !== null && !isRecord(patch.fields)) {
        throw new ProfileError('invalid', 'Enter provider fields as a name-to-value object.', { field: 'fields', messageRef: { id: 'gateway.invalid.fieldsObject', message: 'Enter provider fields as a name-to-value object.' } });
      }
      const mergedFields = patch.fields === undefined ? rec.fields : { ...(rec.fields ?? {}), ...patch.fields };
      const fields = checkFields(rec.kind, {
        name: patch.name ?? rec.name,
        preset: rec.preset,
        // A fields patch on a templated preset rebuilds the base URL from the new fields.
        baseUrl: patch.baseUrl ?? (patch.fields !== undefined && preset?.baseUrlFor !== undefined ? '' : rec.baseUrl),
        defaultModel: patch.defaultModel ?? rec.defaultModel,
        // `null` clears the list, so the connection reads as its default alone; an absent field keeps it as it is. The
        // default is the head of whatever the save stores, so moving the default moves it in the list too.
        pickedModels: patch.pickedModels === undefined ? rec.pickedModels : patch.pickedModels,
        fields: mergedFields,
        // `null` clears the headers; an absent field keeps what is sealed.
        customHeaders: patch.customHeaders === null ? undefined : patch.customHeaders,
        // `null` clears the temperature and the parameters; an absent field keeps what is saved.
        temperature: patch.temperature === null ? undefined : (patch.temperature ?? rec.temperature),
        maxOutputTokens: patch.maxOutputTokens ?? rec.maxOutputTokens,
        params: patch.params === null ? undefined : (patch.params ?? rec.params),
        pricePer1k: price,
      });

      let hasKey = rec.hasKey;
      let keyChanged = false;
      let written: KeyPayload | null = null;
      let keyRemoved = false;
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
              throw new ProfileError('invalid', 'Enter the API key again for the new endpoint.', { field: 'apiKey', messageRef: { id: 'gateway.invalid.apiKeyReenter', message: 'Enter the API key again for the new endpoint.' } });
            }
            if (patch.customHeaders === undefined && existing?.customHeaders !== undefined && Object.keys(existing.customHeaders).length > 0) {
              throw new ProfileError('invalid', 'Enter the extra headers again for the new endpoint.', { field: 'customHeaders', messageRef: { id: 'gateway.invalid.headersReenter', message: 'Enter the extra headers again for the new endpoint.' } });
            }
          }
          if (key === '' && (headers === undefined || Object.keys(headers).length === 0)) {
            await keys.remove(id);
            keyRemoved = true;
          } else {
            written = { apiKey: key, ...(headers === undefined ? {} : { customHeaders: headers }) };
            await keys.putPayload(id, written);
          }
          hasKey = key !== '';
          keyChanged = true;
        } else {
          if (originMoved && rec.hasKey) {
            throw new ProfileError('invalid', 'Enter the API key again for the new endpoint.', { field: 'apiKey', messageRef: { id: 'gateway.invalid.apiKeyReenter', message: 'Enter the API key again for the new endpoint.' } });
          }
          if (originMoved) {
            const existing = await keys.revealPayload(id);
            if (existing?.customHeaders !== undefined && Object.keys(existing.customHeaders).length > 0) {
              throw new ProfileError('invalid', 'Enter the extra headers again for the new endpoint.', { field: 'customHeaders', messageRef: { id: 'gateway.invalid.headersReenter', message: 'Enter the extra headers again for the new endpoint.' } });
            }
          }
          requireKeyFor(rec.hasKey, keyOptional);
        }
      }

      // A profile removed during the seal is not resurrected by the update.
      if (records.get(id) !== rec) throw new ProfileError('not-found', `No provider profile has the id ${id}.`, { messageRef: providerRefs.notFound(id) });

      const endpointChanged = fields.baseUrl !== rec.baseUrl || fields.defaultModel !== rec.defaultModel;
      const { customHeaders: _sealed, ...stored } = fields;
      Object.assign(rec, stored, { hasKey });
      // `Object.assign` cannot clear a key it was not given, so a cleared price is removed from the record here.
      if (fields.pricePer1k === undefined) delete rec.pricePer1k;
      if (fields.temperature === undefined) delete rec.temperature;
      if (fields.params === undefined) delete rec.params;
      if (fields.fields === undefined) delete rec.fields;
      if (fields.pickedModels === undefined) delete rec.pickedModels;
      // §5's probe is about one endpoint and one model with one key. Any of those
      // changing makes the cached answer a guess, so it goes.
      if (endpointChanged || keyChanged) {
        rec.responseFormat = undefined;
        rec.verification = providerVerificationMachine.step(rec.verification ?? { kind: 'unknown' }, { type: 'invalidate' });
      }
      // After the record holds the new fields, so a host sealing against the origin is told the address that save chose.
      if (written !== null) report(rec, written);
      else if (keyRemoved) report(rec, null);
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
      if (rec.kind === 'endpoint') report(rec, null);
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

    recordProbe(id, probe, attempt) {
      const rec = records.get(id);
      if (attempt !== undefined && (rec?.verification?.kind !== 'checking' || rec.verification.attempt !== attempt)) return;
      if (rec !== undefined) rec.responseFormat = { supportsJsonObject: probe.supportsJsonObject, probedAt: probe.probedAt };
    },

    recordVerification(id, verification) {
      const rec = records.get(id);
      if (rec !== undefined) rec.verification = { ...verification };
    },
  };
}
