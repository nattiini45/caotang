/**
 * The MCP settings slice — [extensibility.md §3.1–§3.2](../../../docs/architecture/extensibility.md),
 * [§8](../../../docs/architecture/extensibility.md) (config UX) and [ui-modules.md §5.1](../../../docs/architecture/ui-modules.md)
 * (`AppSettings.mcp`).
 *
 * Server configs are **app settings, never project files**: a repo-committed
 * `mcp.json` is the delivery channel that made Cursor's MCPoison possible, and the shape
 * here has no field a project could carry. Everything in this file is pure: it parses,
 * checks and serialises, and the caller decides where the bytes live.
 *
 * Three rules the functions below keep, each because a broken config must not take the
 * rest of the settings down with it:
 *
 * - **Load is per entry.** A malformed server object is dropped with a named warning and
 *   the rest load (§3.2, §8).
 * - **Import is per entry.** One malformed entry in a JSON import is refused by name and
 *   the rest are kept, where Cursor drops the whole file over one wrong value (§8).
 * - **Clamp at save.** At most twenty servers (A8). The clamp names what it dropped.
 */

import { isLoopbackHost } from '@caotang/gateway/loopback';
import { CROCKFORD_ALPHABET } from '@caotang/ids';

import { hasOwn, isRecord } from './util.js';

/** A8: at most twenty servers per install, a save-time clamp. */
export const MCP_SERVER_LIMIT = 20;

/** Display names are short; a longer one is a paste error or a hostile label. */
export const MCP_NAME_MAX = 80;

/** A token reference is a vault id, never a token: this bounds one, it does not check its shape. */
export const MCP_TOKEN_REF_MAX = 200;

/** A tool name in a saved selection. A longer one is not a name a server advertises, and it is refused rather than kept. */
export const MCP_TOOL_NAME_MAX = 200;

/** §3.2: `"s_"` plus ten Crockford base32 characters, assigned once and never reused. */
export const MCP_KEY_PATTERN = /^s_[0-9A-HJKMNP-TV-Z]{10}$/;

/** How a server authenticates. `bearer` names a vault entry; the token itself never enters settings. */
export type McpAuth = { kind: 'none' } | { kind: 'bearer'; tokenRef: string };

/**
 * §3.2's content pin: the hash, when the tool was first seen, and when a person last reviewed it. `toolName` is the server's own name
 * for the tool, which the pin's key does not hold when the name is aliased (extensibility §3.5). A pin reviewed before it was kept has
 * none, and a removed tool then shows its alias.
 */
export interface ToolPin {
  hash: string;
  firstSeen: string;
  lastReviewedAt: string;
  toolName?: string;
}

/** One connected server, as persisted (§3.2). */
export interface McpServerConfig {
  /** `s_` + ten Crockford characters. Assigned at add time, immutable, and namespaces every tool name. */
  key: string;
  /** The label the person chose. */
  name: string;
  /** v0.2 has exactly one transport. stdio joins with the desktop build (extensibility §1). */
  transport: 'http';
  /** A normalised endpoint: `https://…`, or `http://` only on loopback. */
  url: string;
  auth: McpAuth;
  /** Disabled servers are excluded from discovery and search. Default true after add. */
  enabled: boolean;
  /** Tool names kept enabled. Absent means every discovered tool is enabled (§8). */
  enabledTools?: string[];
  /** The "trusted for reads" grant. Off by default; may be turned on only after a review (§3.4 step 4a). */
  trustReads: boolean;
  /** Qualified tool name → the pin the person last reviewed. Changes only on an explicit review. */
  pinnedTools: Record<string, ToolPin>;
  /**
   * Prompt name → the pin the person last reviewed (extensibility §3.2). Absent until a review has seen a prompt, so a server saved before
   * prompts were pinned loads as it was saved, with its tool pins untouched.
   */
  pinnedPrompts?: Record<string, ToolPin>;
  /** URI template → the pin the person last reviewed, for the server's resource templates. Absent like {@link pinnedPrompts}. */
  pinnedTemplates?: Record<string, ToolPin>;
  addedAt: string;
}

