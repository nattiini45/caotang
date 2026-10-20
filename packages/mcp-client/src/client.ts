/**
 * The MCP client — [extensibility.md §3.2–§3.5](../../../docs/architecture/extensibility.md),
 * with the settings operations of §8 and the review flow of §3.4.
 *
 * One object owns the server list, each server's connection, the last listing it returned, and
 * the three health states. Everything the rest of the app reads is a snapshot: `health()`,
 * `indexedTools()`, `describe()`. Everything that changes a persisted setting goes through a
 * method here and then calls `onChange`, which is where the app writes the settings.
 *
 * **The three states are not two.** `configured` means there is no successful listing this
 * session. `connected` means a listing arrived and a pin changed or a tool is new, so the tools
 * wait for a review. `healthy` means the listing matches the reviewed pins and the tools may be
 * searched. A connection that works and a tool that can be called are different signals, and this
 * object keeps them apart.
 */

import type { FetchLike } from '@modelcontextprotocol/client';
import { err, ok, type Result } from '@caotang/bus';

import { modelSafeAliases } from './alias.js';
import { canonicalJson, pinHash } from './canonical.js';
import {
  checkServerUrl,
  MCP_NAME_MAX,
  MCP_SERVER_LIMIT,
  MCP_TOKEN_REF_MAX,
  MCP_TOOL_NAME_MAX,
  newServerKey,
  toolNameList,
  type McpAuth,
  type McpServerConfig,
  type McpSettings,
  type ToolPin,
} from './config.js';
import { McpFailure, PIN_MISMATCH_TEXT, serverErrorText, timeoutText, unreachableText, type McpError } from './errors.js';
import { effectiveRiskOf, type EffectiveRisk } from './risk.js';
import { diffPins, hasDelta, listingFingerprint, pinsAfterReview, pinStateOf, type PinDelta, type PinState } from './pins.js';
import { corsProbe, createStreamableHttpWire, WireError, type McpWire, type WireAnnotations, type WireCallResult, type WireDeps, type WireFactory, type WireTool } from './wire.js';

/** §3.3: the reachable-but-blocked message, verbatim. */
export const CORS_REFUSAL = 'server reachable but refuses browser connections (CORS). The desktop app on the roadmap connects without this restriction.';

/**
 * A server that speaks none of the revisions Caotang offers: 2026-07-28, or a 2024 or 2025 revision (§3.3, §12 D17). The
 * client has offered all of them, so the fix is the server's version, not the URL.
 */
export const REVISION_REFUSAL =
  'this server speaks none of the MCP revisions Caotang can connect on (2026-07-28, or a 2024 or 2025 revision), so its tools cannot be listed — ask its maker for an update';

/** §3.3: `tools/list` times out after 10 s. */
export const LIST_TIMEOUT_MS = 10_000;

/** §3.3 and A8: a tool call times out after 120 s, and no partial result is ever returned. */
export const CALL_TIMEOUT_MS = 120_000;

/**
 * The model API accepts tool names of this shape only. A server's tool name is given an alias of this shape (alias.ts), so
 * every name that reaches the model passes this check; one that still does not is named as hidden in the health detail.
 */
const USABLE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The longest name the model accepts, which a qualified name (prefix included) may not exceed. */
const QUALIFIED_NAME_MAX = 64;

export type HealthState = 'configured' | 'connected' | 'healthy';

/** §3.2's runtime health, never persisted. */
export interface McpServerHealth {
  readonly key: string;
  readonly state: HealthState;
  /** Human and model-facing: the named corrective path for a failure. */
  readonly detail?: string;
  readonly toolsDiscovered?: number;
  readonly pendingReview?: boolean;
}

/** §3.5's descriptor. The description and the schema are the server's text, verbatim: untrusted, and never rewritten. */
export interface ExternalToolDescriptor {
  /** `mcp__<serverKey>__<alias>`: the name the model is given. The alias is the tool's own name when the model's rule takes it (alias.ts). */
  readonly qualifiedName: string;
  readonly serverKey: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly annotations?: WireAnnotations;
  /** The hash of the listing as the server advertises it now. */
  readonly candidateHash: string;
  /** The pin the person reviewed, if any. */
  readonly pin?: ToolPin;
  readonly pinState: PinState;
  readonly enabled: boolean;
  readonly effectiveRisk: EffectiveRisk;
  /** §3.5: the full schema enters the model's context only after `tool.search`. */
  readonly deferred: true;
}

/** What `tool.search` may find: the tools of healthy, enabled servers, and a note for each server it skipped. */
export interface IndexedTools {
  readonly tools: readonly ExternalToolDescriptor[];
  readonly notes: readonly string[];
}

export interface ReviewTool {
  readonly qualifiedName: string;
  readonly toolName: string;
  readonly status: 'new' | 'changed' | 'unchanged';
  readonly description: string;
  readonly inputSchema: unknown;
  readonly annotations?: WireAnnotations;
  readonly candidateHash: string;
  readonly previousHash?: string;
  readonly enabled: boolean;
}

/** §3.4's review card, as data. The UI renders every description in full (§4 rule 4). */
export interface ReviewCard {
  readonly serverKey: string;
  readonly serverName: string;
  readonly kind: 'first-connect' | 'changed' | 'current';
  /** The approval must carry this back. A listing that changed since the card was built will not match it. */
  readonly fingerprint: string;
  readonly tools: readonly ReviewTool[];
  readonly removed: readonly { readonly qualifiedName: string; readonly toolName: string; readonly previousHash: string }[];
}

