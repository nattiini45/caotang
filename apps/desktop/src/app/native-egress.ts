/**
 * Provider and MCP calls from the desktop app: the page's side of the main process's port
 * ([desktop.md](../../../docs/architecture/desktop.md#native-provider-and-mcp-calls-405)).
 *
 * Nothing here decides what a call may reach — the main process does, from the origins this module publishes before each
 * call. The page's part is to notice when it is running in the shell, to say which addresses the app is configured for,
 * and to turn one response into the `Response` the gateway already reads: a stream, its status, its headers.
 *
 * **A server on this computer is a local entry.** A provider profile whose address is a loopback literal, and a local MCP
 * server, reach the port as `local` entries, because that is where a key held by the keychain most often is and the page can
 * never read one: the main process attaches the secret, and the browser's Local Network Access prompt and its advice about a
 * server that refuses the page belong to the browser build alone. The port still refuses plain http to any other address, and
 * anything whose origin this app is not configured for keeps the browser's path, so a call that worked in the browser works.
 */

import { isLocalBase, isLoopbackHost, nativeEgressTargets, originOf } from '@caotang/gateway';
import type { FetchLike, NativeEgressTarget, ProfileView } from '@caotang/gateway';
import type { McpSettings } from '@caotang/mcp-client';

import type { EgressError, EgressReply, NativeEgressBridge } from '../../../desktop-shell/src/egress-contract.cjs';

/** The bridge, when this page is running in the desktop shell. */
function bridge(): NativeEgressBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const desktop = window.caotangDesktop;
  return desktop !== undefined && desktop.version >= 4 ? desktop.net : undefined;
}

/** Whether provider and MCP calls are made by the main process here. The interface says so where it matters. */
export function nativeEgressAvailable(): boolean {
  return bridge() !== undefined;
}

export interface DesktopEgress {
  /** Hand to the gateway and to the MCP client in place of the page's own `fetch`. */
  readonly fetch: FetchLike;
  /**
   * Where the addresses the app is configured for come from, and which key may go to each. Read before every call, so a
   * profile or server added a moment ago is reachable on its first request instead of being reported as refused.
   */
  points(source: () => readonly NativeEgressTarget[]): void;
}

interface Sink {
  push(bytes: Uint8Array): void;
  end(error?: Exclude<EgressError, 'invalid' | 'denied'>): void;
}

/** What a refusal or a broken call looks like to the gateway: a fetch that did not deliver a response. */
function unreachable(error: EgressError): Error {
  switch (error) {
    case 'aborted':
      return new DOMException('The request was stopped.', 'AbortError');
    case 'invalid':
      return new TypeError('Caotang for desktop could not make this request: its shape was refused.');
    case 'denied':
      return new TypeError('Caotang for desktop does not connect to this address. Add the provider in Settings first.');
    case 'too-large':
      return new TypeError('The request or its answer was larger than Caotang for desktop carries.');
    case 'unavailable':
      return new TypeError('Failed to fetch');
  }
}

/** The port as this page sees it, or undefined when the page is running in a browser. */
export function desktopEgress(): DesktopEgress | undefined {
  const api = bridge();
  if (api === undefined) return undefined;

  const sinks = new Map<string, Sink>();
  api.onChunk(({ id, bytes }) => sinks.get(id)?.push(bytes));
  api.onEnd(({ id, error }) => {
    const sink = sinks.get(id);
    sinks.delete(id);
    sink?.end(error);
  });

  let source: (() => readonly NativeEgressTarget[]) | undefined;
  let published: readonly NativeEgressTarget[] = [];
  let publishedOrigins: ReadonlySet<string> = new Set();
  let publishing: Promise<ReadonlySet<string>> | undefined;

  /** Publishes the addresses the app is configured for, and answers the set the call is judged against. */
  const publish = (): Promise<ReadonlySet<string>> => {
    publishing ??= (async () => {
      const next = source === undefined ? [] : [...source()];
      if (JSON.stringify(next) !== JSON.stringify(published)) {
        const reply = await api.configure(next);
        // A refused configuration leaves the previous set in force, which is narrower or equal: a page then reaches what
        // it reached before rather than everything.
        if (reply.ok) {
          published = next;
          publishedOrigins = new Set(nativeEgressTargets(next).keys());
        }
      }
      return publishedOrigins;
    })().finally(() => { publishing = undefined; });
    return publishing;
  };

  const fetch: FetchLike = async (url, init) => {
    const reachable = await publish();
    const target = new URL(url);
    // An address the app is not configured for — a server on another machine that was never added, say — keeps the browser's
    // path, with its own advice, exactly as it is in a page.
    if (!reachable.has(target.origin)) return globalThis.fetch(url, init);
    return throughPort(api, sinks, target, init);
  };

  return { fetch, points: (from) => { source = from; } };
}