/** `AppSettings.mcp`: the master switch, which is off until the person turns it on, and the server list. */
export interface McpSettings {
  enabled: boolean;
  servers: McpServerConfig[];
}

export const EMPTY_MCP_SETTINGS: McpSettings = { enabled: false, servers: [] };

/** The result of a settings load: what loaded, and a named warning for everything that did not. */
export interface McpSettingsLoad {
  readonly settings: McpSettings;
  readonly warnings: readonly string[];
}

/** The one loopback predicate the gateway shares (`@caotang/gateway/loopback`), re-exported for callers of this package. */
export { isLoopbackHost };

export type UrlCheck = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

/**
 * The save-time check on a server URL (§3.2: "validated at save (https or http://localhost*,
 * no trailing slash)"). Also refused, and named: credentials in the URL (a token belongs in
 * the vault), a query string or fragment (a token routinely rides there), and a non-web scheme.
 */
export function checkServerUrl(input: string): UrlCheck {
  const raw = input.trim();
  if (raw === '') return fail('is empty');
  if (raw.endsWith('/')) return fail('must not end in a slash — enter the endpoint without a trailing /');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('is not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('must start with https:// (or http:// for localhost)');
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return fail('must use https:// unless it points at localhost, so the request is not sent in plain text');
  }
  if (url.username !== '' || url.password !== '') return fail('must not carry a username or password — the token goes in the server card');
  if (url.search !== '' || url.hash !== '') return fail('must not carry a query string or fragment');
  const path = url.pathname === '/' ? '' : url.pathname;
  return { ok: true, url: `${url.origin}${path}` };
}

function fail(reason: string): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason: `The server URL ${reason}.` };
}

/** A fresh key from the given bytes, re-rolled until it is not `taken`. Keys are never reused, so a removed one stays out of the set. */
export function newServerKey(taken: ReadonlySet<string>, randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const key = keyFrom(randomBytes(10));
    if (!taken.has(key)) return key;
  }
  throw new Error('could not mint an MCP server key that is not already taken');
}

/**
 * Ten characters from thirty-two symbols: one byte, masked to five bits, is unbiased because 256
 * is a multiple of 32. The alphabet comes from `@caotang/ids`, so the two families agree.
 */
function keyFrom(bytes: Uint8Array): string {
  let body = '';
  for (const byte of bytes) body += CROCKFORD_ALPHABET[byte & 31] ?? '0';
  return `s_${body}`;
}

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** §8's save-time clamp: keep the first `MCP_SERVER_LIMIT`, and name what was dropped. */
export function clampServers(servers: readonly McpServerConfig[]): { servers: McpServerConfig[]; dropped: string[] } {
  if (servers.length <= MCP_SERVER_LIMIT) return { servers: [...servers], dropped: [] };
  return {
    servers: servers.slice(0, MCP_SERVER_LIMIT),
    dropped: servers.slice(MCP_SERVER_LIMIT).map((server) => server.name),
  };
}

/**
 * Loads the persisted MCP slice, entry by entry. Anything that is not a valid settings
 * object loads as the empty default and says why. Within a valid object, one bad server is
 * dropped by name and the others are kept, and one bad pin is dropped so its tool needs a
 * review (a dropped pin is the safe direction: the tool is then `new`).
 */
