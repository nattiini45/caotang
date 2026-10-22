/**
 * A 2025-era host over Streamable HTTP (extensibility.md §9 and D17). The host opens a connection with `initialize`,
 * the connection keeps the session the host's confirmation answers come back on, and each test states one property of
 * those connections (legacy-sessions.ts). The client is the SDK's own 2025 client, on a real loopback port.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { Client as LegacyClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, ElicitRequestParams, ElicitResult } from '@modelcontextprotocol/client';
import { parseDocumentFile } from '@caotang/store';

import {
  createToolRuntime,
  LEGACY_ROUND_TIMEOUT_MS,
  openProject,
  startHttpServer,
  type LegacySessionOptions,
  type ProjectSession,
  type RunningHttpServer,
} from '../src/index.js';
import {
  acceptConfirm,
  cancelConfirm,
  CHAPTER_ONE,
  declineConfirm,
  folderBytes,
  jsonRpcOf,
  removeDir,
  resultJson,
  seedProject,
  tempDir,
  testToken,
  type Answer,
} from './support.js';

/** A project in a temporary folder, served on an ephemeral port with the given limits for the 2025-era connections. */
interface Booted {
  readonly root: string;
  readonly session: ProjectSession;
  readonly server: RunningHttpServer;
  readonly token: string;
  /** The nonces the server remembered an answer for. A round that timed out remembers none. */
  readonly remembered: string[];
  close(): Promise<void>;
}

const booted: Booted[] = [];

async function boot(label: string, legacySessions?: LegacySessionOptions, roundTimeoutMs?: number): Promise<Booted> {
  const root = tempDir(label);
  await seedProject(root, 'The Lighthouse Keeper');
  const session = await openProject({ root, allowWrites: true });
  const token = testToken();
  const base = createToolRuntime(session);
  const remembered: string[] = [];
  const runtime = {
    ...base,
    ledger: {
      recall: base.ledger.recall,
      remember: (nonce: string, answer: Promise<CallToolResult>, expiresAt: number, now: number): void => {
        remembered.push(nonce);
        base.ledger.remember(nonce, answer, expiresAt, now);
      },
    },
  };
  const server = await startHttpServer(runtime, {
    port: 0,
    token,
    ...(legacySessions === undefined ? {} : { legacySessions }),
    ...(roundTimeoutMs === undefined ? {} : { roundTimeoutMs }),
  });
  const fixture: Booted = {
    root,
    session,
    server,
    token,
    remembered,
    async close() {
      await server.close();
      await session.close();
      removeDir(root);
    },
  };
  booted.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of booted.splice(0)) await fixture.close();
});

/** A 2025-era client on the given server. With `answer`, it declares elicitation and answers each question through it. */
interface Host {
  readonly client: LegacyClient;
  readonly transport: StreamableHTTPClientTransport;
  /** The questions the server asked this host, in order. */
  readonly asked: ElicitRequestParams[];
}

