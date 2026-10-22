/**
 * The 2025-era connections over Streamable HTTP (extensibility.md §9, and the legacy path of D17).
 *
 * A 2026-07-28 request carries its capabilities with every request, so the stateless entry serves it with a fresh
 * server each time, and nothing is kept between requests. A 2025-era host is different. It declares its capabilities
 * once, on `initialize`, and it answers the server's questions on the connection the server asked on. A write-confirm
 * asks one through an elicitation sent on that connection, and the answer comes back as a separate POST. A fresh server
 * per POST cannot receive that answer, so the connection has to outlive its first request, as it does over stdio.
 *
 * This table keeps it. An `initialize` opens a connection: one server and one stateful transport, under a session id
 * that the transport returns in `Mcp-Session-Id`. The host sends that id on each later request, and the request goes to
 * the same transport. A connection ends when the host sends DELETE, when it has been idle too long, or when it is
 * evicted to keep the table within its limit. The table holds no project data. Each entry is a transport and the
 * server built over the runtime, and the capabilities the handshake declared are the ones that server recorded.
 *
 * The table is bounded in two ways. It holds at most `limit` connections, and a connection idle for `idleMs` is closed.
 * A connection with a POST still in flight is neither expired nor evicted, because that POST may be waiting for a
 * person to answer a confirmation. That wait ends at the server's round timeout (server.ts, LEGACY_ROUND_TIMEOUT_MS,
 * 60 seconds), when the POST is answered with a failed result and the connection is idle again. When every connection is
 * busy and the table is full, a new `initialize` is refused with a 503 that names the limit, the busy count and the wait.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';

/** Most 2025-era connections held at once. A connection past this evicts the idle one used least recently. */
export const LEGACY_SESSION_LIMIT = 16;

/** How long a connection may stay idle before it is closed. A request on it renews the time. */
export const LEGACY_SESSION_IDLE_MS = 30 * 60 * 1000;

export interface LegacySessionOptions {
  /** Most connections held at once. Defaults to {@linkcode LEGACY_SESSION_LIMIT}. */
  readonly limit?: number;
  /** Idle time, in milliseconds, before a connection is closed. Defaults to {@linkcode LEGACY_SESSION_IDLE_MS}. */
  readonly idleMs?: number;
  /** The clock, in milliseconds. Defaults to `Date.now`; a test passes its own. */
  readonly now?: () => number;
}

interface Connection {
  readonly server: McpServer;
  readonly transport: NodeStreamableHTTPServerTransport;
  lastSeen: number;
  /** POSTs whose answer is still being written. A connection with one is never expired or evicted. */
  busy: number;
}

/** The connections a 2025-era host holds with this server, keyed by `Mcp-Session-Id`. */
export class LegacySessions {
  private readonly connections = new Map<string, Connection>();
  /** Most connections held at once. */
  readonly limit: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(options: LegacySessionOptions = {}) {
    this.limit = options.limit ?? LEGACY_SESSION_LIMIT;
    this.idleMs = options.idleMs ?? LEGACY_SESSION_IDLE_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.limit) || this.limit < 1) throw new RangeError(`legacySessions.limit must be a positive integer (got ${this.limit})`);
    if (!Number.isFinite(this.idleMs) || this.idleMs <= 0) throw new RangeError(`legacySessions.idleMs must be a positive number (got ${this.idleMs})`);
  }

  /** How many connections are held now, after the idle ones are closed. */
  get size(): number {
    this.sweep();
    return this.connections.size;
  }

  /** How many connections have a POST in flight now, after the idle ones are closed. */
  get busyCount(): number {
    this.sweep();
    let busy = 0;
    for (const connection of this.connections.values()) if (connection.busy > 0) busy += 1;
    return busy;
  }

  /** Whether a live connection holds this session id. */
  has(id: string): boolean {
    this.sweep();
    return this.connections.has(id);
  }

  /**
   * Answers an `initialize` request by opening a connection for it. The new connection keeps the session id the
   * transport returns, and it is kept only if the handshake succeeded. Resolves to false, without answering the
   * request, when the table is full and every connection in it is busy.
   */
  async initialize(req: IncomingMessage, res: ServerResponse, parsedBody: unknown, build: () => McpServer): Promise<boolean> {
    this.sweep();
    if (this.connections.size >= this.limit && !this.evictIdle()) return false;

    const id = randomUUID();
    const server = build();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessionclosed: () => this.forget(id),
    });
    const connection: Connection = { server, transport, lastSeen: this.now(), busy: 1 };
    this.connections.set(id, connection);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      this.forget(id);
      throw error;
    } finally {
      connection.busy -= 1;
    }
    // A handshake the transport answers without a 200 opened nothing the host can use, so it is not kept: a 406 when the
    // Accept header does not name both JSON and a stream, or a 415 when the body is not JSON. The SDK never refuses a
    // revision on this path. It answers an unknown one with a revision of its own.
    if (res.statusCode !== 200 || transport.sessionId !== id) this.forget(id);
    else connection.lastSeen = this.now();
    return true;
  }

  /**
   * Serves a request on a live connection, and resolves to false, without answering it, when the id holds no live
   * connection. The caller answers that case with a 404, so the host knows to send `initialize` again.
   */
  async serve(id: string, req: IncomingMessage, res: ServerResponse, parsedBody: unknown): Promise<boolean> {
    this.sweep();
    const connection = this.connections.get(id);
    if (connection === undefined) return false;
    const posting = req.method === 'POST';
    connection.lastSeen = this.now();
    if (posting) connection.busy += 1;
    try {
      await connection.transport.handleRequest(req, res, parsedBody);
    } finally {
      if (posting) connection.busy -= 1;
      connection.lastSeen = this.now();
    }
    return true;
  }

  /** Closes one connection and forgets it. A session id that is not held is ignored. */
  forget(id: string): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    void connection.server.close().catch(() => undefined);
  }

  /** Closes every connection. Used when the listener stops. */
  async close(): Promise<void> {
    for (const id of [...this.connections.keys()]) this.forget(id);
  }

  /** Closes the idle connection that was used longest ago, and reports whether one was closed. */
  private evictIdle(): boolean {
    let oldest: { id: string; lastSeen: number } | undefined;
    for (const [id, connection] of this.connections) {
      if (connection.busy > 0) continue;
      if (oldest === undefined || connection.lastSeen < oldest.lastSeen) oldest = { id, lastSeen: connection.lastSeen };
    }
    if (oldest === undefined) return false;
    this.forget(oldest.id);
    return true;
  }

  /** Closes every idle connection that has been idle for `idleMs`. */
  private sweep(): void {
    const now = this.now();
    for (const [id, connection] of this.connections) {
      if (connection.busy === 0 && now - connection.lastSeen >= this.idleMs) this.forget(id);
    }
  }
}