export function loadMcpSettings(raw: unknown, now: string): McpSettingsLoad {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { settings: { ...EMPTY_MCP_SETTINGS, servers: [] }, warnings };
  if (!isRecord(raw)) {
    return { settings: { enabled: false, servers: [] }, warnings: ['MCP settings are not an object; MCP & tools is off'] };
  }
  const enabled = raw['enabled'] === true;
  if (raw['enabled'] !== undefined && typeof raw['enabled'] !== 'boolean') {
    warnings.push('MCP master switch is not true or false; MCP & tools is off');
  }
  const servers: McpServerConfig[] = [];
  const keys = new Set<string>();
  const entries = Array.isArray(raw['servers']) ? raw['servers'] : [];
  if (raw['servers'] !== undefined && !Array.isArray(raw['servers'])) warnings.push('MCP server list is not a list; no servers loaded');
  entries.forEach((entry, index) => {
    const parsed = parseStoredServer(entry, now, `entry ${index + 1}`);
    if (!parsed.ok) {
      warnings.push(`dropped MCP server ${parsed.label}: ${parsed.reason}`);
      return;
    }
    if (keys.has(parsed.server.key)) {
      warnings.push(`dropped MCP server ${parsed.label}: its key ${parsed.server.key} is already used by an earlier entry`);
      return;
    }
    keys.add(parsed.server.key);
    servers.push(parsed.server);
    warnings.push(...parsed.warnings);
  });
  const clamped = clampServers(servers);
  for (const name of clamped.dropped) warnings.push(`dropped MCP server "${name}": at most ${MCP_SERVER_LIMIT} servers are kept`);
  return { settings: { enabled, servers: clamped.servers }, warnings };
}

type StoredParse =
  | { readonly ok: true; readonly label: string; readonly server: McpServerConfig; readonly warnings: string[] }
  | { readonly ok: false; readonly label: string; readonly reason: string };

function parseStoredServer(entry: unknown, now: string, position: string): StoredParse {
  if (!isRecord(entry)) return { ok: false, label: position, reason: 'it is not an object' };
  const name = typeof entry['name'] === 'string' ? entry['name'] : undefined;
  const label = name === undefined ? position : `"${name}"`;
  const reject = (reason: string): StoredParse => ({ ok: false, label, reason });
  const key = entry['key'];
  if (typeof key !== 'string' || !MCP_KEY_PATTERN.test(key)) return reject('its key is missing or not in the s_ form');
  if (name === undefined || name.trim() === '' || name.length > MCP_NAME_MAX) return reject(`its name must be 1 to ${MCP_NAME_MAX} characters`);
  if (entry['transport'] !== 'http') return reject('its transport must be "http"');
  if (typeof entry['url'] !== 'string') return reject('its URL is missing');
  const url = checkServerUrl(entry['url']);
  if (!url.ok) return reject(url.reason);
  const auth = parseAuth(entry['auth']);
  if (auth === undefined) return reject('its auth must be { kind: "none" } or { kind: "bearer", tokenRef }');
  if (entry['enabled'] !== undefined && typeof entry['enabled'] !== 'boolean') return reject('its enabled flag must be true or false');
  if (entry['trustReads'] !== undefined && typeof entry['trustReads'] !== 'boolean') return reject('its trustReads flag must be true or false');
  const enabledTools = parseNameList(entry['enabledTools']);
  if (enabledTools === 'invalid') return reject('its enabledTools must be a list of tool names');
  if (entry['addedAt'] !== undefined && typeof entry['addedAt'] !== 'string') return reject('its addedAt must be a string');

  const warnings: string[] = [];
  const pinnedTools: Record<string, ToolPin> = {};
  const rawPins = entry['pinnedTools'];
  if (rawPins !== undefined && !isRecord(rawPins)) return reject('its pinnedTools must be an object');
  for (const [qualified, pin] of Object.entries(isRecord(rawPins) ? rawPins : {})) {
    if (!isRecord(pin) || typeof pin['hash'] !== 'string' || !/^[0-9a-f]{64}$/.test(pin['hash'])) {
      warnings.push(`dropped the pin for ${qualified} on MCP server ${label}: it needs review again`);
      continue;
    }
    pinnedTools[qualified] = {
      hash: pin['hash'],
      firstSeen: typeof pin['firstSeen'] === 'string' ? pin['firstSeen'] : now,
      lastReviewedAt: typeof pin['lastReviewedAt'] === 'string' ? pin['lastReviewedAt'] : now,
      // The server's own name for the tool, which a pin written before it was kept does not have (the field is optional).
      ...(typeof pin['toolName'] === 'string' ? { toolName: pin['toolName'] } : {}),
    };
  }

  const pinnedPrompts = parsePinMap(entry['pinnedPrompts'], 'prompt', label, now, warnings);
  if (pinnedPrompts === 'invalid') return reject('its pinnedPrompts must be an object');
  const pinnedTemplates = parsePinMap(entry['pinnedTemplates'], 'resource template', label, now, warnings);
  if (pinnedTemplates === 'invalid') return reject('its pinnedTemplates must be an object');

  const server: McpServerConfig = {
    key,
    name,
    transport: 'http',
    url: url.url,
    auth,
    enabled: entry['enabled'] !== false,
    trustReads: entry['trustReads'] === true,
    pinnedTools,
    addedAt: typeof entry['addedAt'] === 'string' ? entry['addedAt'] : now,
  };
  if (enabledTools !== undefined) server.enabledTools = enabledTools;
  if (pinnedPrompts !== undefined) server.pinnedPrompts = pinnedPrompts;
  if (pinnedTemplates !== undefined) server.pinnedTemplates = pinnedTemplates;
  return { ok: true, label, server, warnings };
}

