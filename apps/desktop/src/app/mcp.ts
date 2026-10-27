/**
 * The app's MCP client: one `McpClient` for the session, persisted through the app settings, with the bearer tokens in the
 * provider key vault (extensibility §3.1, §3.6, §8; ui-modules §5.2).
 *
 * What lives here, and why it is not in `@caotang/mcp-client`:
 * - **Persistence.** The client reports every change to the whole slice (`onChange`), and this file writes that slice into the
 *   app settings. The client never touches storage.
 * - **Tokens.** A bearer token is sealed by the same vault that holds provider keys (AES-GCM, provider-gateway §7), under a
 *   reference of its own (`mcp:…`). The settings record names the reference, never the token.
 * - **Imported tool selections.** An import may carry the tools a person kept enabled. The client takes the selection with the
 *   server (`addServer`'s `enabledTools`) and keeps it on the stored record, so a reload before the first connect keeps it, and
 *   the first connect applies it: a tool the selection does not name is disabled from then on. Known limit: the names in a
 *   selection are not checked against the server's tool list until that connect, so a name the server never lists does nothing.
 * - **Dev fixture.** `fixtureWireFactory` answers the servers a development page names in `__caotangMcpFixture`, instead of the
 *   network. The end-to-end suite uses it; the app calls it only in a development build (App.tsx).
 */

import {
  createMcpClient,
  createMockWire,
  createStreamableHttpWire,
  exportServers,
  parseServerImport,
  WireError,
  type ImportRefusal,
  type McpAuth,
  type McpClient,
  type McpServerConfig,
  type McpServerHealth,
  type McpSettings,
  type WireFactory,
  type WirePrompt,
  type WireProgress,
  type WireResource,
  type WireResourceTemplate,
  type WireTool,
} from '@caotang/mcp-client';

/** The reference prefix a bearer token is stored under in the key vault. The vault binds it as additional data. */
export const BEARER_REF_PREFIX = 'mcp:';

/** What the MCP app needs from the settings store: the slice as it stands, and a write of the whole slice. */
export interface McpSettingsPort {
  current(): McpSettings;
  update(patch: { readonly mcp: McpSettings }): Promise<string | null>;
}

/** The part of the key store the MCP client uses: a token is put, read, checked and removed under its reference. */
export interface McpKeyPort {
  put(ref: string, token: string): Promise<void>;
  reveal(ref: string): Promise<string | undefined>;
  has(ref: string): Promise<boolean>;
  remove(ref: string): Promise<void>;
}

export interface McpAppOptions {
  readonly settings: McpSettingsPort;
  readonly keys: McpKeyPort;
  /** The transport. Absent in a shipped build, where the SDK's Streamable HTTP wire is used. */
  readonly wire?: WireFactory;
}

/** What the add form may ask for: a name, a URL, and either no credentials or a token the form holds for one moment. */
export type AddServerInput = { readonly name: string; readonly url: string; readonly token?: string };

export type AddServerOutcome = { readonly ok: true; readonly server: McpServerConfig } | { readonly ok: false; readonly message: string };

export interface ImportOutcome {
  readonly added: readonly string[];
  readonly refused: readonly ImportRefusal[];
}

export class McpApp {
  readonly client: McpClient;
  private readonly keys: McpKeyPort;
  private readonly settings: McpSettingsPort;

  constructor(options: McpAppOptions) {
    this.keys = options.keys;
    this.settings = options.settings;
    this.client = createMcpClient({
      settings: options.settings.current(),
      ...(options.wire === undefined ? {} : { wire: options.wire }),
      resolveBearer: (ref) => options.keys.reveal(ref),
      onChange: (mcp) => {
        void this.settings.update({ mcp });
      },
      // A credential that a change dropped is taken out of the vault: the settings no longer name
      // it, and a token that nothing names is a token that is kept for ever. The removal is
      // awaited, like the removals below it: a vault that cannot be written is then the caller's
      // to see, and not a rejection that vanishes and leaves the sealed token behind.
      onTokenDropped: (ref) => options.keys.remove(ref),
    });
  }

  /** Connects one server: the one explicit action that makes its tools searchable (extensibility §4 rule 1). */
  connect(key: string): Promise<McpServerHealth> {
    return this.client.connect(key);
  }

  /** Checks the server again: lists its tools and compares them with the reviewed pins. */
  refresh(key: string): Promise<McpServerHealth> {
    return this.client.refresh(key);
  }

  /**
   * Adds a server. A bearer token is sealed first, under a reference made for it, and the reference is what the server
   * stores. If the server is refused, the token is taken back out of the vault, so nothing is left behind.
   */
  async addServer(input: AddServerInput): Promise<AddServerOutcome> {
    const token = input.token?.trim() ?? '';
    const ref = token === '' ? undefined : `${BEARER_REF_PREFIX}${randomRef()}`;
    if (ref !== undefined) await this.keys.put(ref, token);
    const auth: McpAuth = ref === undefined ? { kind: 'none' } : { kind: 'bearer', tokenRef: ref };
    const result = this.client.addServer({ name: input.name, url: input.url, auth });
    if (!result.ok) {
      if (ref !== undefined) await this.keys.remove(ref);
      return { ok: false, message: result.error };
    }
    return { ok: true, server: result.value };
  }

