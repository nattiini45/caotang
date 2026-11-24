/**
 * The two ways this server speaks MCP, over one project session.
 *
 * - **Streamable HTTP on 127.0.0.1** (`startHttpServer`). 2026-07-28 requests take the SDK's
 *   dual-era entry, `createMcpHandler`, which answers each one from a fresh `McpServer`, so
 *   no session outlives its request. A 2025-era host opens a connection with `initialize`, and
 *   that connection is kept in `legacy-sessions.ts` under its `Mcp-Session-Id`, because the
 *   host answers the server's questions (a write-confirm) on it. A 2025-era request with no
 *   session id is still served statelessly by the entry, and gets no capabilities. Before the
 *   SDK sees a request the server checks, in order: the `Host` and `Origin` headers (DNS
 *   rebinding and browser pages), the bearer token, the body's size and JSON, and the guard's
 *   refusals. The loopback bind is the boundary; the token is the credential on it.
 * - **stdio** (`startStdioServer`), for a host that starts the server as a child
 *   process, as an MCPB bundle does. The host's own process boundary stands in for the
 *   token, and `serveStdio` owns the era decision for the connection.
 *
 * Both build their tools from the same `buildMcpServer`, so a tool is the same tool on
 * either transport.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  isInitializeRequest,
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage,
  type McpHttpHandler,
  type MessageExtraInfo,
  type Transport,
} from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import { bearerAccepted } from './auth.js';
import { createConfirmLedger, createRoundCodec } from './confirm.js';
import type { WriteGate } from './gate.js';
import { createReplayCache } from './replay.js';
import { folderWrite, guardBatch, guardMessage, type GuardPolicy, type RefusalResponse } from './guard.js';
import { LegacySessions, type LegacySessionOptions } from './legacy-sessions.js';
import { degradedInstructions, guardDegraded, registerRecoveryTools, type DegradedSession, type RecoveryRuntime } from './recovery.js';
import { registerPictureTools } from './pictures.js';
import { registerCaotangPrompts } from './prompts.js';
import { registerCaotangResources } from './resources.js';
import { forwardChanges, forwardToListeners } from './subscriptions.js';
import { registerCaotangTools, type ToolRuntime } from './tools.js';
import type { ProjectSession } from './session.js';
import { MCP_PATH, MODERN_PROTOCOL_VERSION, VERSION } from './version.js';

/** The control paths a desktop app posts to while it saves. They are never part of the MCP surface. */
export const CONTROL_PAUSE = '/control/pause';
export const CONTROL_RESUME = '/control/resume';
/** A save that stopped waiting for its pause: the pause is let go and nothing is read, because no save of it is coming. */
export const CONTROL_CANCEL = '/control/cancel';

/** The header a control call names its pause in, so a resume can let go of a pause that lands after it. */
export const CONTROL_LEASE_HEADER = 'x-caotang-pause';

/** The longest lease a control call may name. A longer value names no pause, which counts as a call that names none. */
const MAX_LEASE_LENGTH = 128;

/** The most body a POST may carry. The SDK's own default is the same 4 MiB. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * How long a confirmation on a 2025-era connection waits for its answer. The connection's POST stays open that long, and
 * a connection with a POST open holds one of the table's places (legacy-sessions.ts), so this is how long a person who
 * walked away from the dialog costs. It is this server's own decision: the SDK's default is ten minutes. The SDK's
 * `maxRounds` stays at its default of 8; a confirmation re-enters its handler once. The 2026-07-28 path and stdio hold
 * no place, so they keep the SDK's default.
 */
export const LEGACY_ROUND_TIMEOUT_MS = 60_000;

/**
 * What a host reads at initialize. It says exactly which writes ask first: the ones whose description opens with the
 * confirmation sentence (tools.ts reads the same marker through the harness's exposure). The others apply at once.
 */