/** A successful call's result, verbatim, and not yet trusted. */
export interface McpToolResult {
  readonly content: readonly unknown[];
  readonly isError: boolean;
}

export interface McpClientOptions {
  /** The persisted MCP slice, as loaded. The client works on its own copy. */
  readonly settings: McpSettings;
  /** The transport. Defaults to the SDK's Streamable HTTP wire; evals inject a scripted one. */
  readonly wire?: WireFactory;
  /** The vault's bearer lookup. Absent means no token is ever available, and bearer servers stay `configured`. */
  readonly resolveBearer?: (tokenRef: string) => Promise<string | undefined>;
  /** The fetch the default wire uses. Defaults to the platform's. */
  readonly fetch?: FetchLike;
  /** The CORS probe. Defaults to a no-cors request to the same URL. */
  readonly probe?: (url: string) => Promise<boolean>;
  /** ISO timestamps for pins. Defaults to the clock. */
  readonly now?: () => string;
  /** Mints a server key that is not in the given set. Defaults to a random one. */
  readonly newKey?: (taken: ReadonlySet<string>) => string;
  readonly listTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  /** Called with the whole slice after every change to it, so the app can persist it. */
  readonly onChange?: (settings: McpSettings) => void;
}

export interface McpClient {
  settings(): McpSettings;
  setMasterEnabled(on: boolean): Promise<void>;
  health(): McpServerHealth[];
  onHealthChange(listener: (health: McpServerHealth) => void): () => void;
  onToolListChanged(listener: (serverKey: string) => void): () => void;
  connect(key: string): Promise<McpServerHealth>;
  connectAll(): Promise<McpServerHealth[]>;
  refresh(key: string): Promise<McpServerHealth>;
  disconnect(key: string): Promise<void>;
  close(): Promise<void>;
  listTools(key: string): ExternalToolDescriptor[];
  describe(serverKey: string, toolName: string): ExternalToolDescriptor | undefined;
  serverFor(serverKey: string): McpServerConfig | undefined;
  healthOf(serverKey: string): McpServerHealth | undefined;
  indexedTools(): IndexedTools;
  review(key: string): ReviewCard | undefined;
  approveReview(key: string, fingerprint: string): Result<McpServerHealth, string>;
  setTrustReads(key: string, value: boolean): Result<McpServerConfig, string>;
  setToolEnabled(key: string, toolName: string, enabled: boolean): Result<McpServerConfig, string>;
  addServer(input: AddServerInput): Result<McpServerConfig, string>;
  updateServer(key: string, patch: UpdateServerPatch): Promise<Result<McpServerConfig, string>>;
  removeServer(key: string): Promise<void>;
}

/**
 * What a server is added with. `enabledTools` is the tool selection an import carried, and it is stored with the server
 * before the first connect (§8, D15), so it survives a reload and applies when the listing arrives.
 */
export interface AddServerInput {
  readonly name: string;
  readonly url: string;
  readonly auth: McpAuth;
  readonly enabledTools?: readonly string[];
}

/** The fields an edit may change. Every field is optional; an absent one is left as it is. */
export interface UpdateServerPatch {
  readonly name?: string;
  readonly url?: string;
  readonly auth?: McpAuth;
  readonly enabled?: boolean;
  readonly enabledTools?: readonly string[];
}

/**
 * The one way to make a tool call: a single `tools/call`, with the 120 s limit and no retry. It is not on
 * {@link McpClient}, so the state surface a model or a panel reads cannot make a call (extensibility §4 rule 2).
 * {@link createMcpTransport} builds it, and only `mcp.invoke` (invoke.ts) holds it, and that command decides each
 * call before this step is reached. The transport checks what the client itself owns as well: the tool must be
 * listed with a verified pin, so a tool nobody reviewed cannot be called through it.
 */
export interface McpTransport {
  callTool(serverKey: string, toolName: string, args: Record<string, unknown>, options?: { readonly signal?: AbortSignal }): Promise<McpToolResult>;
  /**
   * Lists the server again, bounded by the list timeout, so a call is checked against what the server advertises at the
   * moment it is made, not against a listing from validation (which can be minutes earlier, behind a confirmation). It never
   * rejects: a failed listing demotes the server, and the caller's recheck refuses the call.
   */
  relist(serverKey: string): Promise<McpServerHealth>;
}

/**
 * The qualified name a tool is given to the model: `mcp__<serverKey>__<alias>` (extensibility §3.5). The argument is the tool's
 * model-facing alias, which is the server's own name when the model's rule takes it, and a listing gives each tool its alias.
 */
export function qualifiedNameOf(serverKey: string, alias: string): string {
  return `${prefixOf(serverKey)}${alias}`;
}

function prefixOf(serverKey: string): string {
  return `mcp__${serverKey}__`;
}

interface ListedTool {
  readonly toolName: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly annotations?: WireAnnotations;
  readonly candidateHash: string;
  readonly usable: boolean;
}

interface Listing {
  readonly tools: readonly ListedTool[];
  readonly delta: PinDelta;
  readonly removed: readonly string[];
  readonly fingerprint: string;
  /** The canonical text of the listing's (name, hash) pairs, to notice a listing that changed since the last one. */
  readonly listedKey: string;
}