/** A saved map of prompt or template pins. Absent stays absent, and an empty map is not kept, so a server with none is saved as it always was. */
function parsePinMap(value: unknown, what: string, label: string, now: string, warnings: string[]): Record<string, ToolPin> | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return 'invalid';
  const pins: Record<string, ToolPin> = {};
  for (const [name, pin] of Object.entries(value)) {
    if (name === '__proto__') continue;
    if (!isRecord(pin) || typeof pin['hash'] !== 'string' || !/^[0-9a-f]{64}$/.test(pin['hash'])) {
      warnings.push(`dropped the pin for ${what} ${name} on MCP server ${label}: it needs review again`);
      continue;
    }
    pins[name] = {
      hash: pin['hash'],
      firstSeen: typeof pin['firstSeen'] === 'string' ? pin['firstSeen'] : now,
      lastReviewedAt: typeof pin['lastReviewedAt'] === 'string' ? pin['lastReviewedAt'] : now,
    };
  }
  return Object.keys(pins).length === 0 ? undefined : pins;
}

function parseAuth(value: unknown): McpAuth | undefined {
  if (!isRecord(value)) return undefined;
  if (value['kind'] === 'none') return { kind: 'none' };
  if (value['kind'] === 'bearer' && typeof value['tokenRef'] === 'string' && value['tokenRef'] !== '' && value['tokenRef'].length <= MCP_TOKEN_REF_MAX) {
    return { kind: 'bearer', tokenRef: value['tokenRef'] };
  }
  return undefined;
}

/**
 * A selection of tool names: non-empty strings no longer than {@link MCP_TOOL_NAME_MAX}, sorted and without repeats. Returns
 * `'invalid'` for anything else. The caller decides what absence means (`enabledTools` absent = every tool enabled, §8).
 */
export function toolNameList(value: unknown): string[] | 'invalid' {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== '' && item.length <= MCP_TOOL_NAME_MAX)) {
    return 'invalid';
  }
  return [...new Set(value as string[])].sort();
}

/** A list of non-empty tool names, sorted and without repeats; `undefined` when absent, `'invalid'` when malformed. */
function parseNameList(value: unknown): string[] | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return toolNameList(value);
}

/** The fields an import may set. Anything else in an entry is refused by name, and the grants are refused on purpose. */
const IMPORT_FIELDS: readonly string[] = ['name', 'url', 'auth', 'enabled', 'enabledTools'];
const REFUSED_IMPORT_FIELDS: readonly string[] = ['key', 'trustReads', 'pinnedTools', 'pinnedPrompts', 'pinnedTemplates', 'addedAt', 'transport'];

export interface ImportRefusal {
  readonly entry: string;
  readonly reason: string;
}

export interface ImportResult {
  readonly servers: McpServerConfig[];
  readonly refused: readonly ImportRefusal[];
}