const INSTRUCTIONS =
  'Caotang is a writing project. Its text is served as resources, which the writer attaches on purpose: caotang://binder lists the structure with the ids, ' +
  'caotang://doc/{id} is a document whole, caotang://notes/{id} its synopsis and notes, caotang://codex lists the codex and caotang://codex/{id} is one entry. ' +
  'It also serves prompts (draft-scene, fill-synopsis, continuity-check, codex-from-doc, revise-with-codex) that carry the context of Caotang’s own agent for that job; ' +
  'they are written for your model, and nothing on this server calls one. ' +
  'The story timeline is served read-only: caotang://timeline is the whole model as JSON and caotang://timeline.csv its rows, and timeline.read reads it capped. ' +
  'The pictures are served read-only: caotang://assets is the registry as JSON, caotang://asset/{id} one picture’s bytes, pictures.list lists them with where they are placed, and pictures.view sends up to four as images. ' +
  'This server cannot shrink a picture, so one over the size a message carries is refused with its size. ' +
  'A host that reads through tools reads it first with project.overview for the summary, then binder.read_tree for the structure, and doc.read for a document. ' +
  'Writes are exposed only when the project was started with --allow-writes. A write tool whose description starts with "Requires user confirmation." ' +
  'asks the user to confirm it in the host before it changes anything. The other write tools apply at once. ' +
  'A refused call says why, and the corrective step is in the refusal.';

/** The instructions of a connection whose confirmations wait `roundMs`: they say how long, so a host can tell the user. */
function instructionsFor(runtime: ServerRuntime, roundMs: number | undefined): string {
  const base = 'recovery' in runtime ? degradedInstructions(runtime.recovery) : INSTRUCTIONS;
  if (roundMs === undefined) return base;
  const seconds = Math.ceil(roundMs / 1000);
  return `${base} A confirmation waits ${seconds} seconds for the user's answer; after that the call fails, nothing changes, and the call can be made again.`;
}

/** What a server runs over: an open project, or a folder that would not open and is offered its recovery (recovery.ts). */
export type ServerRuntime = ToolRuntime | RecoveryRuntime;

/** Everything a server needs: the session, and the confirmation machinery bound to this process. */
export function createToolRuntime(session: ProjectSession): ToolRuntime;
export function createToolRuntime(session: DegradedSession): RecoveryRuntime;
export function createToolRuntime(session: ProjectSession | DegradedSession): ServerRuntime;
export function createToolRuntime(session: ProjectSession | DegradedSession): ServerRuntime {
  const machinery = { codec: createRoundCodec(), ledger: createConfirmLedger() };
  return 'degraded' in session ? { recovery: session, ...machinery } : { session, changes: session.changes, replay: createReplayCache(), ...machinery };
}

/**
 * The guard's policy for a runtime: whether writes are exposed, on a degraded server which names reach a handler, and — on a
 * server the app started — whether a save has paused it. The pause is read live, so the next request sees a pause set a moment ago.
 */
function policyOf(runtime: ServerRuntime, gate?: WriteGate): GuardPolicy {
  const paused = gate === undefined ? undefined : (): boolean => gate.paused();
  if (!('recovery' in runtime)) return { allowWrites: runtime.session.allowWrites, ...(paused === undefined ? {} : { paused }) };
  const { recovery } = runtime;
  return { allowWrites: recovery.allowWrites, degraded: (name) => guardDegraded(recovery, name), ...(paused === undefined ? {} : { paused }) };
}

export interface McpServerOptions {
  /**
   * How long a confirmation waits for its answer on this server's 2025-era connection, in milliseconds. Left out, the
   * SDK's default stands and the question and the instructions name no deadline. The SDK takes this option on the
   * server, not on `createMcpHandler`, which has no such option.
   */
  readonly roundTimeoutMs?: number;
  /**
   * Whether this server outlives the request that built it: a 2025-era connection, or the one server of a stdio connection. Such a server
   * tells its client what the project's writes changed (subscriptions.ts). A 2026-07-28 request is answered by a server that is gone with
   * it, and its listeners are served from the handler's own bus.
   */
  readonly live?: boolean;
}

/** A fresh MCP server over the runtime: its tools registered, and its `requestState` verified by the codec. */
export function buildMcpServer(runtime: ServerRuntime, options: McpServerOptions = {}): McpServer {
  const { codec } = runtime;
  const { roundTimeoutMs } = options;
  const server = new McpServer(
    { name: 'caotang', title: 'Caotang', version: VERSION },
    {
      instructions: instructionsFor(runtime, roundTimeoutMs),
      // The tools are fixed when the project is opened (a write tool is listed only with --allow-writes), so the list never
      // changes during a session and no list-changed notice is ever sent. A degraded server's list is fixed too: after a recovery
      // its tools answer that the server must be restarted, rather than the list changing under the host. The 2025 initialize result says so, and the SDK's
      // default of `true` would promise a notice this server never sends.
      // The resources and prompts are the project's, so a degraded server has none. A server that cannot write never changes the project
      // while it runs, so it neither lists a change nor takes a subscription; with --allow-writes it does both (changes.ts).
      capabilities: {
        tools: { listChanged: false },
        ...('recovery' in runtime
          ? {}
          : {
              resources: { listChanged: runtime.session.allowWrites, subscribe: runtime.session.allowWrites },
              prompts: { listChanged: false },
              completions: {},
            }),
      },
      supportedProtocolVersions: [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS],
      requestState: { verify: (state, ctx) => codec.verify(state, ctx) },
      ...(roundTimeoutMs === undefined ? {} : { inputRequired: { roundTimeoutMs } }),
    },
  );
  if ('recovery' in runtime) {
    registerRecoveryTools(server, runtime, roundTimeoutMs);
  } else {
    registerCaotangTools(server, runtime, roundTimeoutMs);
    // The picture reads are listed in every mode: they never reach the bus and never save the folder (pictures.ts).
    registerPictureTools(server, runtime);
    registerCaotangResources(server, runtime);
    registerCaotangPrompts(server, runtime);
    if (options.live === true && runtime.session.allowWrites) forwardChanges(server, runtime);
  }
  return server;
}

