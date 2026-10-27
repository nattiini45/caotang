/**
 * The transport seam, and the one real transport behind it — [extensibility.md §3.3](../../../docs/architecture/extensibility.md).
 *
 * **Streamable HTTP only.** The revision is negotiated with the SDK's `auto` mode (§3.3, §12 D17,
 * as amended). The SDK sends `server/discover` first. A server that offers
 * 2026-07-28 answers with its discovery result, and the requests then go out with no `initialize`
 * and no session header. A 2025-era server answers that probe with a JSON-RPC "method not found",
 * which the SDK reads as a legacy server, so it is connected through the plain `initialize`
 * handshake it knows. The list is requested with `cacheMode: 'refresh'`, because the SDK otherwise
 * serves a cached list and a changed tool would go unnoticed.
 *
 * The seam ({@link McpWire}) is what the client talks to. The SDK wire is one implementation;
 * `mock.ts` is another, scripted for evals. The client never imports the SDK directly, so every
 * behaviour above the seam is testable without a socket. This file is the only one that holds the
 * SDK at runtime, and `lazy-wire.ts` loads it on first use, so the app's first download does not
 * carry it.
 *
 * **Failures leave this file as {@link WireError}s**, classified by kind. The kind decides
 * what the person is told: a network failure and a CORS refusal look the same to `fetch`, so the
 * wrapper probes the same URL with a no-cors request. A reachable server that refuses the browser
 * is a CORS refusal, and §3.3 names it as one.
 */

import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  UnsupportedProtocolVersionError,
  type FetchLike,
} from '@modelcontextprotocol/client';

import { egressAllowed } from './egress.js';
import type { McpServerConfig } from './config.js';
import { cleanProgress, type WireProgress } from './progress.js';
import { CLIENT_NAME, CLIENT_VERSION, WireError } from './wire-error.js';

export { CLIENT_NAME, CLIENT_VERSION, MODERN_REVISION, WireError, WireLoadError, corsProbe, type WireErrorKind } from './wire-error.js';
export type { WireProgress } from './progress.js';

/**
 * The most bytes one answer from a server may carry before it is refused. A server the writer
 * connected is untrusted for its output (§4 rule 6), and the 8k answer cap is applied to the
 * parsed result, which is after the memory is already spent. This is the bound that stops a
 * 300 MB `tools/list` or `tools/call` body ever being materialised. It is well over any real
 * listing or answer, and well under what the tab can hold.
 *
 * An event stream is bounded event by event rather than as a whole, because it is a sequence of
 * answers rather than one: see `eventStreamResponse`.
 */
export const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

/** The start of the SDK's message when the server's `initialize` answer names a revision the client does not offer. */
const UNSUPPORTED_SERVER_REVISION = "Server's protocol version is not supported";

/** A tool as a server advertises it. Verbatim: the description and the schema are the server's own text. */
export interface WireTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: WireAnnotations;
}