async function connectHost(fixture: Booted, answer?: Answer): Promise<Host> {
  const asked: ElicitRequestParams[] = [];
  const client = new LegacyClient(
    { name: 'legacy-host-test', version: '0.0.0' },
    { capabilities: answer === undefined ? {} : { elicitation: {} }, versionNegotiation: { mode: 'legacy' } },
  );
  if (answer !== undefined) {
    client.setRequestHandler('elicitation/create', (request): ElicitResult | Promise<ElicitResult> => {
      asked.push(request.params);
      return answer(request.params);
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(fixture.server.url), {
    requestInit: { headers: { authorization: `Bearer ${fixture.token}` } },
  });
  await client.connect(transport);
  return { client, transport, asked };
}

/**
 * Lets the server finish the streams it has answered. A client reads a response's last bytes before the server has closed
 * the stream behind them, and a connection that is still closing counts as busy, so an eviction that follows at once could
 * pick a different connection than the one this test means. Both sides share one event loop here, so a short wait is the
 * honest way to let the order settle.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/** Connects a host, retrying for a moment while the table has no room. A refused handshake is a 503 the client throws on. */
async function connectWhenRoom(fixture: Booted): Promise<Host> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await connectHost(fixture);
    } catch (error) {
      if (attempt >= 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/**
 * A raw POST to the endpoint, with the session header when given. The body is a JSON-RPC message. The answer is read to
 * its end, because a response left unread keeps its stream, and so its request, open on the server.
 */
async function post(
  fixture: Booted,
  message: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<{ status: number; retryAfter: string | null; message: Record<string, unknown> | undefined }> {
  const response = await fetch(fixture.server.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fixture.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    },
    body: JSON.stringify(message),
  });
  const answered = await jsonRpcOf(response).catch(() => undefined);
  return { status: response.status, retryAfter: response.headers.get('retry-after'), message: answered };
}

/** An `initialize` for a newcomer, sent raw so a test reads the status and the body, not a client's error. */
const HANDSHAKE = {
  jsonrpc: '2.0',
  id: 14,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-newcomer', version: '0.0.0' } },
};

/** A `doc.import` call's arguments, the same write in every test. */
const IMPORT = (title: string): { name: string; arguments: Record<string, unknown> } => ({
  name: 'doc.import',
  arguments: { parent: CHAPTER_ONE, title, body: `The body of ${title}.` },
});

describe('a 2025-era host confirms a write over HTTP', () => {
  it('accepted: the host is asked once, and the document is written before the result returns', async () => {
    const fixture = await boot('legacy-accept');
    const host = await connectHost(fixture, acceptConfirm);
    try {
      const result = await host.client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Legacy', body: 'Written over HTTP.' } });
      expect(result.isError).not.toBe(true);
      expect(host.asked).toHaveLength(1);
      expect(host.asked[0]?.message).toContain('import "Legacy"');

      const doc = (resultJson(result)['data'] as { doc: { id: string; title: string } }).doc;
      expect(doc.title).toBe('Legacy');
      const written = parseDocumentFile(readFileSync(join(fixture.root, 'docs', `${doc.id}.md`), 'utf8'));
      expect(written.body).toBe('Written over HTTP.');
    } finally {
      await host.client.close();
    }
    // A full parallel run loads the machine, and this test's HTTP round trip ran past the default 5 s under it (it passes alone in about 2.5 s).
  }, 30_000);

  // The chapter rule: a document imported directly under the manuscript is refused in the
  // binder's words before the host is asked, and nothing is written.
  it('an import directly under the manuscript is refused before the host is asked, and nothing is written', async () => {
    const fixture = await boot('legacy-chapterless');
    const host = await connectHost(fixture, acceptConfirm);
    try {
      const before = folderBytes(fixture.root);
      const result = await host.client.callTool({ name: 'doc.import', arguments: { parent: 'manuscript', title: 'Loose', body: 'Words.' } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('A document goes inside a chapter, not directly under the manuscript.');
      expect(host.asked).toHaveLength(0);
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await host.client.close();
    }
  }, 30_000);

  it('declined: nothing is written, the result says so, and the folder keeps its bytes', async () => {
    const fixture = await boot('legacy-decline');
    const host = await connectHost(fixture, declineConfirm);
    try {
      const before = folderBytes(fixture.root);
      const treeBefore = fixture.session.state.manifest.tree.length;
      const result = await host.client.callTool(IMPORT('Declined'));
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain('"written":false');
      expect(host.asked).toHaveLength(1);
      expect(folderBytes(fixture.root)).toEqual(before);
      expect(fixture.session.state.manifest.tree.length).toBe(treeBefore);
    } finally {
      await host.client.close();
    }
  });

  it('cancelled: nothing is written either, and the call completes without an error', async () => {
    const fixture = await boot('legacy-cancel');
    const host = await connectHost(fixture, cancelConfirm);
    try {
      const before = folderBytes(fixture.root);
      const result = await host.client.callTool(IMPORT('Cancelled'));
      expect(JSON.stringify(result.structuredContent)).toContain('"status":"cancelled"');
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await host.client.close();
    }
  });

  it('a host that did not declare elicitation is refused before anything is written, and is never asked', async () => {
    const fixture = await boot('legacy-no-elicit');
    const host = await connectHost(fixture);
    try {
      const before = folderBytes(fixture.root);
      const result = await host.client.callTool(IMPORT('Never'));
      expect(result.isError).toBe(true);
      expect(JSON.stringify(resultJson(result))).toContain('did not declare elicitation support');
      expect(host.asked).toHaveLength(0);
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await host.client.close();
    }
  });

  it('a call that names no session is refused, and the refusal names the handshake and the stdio route', async () => {
    const fixture = await boot('legacy-sessionless');
    const before = folderBytes(fixture.root);
    const answer = await post(fixture, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: IMPORT('Sessionless') }, undefined);
    const result = answer.message?.['result'] as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const error = (JSON.parse(result.content[0]?.text ?? '{}') as { error: Record<string, unknown> }).error;
    expect(String(error['correctiveHint'])).toContain('Mcp-Session-Id');
    expect(String(error['correctiveHint'])).toContain('--stdio');
    expect(folderBytes(fixture.root)).toEqual(before);
  });
});

describe('the 2025-era connections are kept, bounded and closed', () => {
  it('a session id no connection holds is answered 404, so the host knows to send initialize again', async () => {
    const fixture = await boot('legacy-unknown');
    const answer = await post(fixture, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'not-a-session');
    expect(answer.status).toBe(404);
    const error = answer.message?.['error'] as { message: string } | undefined;
    expect(error?.message).toContain('Session not found');
  });

  it('the host ends its connection with DELETE, and the id answers 404 afterwards', async () => {
    const fixture = await boot('legacy-delete');
    const host = await connectHost(fixture);
    const sessionId = host.transport.sessionId;
    expect(sessionId).toBeTypeOf('string');
    const live = await post(fixture, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, sessionId);
    expect(live.status).toBe(200);
    // The client ends a session only when asked to: close() leaves the connection open, terminateSession() sends the DELETE.
    await host.transport.terminateSession();
    const after = await post(fixture, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, sessionId);
    expect(after.status).toBe(404);
    await host.client.close();
  });

  it('a connection idle for longer than its limit is closed, and a request that comes in time keeps it open', async () => {
    let clock = 0;
    const fixture = await boot('legacy-idle', { idleMs: 1000, now: () => clock });
    const host = await connectHost(fixture);
    await settle();
    try {
      const sessionId = host.transport.sessionId ?? '';
      // The connection was last used at 0. A request at 999 is inside its second, and renews it; one at 1500 is inside it again.
      clock = 999;
      expect((await post(fixture, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, sessionId)).status).toBe(200);
      clock = 1500;
      expect((await post(fixture, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, sessionId)).status).toBe(200);
      // Nothing reached it for 1100, which is past the limit.
      clock = 2600;
      expect((await post(fixture, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, sessionId)).status).toBe(404);
    } finally {
      await host.client.close().catch(() => undefined);
    }
  });

  it('the table holds at most its limit: the connection used least recently is the one closed', async () => {
    let clock = 0;
    const fixture = await boot('legacy-limit', { limit: 2, idleMs: 60_000, now: () => clock });
    // The SDK host opens its standalone GET stream just after the handshake, and a request counts as use, so each host
    // is settled at the moment it connects, before the clock moves on.
    clock = 1;
    const first = await connectHost(fixture);
    await settle();
    clock = 2;
    const second = await connectHost(fixture);
    await settle();
    clock = 3;
    await post(fixture, { jsonrpc: '2.0', id: 8, method: 'tools/list' }, first.transport.sessionId);
    await settle();
    clock = 4;
    const third = await connectHost(fixture);
    await settle();
    try {
      clock = 5;
      // The first was used at 3, the second last at 2, so the second is the one the third connection displaces.
      expect((await post(fixture, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, second.transport.sessionId)).status).toBe(404);
      expect((await post(fixture, { jsonrpc: '2.0', id: 10, method: 'tools/list' }, first.transport.sessionId)).status).toBe(200);
      expect((await post(fixture, { jsonrpc: '2.0', id: 11, method: 'tools/list' }, third.transport.sessionId)).status).toBe(200);
    } finally {
      await first.client.close().catch(() => undefined);
      await second.client.close().catch(() => undefined);
      await third.client.close().catch(() => undefined);
    }
  });

  it('a connection with a confirmation still open is never closed to make room, and a new host is refused while every connection is busy', async () => {
    // The holder's question is asked, and held open until the test answers it. Resolving `asked` says it is on the wire.
    let asked: () => void = () => undefined;
    const questionAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let release: (answer: ElicitResult) => void = () => undefined;
    const pending = new Promise<ElicitResult>((resolve) => {
      release = resolve;
    });
    const fixture = await boot('legacy-busy', { limit: 1 });
    const holder = await connectHost(fixture, () => {
      asked();
      return pending;
    });
    const running = holder.client.callTool(IMPORT('Waiting'));
    try {
      await questionAsked;
      // The holder's confirmation is open, so its connection is busy and the table is full: a newcomer's handshake is refused
      // with a 503 that says why. It is sent raw, so the test reads the status and the body, not a client's error.
      const refused = await post(fixture, HANDSHAKE, undefined);
      expect(refused.status).toBe(503);
      expect(JSON.stringify(refused.message)).toContain('Too many connections');
      expect(JSON.stringify(refused.message)).toContain('all 1 2025-era connections are busy (1 with a request open)');

      release({ action: 'accept', content: { confirmed: true } });
      const result = await running;
      expect(result.isError).not.toBe(true);

      // Once the answer is written the holder is idle, and its place can be given up. The holder's POST may still be
      // closing its stream when the result arrives, so the newcomer is retried for a moment rather than refused at once.
      const next = await connectWhenRoom(fixture);
      expect(next.transport.sessionId).toBeTypeOf('string');
      await next.client.close();
    } finally {
      release({ action: 'decline' });
      await running.catch(() => undefined);
      await holder.client.close().catch(() => undefined);
    }
  });

  it('two handshakes get two sessions, and each keeps its own', async () => {
    const fixture = await boot('legacy-fresh-ids');
    const first = await connectHost(fixture);
    const second = await connectHost(fixture);
    try {
      expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
      expect((await post(fixture, { jsonrpc: '2.0', id: 12, method: 'tools/list' }, first.transport.sessionId)).status).toBe(200);
      expect((await post(fixture, { jsonrpc: '2.0', id: 13, method: 'tools/list' }, second.transport.sessionId)).status).toBe(200);
    } finally {
      await first.client.close();
      await second.client.close();
    }
  });
});

describe("an unanswered confirmation ends at the server's own deadline", () => {
  /** A host whose writer never answers: the question is on the wire, and the answer is withheld until the test ends. */
  function silentHost(): { answer: Answer; asked: Promise<void>; release: () => void } {
    let asked: () => void = () => undefined;
    const questionAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let release: (answer: ElicitResult) => void = () => undefined;
    const pending = new Promise<ElicitResult>((resolve) => {
      release = resolve;
    });
    return {
      answer: () => {
        asked();
        return pending;
      },
      asked: questionAsked,
      release: () => release({ action: 'decline' }),
    };
  }

  it("the server holds a confirmation for 60 seconds by default, not the SDK's ten minutes", () => {
    expect(LEGACY_ROUND_TIMEOUT_MS).toBe(60_000);
  });

  it('the host gets a failed result at the deadline, nothing is written, and the connection and its place are free again', async () => {
    const silent = silentHost();
    const fixture = await boot('legacy-timeout', { limit: 1 }, 300);
    const holder = await connectHost(fixture, silent.answer);
    try {
      const before = folderBytes(fixture.root);
      const result = await holder.client.callTool(IMPORT('Unanswered'));
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("Fulfilling input required by 'tools/call' failed: Request timed out");
      expect(holder.asked).toHaveLength(1);
      expect(folderBytes(fixture.root)).toEqual(before);
      expect(fixture.remembered).toEqual([]);

      // The POST is answered, so the connection is idle, and the one place of this table can be given to a newcomer.
      const next = await connectWhenRoom(fixture);
      expect(next.transport.sessionId).toBeTypeOf('string');
      await next.client.close();
    } finally {
      silent.release();
      await holder.client.close().catch(() => undefined);
    }
  }, 30_000);

  it('the retry after a timeout asks a fresh question, and an answer inside the deadline writes once', async () => {
    let calls = 0;
    const silent = silentHost();
    const fixture = await boot('legacy-retry', undefined, 300);
    const host = await connectHost(fixture, (params) => {
      calls += 1;
      return calls === 1 ? silent.answer(params) : acceptConfirm(params);
    });
    try {
      const first = await host.client.callTool(IMPORT('Twice'));
      expect(first.isError).toBe(true);
      expect(fixture.remembered).toEqual([]);

      const second = await host.client.callTool(IMPORT('Twice'));
      expect(second.isError).not.toBe(true);
      expect(host.asked).toHaveLength(2);
      expect(fixture.remembered).toHaveLength(1);
      expect(fixture.session.state.manifest.tree.filter((node) => node.title === 'Twice')).toHaveLength(1);
    } finally {
      silent.release();
      await host.client.close().catch(() => undefined);
    }
  }, 30_000);

  it('a full table refuses initialize with the limit, the busy count and the wait, and a Retry-After', async () => {
    const silent = silentHost();
    const fixture = await boot('legacy-503', { limit: 1 }, 60_000);
    const holder = await connectHost(fixture, silent.answer);
    const running = holder.client.callTool(IMPORT('Waiting'));
    try {
      await silent.asked;
      const refused = await post(fixture, HANDSHAKE, undefined);
      expect(refused.status).toBe(503);
      expect(refused.retryAfter).toBe('60');
      const error = refused.message?.['error'] as { code: number; message: string };
      expect(refused.message?.['id']).toBeNull();
      expect(error.code).toBe(-32000);
      expect(error.message).toContain('all 1 2025-era connections are busy (1 with a request open)');
      expect(error.message).toContain('60 seconds');
    } finally {
      silent.release();
      await running.catch(() => undefined);
      await holder.client.close().catch(() => undefined);
    }
  }, 30_000);

  it('the question and the initialize instructions say how long the question waits', async () => {
    const fixture = await boot('legacy-says', undefined, 45_000);
    const host = await connectHost(fixture, declineConfirm);
    try {
      expect(host.client.getInstructions()).toContain('A confirmation waits 45 seconds');
      await host.client.callTool(IMPORT('Says'));
      expect(host.asked[0]?.message).toContain('This question waits 45 seconds');
    } finally {
      await host.client.close();
    }
  }, 30_000);
});
