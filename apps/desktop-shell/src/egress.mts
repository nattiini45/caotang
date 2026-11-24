/**
 * Provider and MCP calls, made by the main process — [desktop.md](../../../docs/architecture/desktop.md#native-provider-and-mcp-calls-405).
 *
 * A page request to a provider must survive a CORS preflight. In the desktop app there is no preflight: the main process
 * makes the call. That makes this a fetcher, so it is held to [native-egress.ts](../../../packages/gateway/src/native-egress.ts)
 * — https only, to origins the app configured, and to this computer only through a `local` entry (a provider profile or MCP
 * server on a loopback literal), with caps on every part of the request and on the answer. A refusal names its reason, so the
 * app can say what went wrong instead of reporting a dead network.
 *
 * **A keyed call is attached here.** The page writes `caotang-key:<id>` where the key goes, because the adapter that builds a
 * provider's headers knows the shape and this file does not. The handle is swapped for the secret from the vault, and only for
 * an address that key was configured for; the secret is then scrubbed out of the answer, so a provider that echoes a key back
 * cannot put one in the page's request log.
 *
 * The body streams back as it arrives. A model's answer is server-sent events, and holding it until the response ended
 * would turn a live answer into a pause followed by a wall of text; so the reply carries the status and headers, and the
 * bytes follow on one channel keyed by the request's own id.
 */

import { attachKeys, checkNativeEgress, nativeEgressTargets, pumpResponse, createSecretScrubber, redactSecrets } from '@caotang/gateway/native-egress';
import { net, ipcMain } from 'electron';
import type { WebContents } from 'electron';

import type { EgressChunk, EgressEnd, EgressError, EgressHead, EgressReply } from './egress-contract.cjs';
import { fromStudioFrame } from './ipc-guard.mjs';
import type { KeyVault } from './vault.mjs';

class EgressRefusal extends Error {
  constructor(readonly reason: EgressError) {
    super(reason);
  }
}

type Stream = { readonly controller: AbortController; readonly sender: WebContents };

/**
 * What the port needs of the keychain: the secret one handle names, and nothing else. Reading it is asynchronous — the
 * operating system opens the seal — and that await is the one a cancellation has to survive.
 */
export type KeyReader = Pick<KeyVault, 'read'>;

/** A request with its handles swapped for the secrets they name, and those secrets in the order to scrub them. */
interface AttachedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly secrets: readonly string[];
}

/**
 * The headers of a response as a plain record: what crosses to the page is data, not a Headers instance. Each value is scrubbed
 * of the secrets attached to the call, because a provider that echoes a key in a header puts it in the head, which is not the
 * body the streaming scrubber watches.
 */
function headersOf(headers: Headers, secrets: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => { out[name] = redactSecrets(value, secrets); });
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