/** The self-declared hints. They inform nothing by themselves (§7: attacker-controlled text). */
export interface WireAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** A resource as a server lists it. Verbatim: the name and the description are the server's own text. */
export interface WireResource {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

/** A resource template as a server lists it: an RFC 6570 URI template, and the text that describes it. */
export interface WireResourceTemplate {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/** One piece of a resource's contents: text, or a blob, which the client refuses (extensibility §4). */
export type WireResourceContents =
  | { readonly uri: string; readonly mimeType?: string; readonly text: string }
  | { readonly uri: string; readonly mimeType?: string; readonly blob: string };

export interface WireResourceListing {
  readonly resources: readonly WireResource[];
  readonly templates: readonly WireResourceTemplate[];
}

export interface WirePromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

/** A prompt as a server lists it. Verbatim, like a tool. */
export interface WirePrompt {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly WirePromptArgument[];
}

/** What `prompts/get` returned: the messages, verbatim. Nothing in this package sends them anywhere. */
export interface WirePromptResult {
  readonly description?: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: unknown }[];
}

/** What the server says it offers beyond tools. A feature it does not advertise is never asked for. */
export interface WireCapabilities {
  readonly resources: boolean;
  readonly prompts: boolean;
  readonly completions: boolean;
}

/** What a completion is asked about: a prompt's argument, or a resource template's variable. */
export type WireCompletionRef = { readonly type: 'ref/prompt'; readonly name: string } | { readonly type: 'ref/resource'; readonly uri: string };

/** A call's result: the content blocks verbatim, and whether the tool reported an error. */
export interface WireCallResult {
  readonly content: readonly unknown[];
  readonly isError?: boolean;
}

export interface WireOptions {
  /** How long a request may go without an answer. For a call it is the idle limit: a progress report from the server starts it again. */
  readonly timeoutMs: number;
  /** A call's wall-clock cap, which progress does not extend. Absent, a call has none beyond the idle limit. */
  readonly maxTotalMs?: number;
  readonly signal?: AbortSignal;
  /** Told of each progress report on a call, cleaned (see progress.ts). A wire that has no progress to report never calls it. */
  readonly onProgress?: (progress: WireProgress) => void;
}

/** One server's connection. Operations are sequential per server; the client never overlaps two calls on one wire. */
export interface McpWire {
  listTools(options: WireOptions): Promise<readonly WireTool[]>;
  callTool(name: string, args: Record<string, unknown>, options: WireOptions): Promise<WireCallResult>;
  /** What the server advertises beyond tools. The client asks for resources and prompts only when this says they exist. */
  capabilities(options: WireOptions): Promise<WireCapabilities>;
  listResources(options: WireOptions): Promise<WireResourceListing>;
  readResource(uri: string, options: WireOptions): Promise<readonly WireResourceContents[]>;
  listPrompts(options: WireOptions): Promise<readonly WirePrompt[]>;
  getPrompt(name: string, args: Record<string, string>, options: WireOptions): Promise<WirePromptResult>;
  /** Suggestions for one argument of a prompt or template variable; absent on a wire that cannot ask. */
  complete?(ref: WireCompletionRef, argument: { readonly name: string; readonly value: string }, options: WireOptions): Promise<readonly string[]>;
  close(): Promise<void>;
}

/** What a wire needs from the app: the vault's bearer lookup, a fetch, and the CORS probe. */
export interface WireDeps {
  readonly resolveBearer: (tokenRef: string) => Promise<string | undefined>;
  readonly fetch: FetchLike;
  readonly probe: (url: string) => Promise<boolean>;
}

export type WireFactory = (server: McpServerConfig, deps: WireDeps) => McpWire;

/** The SDK-backed wire for one server. It opens its connection on first use. */
class StreamableHttpWire implements McpWire {
  private readonly server: McpServerConfig;
  private readonly deps: WireDeps;
  private client: Client | undefined;
  /** Set by the fetch wrapper just before a network failure surfaces, so the classifier can tell CORS from a dead host. */
  private networkFailure: 'network' | 'cors' | undefined;
  /** Set when an answer was refused for its size, so the refusal is told even when the SDK reported it as a broken connection. */
  private sizeRefusal: WireError | undefined;

  constructor(server: McpServerConfig, deps: WireDeps) {
    this.server = server;
    this.deps = deps;
  }