export interface RunningHttpServer {
  /** The endpoint a host is configured with, e.g. `http://127.0.0.1:7433/mcp`. */
  readonly url: string;
  /** The port actually bound, which differs from the requested one when that was 0. */
  readonly port: number;
  close(): Promise<void>;
}

export interface HttpServerOptions {
  readonly port: number;
  readonly token: string;
  /**
   * The pause a desktop app can ask for while it saves (gate.ts). Without one the control endpoints answer 404: a server no app
   * started has no partner to coordinate with, and nothing to pause for.
   */
  readonly gate?: WriteGate;
  /**
   * Called when the last pause lifts, before the resume is answered and with the pause standing for its length: the app has just saved
   * the folder this server holds, so the server reads it again (session.ts `reload`) and the next request is answered from what the
   * save wrote. Absent on a server whose runtime has no project to read (a degraded one), where a save is not coordinated either.
   */
  readonly reloaded?: () => Promise<unknown>;
  /** The limit and idle time of the 2025-era connections, and the clock they read. Tests set them; a host does not. */
  readonly legacySessions?: LegacySessionOptions;
  /** How long a confirmation waits on a 2025-era connection. Defaults to {@linkcode LEGACY_ROUND_TIMEOUT_MS}; a test shortens it. */
  readonly roundTimeoutMs?: number;
}

/** The `Host` and `Origin` guards from the SDK, built once per listener. */
interface HeaderGuards {
  readonly host: ReturnType<typeof localhostHostValidation>;
  readonly origin: ReturnType<typeof localhostOriginValidation>;
}