interface ServerRuntime {
  health: McpServerHealth;
  wire: McpWire | undefined;
  listing: Listing | undefined;
  pending: Promise<McpServerHealth> | undefined;
  /** Moves on at every teardown. A listing that started under an earlier value writes nothing when it returns. */
  generation: number;
}

class McpClientImpl implements McpClient {
  private config: McpSettings;
  private readonly runtimes = new Map<string, ServerRuntime>();
  private readonly healthListeners = new Set<(health: McpServerHealth) => void>();
  private readonly listChangeListeners = new Set<(serverKey: string) => void>();
  private readonly factory: WireFactory;
  private readonly resolveToken: (tokenRef: string) => Promise<string | undefined>;
  private readonly fetchImpl: FetchLike;
  private readonly probe: (url: string) => Promise<boolean>;
  private readonly clock: () => string;
  private readonly newKey: (taken: ReadonlySet<string>) => string;
  private readonly listTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly onChange: ((settings: McpSettings) => void) | undefined;

  constructor(options: McpClientOptions) {
    this.config = { enabled: options.settings.enabled, servers: options.settings.servers.map(cloneServer) };
    this.factory = options.wire ?? createStreamableHttpWire;
    this.resolveToken = options.resolveBearer ?? (() => Promise.resolve(undefined));
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.probe = options.probe ?? corsProbe(this.fetchImpl);
    this.clock = options.now ?? (() => new Date().toISOString());
    this.newKey = options.newKey ?? ((taken) => newServerKey(taken));
    this.listTimeoutMs = options.listTimeoutMs ?? LIST_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.onChange = options.onChange;
    for (const server of this.config.servers) {
      this.runtimes.set(server.key, freshRuntime(server.key, 'not connected this session'));
    }
  }

  settings(): McpSettings {
    return { enabled: this.config.enabled, servers: this.config.servers.map(cloneServer) };
  }

  health(): McpServerHealth[] {
    return this.config.servers.map((server) => this.runtime(server.key).health);
  }

  healthOf(serverKey: string): McpServerHealth | undefined {
    return this.runtimes.get(serverKey)?.health;
  }

  serverFor(serverKey: string): McpServerConfig | undefined {
    const server = this.config.servers.find((candidate) => candidate.key === serverKey);
    return server === undefined ? undefined : cloneServer(server);
  }