  async listTools(options: WireOptions): Promise<readonly WireTool[]> {
    this.networkFailure = undefined;
    this.sizeRefusal = undefined;
    try {
      const client = await this.open(options.timeoutMs, options.signal);
      const listed = await client.listTools(undefined, { cacheMode: 'refresh', timeout: options.timeoutMs, signal: options.signal });
      return listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations === undefined ? undefined : {
          readOnlyHint: tool.annotations.readOnlyHint,
          destructiveHint: tool.annotations.destructiveHint,
          idempotentHint: tool.annotations.idempotentHint,
          openWorldHint: tool.annotations.openWorldHint,
        },
      }));
    } catch (error) {
      throw this.classify(error, options.signal);
    }
  }

  async callTool(name: string, args: Record<string, unknown>, options: WireOptions): Promise<WireCallResult> {
    this.networkFailure = undefined;
    this.sizeRefusal = undefined;
    const wall = wallClock(options.signal, options.maxTotalMs);
    try {
      const client = await this.open(options.timeoutMs, wall.signal);
      // The SDK sends a progress token when `onprogress` is set, and starts the idle timer again on each report. Its own total cap is
      // only read when a report arrives, so the wall clock above is the one that ends a call exactly at the cap; this one backs it up.
      const result = await client.callTool(
        { name, arguments: args },
        {
          timeout: options.timeoutMs,
          signal: wall.signal,
          resetTimeoutOnProgress: true,
          ...(options.maxTotalMs === undefined ? {} : { maxTotalTimeout: options.maxTotalMs }),
          onprogress: (raw) => {
            const report = cleanProgress(raw);
            if (report === undefined) return;
            try {
              options.onProgress?.(report);
            } catch {
              // A listener's failure is not the call's.
            }
          },
        },
      );
      return { content: result.content, isError: result.isError === true };
    } catch (error) {
      throw this.classify(error, options.signal, 'tools', wall.fired());
    } finally {
      wall.stop();
    }
  }

  async capabilities(options: WireOptions): Promise<WireCapabilities> {
    return this.request(options, 'tools', (client) => {
      const advertised = client.getServerCapabilities();
      return Promise.resolve({
        resources: advertised?.resources !== undefined,
        prompts: advertised?.prompts !== undefined,
        completions: advertised?.completions !== undefined,
      });
    });
  }

  async listResources(options: WireOptions): Promise<WireResourceListing> {
    return this.request(options, 'resources', async (client) => {
      this.require(client, 'resources');
      // Without `cacheMode: 'refresh'`: the SDK keeps a list for the server's own `ttlMs`, which is what a picker opened twice in a row should do.
      const requestOptions = { timeout: options.timeoutMs, signal: options.signal };
      const listed = await client.listResources(undefined, requestOptions);
      const templates = await client.listResourceTemplates(undefined, requestOptions);
      return {
        resources: listed.resources.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          title: resource.title,
          description: resource.description,
          mimeType: resource.mimeType,
          size: resource.size,
        })),
        templates: templates.resourceTemplates.map((template) => ({
          uriTemplate: template.uriTemplate,
          name: template.name,
          title: template.title,
          description: template.description,
          mimeType: template.mimeType,
        })),
      };
    });
  }

  async readResource(uri: string, options: WireOptions): Promise<readonly WireResourceContents[]> {
    return this.request(options, 'resources', async (client) => {
      this.require(client, 'resources');
      const read = await client.readResource({ uri }, { timeout: options.timeoutMs, signal: options.signal });
      return read.contents.map((content): WireResourceContents => {
        if ('text' in content && typeof content.text === 'string') return { uri: content.uri, mimeType: content.mimeType, text: content.text };
        return { uri: content.uri, mimeType: content.mimeType, blob: 'blob' in content && typeof content.blob === 'string' ? content.blob : '' };
      });
    });
  }

  async listPrompts(options: WireOptions): Promise<readonly WirePrompt[]> {
    return this.request(options, 'prompts', async (client) => {
      this.require(client, 'prompts');
      const listed = await client.listPrompts(undefined, { timeout: options.timeoutMs, signal: options.signal });
      return listed.prompts.map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: prompt.arguments?.map((argument) => ({ name: argument.name, description: argument.description, required: argument.required })),
      }));
    });
  }

  async getPrompt(name: string, args: Record<string, string>, options: WireOptions): Promise<WirePromptResult> {
    return this.request(options, 'prompts', async (client) => {
      this.require(client, 'prompts');
      const got = await client.getPrompt({ name, arguments: args }, { timeout: options.timeoutMs, signal: options.signal });
      return { description: got.description, messages: got.messages.map((message) => ({ role: message.role, content: message.content })) };
    });
  }

  async complete(ref: WireCompletionRef, argument: { readonly name: string; readonly value: string }, options: WireOptions): Promise<readonly string[]> {
    return this.request(options, 'completions', async (client) => {
      this.require(client, 'completions');
      const done = await client.complete({ ref, argument }, { timeout: options.timeoutMs, signal: options.signal });
      return done.completion.values;
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) await client.close();
  }

  /** One request on the open connection, with the failure classified. `what` says which feature the request is for, to read a not-found right. */
  private async request<T>(options: WireOptions, what: 'tools' | 'resources' | 'prompts' | 'completions', run: (client: Client) => Promise<T>): Promise<T> {
    this.networkFailure = undefined;
    this.sizeRefusal = undefined;
    try {
      return await run(await this.open(options.timeoutMs, options.signal));
    } catch (error) {
      throw this.classify(error, options.signal, what);
    }
  }

  /** A feature the server did not advertise is never asked for: the wire refuses before anything is sent. */
  private require(client: Client, feature: 'resources' | 'prompts' | 'completions'): void {
    if (client.getServerCapabilities()?.[feature] === undefined) {
      throw new WireError('protocol', `the server does not advertise ${feature}, so Caotang did not ask for them`);
    }
  }

  private async open(timeoutMs: number, signal?: AbortSignal): Promise<Client> {
    if (this.client !== undefined) return this.client;
    // `auto`, not a pin: a pin refuses every 2025-era server (D17's amendment). The probe is the same either way.
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { versionNegotiation: { mode: 'auto' } });
    const auth = this.server.auth;
    const transport = new StreamableHTTPClientTransport(new URL(this.server.url), {
      ...(auth.kind === 'bearer' ? { authProvider: { token: () => this.deps.resolveBearer(auth.tokenRef) } } : {}),
      fetch: this.fetchFor(),
      redirectPolicy: 'same-origin',
    });
    try {
      await client.connect(transport, { timeout: timeoutMs, ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.client = client;
    return client;
  }

  /** Every request goes through here, and only to the server's own URL (§4 rule 6). A failure is probed before it is reported. */
  private fetchFor(): FetchLike {
    return async (input, init) => {
      const target = typeof input === 'string' ? input : input.href;
      if (!egressAllowed(target, { providerEndpoints: [], mcpServerUrls: [this.server.url] })) {
        this.networkFailure = 'network';
        throw new TypeError(`request to ${target} is outside the connected server`);
      }
      try {
        return boundedResponse(await this.deps.fetch(input, init), MAX_ANSWER_BYTES, (error) => {
          this.sizeRefusal = error;
        });
      } catch (error) {
        // A refused answer is not a network failure: the server answered, and the answer was over
        // the budget. It stands as it is, and is never probed.
        if (error instanceof WireError) throw error;
        if (isAbort(error)) throw error;
        const reachable = await this.deps.probe(target).catch(() => false);
        this.networkFailure = reachable ? 'cors' : 'network';
        throw error;
      }
    };
  }

  private classify(
    error: unknown,
    signal: AbortSignal | undefined,
    what: 'tools' | 'resources' | 'prompts' | 'completions' = 'tools',
    wallClockFired = false,
  ): WireError {
    if (error instanceof WireError) return error;
    // The call ran to its wall-clock cap. The writer's own abort wins when both happened.
    if (wallClockFired && signal?.aborted !== true) return new WireError('timeout', 'the call ran to its wall-clock limit', undefined, { limit: 'total' });
    // An answer refused for its size is this module's own refusal, and it is the kind the person
    // is told, however deeply the SDK wrapped it on the way out. A refusal inside an event stream
    // reaches the SDK as a broken connection, so the refusal that was recorded when it happened is
    // the one that is told.
    if (this.sizeRefusal !== undefined) return this.sizeRefusal;
    if (isAbort(error) || signal?.aborted === true) return new WireError('abort', 'the call was aborted');
    // The SDK wraps a failed request in its own error (the version probe reports "Failed to fetch" as a
    // ProtocolError, for one). The fetch wrapper saw the real failure and recorded it, so that record wins.
    if (this.networkFailure !== undefined) return new WireError(this.networkFailure, errorMessage(error));
    if (error instanceof SdkHttpError) {
      const status = error.status;
      if (status === 401 || status === 403) return new WireError('auth', `the server answered HTTP ${status}`, status);
      return new WireError('http', `the server answered HTTP ${status}`, status);
    }
    if (error instanceof UnauthorizedError) return new WireError('auth', 'the server answered HTTP 401');
    // A refusal the SDK wrapped is recognised by what it says, and told in its own words. It comes
    // after the status a server answered with: a status says why the call failed, and a sentence
    // in a message does not.
    const refusal = sizeRefusalOf(error);
    if (refusal !== undefined) return refusal;
    if (what !== 'tools' && isInputRequired(error)) {
      return new WireError('input-required', 'the server answered with input_required, which asks for more input than Caotang can give yet');
    }
    // A resource the server does not have: `-32002` before 2026-07-28 and `-32602` after it are one answer here.
    if (what === 'resources' && error instanceof ProtocolError && (error.code === ProtocolErrorCode.ResourceNotFound || error.code === ProtocolErrorCode.InvalidParams)) {
      return new WireError('not-found', error.message);
    }
    if (error instanceof SdkError) {
      switch (error.code) {
        case SdkErrorCode.RequestTimeout:
          // The SDK's own total cap carries the cap in its data; any other timeout is the idle limit.
          return new WireError('timeout', error.message, undefined, { limit: (error as { data?: { maxTotalTimeout?: unknown } }).data?.maxTotalTimeout === undefined ? 'idle' : 'total' });
        case SdkErrorCode.InvalidResult:
        case SdkErrorCode.UnsupportedResultType:
          return new WireError('result', error.message);
        // The probe itself failed (an unusable reply, or a close with no answer). That is a protocol failure. A revision
        // with no common one is `UnsupportedProtocolVersionError`, classified below.
        case SdkErrorCode.EraNegotiationFailed:
          return new WireError('protocol', error.message);
        case SdkErrorCode.SendFailed:
        case SdkErrorCode.ConnectionClosed:
        case SdkErrorCode.NotConnected:
          return new WireError('network', error.message);
        default:
          return new WireError('protocol', error.message);
      }
    }
    if (error instanceof UnsupportedProtocolVersionError) return new WireError('revision', error.message, undefined, { supported: revisionTokens(error.supported) });
    // The legacy handshake's own check, on the revision the server answered `initialize` with. The SDK throws a plain
    // Error for it (pinned SDK 2.3.1), so the message is what identifies it, and the message is where the revision is.
    if (error instanceof Error && error.message.startsWith(UNSUPPORTED_SERVER_REVISION)) {
      return new WireError('revision', error.message, undefined, { answered: answeredRevisionOf(error.message) });
    }
    if (error instanceof ProtocolError) return new WireError('protocol', error.message);
    if (error instanceof TypeError) return new WireError('network', error.message);
    return new WireError('protocol', errorMessage(error));
  }
}

/** Whether the server answered `input_required`, however the SDK reported that it could not fulfil it. */
function isInputRequired(error: unknown): boolean {
  if (!(error instanceof SdkError)) return false;
  if (error.code === SdkErrorCode.InputRequiredRoundsExceeded) return true;
  // With no handler for the embedded request (this client declares none), the SDK cannot fulfil it and says so in these words.
  if (error.code === SdkErrorCode.CapabilityNotSupported && error.message.startsWith('Cannot fulfil input request')) return true;
  const data = (error as { data?: unknown }).data;
  return error.code === SdkErrorCode.UnsupportedResultType && typeof data === 'object' && data !== null && (data as { resultType?: unknown }).resultType === 'input_required';
}

/**
 * A signal that also fires at the call's wall-clock cap, and a way to tell which of the two did. The cap is exact here, not left to the
 * SDK, which reads its own only when the server next reports progress: a server that reports at 599 s would otherwise run to 719 s.
 */
function wallClock(
  signal: AbortSignal | undefined,
  maxTotalMs: number | undefined,
): { readonly signal: AbortSignal | undefined; fired(): boolean; stop(): void } {
  if (maxTotalMs === undefined) return { signal, fired: () => false, stop: () => undefined };
  const controller = new AbortController();
  let fired = false;
  const forward = (): void => controller.abort(signal?.reason);
  if (signal?.aborted === true) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(new Error('wall-clock limit'));
  }, maxTotalMs);
  return {
    signal: controller.signal,
    fired: () => fired,
    stop: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * An answer whose body is kept under `max` bytes, whichever way the server framed its length. A
 * declared `Content-Length` over the budget is refused before a byte is read, and a body the
 * server left unbounded is read through a counting stream that stops at the same limit, so a
 * chunked answer is cut where a declared one is refused. The whole body is refused, never cut
 * down: the SDK's own parse of a truncated message would be a worse failure than no answer at all.
 *
 * An event stream is the one answer that is not one answer. The SDK reads it event by event, and
 * a server that keeps a connection open carries every notification for the life of that
 * connection in one body, so the bytes of the body add up past the budget while every event in it
 * stays small. The bound there is on one event, not on the stream, and `onRefusal` is told when
 * an event is refused, because a refusal inside a stream reaches the SDK as a broken connection
 * rather than as an answer that was too big.
 */
function boundedResponse(response: Response, max: number, onRefusal: (error: WireError) => void): Response {
  if (isEventStream(response)) return eventStreamResponse(response, max, onRefusal);
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) {
    const error = tooLarge(declared, max);
    // The refusal is told before it is thrown, so it is told as a refusal and not as whatever
    // the SDK makes of it. The body is cancelled, so a server that answers every request with
    // an oversized length does not leave a connection open behind every one of them.
    onRefusal(error);
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let seen = 0;
  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      seen += value?.byteLength ?? 0;
      if (seen > max) {
        await reader.cancel().catch(() => undefined);
        const error = tooLarge(seen, max);
        onRefusal(error);
        controller.error(error);
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Whether the answer is an event stream: a sequence of events, not one body. */
function isEventStream(response: Response): boolean {
  const type = response.headers.get('content-type') ?? '';
  return type.split(';')[0]?.trim().toLowerCase() === 'text/event-stream';
}

/** One byte of a line terminator. */
const LF = 10;
const CR = 13;

/**
 * The size of the events in one event stream, counted between the blank lines that end them.
 *
 * The framing is the one the SDK's parser uses: a line ends at LF, CR or CRLF, and an event ends
 * at a blank line. The size of an event is the bytes it occupies in the stream — its lines and
 * their terminators, without the blank line that ends it.
 */
class EventSize {
  /** The bytes of the lines of the event being read. */
  private event = 0;
  /** The bytes of the line being read. */
  private line = 0;
  /** The last byte was a CR, which may still be the first half of a CRLF. */
  private pendingCr = false;
  /** The size of the event that was over the budget, once one of them has been. */
  private refused: number | undefined;

  constructor(private readonly budget: number) {}

  /** Whether an event of this stream has been over the budget. */
  get over(): boolean {
    return this.refused !== undefined;
  }

  /** The size of the event that was over the budget. */
  get size(): number {
    return this.refused ?? this.event + this.line;
  }

  /** Adds the bytes of a line's content. */
  addContent(count: number): void {
    // A CR that ended the line before this content was deferred, because it may have been the
    // first half of a CRLF. It is resolved here: that CR ended the line it came after, and these
    // bytes are the next one's. Without this, a line framed with a CR alone is counted without
    // its terminator, and an event of it is counted one byte short.
    if (this.pendingCr) {
      this.pendingCr = false;
      this.endLine(1);
    }
    this.line += count;
    this.check(this.event + this.line);
  }

  /** Adds one line terminator. */
  addTerminator(byte: number): void {
    if (this.pendingCr) {
      this.pendingCr = false;
      if (byte === LF) {
        this.endLine(2);
        return;
      }
      this.endLine(1);
    }
    if (byte === CR) {
      this.pendingCr = true;
      return;
    }
    this.endLine(1);
  }

  /** The stream ended: an event that never got its blank line is measured all the same. */
  end(): void {
    this.check(this.event + this.line);
  }

  /** One line ended: either a line of the event, or the blank line that ends the event. */
  private endLine(terminatorBytes: number): void {
    if (this.line === 0) {
      // A blank line ends the event. The blank line is the boundary, not part of the event.
      this.check(this.event);
      this.event = 0;
      return;
    }
    this.event += this.line + terminatorBytes;
    this.line = 0;
    this.check(this.event);
  }

  private check(size: number): void {
    if (this.refused === undefined && size > this.budget) this.refused = size;
  }
}

/**
 * An event stream whose events are kept under `max` bytes each. The stream itself is not bounded:
 * a server that keeps a connection open carries every notification for the life of it in one
 * body, and a healthy server that streams more than the budget over that life is not cut off for
 * it. One event over the budget is refused, whole.
 */
function eventStreamResponse(response: Response, max: number, onRefusal: (error: WireError) => void): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const size = new EventSize(max);
  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        size.end();
        if (size.over) {
          const error = tooLarge(size.size, max);
          onRefusal(error);
          controller.error(error);
          return;
        }
        controller.close();
        return;
      }
      if (value !== undefined) {
        let start = 0;
        while (start < value.length) {
          const cr = value.indexOf(CR, start);
          const lf = value.indexOf(LF, start);
          const next = cr === -1 ? lf : lf === -1 ? cr : Math.min(cr, lf);
          if (next === -1) {
            size.addContent(value.length - start);
            break;
          }
          if (next > start) size.addContent(next - start);
          const terminator = value[next];
          if (terminator === undefined) break;
          size.addTerminator(terminator);
          start = next + 1;
          if (size.over) break;
        }
        if (size.over) {
          await reader.cancel().catch(() => undefined);
          const error = tooLarge(size.size, max);
          onRefusal(error);
          controller.error(error);
          return;
        }
        controller.enqueue(value);
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function tooLarge(seen: number, max: number): WireError {
  return new WireError('result', `the server's answer is over the ${max}-byte budget (about ${seen} bytes), so it was refused and not read`);
}

/**
 * This module's own refusal of an oversized answer, at whatever depth the SDK wrapped it, and the
 * refusal's own words: a wrapper's message says nothing of the budget or of the size that was
 * refused.
 */
function sizeRefusalOf(error: unknown, seen = 0): WireError | undefined {
  if (error instanceof WireError) return error;
  if (seen > 5 || typeof error !== 'object' || error === null) return undefined;
  if ('cause' in error) {
    const found = sizeRefusalOf((error as { cause: unknown }).cause, seen + 1);
    if (found !== undefined) return found;
  }
  if ('message' in error && /over the \d+-byte budget/.test(String((error as { message: unknown }).message))) {
    return new WireError('result', String((error as { message: unknown }).message));
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How many revisions a refusal names at most. A server's own list is shown in full up to this many. */
const MAX_NAMED_REVISIONS = 8;

/** The revision the SDK's message names: `Server's protocol version is not supported: <rev>`. The server wrote it, so only a plain token is kept. */
function answeredRevisionOf(message: string): string | undefined {
  return revisionToken(message.slice(UNSUPPORTED_SERVER_REVISION.length).replace(/^:\s*/, ''));
}

/** The revisions a server listed, each kept only when it is a plain token, and at most {@link MAX_NAMED_REVISIONS} of them. */
function revisionTokens(values: readonly unknown[]): string[] {
  return values.map(revisionToken).filter((token): token is string => token !== undefined).slice(0, MAX_NAMED_REVISIONS);
}

/**
 * A revision as the server wrote it, if it is a plain token: a short run of letters, digits, dots, dashes and underscores.
 * The text reaches the person and the model, so anything longer, or with spaces, is left out rather than repeated.
 */
function revisionToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9A-Za-z._-]{1,32}$/.test(value) ? value : undefined;
}

/** The SDK-backed wire: one {@link StreamableHttpWire} per server. The app reaches it through `lazy-wire.ts`, which loads this file on first use. */
export const createSdkWire: WireFactory = (server, deps) => new StreamableHttpWire(server, deps);
