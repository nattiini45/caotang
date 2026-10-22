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
import { guardBatch, guardMessage, type RefusalResponse } from './guard.js';
import { LegacySessions, type LegacySessionOptions } from './legacy-sessions.js';
import { registerCaotangTools, type ToolRuntime } from './tools.js';
import type { ProjectSession } from './session.js';
import { MCP_PATH, VERSION } from './version.js';

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
  'Caotang is a writing project. Read it first: project.overview for the summary, then binder.read_tree for the structure, and doc.read for a document. ' +
  'Writes are exposed only when the project was started with --allow-writes. A write tool whose description starts with "Requires user confirmation." ' +
  'asks the user to confirm it in the host before it changes anything. The other write tools apply at once. ' +
  'A refused call says why, and the corrective step is in the refusal.';

/** The instructions of a connection whose confirmations wait `roundMs`: they say how long, so a host can tell the user. */
function instructionsFor(roundMs: number | undefined): string {
  if (roundMs === undefined) return INSTRUCTIONS;
  const seconds = Math.ceil(roundMs / 1000);
  return `${INSTRUCTIONS} A confirmation waits ${seconds} seconds for the user's answer; after that the call fails, nothing changes, and the call can be made again.`;
}

/** Everything a server needs: the session, and the confirmation machinery bound to this process. */
export function createToolRuntime(session: ProjectSession): ToolRuntime {
  return { session, codec: createRoundCodec(), ledger: createConfirmLedger() };
}

/**
 * The stateless revision this server is built for (extensibility.md §9). The SDK
 * only selects a 2026 revision through `server/discover`, and only when the server
 * lists it, so it is listed ahead of the 2025 entries. Those stay, so a 2025-era client
 * still negotiates the handshake it knows.
 */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

export interface McpServerOptions {
  /**
   * How long a confirmation waits for its answer on this server's 2025-era connection, in milliseconds. Left out, the
   * SDK's default stands and the question and the instructions name no deadline. The SDK takes this option on the
   * server, not on `createMcpHandler`, which has no such option.
   */
  readonly roundTimeoutMs?: number;
}

/** A fresh MCP server over the runtime: its tools registered, and its `requestState` verified by the codec. */
export function buildMcpServer(runtime: ToolRuntime, options: McpServerOptions = {}): McpServer {
  const { codec } = runtime;
  const { roundTimeoutMs } = options;
  const server = new McpServer(
    { name: 'caotang', title: 'Caotang', version: VERSION },
    {
      instructions: instructionsFor(roundTimeoutMs),
      // The tools are fixed when the project is opened (a write tool is listed only with --allow-writes), so the list never
      // changes during a session and no list-changed notice is ever sent. The 2025 initialize result says so, and the SDK's
      // default of `true` would promise a notice this server never sends.
      capabilities: { tools: { listChanged: false } },
      supportedProtocolVersions: [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS],
      requestState: { verify: (state, ctx) => codec.verify(state, ctx) },
      ...(roundTimeoutMs === undefined ? {} : { inputRequired: { roundTimeoutMs } }),
    },
  );
  registerCaotangTools(server, runtime, roundTimeoutMs);
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

/** One request, from the guards to the SDK's handler. See the module comment for the order. */
async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ToolRuntime,
  options: HttpServerOptions,
  http: HttpSurface,
): Promise<void> {
  if (!http.guards.host(req, res)) return;
  if (!http.guards.origin(req, res)) return;

  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (path !== MCP_PATH) {
    sendJson(res, 404, { error: `not found: the MCP endpoint is ${MCP_PATH}` });
    return;
  }
  if (!bearerAccepted(req.headers.authorization, options.token)) {
    sendJson(res, 401, { error: 'a bearer token is required: send Authorization: Bearer <token>' }, { 'WWW-Authenticate': 'Bearer realm="caotang-mcp"' });
    return;
  }

  const policy = { allowWrites: runtime.session.allowWrites };
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
    const opened = await http.legacy.initialize(req, res, parsed, () => buildMcpServer(runtime, { roundTimeoutMs: roundMs }));
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
export async function startHttpServer(runtime: ToolRuntime, options: HttpServerOptions): Promise<RunningHttpServer> {
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
export function startStdioServer(runtime: ToolRuntime): StdioServerHandle {
  const policy = { allowWrites: runtime.session.allowWrites };
  const transport = new GuardedStdioTransport(new StdioServerTransport(), (message) => guardMessage(message, policy));
  return serveStdio(() => buildMcpServer(runtime), { legacy: 'serve', transport });
}
