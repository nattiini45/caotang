/**
 * What a write tells a subscribed host (extensibility.md §9): a notice for the notes a `notes.append` changed, a list change for a
 * restructure, on a 2026-07-28 listen stream, on a 2025-era connection and over stdio; nothing from a read-only server; and a
 * listening connection that cannot starve the table of 2025-era connections.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { buildMcpServer, createToolRuntime, openProject, startHttpServer } from '../src/index.js';
import { notesUri } from '../src/resources.js';
import {
  CHAPTER_ONE,
  LANDING,
  STORM,
  acceptConfirm,
  connectClient,
  removeDir,
  seedWriting,
  startFixture,
  tempDir,
  testToken,
  type Fixture,
} from './support.js';

const RENAME = { ops: [{ action: 'rename', node: STORM, title: 'The Gale' }] };

/** Waits until the check holds, or fails with what was seen. */
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const stop = Date.now() + ms;
  while (!check()) {
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Gives a quiet period for a notice that should not come. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

/**
 * The budget for every fixture below — explicit and per-test, never `vitest.config.ts`'s default.
 *
 * Each test starts a project fixture and a server over the wire (or the in-memory pair the stdio
 * tests use), and the two long notice tests also wait on the change feed. The fixture's cost is the
 * claim: seeding a writing project, opening it, starting the listener and connecting a real client.
 * Measured on one development machine under a loaded host (16 logical CPUs; another project's vitest
 * worker was using a core): the two long notice tests took **1 447 ms** and **1 499 ms** on the
 * first cold run of this file, then **439-600 ms** across three warm runs. In this package's own
 * suite (19 files, Vitest's default worker pool) they timed out at the 5 000 ms default; with a
 * 30 000 ms override the same suite passed, and those tests took **10 610 ms** and **7 718 ms**.
 * 30 000 ms clears every recorded figure with headroom and still fails a hang. Raising the config
 * default instead would move every other test's budget in the repo, which the timeout decision in
 * `packages/editor/test/dialect.test.ts` rules out and its guard rejects.
 */
const WIRE_FIXTURE_TIMEOUT = 30_000;

interface Seen {
  readonly updated: string[];
  listChanges: number;
}

function watch(client: Client): Seen {
  const seen: Seen = { updated: [], listChanges: 0 };
  client.setNotificationHandler('notifications/resources/updated', (notification) => {
    seen.updated.push(notification.params.uri);
  });
  client.setNotificationHandler('notifications/resources/list_changed', () => {
    seen.listChanges += 1;
  });
  return seen;
}

/** A 2025-era client over the HTTP endpoint, answering confirmations. */
function legacyClient(): Client {
  const client = new Client({ name: 'legacy-subscriber', version: '0.0.0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler('elicitation/create', () => ({ action: 'accept' as const, content: { confirmed: true } }));
  client.onerror = () => undefined;
  return client;
}

async function connectLegacy(fixture: Pick<Fixture, 'url' | 'token'>, client: Client = legacyClient()): Promise<Client> {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(fixture.url), { requestInit: { headers: { authorization: `Bearer ${fixture.token}` } } }),
  );
  return client;
}

const append = (client: Client, doc: string) => client.callTool({ name: 'notes.append', arguments: { doc, text: 'A line more.' } });

const opened: Fixture[] = [];
afterEach(async () => {
  for (const fixture of opened.splice(0)) await fixture.close();
});

async function writable(label: string): Promise<Fixture> {
  const fixture = await startFixture({ label, allowWrites: true, seed: true, writing: true });
  opened.push(fixture);
  return fixture;
}

describe('a 2026-07-28 listen stream', () => {
  it('is told of the notes a notes.append changed, and of a restructure, and of nothing it did not ask for', async () => {
    const fixture = await writable('sub-modern');
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      const seen = watch(client);
      const subscription = await client.listen({ resourceSubscriptions: [notesUri(LANDING)], resourcesListChanged: true });

      await append(client, STORM);
      await append(client, LANDING);
      await until(() => seen.updated.includes(notesUri(LANDING)), 'the notes notice');
      expect(seen.updated).toEqual([notesUri(LANDING)]);
      expect(seen.listChanges).toBe(0);

      await client.callTool({ name: 'binder.restructure', arguments: RENAME });
      await until(() => seen.listChanges > 0, 'the list change');
      expect(seen.listChanges).toBe(1);
      await subscription.close();
    } finally {
      await client.close();
    }
  }, WIRE_FIXTURE_TIMEOUT);

  it('is told nothing by a read', async () => {
    const fixture = await writable('sub-read');
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      const seen = watch(client);
      const subscription = await client.listen({ resourceSubscriptions: [notesUri(LANDING)], resourcesListChanged: true });
      await client.readResource({ uri: notesUri(LANDING) });
      await client.callTool({ name: 'doc.read', arguments: { doc: LANDING } });
      await client.callTool({ name: 'notes.read', arguments: { doc: LANDING } });
      await settle();
      expect(seen).toEqual({ updated: [], listChanges: 0 });
      await subscription.close();
    } finally {
      await client.close();
    }
  }, WIRE_FIXTURE_TIMEOUT);

  it('is told once when another program changes the folder and the writes stop', async () => {
    const fixture = await writable('sub-drift');
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      const seen = watch(client);
      const subscription = await client.listen({ resourcesListChanged: true });
      const docs = fixture.root;
      const file = join(docs, 'docs', `${LANDING}.md`);
      appendFileSync(file, '\nAnother program wrote this.\n');

      const refused = await append(client, LANDING);
      expect(refused.isError).toBe(true);
      await until(() => seen.listChanges > 0, 'the drift notice');
      await append(client, LANDING);
      await settle();
      expect(seen.listChanges).toBe(1);
      await subscription.close();
    } finally {
      await client.close();
    }
  }, WIRE_FIXTURE_TIMEOUT);
});