  /** Replaces a server's bearer token. The reference stays the same; the server must connect again to check the tool list. */
  async setToken(key: string, token: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const server = this.client.serverFor(key);
    if (server === undefined) return { ok: false, message: `no MCP server with key ${key} is configured` };
    const trimmed = token.trim();
    if (trimmed === '') return { ok: false, message: 'the token is empty — enter the token the server gave you' };
    const ref = server.auth.kind === 'bearer' ? server.auth.tokenRef : `${BEARER_REF_PREFIX}${randomRef()}`;
    await this.keys.put(ref, trimmed);
    const updated = await this.client.updateServer(key, { auth: { kind: 'bearer', tokenRef: ref } });
    return updated.ok ? { ok: true } : { ok: false, message: updated.error };
  }

  /** Removes a server, its tools and its token. The client hands the token back when the server is gone. */
  async removeServer(key: string): Promise<void> {
    await this.client.removeServer(key);
  }

  /** Whether a server's bearer token is in the vault. A server with no bearer auth never needs one, so it reports true. */
  async tokenPresent(key: string): Promise<boolean> {
    const server = this.client.serverFor(key);
    if (server === undefined || server.auth.kind !== 'bearer') return true;
    return this.keys.has(server.auth.tokenRef);
  }

  /**
   * Adds the servers an import names. Each refused entry is kept with its name and reason; the others are added. An import
   * never carries a key, a pin or a trust grant (config.ts), so every server it adds starts unreviewed.
   */
  importServers(text: string, now: string): ImportOutcome {
    const existing = this.client.settings().servers;
    const parsed = parseServerImport(text, { existing, now, newKey: () => '' });
    const added: string[] = [];
    const refused: ImportRefusal[] = [...parsed.refused];
    for (const server of parsed.servers) {
      const result = this.client.addServer({
        name: server.name,
        url: server.url,
        auth: { kind: 'none' },
        ...(server.enabledTools === undefined ? {} : { enabledTools: server.enabledTools }),
      });
      if (!result.ok) {
        refused.push({ entry: `"${server.name}"`, reason: result.error });
        continue;
      }
      added.push(server.name);
      if (!server.enabled) void this.client.updateServer(result.value.key, { enabled: false });
    }
    return { added, refused };
  }

  /** The shareable text of the server list: names, URLs, auth kind and enabled tools. Never a key, a token or a pin. */
  exportText(): string {
    return exportServers(this.client.settings().servers);
  }
}

function randomRef(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A fixture a development page may install to answer a server without a network (see the module note). */
interface FixtureServer {
  readonly tools: readonly WireTool[];
  readonly content?: readonly unknown[];
  /** What the server lists beyond tools. A fixture with none of these advertises none. */
  readonly resources?: readonly WireResource[];
  readonly templates?: readonly WireResourceTemplate[];
  readonly prompts?: readonly WirePrompt[];
  /** When set, listing resources fails with this reason, and the tools stay listed. */
  readonly resourcesError?: string;
  /**
   * A tool whose call takes time: it reports each of `progress` (300 ms apart), then answers with `content`, or, with `hold`, stays running until the
   * caller stops it. `globalThis.__caotangMcpFixtureCancelled` counts the calls that ended without an answer.
   */
  readonly slow?: { readonly tool: string; readonly progress?: readonly WireProgress[]; readonly hold?: boolean };
}

/**
 * The transport a development page's fixture asks for: the fixture's scripted server for each URL it names, and the SDK's wire
 * for every other. The scripted server reads its tool list on every listing, so a test changes what the server lists by
 * changing the fixture's `tools`. Returns `undefined` when no fixture is installed. App.tsx calls this only in a development
 * build, so a production bundle never reads the fixture.
 */
export function fixtureWireFactory(): WireFactory | undefined {
  const fixtures = (globalThis as { __caotangMcpFixture?: Readonly<Record<string, FixtureServer>> }).__caotangMcpFixture;
  if (fixtures === undefined) return undefined;
  return (server, deps) => {
    const fixture = Object.prototype.hasOwnProperty.call(fixtures, server.url) ? fixtures[server.url] : undefined;
    if (fixture === undefined) return createStreamableHttpWire(server, deps);
    return createMockWire({
      get listTools() {
        return [...fixture.tools];
      },
      get resources() {
        return fixture.resources === undefined ? undefined : [...fixture.resources];
      },
      get templates() {
        return fixture.templates === undefined ? undefined : [...fixture.templates];
      },
      get prompts() {
        return fixture.prompts === undefined ? undefined : [...fixture.prompts];
      },
      ...(fixture.resourcesError === undefined
        ? {}
        : {
            fail: (phase: string) => {
              if (phase === 'resources') throw new WireError('protocol', fixture.resourcesError ?? '');
            },
          }),
      respond: () => ({ content: [...(fixture.content ?? [])], isError: false }),
      run: (tool, _args, call) => {
        const slow = fixture.slow;
        if (slow === undefined || slow.tool !== tool) return undefined;
        return (async () => {
          try {
            for (const report of slow.progress ?? []) {
              await call.wait(300);
              call.progress(report);
            }
            if (slow.hold === true) await call.wait(60 * 60 * 1000);
          } catch (error) {
            const counter = globalThis as { __caotangMcpFixtureCancelled?: number };
            counter.__caotangMcpFixtureCancelled = (counter.__caotangMcpFixtureCancelled ?? 0) + 1;
            throw error;
          }
          return { content: [...(fixture.content ?? [])], isError: false };
        })();
      },
    });
  };
}