class BodyTooLarge extends Error {
  constructor() {
    super(`the request body is larger than ${MAX_BODY_BYTES} bytes`);
    this.name = 'BodyTooLarge';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The pause a desktop app asks for while it saves (gate.ts, desktop.md §The project's own MCP server): `POST /control/pause` stops a
 * write from starting and answers only once the writes already admitted have finished, `POST /control/resume` lets them start again,
 * `POST /control/cancel` is a save that gave up and lets its pause go, and all three answer the pause as it now stands. The token is the
 * same one the MCP endpoint takes, so only the app that holds it can pause a server it started. Every call may name the pause in
 * `X-Caotang-Pause`, so a resume or a cancel can arrive before its pause and cancel it (gate.ts): a save that stopped waiting sends the
 * cancel, and it must let go even when the pause it belongs to is still in flight.
 *
 * A resume that lifts the last pause is the end of a save, so the folder is read again before it is answered, with the pause standing
 * for its length: what the save wrote is what every later request is answered from, and no write can start in the middle of that read.
 * A resume with a pause still standing answers at once — the folder is still being saved.
 */
async function answerControl(req: IncomingMessage, res: ServerResponse, path: string, options: HttpServerOptions): Promise<void> {
  if (!bearerAccepted(req.headers.authorization, options.token)) {
    sendJson(res, 401, { error: 'a bearer token is required: send Authorization: Bearer <token>' }, { 'WWW-Authenticate': 'Bearer realm="caotang-mcp"' });
    return;
  }
  const gate = options.gate;
  if (gate === undefined) {
    sendJson(res, 404, { error: 'this server was not started by Caotang for desktop, so nothing coordinates a save with it' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: `${path} takes POST` }, { Allow: 'POST' });
    return;
  }
  const lease = pauseLeaseOf(req);
  if (path === CONTROL_PAUSE) {
    sendJson(res, 200, await gate.pause(lease));
    return;
  }
  if (path === CONTROL_CANCEL) {
    // The app gave up waiting for this pause, so no save of it is coming: the pause is let go and the folder is not read again — there is
    // nothing of the app's to adopt, and that read would queue behind the very write the pause was waiting for.
    sendJson(res, 200, gate.resume(lease));
    return;
  }
  const state = gate.resume(lease);
  // A folder this server cannot read again leaves its copy as it was, and says so on stderr: the resume is still the app's to have,
  // because the save itself is on disk and a refused resume would stop a server that is answering.
  if (!state.paused) {
    // The save is over, but the folder is about to be read: the pause stands across the read too, so a write tool cannot start in the
    // middle of the copy being adopted — it would change the project this server is about to replace, and its save would then write the
    // adopted copy and lose it. Its refusal is the pause's own words: ask again once the save has finished. This pause is raised, not
    // waited for: a write already running is the save's own work finishing, and the lift below settles the promise either way.
    const held = gate.pause();
    try {
      await options.reloaded?.();
    } catch {
      // The reload reports what it could not read itself (folder.ts), and the app's save is on disk either way.
    } finally {
      gate.resume();
    }
    await held;
  }
  sendJson(res, 200, state);
}

/** The lease a control call names, or `undefined` for a call that names none: an over-long or empty value names no pause. */
function pauseLeaseOf(req: IncomingMessage): string | undefined {
  const value = req.headers[CONTROL_LEASE_HEADER];
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LEASE_LENGTH ? value : undefined;
}

/** One request, from the guards to the SDK's handler: what is admitted, and what is served. See the module comment for the order. */
async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ServerRuntime,
  options: HttpServerOptions,
  http: HttpSurface,
): Promise<void> {
  if (!http.guards.host(req, res)) return;
  if (!http.guards.origin(req, res)) return;

  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (path === CONTROL_PAUSE || path === CONTROL_RESUME || path === CONTROL_CANCEL) {
    await answerControl(req, res, path, options);
    return;
  }
  if (path !== MCP_PATH) {
    sendJson(res, 404, { error: `not found: the MCP endpoint is ${MCP_PATH}` });
    return;
  }
  if (!bearerAccepted(req.headers.authorization, options.token)) {
    sendJson(res, 401, { error: 'a bearer token is required: send Authorization: Bearer <token>' }, { 'WWW-Authenticate': 'Bearer realm="caotang-mcp"' });
    return;
  }

  const policy = policyOf(runtime, options.gate);
  let parsed: unknown;
  if (req.method === 'POST') {
    let text: string;
    try {
      text = await readBody(req);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      throw error;
    }
    try {
      parsed = JSON.parse(text);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not JSON' } });
      return;
    }
    const refused: RefusalResponse | undefined = Array.isArray(parsed) ? guardBatch(parsed, policy) : guardMessage(parsed, policy);
    if (refused !== undefined) {
      sendJson(res, 200, refused);
      return;
    }
  }

  // A write the guards let through is admitted here, so a pause asked for now waits for it instead of letting the app save over it.
  // The guard read the pause in this same turn, so a write cannot slip in behind a pause raised between the two. The release runs
  // however this request ends — an answer, a refusal, a deadline, a thrown error — and a request that carries no write admits
  // nothing, so a read never holds a pause.
  const gate = options.gate;
  const release = gate !== undefined && req.method === 'POST' && folderWrite(parsed, policy.allowWrites) !== undefined ? gate.admit() : undefined;
  try {
    await serveRequest(req, res, runtime, options, http, parsed);
  } finally {
    release?.();
  }
}

/** A guarded MCP request, served: a 2025-era connection's own server, a first `initialize`, or the handler for one request. */
async function serveRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ServerRuntime,
  options: HttpServerOptions,
  http: HttpSurface,
  parsed: unknown,
): Promise<void> {
  // A request that names a session belongs to a 2025-era connection, and only that connection can answer it.
  const session = req.headers['mcp-session-id'];
  if (typeof session === 'string') {
    if (await http.legacy.serve(session, req, res, parsed)) return;
    sendJson(res, 404, {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32001,
        message:
          'Session not found: this connection has closed or expired. A confirmation open on it ended too and nothing was written. Send initialize again, then ask for the change again.',
      },
    });
    return;
  }
  if (req.method === 'POST' && isInitializeRequest(parsed)) {
    const roundMs = options.roundTimeoutMs ?? LEGACY_ROUND_TIMEOUT_MS;
    const opened = await http.legacy.initialize(req, res, parsed, () => buildMcpServer(runtime, { roundTimeoutMs: roundMs, live: true }));
    if (!opened) {
      // A busy connection frees when its POST is answered, and an unanswered confirmation is answered at the deadline.
      const seconds = Math.ceil(roundMs / 1000);
      const { limit, busyCount } = http.legacy;
      sendJson(
        res,
        503,
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message:
              `Too many connections: all ${limit} 2025-era connections are busy (${busyCount} with a request open). ` +
              `A connection frees when its request is answered; a confirmation nobody answers ends after ${seconds} seconds. Try again in ${seconds} seconds.`,
          },
        },
        { 'Retry-After': String(seconds) },
      );
    }
    return;
  }

  // A POST's body is already read above, so it is handed over parsed, and the handler does not read the stream again.
  await http.serve(req, res, req.method === 'POST' ? parsed : undefined);
}