describe('a 2025-era connection', () => {
  it('is told of the notes it subscribed to, and of a list change, and of nothing else', async () => {
    const fixture = await writable('sub-legacy');
    const client = await connectLegacy(fixture);
    try {
      const seen = watch(client);
      expect(client.getServerCapabilities()?.resources).toMatchObject({ subscribe: true, listChanged: true });
      await client.subscribeResource({ uri: notesUri(LANDING) });

      await append(client, STORM);
      await append(client, LANDING);
      await until(() => seen.updated.includes(notesUri(LANDING)), 'the notes notice');
      expect(seen.updated).toEqual([notesUri(LANDING)]);

      await client.callTool({ name: 'binder.restructure', arguments: RENAME });
      await until(() => seen.listChanges > 0, 'the list change');

      await client.unsubscribeResource({ uri: notesUri(LANDING) });
      await append(client, LANDING);
      await settle();
      expect(seen.updated).toEqual([notesUri(LANDING)]);
    } finally {
      await client.close();
    }
  }, WIRE_FIXTURE_TIMEOUT);

  it('stops being told when the connection ends: the feed keeps no listener for a closed one', async () => {
    const fixture = await writable('sub-closed');
    // The HTTP listener's own forwarder to the 2026-07-28 streams is on the feed already.
    const feed = fixture.session.changes;
    const idle = feed.size;
    const transport = new StreamableHTTPClientTransport(new URL(fixture.url), { requestInit: { headers: { authorization: `Bearer ${fixture.token}` } } });
    const client = legacyClient();
    await client.connect(transport);
    await client.subscribeResource({ uri: notesUri(LANDING) });
    expect(feed.size).toBe(idle + 1);
    await transport.terminateSession();
    await client.close();
    await until(() => feed.size === idle, 'the listener to be removed');
  }, WIRE_FIXTURE_TIMEOUT);

  it('does not starve the table: connections that only listen are idle, and the oldest makes room for a new one', async () => {
    const root = tempDir('sub-table');
    await seedWriting(root);
    const session = await openProject({ root, allowWrites: true });
    const token = testToken();
    const server = await startHttpServer(createToolRuntime(session), { port: 0, token, legacySessions: { limit: 2 } });
    const hosts: Client[] = [];
    const idle = session.changes.size;
    try {
      for (let index = 0; index < 2; index += 1) {
        const client = await connectLegacy({ url: server.url, token });
        await client.subscribeResource({ uri: notesUri(LANDING) });
        hosts.push(client);
      }
      // Both hold a subscription and an open stream, and neither has a request in flight: the table is full and nothing is busy.
      const third = await connectLegacy({ url: server.url, token });
      hosts.push(third);
      expect((await third.listTools()).tools.length).toBeGreaterThan(0);
      // The oldest connection was closed to make room, and its listener went with it.
      expect(session.changes.size).toBe(idle + 2);
    } finally {
      for (const client of hosts) await client.close().catch(() => undefined);
      await server.close();
      await session.close();
      removeDir(root);
    }
  }, WIRE_FIXTURE_TIMEOUT);
});