export function registerEgressIpc(entryUrl: string, vault: KeyReader): void {
  let targets: ReturnType<typeof nativeEgressTargets> = new Map();
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
  async function pump(id: string, stream: Stream, response: Response, secrets: readonly string[]): Promise<void> {
    // Only the stream this id currently names is answered: a call the page stopped, or one whose page went, has left the map, and a
    // later call that took the id would otherwise receive the abandoned body's remaining chunks. The scrubber writes through the
    // same guard, so a secret cannot reach a call that is no longer this one either.
    const alive = (): boolean => streams.get(id) === stream;
    const scrubber = createSecretScrubber(secrets, (bytes) => { if (alive()) send(stream, 'net:chunk', { id, bytes }); });
    const outcome = await pumpResponse(response, (bytes) => scrubber.write(bytes));
    if (outcome !== 'unavailable' || !stream.controller.signal.aborted) scrubber.end();
    // A call the page stopped ends through `abort`, which has already said so; a page that went hears nothing at all. Sending an end
    // for either would be a message about a request nobody is listening for.
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

  /**
   * The request with its handles swapped for the secrets they name, and the secrets in that order for scrubbing. A configured
   * key the vault does not hold is refused rather than sent as a handle, which the provider would report as a bad key.
   */
  async function attach(request: { url: string; headers: Readonly<Record<string, string>>; keys: readonly string[] }): Promise<AttachedRequest> {
    if (request.keys.length === 0) return { url: request.url, headers: { ...request.headers }, secrets: [] };
    const secrets = new Map<string, string>();
    for (const id of request.keys) {
      const payload = await vault.read(id);
      // A key the app configured but the keychain does not hold is not a key: refusing beats sending the handle, which the
      // provider would report as a bad key and the writer would read as a wrong key rather than a missing one.
      if (payload === undefined) throw new EgressRefusal('denied');
      secrets.set(id, payload.apiKey);
    }
    const attached = attachKeys(request, secrets);
    return { url: attached.url, headers: attached.headers, secrets: attached.values };
  }

  ipcMain.handle('net:configure', (event, entries: unknown): Promise<EgressReply<null>> => reply(() => {
    if (!fromStudioFrame(event, entryUrl)) throw new EgressRefusal('invalid');
    targets = nativeEgressTargets(Array.isArray(entries) ? entries : []);
    return null;
  }));

  ipcMain.handle('net:start', (event, spec: unknown): Promise<EgressReply<EgressHead>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new EgressRefusal('invalid');
    const id = spec !== null && typeof spec === 'object' ? (spec as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/u.test(id)) throw new EgressRefusal('invalid');
    if (streams.has(id)) throw new EgressRefusal('invalid');
    const checked = checkNativeEgress(targets, spec);
    if (!checked.ok) throw new EgressRefusal(checked.refusal);
    // The call is claimed before its key is opened, not after. Opening one is asynchronous, and a page that cancels during that
    // wait has to find a stream to stop: claimed afterwards there was nothing to find, so the cancel was answered as though the
    // call had never been made, and the request went out for a caller that had already stopped it (#869). A reload takes the
    // same path, through `stopAll`.
    const controller = new AbortController();
    const stream: Stream = { controller, sender: event.sender };
    streams.set(id, stream);
    watch(event.sender);

    /** Whether the call has been stopped from the page's side since it was claimed: then nothing more is sent for it. */
    const stopped = (): boolean => {
      if (!controller.signal.aborted) return false;
      streams.delete(id);
      return true;
    };

    let keyed: AttachedRequest;
    let response: Response;
    try {
      keyed = await attach(checked.request);
      // A key that arrived for a call the page has stopped is not a reason to send it: the cancellation is the answer.
      if (stopped()) throw new EgressRefusal('aborted');
      response = await net.fetch(keyed.url, {
        method: checked.request.method,
        headers: keyed.headers,
        ...(checked.request.body === undefined ? {} : { body: checked.request.body }),
        // A redirect leads to an address the allowlist has not approved, so it is never followed: the status goes back to the
        // page, which already refuses a 3xx with what it means. Following it here would make the allowlist a starting point.
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      // A call the page stopped is an abort, whatever went wrong on the way out: a key the vault would not open after the
      // writer cancelled is not the answer they are owed, and neither is a dead network.
      if (stopped()) throw new EgressRefusal('aborted');
      streams.delete(id);
      throw error;
    }
    if (stopped()) throw new EgressRefusal('aborted');
    void pump(id, stream, response, keyed.secrets);
    return {
      status: response.status,
      statusText: redactSecrets(response.statusText, keyed.secrets),
      headers: headersOf(response.headers, keyed.secrets),
    };
  }));

  ipcMain.handle('net:abort', (event, id: unknown): Promise<EgressReply<null>> => reply(() => {
    if (!fromStudioFrame(event, entryUrl)) throw new EgressRefusal('invalid');
    if (typeof id !== 'string') throw new EgressRefusal('invalid');
    const stream = streams.get(id);
    if (stream === undefined) return null;
    streams.delete(id);
    stream.controller.abort();
    send(stream, 'net:end', { id, error: 'aborted' });
    return null;
  }));
}