/** One call through the main process: its head from the reply, its body from the chunks that follow it. */
async function throughPort(api: NativeEgressBridge, sinks: Map<string, Sink>, target: URL, init: RequestInit): Promise<Response> {
  // A call whose signal is already aborted was stopped before it started: nothing goes to the main process, because a request
  // that arrives is a request that was made, and one the writer cancelled must not reach a provider at all.
  if (init.signal?.aborted === true) throw unreachable('aborted');
  const id = crypto.randomUUID();
  const body = typeof init.body === 'string' ? init.body : undefined;
  // The gateway sends JSON text and the MCP client sends JSON text or nothing: a stream or a buffer is not a shape the
  // port carries, and it would arrive at the provider as an empty body.
  if (init.body !== undefined && body === undefined) throw unreachable('invalid');
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => { headers[name] = value; });

  const onAbort = (): void => { void api.abort(id); };
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller;
      let ended = false;
      sinks.set(id, {
        push(bytes) { if (!ended) controller.enqueue(bytes); },
        end(error) {
          ended = true;
          init.signal?.removeEventListener('abort', onAbort);
          if (error === undefined) controller.close();
          else controller.error(unreachable(error));
        },
      });
    },
    cancel() { void api.abort(id); },
  });

  init.signal?.addEventListener('abort', onAbort, { once: true });

  let reply: EgressReply<{ readonly status: number; readonly statusText: string; readonly headers: Readonly<Record<string, string>> }>;
  try {
    reply = await api.start({ id, url: target.href, method: (init.method ?? 'GET').toUpperCase(), headers, ...(body === undefined ? {} : { body }) });
  } catch (error) {
    sinks.delete(id);
    init.signal?.removeEventListener('abort', onAbort);
    control?.error(error);
    throw unreachable('unavailable');
  }
  if (!reply.ok) {
    sinks.delete(id);
    init.signal?.removeEventListener('abort', onAbort);
    const failure = unreachable(reply.error);
    control?.error(failure);
    throw failure;
  }

  // A head with no body — 204, 205 and 304 — refuses a stream, and handing one over would turn a complete answer into a failed
  // call. The call is closed instead, and the answer is what the status and headers say it is.
  if (reply.value.status === 204 || reply.value.status === 205 || reply.value.status === 304) {
    sinks.delete(id);
    init.signal?.removeEventListener('abort', onAbort);
    void stream.cancel().catch(() => undefined);
    return new Response(null, { status: reply.value.status, statusText: reply.value.statusText, headers: reply.value.headers });
  }

  return new Response(stream, { status: reply.value.status, statusText: reply.value.statusText, headers: reply.value.headers });
}

/**
 * The addresses the desktop port may reach, and the key each may carry: a provider profile's origin with that profile's key,
 * and a connected MCP server's origin with its bearer token.
 *
 * A profile pointed at a loopback literal is published as a `local` entry, exactly as an MCP server on this computer is: the key
 * a local server asks for may be held by the keychain, which only the main process can read, so the page's handle has to become
 * the secret there. Local means "this computer" to the port, which is why such an entry may be plain http and nothing else may:
 * an address anywhere else is still https, and a profile there is published as an https origin.
 */
export function egressTargets(profiles: readonly ProfileView[], mcp: McpSettings): NativeEgressTarget[] {
  const targets: NativeEgressTarget[] = [];
  /** A record whose address does not parse cannot be reached anyway; the form that saved it reported the address. */
  const add = (url: string, keys: readonly string[], local = false): void => {
    try {
      targets.push({ origin: originOf(url), keys, ...(local ? { local } : {}) });
    } catch {
      // A record whose address does not parse is not an address, so it adds nothing to the list.
    }
  };
  for (const profile of profiles) {
    if (profile.kind !== 'mock') add(profile.baseUrl, [profile.id], isLocalBase(profile.baseUrl));
  }
  for (const server of mcp.servers) {
    let local = false;
    try {
      local = isLoopbackHost(new URL(server.url).hostname);
    } catch {
      continue;
    }
    add(server.url, server.auth.kind === 'bearer' ? [server.auth.tokenRef] : [], local);
  }
  return targets;
}