describe('a read-only server', () => {
  it('advertises neither a subscription nor a list change, on either revision', async () => {
    const fixture = await startFixture({ label: 'sub-ro', allowWrites: false, seed: true, writing: true });
    opened.push(fixture);
    const modern = await connectClient(fixture.url, fixture.token);
    const legacy = await connectLegacy(fixture);
    try {
      for (const client of [modern, legacy]) {
        const resources = client.getServerCapabilities()?.resources;
        expect(resources?.subscribe).toBeFalsy();
        expect(resources?.listChanged).toBeFalsy();
        expect(client.getServerCapabilities()?.prompts).toBeDefined();
      }
      await expect(legacy.subscribeResource({ uri: notesUri(LANDING) })).rejects.toThrow();
    } finally {
      await modern.close();
      await legacy.close();
    }
  }, WIRE_FIXTURE_TIMEOUT);

  it('answers a listen request with nothing honoured', async () => {
    const fixture = await startFixture({ label: 'sub-ro-listen', allowWrites: false, seed: true, writing: true });
    opened.push(fixture);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const seen = watch(client);
      const subscription = await client.listen({ resourceSubscriptions: [notesUri(LANDING)], resourcesListChanged: true });
      await subscription.close();
      expect(seen).toEqual({ updated: [], listChanges: 0 });
    } finally {
      await client.close();
    }
  }, WIRE_FIXTURE_TIMEOUT);
});

describe('over stdio', () => {
  /** A server on one end of an in-memory pair, as `startStdioServer` builds it, and a client on the other. */
  async function pair(root: string, modern: boolean) {
    const session = await openProject({ root, allowWrites: true });
    const runtime = createToolRuntime(session);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => buildMcpServer(runtime, { live: true }), { legacy: 'serve', transport: serverSide });
    const client = new Client(
      { name: 'stdio-subscriber', version: '0.0.0' },
      { capabilities: { elicitation: {} }, ...(modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}) },
    );
    client.setRequestHandler('elicitation/create', () => ({ action: 'accept' as const, content: { confirmed: true } }));
    await client.connect(clientSide);
    return {
      session,
      client,
      async close() {
        await client.close();
        await handle.close();
        await session.close();
      },
    };
  }

  it('tells a 2026-07-28 listener of a write', async () => {
    const root = tempDir('sub-stdio-modern');
    await seedWriting(root);
    const host = await pair(root, true);
    try {
      const seen = watch(host.client);
      const subscription = await host.client.listen({ resourceSubscriptions: [notesUri(LANDING)], resourcesListChanged: true });
      await append(host.client, LANDING);
      await until(() => seen.updated.includes(notesUri(LANDING)), 'the notes notice');
      await host.client.callTool({ name: 'binder.restructure', arguments: { ops: [{ action: 'rename', node: CHAPTER_ONE, title: 'Part One' }] } });
      await until(() => seen.listChanges > 0, 'the list change');
      await subscription.close();
    } finally {
      await host.close();
      removeDir(root);
    }
  }, WIRE_FIXTURE_TIMEOUT);

  it('tells a 2025-era subscriber of a write', async () => {
    const root = tempDir('sub-stdio-legacy');
    await seedWriting(root);
    const host = await pair(root, false);
    try {
      const seen = watch(host.client);
      await host.client.subscribeResource({ uri: notesUri(LANDING) });
      await append(host.client, LANDING);
      await until(() => seen.updated.includes(notesUri(LANDING)), 'the notes notice');
    } finally {
      await host.close();
      removeDir(root);
    }
  }, WIRE_FIXTURE_TIMEOUT);
});
