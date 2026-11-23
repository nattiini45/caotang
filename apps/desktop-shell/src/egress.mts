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
    // Only the stream this id currently names is answered: a call the page stopped, or one whose page went, has left the map,
    // and a later call that took the id would otherwise receive the abandoned body's remaining chunks.
    const alive = (): boolean => streams.get(id) === stream;
    const outcome = await pumpResponse(response, (bytes) => { if (alive()) send(stream, 'net:chunk', { id, bytes }); });
    // A call the page stopped ends through `abort`, which has already said so; a page that went hears nothing at all. Sending
    // an end for either would be a message about a request nobody is listening for.
    if (!alive()) return;
    streams.delete(id);
    if (outcome === 'too-large') stream.controller.abort();
    if (outcome === 'ended') send(stream, 'net:end', { id });
    else if (outcome === 'too-large') send(stream, 'net:end', { id, error: 'too-large' });
    else if (!stream.controller.signal.aborted) send(stream, 'net:end', { id, error: 'unavailable' });
  }

  /** Stops every call one page started: its sinks are gone, so nothing here keeps reading for a document that no longer exists. */
  function stopAll(sender: WebContents): void {
    for (const [id, stream] of streams) {
      if (stream.sender !== sender) continue;
      streams.delete(id);
      stream.controller.abort();
    }
  }

  /**
   * One set of listeners per page. A page stops its calls when it is destroyed, and also when a reload or a navigation
   * replaces it: the document that made them is gone while the `WebContents` lives on, and the reads it left behind would
   * otherwise run to their end for nobody. A sub-frame's navigation is not this: the studio's own frame is the one that made
   * the calls.
   */
  function watch(sender: WebContents): void {
    if (watched.has(sender.id)) return;
    watched.add(sender.id);
    sender.once('destroyed', () => {
      watched.delete(sender.id);
      stopAll(sender);
    });
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) stopAll(sender);
    });
    sender.on('render-process-gone', () => { stopAll(sender); });
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
      // A call the page stopped while the head was still arriving is an abort, whatever the network stack made of it on the
      // way out: the page asked for one thing and would otherwise be told the network was unreachable.
      if (controller.signal.aborted) throw new EgressRefusal('aborted');
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