/** The per-listener pieces: the SDK's handler over the runtime, the 2025-era connections, and the header guards in front. */
interface HttpSurface {
  readonly guards: HeaderGuards;
  readonly serve: ReturnType<typeof toNodeHandler>;
  readonly handler: McpHttpHandler;
  readonly legacy: LegacySessions;
}

/**
 * Serves the MCP endpoint on 127.0.0.1 until closed. Port 0 takes an ephemeral port.
 *
 * The handler is the SDK's dual-era entry, `createMcpHandler`, with one fresh server per
 * request from `buildMcpServer`. It answers 2026-07-28 requests on the modern path, and a
 * 2025-era request that carries no session id statelessly. A 2025-era `initialize` opens a
 * connection in `legacy-sessions.ts` instead, and every later request that names its session
 * id goes to that connection, so the host can answer a confirmation on it. A first attempt
 * mounted `NodeStreamableHTTPServerTransport` directly, per request; the SDK's pinned
 * client then failed its `server/discover` probe, so the era-classifying entry is used.
 */
export async function startHttpServer(runtime: ServerRuntime, options: HttpServerOptions): Promise<RunningHttpServer> {
  const handler = createMcpHandler(() => buildMcpServer(runtime), {
    legacy: 'stateless',
    onerror: (error) => {
      process.stderr.write(`caotang-mcp: request error: ${error.message}\n`);
    },
  });
  const http: HttpSurface = {
    guards: { host: localhostHostValidation(), origin: localhostOriginValidation() },
    handler,
    serve: toNodeHandler(handler, {
      onerror: (error) => {
        process.stderr.write(`caotang-mcp: transport error: ${error.message}\n`);
      },
    }),
    legacy: new LegacySessions(options.legacySessions),
  };
  // A change the project's writes make reaches the hosts that listen on a 2026-07-28 stream; the 2025-era connections are served by their own servers.
  const stopForwarding = 'session' in runtime ? runtime.changes.on((change) => forwardToListeners(handler.notify, change)) : undefined;
  const listener = createServer((req, res) => {
    void answer(req, res, runtime, options, http).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
      else res.end();
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    listener.once('error', onError);
    listener.listen(options.port, '127.0.0.1', () => {
      listener.off('error', onError);
      resolveListen();
    });
  });

  const { port } = listener.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    port,
    close: async () => {
      stopForwarding?.();
      await new Promise<void>((resolveClose, rejectClose) => {
        listener.close((error) => (error === undefined || error === null ? resolveClose() : rejectClose(error)));
        listener.closeAllConnections();
      });
      await http.legacy.close();
      await handler.close();
    },
  };
}

/**
 * The stdio transport with the guard in front of it. The SDK's transport is wrapped,
 * not changed: an inbound message the guard refuses is answered on the way in, and
 * every other message is handed to whichever handler the SDK installed.
 */
class GuardedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: StdioServerTransport,
    private readonly refuse: (message: unknown) => RefusalResponse | undefined,
  ) {
    inner.onmessage = (message: JSONRPCMessage) => {
      const refusal = this.refuse(message);
      if (refusal !== undefined) {
        void inner.send(refusal as unknown as JSONRPCMessage);
        return;
      }
      this.onmessage?.(message);
    };
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error: Error) => this.onerror?.(error);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return this.inner.send(message);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/** Serves the MCP endpoint over this process's stdin and stdout, until stdin closes. */
export function startStdioServer(runtime: ServerRuntime): StdioServerHandle {
  const policy = policyOf(runtime);
  const transport = new GuardedStdioTransport(new StdioServerTransport(), (message) => guardMessage(message, policy));
  return serveStdio(() => buildMcpServer(runtime, { live: true }), { legacy: 'serve', transport });
}
