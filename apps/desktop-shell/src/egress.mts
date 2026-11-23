/**
 * Provider and MCP calls, made by the main process — [desktop.md](../../../docs/architecture/desktop.md#native-provider-and-mcp-calls-405).
 *
 * A page request to a provider must survive a CORS preflight. In the desktop app there is no preflight: the main process
 * makes the call. That makes this a fetcher, so it is held to [native-egress.ts](../../../packages/gateway/src/native-egress.ts)
 * — https only, to origins the app configured, never this computer, with caps on every part of the request and on the
 * answer. A refusal names its reason, so the app can say what went wrong instead of reporting a dead network.
 *
 * The body streams back as it arrives. A model's answer is server-sent events, and holding it until the response ended
 * would turn a live answer into a pause followed by a wall of text; so the reply carries the status and headers, and the
 * bytes follow on one channel keyed by the request's own id.
 */

import { checkNativeEgress, nativeEgressOrigins, pumpResponse } from '@caotang/gateway/native-egress';
import { net, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';

import type { EgressChunk, EgressEnd, EgressError, EgressHead, EgressReply } from './egress-contract.cjs';

class EgressRefusal extends Error {
  constructor(readonly reason: EgressError) {
    super(reason);
  }
}

type Stream = { readonly controller: AbortController; readonly sender: WebContents };

/** The headers of a response as a plain record: what crosses to the page is data, not a Headers instance. */
function headersOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => { out[name] = value; });
  return out;
}

/**
 * Answers with the shell's refusal shape, for the same reason the folder calls do: a page that cannot reach the main
 * process gets a value it can show, and an internal failure never becomes an unhandled rejection in the renderer.
 */
function reply<T>(run: () => T | Promise<T>): Promise<EgressReply<T>> {
  return Promise.resolve()
    .then(run)
    .then((value): EgressReply<T> => ({ ok: true, value }), (error: unknown): EgressReply<T> => ({
      ok: false,
      error: error instanceof EgressRefusal ? error.reason : 'unavailable',
    }));
}

/** Whether the call comes from the studio's own top frame: a child frame or another origin never reaches the port. */
function trusted(event: IpcMainInvokeEvent, entryUrl: string): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame.parent === null && frame.url === entryUrl;
}

export function registerEgressIpc(entryUrl: string): void {
  let origins: ReadonlySet<string> = new Set();
  const streams = new Map<string, Stream>();
  const watched = new Set<number>();

  const send = (stream: Stream, channel: string, payload: EgressChunk | EgressEnd): void => {
    if (stream.sender.isDestroyed()) return;
    stream.sender.send(channel, payload);
  };

  /**
   * Reads the body to its end, sending it on as it arrives, and reports how it went once it is done. A body that passed the
   * cap, or broke part-way, ends the call here: the page has its status and headers already, so this is where a failure has
   * to be said.
   */
  async function pump(id: string, stream: Stream, response: Response): Promise<void> {
    const outcome = await pumpResponse(response, (bytes) => send(stream, 'net:chunk', { id, bytes }));
    streams.delete(id);
    if (outcome === 'too-large') stream.controller.abort();
    // A call the page stopped ends through `abort`, which has already said so; sending a second end would be a message about
    // a request the page is no longer listening for.
    if (outcome === 'ended') send(stream, 'net:end', { id });
    else if (outcome === 'too-large') send(stream, 'net:end', { id, error: 'too-large' });
    else if (!stream.controller.signal.aborted) send(stream, 'net:end', { id, error: 'unavailable' });
  }

  /** One listener per page: a page that goes stops every call it started, so nothing keeps reading for a window that is gone. */
  function watch(sender: WebContents): void {
    if (watched.has(sender.id)) return;
    watched.add(sender.id);
    sender.once('destroyed', () => {
      watched.delete(sender.id);
      for (const [id, stream] of streams) {
        if (stream.sender !== sender) continue;
        streams.delete(id);
        stream.controller.abort();
      }
    });
  }

  ipcMain.handle('net:configure', (event, entries: unknown): Promise<EgressReply<null>> => reply(() => {
    if (!trusted(event, entryUrl)) throw new EgressRefusal('invalid');
    origins = nativeEgressOrigins(Array.isArray(entries) ? entries : []);
    return null;
  }));

  ipcMain.handle('net:start', (event, spec: unknown): Promise<EgressReply<EgressHead>> => reply(async () => {
    if (!trusted(event, entryUrl)) throw new EgressRefusal('invalid');
    const id = spec !== null && typeof spec === 'object' ? (spec as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/u.test(id)) throw new EgressRefusal('invalid');
    if (streams.has(id)) throw new EgressRefusal('invalid');
    const checked = checkNativeEgress(origins, spec);
    if (!checked.ok) throw new EgressRefusal(checked.refusal);

    const controller = new AbortController();
    const stream: Stream = { controller, sender: event.sender };
    streams.set(id, stream);
    watch(event.sender);
    let response: Response;
    try {
      response = await net.fetch(checked.request.url, {
        method: checked.request.method,
        headers: checked.request.headers,
        ...(checked.request.body === undefined ? {} : { body: checked.request.body }),
        // A redirect leads to an address the allowlist has not approved, so it is never followed: the status goes back to the
        // page, which already refuses a 3xx with what it means. Following it here would make the allowlist a starting point.
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      streams.delete(id);
      throw error;
    }
    if (controller.signal.aborted) {
      streams.delete(id);
      throw new EgressRefusal('aborted');
    }
    void pump(id, stream, response);
    return { status: response.status, statusText: response.statusText, headers: headersOf(response.headers) };
  }));

  ipcMain.handle('net:abort', (event, id: unknown): Promise<EgressReply<null>> => reply(() => {
    if (!trusted(event, entryUrl)) throw new EgressRefusal('invalid');
    if (typeof id !== 'string') throw new EgressRefusal('invalid');
    const stream = streams.get(id);
    if (stream === undefined) return null;
    streams.delete(id);
    stream.controller.abort();
    send(stream, 'net:end', { id, error: 'aborted' });
    return null;
  }));
}