/**
 * Reads an exported (or hand-written) server list. The list is `{ "servers": [...] }` or a bare array.
 *
 * An import creates servers; it never carries a key, a pin or a trust grant. A pin in a file
 * would be a review the person never made, and a trust grant in a file would bypass the review
 * the settings card requires. A bearer entry is refused, because a token is entered in the
 * server card and never read from a file. Duplicate URLs and entries past the limit are refused by name.
 */
export function parseServerImport(text: string, options: { existing: readonly McpServerConfig[]; now: string; newKey: () => string }): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { servers: [], refused: [{ entry: 'the file', reason: 'it is not JSON' }] };
  }
  const list: readonly unknown[] | undefined = Array.isArray(parsed)
    ? (parsed as unknown[])
    : isRecord(parsed) && Array.isArray(parsed['servers'])
      ? (parsed['servers'] as unknown[])
      : undefined;
  if (list === undefined) {
    return { servers: [], refused: [{ entry: 'the file', reason: 'it must hold a "servers" list, or be a list of servers' }] };
  }
  const servers: McpServerConfig[] = [];
  const refused: ImportRefusal[] = [];
  const urls = new Set(options.existing.map((server) => server.url));
  const room = Math.max(0, MCP_SERVER_LIMIT - options.existing.length);
  list.forEach((entry, index) => {
    const label = isRecord(entry) && typeof entry['name'] === 'string' ? `"${entry['name']}"` : `entry ${index + 1}`;
    const reject = (reason: string): void => {
      refused.push({ entry: label, reason });
    };
    if (!isRecord(entry)) return reject('it is not an object');
    const refusedField = REFUSED_IMPORT_FIELDS.find((field) => hasOwn(entry, field));
    if (refusedField !== undefined) return reject(`it sets "${refusedField}", which an import cannot carry — set it in the server card`);
    const unknownField = Object.keys(entry).find((field) => !IMPORT_FIELDS.includes(field));
    if (unknownField !== undefined) return reject(`it sets "${unknownField}", which is not an MCP server field`);
    const name = entry['name'];
    if (typeof name !== 'string' || name.trim() === '' || name.length > MCP_NAME_MAX) return reject(`its name must be 1 to ${MCP_NAME_MAX} characters`);
    if (typeof entry['url'] !== 'string') return reject('its URL is missing');
    const url = checkServerUrl(entry['url']);
    if (!url.ok) return reject(url.reason);
    if (entry['auth'] !== undefined && (!isRecord(entry['auth']) || entry['auth']['kind'] !== 'none')) {
      return reject('it sets a bearer token, which is entered in the server card and never read from a file');
    }
    if (entry['enabled'] !== undefined && typeof entry['enabled'] !== 'boolean') return reject('its enabled flag must be true or false');
    const enabledTools = parseNameList(entry['enabledTools']);
    if (enabledTools === 'invalid') return reject('its enabledTools must be a list of tool names');
    if (urls.has(url.url)) return reject('a server with this URL is already in the list');
    if (servers.length >= room) return reject(`it would be past the ${MCP_SERVER_LIMIT}-server limit`);
    urls.add(url.url);
    const server: McpServerConfig = {
      key: options.newKey(),
      name: name.trim(),
      transport: 'http',
      url: url.url,
      auth: { kind: 'none' },
      enabled: entry['enabled'] !== false,
      trustReads: false,
      pinnedTools: {},
      addedAt: options.now,
    };
    if (enabledTools !== undefined) server.enabledTools = enabledTools;
    servers.push(server);
  });
  return { servers, refused };
}

/**
 * The shareable form of the server list: names, URLs, the auth kind, and the enabled tools.
 * Never a key, a token reference, a pin or a trust grant. Those belong to this install.
 */
export function exportServers(servers: readonly McpServerConfig[]): string {
  const body = {
    format: 'caotang-mcp-servers',
    version: 1,
    servers: servers.map((server) => ({
      name: server.name,
      url: server.url,
      auth: { kind: server.auth.kind },
      enabled: server.enabled,
      ...(server.enabledTools === undefined ? {} : { enabledTools: [...server.enabledTools] }),
    })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}