  onHealthChange(listener: (health: McpServerHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  onToolListChanged(listener: (serverKey: string) => void): () => void {
    this.listChangeListeners.add(listener);
    return () => this.listChangeListeners.delete(listener);
  }

  async setMasterEnabled(on: boolean): Promise<void> {
    if (this.config.enabled === on) return;
    this.config = { ...this.config, enabled: on };
    if (!on) {
      for (const server of this.config.servers) {
        await this.demote(server.key, 'MCP & tools is off — turn it on in Settings › MCP & tools');
      }
    }
    this.persist();
  }

  async connect(key: string): Promise<McpServerHealth> {
    const server = this.config.servers.find((candidate) => candidate.key === key);
    if (server === undefined) return this.runtime(key).health;
    const rt = this.runtime(key);
    if (!this.config.enabled) return this.setHealth(key, 'configured', 'MCP & tools is off — turn it on in Settings › MCP & tools');
    if (!server.enabled) return this.setHealth(key, 'configured', 'this server is disabled — enable it in Settings › MCP & tools');
    if (rt.health.state !== 'configured' && rt.wire !== undefined && rt.listing !== undefined) return rt.health;
    return this.list(key);
  }

  async connectAll(): Promise<McpServerHealth[]> {
    for (const server of this.config.servers) {
      if (server.enabled) await this.connect(server.key);
    }
    return this.health();
  }

  async refresh(key: string): Promise<McpServerHealth> {
    const server = this.config.servers.find((candidate) => candidate.key === key);
    if (server === undefined) return this.runtime(key).health;
    if (!this.config.enabled || !server.enabled) return this.connect(key);
    return this.listAfter(key);
  }

  async disconnect(key: string): Promise<void> {
    await this.demote(key, 'disconnected');
  }

  async close(): Promise<void> {
    for (const server of this.config.servers) await this.demote(server.key, 'disconnected');
  }

  listTools(key: string): ExternalToolDescriptor[] {
    const server = this.config.servers.find((candidate) => candidate.key === key);
    const listing = this.runtimes.get(key)?.listing;
    if (server === undefined || listing === undefined) return [];
    const health = this.runtime(key).health;
    return listing.tools.map((tool) => this.descriptorOf(server, tool, health));
  }

  describe(serverKey: string, toolName: string): ExternalToolDescriptor | undefined {
    const server = this.config.servers.find((candidate) => candidate.key === serverKey);
    const rt = this.runtimes.get(serverKey);
    // The server's own name, or the alias the model was given (extensibility §3.5). Either one names the same tool.
    const tool =
      rt?.listing?.tools.find((candidate) => candidate.toolName === toolName) ??
      rt?.listing?.tools.find((candidate) => candidate.qualifiedName === qualifiedNameOf(serverKey, toolName));
    if (server === undefined || rt === undefined || tool === undefined) return undefined;
    return this.descriptorOf(server, tool, rt.health);
  }

  indexedTools(): IndexedTools {
    if (!this.config.enabled) {
      return { tools: [], notes: ['MCP & tools is off — turn it on in Settings › MCP & tools'] };
    }
    const enabledServers = this.config.servers.filter((server) => server.enabled);
    if (enabledServers.length === 0) {
      return { tools: [], notes: ['no MCP servers connected — add one in Settings › MCP & tools'] };
    }
    const tools: ExternalToolDescriptor[] = [];
    const notes: string[] = [];
    for (const server of enabledServers) {
      const rt = this.runtime(server.key);
      if (rt.health.state !== 'healthy' || rt.listing === undefined) {
        notes.push(`${server.name} is not searched: ${rt.health.detail ?? 'not connected this session'}`);
        continue;
      }
      for (const tool of rt.listing.tools) {
        if (!tool.usable || !isEnabledTool(server, tool.toolName)) continue;
        tools.push(this.descriptorOf(server, tool, rt.health));
      }
    }
    return { tools, notes };
  }

  review(key: string): ReviewCard | undefined {
    const server = this.config.servers.find((candidate) => candidate.key === key);
    const listing = this.runtimes.get(key)?.listing;
    if (server === undefined || listing === undefined) return undefined;
    const tools: ReviewTool[] = listing.tools.map((tool) => {
      const state = pinStateOf(server.pinnedTools, tool.qualifiedName, tool.candidateHash);
      const previousHash = pinOf(server, tool.qualifiedName)?.hash;
      return {
        qualifiedName: tool.qualifiedName,
        toolName: tool.toolName,
        status: state === 'new' ? 'new' : state === 'changed' ? 'changed' : 'unchanged',
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        candidateHash: tool.candidateHash,
        ...(previousHash === undefined ? {} : { previousHash }),
        enabled: isEnabledTool(server, tool.toolName),
      };
    });
    // A removed tool is named as the server named it, which its pin keeps. A pin from before that was kept shows the alias the model knew it by.
    const removed = listing.removed.map((qualifiedName) => ({
      qualifiedName,
      toolName: pinOf(server, qualifiedName)?.toolName ?? qualifiedName.slice(prefixOf(server.key).length),
      previousHash: pinOf(server, qualifiedName)?.hash ?? '',
    }));
    const kind = listing.delta.firstConnect ? 'first-connect' : hasDelta(listing.delta) ? 'changed' : 'current';
    return { serverKey: key, serverName: server.name, kind, fingerprint: listing.fingerprint, tools, removed };
  }

  approveReview(key: string, fingerprint: string): Result<McpServerHealth, string> {
    const server = this.config.servers.find((candidate) => candidate.key === key);
    if (server === undefined) return err(`no MCP server with key ${key} is configured`);
    const rt = this.runtime(key);
    if (rt.listing === undefined) return err('connect the server first — there is no tool list to review yet');
    // A review confirms a listing that a live connection produced. Without a wire there is nothing behind the
    // listing, so approving it would mark the server healthy with no connection to call through.
    if (rt.wire === undefined || rt.health.state === 'configured') {
      return err('the server is not connected, so its tool list cannot be approved — connect it first');
    }
    if (rt.listing.fingerprint !== fingerprint) {
      return err('the server changed again after this review — review its new tool list before approving it');
    }
    const listed = rt.listing.tools.map((tool) => ({ qualifiedName: tool.qualifiedName, hash: tool.candidateHash, toolName: tool.toolName }));
    const pins = pinsAfterReview(server.pinnedTools, listed, this.clock());
    server.pinnedTools = pins;
    const delta = diffPins(pins, listed);
    rt.listing = { ...rt.listing, delta, removed: [] };
    this.setHealth(key, 'healthy', healthDetailOf(rt.listing), { toolsDiscovered: rt.listing.tools.length, pendingReview: false });
    this.persist();
    return ok(rt.health);
  }

  setTrustReads(key: string, value: boolean): Result<McpServerConfig, string> {
    const server = this.config.servers.find((candidate) => candidate.key === key);
    if (server === undefined) return err(`no MCP server with key ${key} is configured`);
    if (value) {
      const rt = this.runtime(key);
      const reviewed =
        Object.keys(server.pinnedTools).length > 0 && rt.listing !== undefined && !hasDelta(rt.listing.delta) && rt.health.state === 'healthy';
      if (!reviewed) return err('review the tool list before trusting reads — trust is granted only after a review');
    }
    server.trustReads = value;
    this.persist();
    return ok(cloneServer(server));
  }

  setToolEnabled(key: string, toolName: string, enabled: boolean): Result<McpServerConfig, string> {
    const server = this.config.servers.find((candidate) => candidate.key === key);
    if (server === undefined) return err(`no MCP server with key ${key} is configured`);
    if (toolName === '' || toolName.length > MCP_TOOL_NAME_MAX) return err(`a tool name is 1 to ${MCP_TOOL_NAME_MAX} characters`);
    const rt = this.runtime(key);
    // The names are known from the last listing, or from the reviewed pins. Before either exists (a server added with a
    // selection, and not connected yet), a name cannot be checked, so it is kept as given and checked on the first listing.
    const pinned = Object.keys(server.pinnedTools);
    const known: string[] | undefined =
      rt.listing !== undefined
        ? rt.listing.tools.map((tool) => tool.toolName)
        : pinned.length > 0
          ? pinned.map((qualified) => server.pinnedTools[qualified]?.toolName ?? qualified.slice(prefixOf(key).length))
          : undefined;
    if (known !== undefined && !known.includes(toolName)) return err(`no tool named '${toolName}' is listed on this server`);
    // "Absent" means every tool is enabled, and switching one off needs the full list to write the rest. Without it, wait for a connect.
    if (known === undefined && server.enabledTools === undefined) {
      return err('connect the server first — its tool list is not known yet, so a tool cannot be switched off from it');
    }
    const current = server.enabledTools ?? [...(known ?? [])];
    const next = enabled ? [...new Set([...current, toolName])] : current.filter((name) => name !== toolName);
    server.enabledTools = next.sort();
    this.persist();
    return ok(cloneServer(server));
  }

  addServer(input: AddServerInput): Result<McpServerConfig, string> {
    if (this.config.servers.length >= MCP_SERVER_LIMIT) {
      return err(`at most ${MCP_SERVER_LIMIT} MCP servers — remove one before adding another`);
    }
    const name = input.name.trim();
    if (name === '' || name.length > MCP_NAME_MAX) return err(`the name must be 1 to ${MCP_NAME_MAX} characters`);
    const url = checkServerUrl(input.url);
    if (!url.ok) return err(url.reason);
    if (this.config.servers.some((server) => server.url === url.url)) return err('a server with this URL is already connected');
    const authProblem = bearerProblem(input.auth);
    if (authProblem !== undefined) return err(authProblem);
    const selection = input.enabledTools === undefined ? undefined : toolNameList(input.enabledTools);
    if (selection === 'invalid') return err('the tool selection must be a list of tool names');
    const key = this.newKey(new Set(this.config.servers.map((server) => server.key)));
    const server: McpServerConfig = {
      key,
      name,
      transport: 'http',
      url: url.url,
      auth: { ...input.auth },
      enabled: true,
      trustReads: false,
      pinnedTools: {},
      addedAt: this.clock(),
    };
    if (selection !== undefined) server.enabledTools = selection;
    this.config = { ...this.config, servers: [...this.config.servers, server] };
    this.runtimes.set(key, freshRuntime(key, 'not connected this session'));
    this.persist();
    return ok(cloneServer(server));
  }

  async updateServer(key: string, patch: UpdateServerPatch): Promise<Result<McpServerConfig, string>> {
    const server = this.config.servers.find((candidate) => candidate.key === key);
    if (server === undefined) return err(`no MCP server with key ${key} is configured`);
    // Every field is checked before any is changed, so a refused edit leaves the server as it was. A
    // server that was saved with a bearer reference the loader cannot read is dropped on the next start.
    const name = patch.name === undefined ? undefined : patch.name.trim();
    if (name !== undefined && (name === '' || name.length > MCP_NAME_MAX)) {
      return err(`the name must be 1 to ${MCP_NAME_MAX} characters`);
    }
    const selection = patch.enabledTools === undefined ? undefined : toolNameList(patch.enabledTools);
    if (selection === 'invalid') return err('the tool selection must be a list of tool names');
    let address: string | undefined;
    if (patch.url !== undefined) {
      const url = checkServerUrl(patch.url);
      if (!url.ok) return err(url.reason);
      if (url.url !== server.url) {
        if (this.config.servers.some((other) => other.key !== key && other.url === url.url)) {
          return err('a server with this URL is already connected');
        }
        address = url.url;
      }
    }
    if (patch.auth !== undefined) {
      const authProblem = bearerProblem(patch.auth);
      if (authProblem !== undefined) return err(authProblem);
    }

    // The change that applies last names the reason, as it always has: address, then credentials, then the switch.
    let reason: string | undefined;
    if (name !== undefined) server.name = name;
    if (address !== undefined) {
      // A new address is a new server to the pins: whatever was reviewed belonged to the old one,
      // and so did the bearer token. It is dropped with them, so a credential is never sent to a
      // host it was not issued for; the person is asked for one for the new address.
      server.url = address;
      server.pinnedTools = {};
      server.trustReads = false;
      delete server.enabledTools;
      server.auth = { kind: 'none' };
      reason = 'the address changed — connect to review its tool list';
    }
    if (patch.auth !== undefined) {
      server.auth = { ...patch.auth };
      reason = 'the credentials changed — connect to check the tool list';
    }
    if (patch.enabled !== undefined && patch.enabled !== server.enabled) {
      server.enabled = patch.enabled;
      if (!patch.enabled) reason = 'this server is disabled — enable it in Settings › MCP & tools';
    }
    // A selection narrows what is searched and called; it never changes a pin or a trust grant, so it demotes nothing.
    if (selection !== undefined) server.enabledTools = selection;
    if (reason !== undefined) await this.demote(key, reason);
    this.persist();
    return ok(cloneServer(server));
  }

  async removeServer(key: string): Promise<void> {
    const closed = this.dropConnection(key);
    this.config = { ...this.config, servers: this.config.servers.filter((server) => server.key !== key) };
    this.runtimes.delete(key);
    this.persist();
    await closed;
  }

  /**
   * The transport step, reached only through {@link createMcpTransport}: one `tools/call`, with the 120 s limit and no
   * retry. Before it sends anything it checks what the client owns, a live connection and a listed tool with a verified
   * pin. The per-call gate (enabled state, trust, the loaded set) is `mcp.invoke`'s, and it runs before this step.
   */
  async callWire(serverKey: string, toolName: string, args: Record<string, unknown>, options: { readonly signal?: AbortSignal } = {}): Promise<McpToolResult> {
    const server = this.config.servers.find((candidate) => candidate.key === serverKey);
    const rt = this.runtimes.get(serverKey);
    if (server === undefined || rt === undefined) throw new McpFailure({ code: 'unreachable', message: unreachableText(serverKey) });
    const wire = rt.wire;
    if (wire === undefined) throw new McpFailure({ code: 'unreachable', message: unreachableText(server.name) });
    const tool = this.describe(serverKey, toolName);
    if (tool === undefined || tool.pinState !== 'verified') throw new McpFailure({ code: 'pin_mismatch', message: PIN_MISMATCH_TEXT });
    let result: WireCallResult;
    try {
      // The server receives the name it advertised, even when the caller named the tool by its alias (extensibility §3.3).
      result = await wire.callTool(tool.toolName, args, {
        timeoutMs: this.callTimeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      const failure = asWireError(error);
      if (failure.kind === 'network' || failure.kind === 'cors' || failure.kind === 'auth') {
        await this.demote(serverKey, listFailureDetail(failure, this.listTimeoutMs));
      }
      throw new McpFailure(mapCallFailure(failure, server.name, toolName, this.callTimeoutMs));
    }
    return { content: [...result.content], isError: result.isError === true };
  }

  // -- connection and listing ------------------------------------------------

  private runtime(key: string): ServerRuntime {
    let rt = this.runtimes.get(key);
    if (rt === undefined) {
      rt = freshRuntime(key, 'not connected this session');
      this.runtimes.set(key, rt);
    }
    return rt;
  }

  private list(key: string): Promise<McpServerHealth> {
    const rt = this.runtime(key);
    if (rt.pending !== undefined) return rt.pending;
    const pending = this.listNow(key);
    rt.pending = pending;
    return pending.finally(() => {
      if (rt.pending === pending) rt.pending = undefined;
    });
  }

  /**
   * A listing that starts after this request. A listing already in flight may have begun before it (a call validated behind a
   * write-confirm, while the server changed), so it is not joined: this waits for that listing to settle and lists again. The
   * cleanup `list` attaches to the in-flight promise runs first, so the new listing is never handed the old one.
   */
  private listAfter(key: string): Promise<McpServerHealth> {
    const rt = this.runtime(key);
    const pending = rt.pending;
    if (pending === undefined) return this.list(key);
    // A teardown while the request waits (a disconnect, a removal, the master switch) ends the request too: the server is not listed again
    // behind the person's back, and the health the teardown wrote is what the caller gets.
    const generation = rt.generation;
    const again = (): Promise<McpServerHealth> => (rt.generation === generation ? this.list(key) : Promise.resolve(rt.health));
    return pending.then(again, again);
  }

  private async listNow(key: string): Promise<McpServerHealth> {
    const server = this.config.servers.find((candidate) => candidate.key === key);
    if (server === undefined) return this.runtime(key).health;
    const rt = this.runtime(key);
    // Each await below can be overtaken by a teardown (a disconnect, a removal, the master switch, a failed
    // call, an edit). The teardown has already written the state, so a listing that returns after one writes nothing.
    const generation = rt.generation;
    const overtaken = (): boolean => rt.generation !== generation;
    if (server.auth.kind === 'bearer') {
      const token = await this.resolveToken(server.auth.tokenRef).catch(() => undefined);
      if (overtaken()) return rt.health;
      if (token === undefined || token === '') {
        return this.demote(key, 'the bearer token is missing — enter it in the server card');
      }
    }
    // A wire that cannot be built, or a listing that the client cannot read, is a named `configured`
    // state like any other failure. It is never a rejected promise: the settings card has to render it.
    let tools: readonly WireTool[];
    try {
      const wire = rt.wire ?? this.factory(server, this.deps());
      rt.wire = wire;
      tools = await wire.listTools({ timeoutMs: this.listTimeoutMs });
    } catch (error) {
      if (overtaken()) return rt.health;
      return this.demote(key, listFailureDetail(asWireError(error), this.listTimeoutMs));
    }
    if (overtaken()) return rt.health;
    const previousKey = rt.listing?.listedKey;
    let listing: Listing;
    try {
      listing = await this.buildListing(server, tools);
    } catch (error) {
      if (overtaken()) return rt.health;
      return this.demote(key, `the server's tool list could not be read: ${asWireError(error).message}`);
    }
    if (overtaken()) return rt.health;
    rt.listing = listing;
    const reviewPending = hasDelta(listing.delta);
    const health = this.setHealth(key, reviewPending ? 'connected' : 'healthy', healthDetailOf(listing), {
      toolsDiscovered: listing.tools.length,
      pendingReview: reviewPending,
    });
    if (previousKey !== undefined && previousKey !== listing.listedKey) {
      for (const listener of this.listChangeListeners) listener(key);
    }
    return health;
  }

  private async buildListing(server: McpServerConfig, tools: readonly WireTool[]): Promise<Listing> {
    const seen = new Set<string>();
    const listed: ListedTool[] = [];
    const ordered = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Each tool's name for the model: its own, or an alias the model's rule takes (alias.ts). The server still gets its own name in
    // tools/call (callWire), so a tool with a dot in its name is shown to the model, and called as the server advertised it.
    const aliases = await modelSafeAliases(ordered.map((tool) => tool.name), QUALIFIED_NAME_MAX - prefixOf(server.key).length);
    for (const tool of ordered) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      const description = tool.description ?? '';
      const inputSchema = tool.inputSchema ?? { type: 'object' };
      const qualifiedName = qualifiedNameOf(server.key, aliases.get(tool.name) ?? tool.name);
      listed.push({
        toolName: tool.name,
        qualifiedName,
        description,
        inputSchema,
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        candidateHash: await pinHash({ toolName: tool.name, description, inputSchema, ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }) }),
        usable: USABLE_NAME.test(qualifiedName),
      });
    }
    const pins = listed.map((tool) => ({ qualifiedName: tool.qualifiedName, hash: tool.candidateHash }));
    const names = new Set(pins.map((pin) => pin.qualifiedName));
    const removed = Object.keys(server.pinnedTools).filter((name) => !names.has(name)).sort();
    return {
      tools: listed,
      delta: diffPins(server.pinnedTools, pins),
      removed,
      fingerprint: await listingFingerprint(pins, removed),
      listedKey: canonicalJson(pins.map((pin) => [pin.qualifiedName, pin.hash])),
    };
  }

  private descriptorOf(server: McpServerConfig, tool: ListedTool, health: McpServerHealth): ExternalToolDescriptor {
    const pinState = pinStateOf(server.pinnedTools, tool.qualifiedName, tool.candidateHash);
    const pin = pinOf(server, tool.qualifiedName);
    const effectiveRisk = effectiveRiskOf({
      pinVerified: pinState === 'verified',
      // A server with no live connection has no reviewed listing to trust, so its tools stay confirm-only (§3.4).
      pendingReview: health.pendingReview === true || health.state === 'configured',
      trustReads: server.trustReads,
      ...(tool.annotations?.readOnlyHint === undefined ? {} : { readOnlyHint: tool.annotations.readOnlyHint }),
    });
    return {
      qualifiedName: tool.qualifiedName,
      serverKey: server.key,
      serverName: server.name,
      toolName: tool.toolName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      candidateHash: tool.candidateHash,
      ...(pin === undefined ? {} : { pin }),
      pinState,
      enabled: isEnabledTool(server, tool.toolName),
      effectiveRisk,
      deferred: true,
    };
  }

  /**
   * Ends the connection and everything it implied, synchronously. The generation moves on, so a listing still in
   * flight writes nothing when it returns; a pending listing is dropped; the last listing is forgotten, since it
   * belongs to a connection that no longer exists; and the wire is detached. The promise settles when the old
   * transport has closed. Callers write their state between this call and that await, so no read can see tools the
   * connection no longer backs.
   */
  private dropConnection(key: string): Promise<void> {
    const rt = this.runtimes.get(key);
    if (rt === undefined) return Promise.resolve();
    rt.generation += 1;
    rt.pending = undefined;
    rt.listing = undefined;
    const wire = rt.wire;
    rt.wire = undefined;
    return wire === undefined ? Promise.resolve() : wire.close().catch(() => undefined);
  }

  /** Demotes a server to `configured` with the reason, after its connection has been ended (see {@link dropConnection}). */
  private async demote(key: string, detail: string): Promise<McpServerHealth> {
    const closed = this.dropConnection(key);
    const health = this.setHealth(key, 'configured', detail);
    await closed;
    return health;
  }

  private setHealth(key: string, state: HealthState, detail?: string, extra: { toolsDiscovered?: number; pendingReview?: boolean } = {}): McpServerHealth {
    const rt = this.runtime(key);
    const next: McpServerHealth = {
      key,
      state,
      ...(detail === undefined ? {} : { detail }),
      ...(extra.toolsDiscovered === undefined ? {} : { toolsDiscovered: extra.toolsDiscovered }),
      ...(extra.pendingReview === undefined ? {} : { pendingReview: extra.pendingReview }),
    };
    if (canonicalJson(next) !== canonicalJson(rt.health)) {
      rt.health = next;
      for (const listener of this.healthListeners) listener(next);
    }
    return rt.health;
  }

  private deps(): WireDeps {
    return { resolveBearer: this.resolveToken, fetch: this.fetchImpl, probe: this.probe };
  }

  private persist(): void {
    this.onChange?.(this.settings());
  }
}

/** Builds the client. The app holds one for the session and reads snapshots from it. */
export function createMcpClient(options: McpClientOptions): McpClient {
  return new McpClientImpl(options);
}

/**
 * The transport of a client this module made, for `mcp.invoke` at composition. Any other object is refused, so a
 * call always goes to the wire that holds the pins for its server.
 */
export function createMcpTransport(client: McpClient): McpTransport {
  if (!(client instanceof McpClientImpl)) throw new TypeError('createMcpTransport takes a client made by createMcpClient');
  return {
    callTool: (serverKey, toolName, args, options) => client.callWire(serverKey, toolName, args, options),
    relist: (serverKey) => client.refresh(serverKey),
  };
}

function freshRuntime(key: string, detail: string): ServerRuntime {
  return {
    health: { key, state: 'configured', detail },
    wire: undefined,
    listing: undefined,
    pending: undefined,
    generation: 0,
  };
}

/** The bearer check every write path shares: the reference names something, and no more than the loader accepts. */
function bearerProblem(auth: McpAuth): string | undefined {
  if (auth.kind !== 'bearer') return undefined;
  if (auth.tokenRef === '') return 'the bearer token reference is missing';
  if (auth.tokenRef.length > MCP_TOKEN_REF_MAX) return `the bearer token reference is longer than ${MCP_TOKEN_REF_MAX} characters`;
  return undefined;
}

function cloneServer(server: McpServerConfig): McpServerConfig {
  const copy: McpServerConfig = { ...server, auth: { ...server.auth }, pinnedTools: { ...server.pinnedTools } };
  if (server.enabledTools !== undefined) copy.enabledTools = [...server.enabledTools];
  else delete copy.enabledTools;
  return copy;
}

function pinOf(server: McpServerConfig, qualifiedName: string): ToolPin | undefined {
  return Object.prototype.hasOwnProperty.call(server.pinnedTools, qualifiedName) ? server.pinnedTools[qualifiedName] : undefined;
}

/** A tool is enabled when no list narrows the set, or when its name is on the list (§8). */
function isEnabledTool(server: McpServerConfig, toolName: string): boolean {
  return server.enabledTools === undefined || server.enabledTools.includes(toolName);
}

/**
 * The health detail a listing earns: the change to review, and each tool the model cannot be given a name for. Exported for the
 * tests, which give it a listing with a tool that is not usable: every alias the client makes is usable, so no live server reaches
 * that branch, and a test of it has to build the listing itself.
 */
export function healthDetailOf(listing: { readonly delta: PinDelta; readonly tools: readonly { readonly toolName: string; readonly usable: boolean }[] }): string | undefined {
  const parts: string[] = [];
  if (listing.delta.firstConnect) {
    parts.push('first connect — review the tool list in Settings › MCP & tools before its tools can be searched or called');
  } else if (hasDelta(listing.delta)) {
    parts.push(
      `tool list changed since review: ${listing.delta.added.length} added, ${listing.delta.changed.length} changed, ${listing.delta.removed.length} removed — review the change in Settings › MCP & tools`,
    );
  }
  // A tool the model cannot be given is hidden from search and calls, and the detail names it, so a server that reads healthy
  // does not hide a tool without saying which one (extensibility §3.2: healthy means its tools are in the search index).
  const hidden = listing.tools.filter((tool) => !tool.usable);
  if (hidden.length > 0) {
    const names = hidden.slice(0, 3).map((tool) => `"${tool.toolName}"`).join(', ');
    const more = hidden.length > 3 ? ` and ${hidden.length - 3} more` : '';
    parts.push(
      `${hidden.length === 1 ? 'one tool is' : `${hidden.length} tools are`} hidden from search and calls, because the model cannot be given ${hidden.length === 1 ? 'its name' : 'their names'}: ${names}${more}`,
    );
  }
  return parts.length === 0 ? undefined : parts.join('; ');
}

/** The health detail for a failed listing, with the named corrective path. */
function listFailureDetail(failure: WireError, listTimeoutMs: number): string {
  switch (failure.kind) {
    case 'cors':
      return CORS_REFUSAL;
    case 'network':
      return 'server unreachable: no response from the host — check the URL in Settings › MCP & tools';
    case 'timeout':
      return `tools/list timed out after ${Math.round(listTimeoutMs) / 1000} s`;
    case 'abort':
      return 'the connection was aborted';
    case 'auth':
      return failure.status === 403
        ? 'the server refused the bearer token (HTTP 403) — re-enter it in the server card'
        : 'the server rejected the bearer token (HTTP 401) — re-enter it in the server card';
    case 'http':
      return failure.status === 404
        ? 'no MCP endpoint at this URL (HTTP 404) — check the URL in Settings › MCP & tools'
        : `the server answered HTTP ${failure.status ?? 'error'} to tools/list`;
    case 'protocol':
      return `the server returned an error to tools/list: ${failure.message}`;
    case 'result':
      return 'the server sent a tool list Caotang cannot read';
    case 'revision':
      return revisionDetail(failure);
  }
}

/**
 * The refusal, with the revision the server named. The fix is the server's version, so the person is told which one it
 * has. A server that named none gets the refusal alone.
 */
function revisionDetail(failure: WireError): string {
  if (failure.answeredRevision !== undefined) return `${REVISION_REFUSAL}. The server answered with protocol version ${failure.answeredRevision}.`;
  if (failure.supportedRevisions.length > 0) return `${REVISION_REFUSAL}. The server supports protocol versions ${failure.supportedRevisions.join(', ')}.`;
  return REVISION_REFUSAL;
}

function mapCallFailure(failure: WireError, serverName: string, toolName: string, timeoutMs: number): McpError {
  switch (failure.kind) {
    case 'network':
    case 'cors':
      return { code: 'unreachable', message: unreachableText(serverName) };
    case 'timeout':
    case 'abort':
      return { code: 'timeout', message: timeoutText(timeoutMs) };
    case 'auth':
      return { code: 'server_error', message: serverErrorText(serverName, toolName, 'it rejected the bearer token — re-enter it in the server card') };
    case 'http':
      if (failure.status === 404) return { code: 'unreachable', message: unreachableText(serverName) };
      return { code: 'server_error', message: serverErrorText(serverName, toolName, `it answered HTTP ${failure.status ?? 'error'}`) };
    case 'protocol':
    case 'result':
      return { code: 'server_error', message: serverErrorText(serverName, toolName, failure.message) };
    case 'revision':
      return { code: 'server_error', message: serverErrorText(serverName, toolName, revisionDetail(failure)) };
  }
}

function asWireError(error: unknown): WireError {
  if (error instanceof WireError) return error;
  return new WireError('protocol', error instanceof Error ? error.message : String(error));
}
