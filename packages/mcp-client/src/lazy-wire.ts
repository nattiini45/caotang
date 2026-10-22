/**
 * The default wire, loaded on first use — [extensibility.md §3.3](../../../docs/architecture/extensibility.md).
 *
 * The MCP SDK is about 200 kB and only a writer who connected a server needs it, so `wire.ts` (the one
 * file that imports it) is a dynamic import made here, on the first listing or call. The synchronous
 * {@link WireFactory} type survives: the factory returns a proxy at once, and the proxy loads the real
 * wire behind its first operation. A project with no server never reaches the factory, and a server
 * that is off never reaches the wire.
 *
 * The egress check on the server's own URL runs before the code is fetched, so a URL that is outside
 * the allowlist is refused without a chunk load and without a request. A failed load is a
 * {@link WireLoadError}, a `network` failure the client already knows how to show, and it is not
 * remembered: the next operation tries the load again.
 */

import { egressAllowed } from './egress.js';
import type { McpServerConfig } from './config.js';
import { WireError, WireLoadError } from './wire-error.js';
import type {
  McpWire,
  WireCallResult,
  WireCapabilities,
  WireCompletionRef,
  WireDeps,
  WireFactory,
  WireOptions,
  WirePrompt,
  WirePromptResult,
  WireResourceContents,
  WireResourceListing,
  WireTool,
} from './wire.js';

/** How the real wire's code is fetched. Tests replace it. */
export type WireLoader = () => Promise<{ readonly createSdkWire: WireFactory }>;

const loadSdkWire: WireLoader = () => import('./wire.js');

class LazyWire implements McpWire {
  private inner: Promise<McpWire> | undefined;

  constructor(
    private readonly server: McpServerConfig,
    private readonly deps: WireDeps,
    private readonly load: WireLoader,
  ) {}

  async listTools(options: WireOptions): Promise<readonly WireTool[]> {
    return (await this.wire()).listTools(options);
  }

  async callTool(name: string, args: Record<string, unknown>, options: WireOptions): Promise<WireCallResult> {
    return (await this.wire()).callTool(name, args, options);
  }

  async capabilities(options: WireOptions): Promise<WireCapabilities> {
    return (await this.wire()).capabilities(options);
  }

  async listResources(options: WireOptions): Promise<WireResourceListing> {
    return (await this.wire()).listResources(options);
  }

  async readResource(uri: string, options: WireOptions): Promise<readonly WireResourceContents[]> {
    return (await this.wire()).readResource(uri, options);
  }

  async listPrompts(options: WireOptions): Promise<readonly WirePrompt[]> {
    return (await this.wire()).listPrompts(options);
  }

  async getPrompt(name: string, args: Record<string, string>, options: WireOptions): Promise<WirePromptResult> {
    return (await this.wire()).getPrompt(name, args, options);
  }

  async complete(ref: WireCompletionRef, argument: { readonly name: string; readonly value: string }, options: WireOptions): Promise<readonly string[]> {
    const wire = await this.wire();
    if (wire.complete === undefined) throw new WireError('protocol', 'this connection cannot ask for completions');
    return wire.complete(ref, argument, options);
  }

  async close(): Promise<void> {
    // A wire that was never used has nothing open, and closing it must not fetch the SDK to find that out.
    const inner = this.inner;
    if (inner === undefined) return;
    const wire = await inner.catch(() => undefined);
    if (wire !== undefined) await wire.close();
  }

  private wire(): Promise<McpWire> {
    if (this.inner !== undefined) return this.inner;
    if (!egressAllowed(this.server.url, { providerEndpoints: [], mcpServerUrls: [this.server.url] })) {
      return Promise.reject(new WireError('network', `request to ${this.server.url} is outside the connected server`));
    }
    const loading = this.load().then(
      (module) => module.createSdkWire(this.server, this.deps),
      (error: unknown) => {
        this.inner = undefined;
        throw new WireLoadError(error);
      },
    );
    this.inner = loading;
    return loading;
  }
}

/** A wire that loads `load()` on first use. Exported for tests; the app uses {@link createStreamableHttpWire}. */
export function createLazyWire(server: McpServerConfig, deps: WireDeps, load: WireLoader): McpWire {
  return new LazyWire(server, deps, load);
}

/** The default wire: the SDK's Streamable HTTP wire, fetched on first use. */
export const createStreamableHttpWire: WireFactory = (server, deps) => new LazyWire(server, deps, loadSdkWire);
