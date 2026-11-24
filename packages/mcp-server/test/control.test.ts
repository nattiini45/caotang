/**
 * The pause a desktop app asks for while it saves (gate.ts, desktop.md §The project's own MCP server): what the gate says, that a
 * pause waits for the writes the server admitted before it, and what the two control endpoints answer with and without the token.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createWriteGate, type WriteGate } from '../src/index.js';
import { connectClient, LANDING, resultJson, startFixture, type Fixture } from './support.js';

/** One control call, as the app makes it: a POST with the token, and the answer read as JSON. */
async function control(
  url: string,
  path: string,
  token: string | undefined,
  method = 'POST',
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = url.replace(/\/mcp$/, '');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(signal === undefined ? {} : { signal }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Lets every continuation queued so far run, so a pause that answered at once would have answered by now. */
async function settle(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits until a request has reached the server and changed what the condition reads. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never held');
}

describe('createWriteGate', () => {
  it('is not paused until asked, and says when a pause began', async () => {
    const gate = createWriteGate(() => new Date('2026-11-23T10:00:00.000Z'));
    expect(gate.paused()).toBe(false);
    expect(gate.state()).toEqual({ paused: false });
    expect(await gate.pause()).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
    expect(gate.paused()).toBe(true);
    expect(gate.resume()).toEqual({ paused: false });
    expect(gate.paused()).toBe(false);
  });

  it('keeps the first instant when asked twice, and lifts only when the second resume arrives', async () => {
    let now = new Date('2026-11-23T10:00:00.000Z');
    const gate = createWriteGate(() => now);
    await gate.pause();
    now = new Date('2026-11-23T10:00:05.000Z');
    expect((await gate.pause()).since).toBe('2026-11-23T10:00:00.000Z');
    // Two saves overlap: the first one finishing must not let a write start under the second.
    expect(gate.resume()).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
    expect(gate.paused()).toBe(true);
    expect(gate.resume()).toEqual({ paused: false });
    expect(gate.paused()).toBe(false);
    // A resume with nothing paused answers what the gate already says, and the next pause starts its own clock.
    expect(gate.resume()).toEqual({ paused: false });
    expect((await gate.pause()).since).toBe('2026-11-23T10:00:05.000Z');
  });

  it('does not answer a pause while a write it admitted is running, and answers the moment it releases', async () => {
    const gate = createWriteGate(() => new Date('2026-11-23T10:00:00.000Z'));
    const release = gate.admit();
    const paused = gate.pause();
    // The pause is raised before it answers: a write asked for now is refused, not admitted behind a barrier that has not drained yet.
    expect(gate.paused()).toBe(true);
    expect(gate.state()).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
    let answered = false;
    void paused.then(() => {
      answered = true;
    });
    await settle();
    expect(answered).toBe(false);
    release();
    expect(await paused).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
  });

  it('answers a pause at once when no write is in flight', async () => {
    const gate = createWriteGate(() => new Date('2026-11-23T10:00:00.000Z'));
    const paused = gate.pause();
    // Settled within the turn it was asked in, so an app saving over a folder with nothing of the server's in it never waits.
    expect(await Promise.race([paused, Promise.resolve('still waiting')])).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
  });

  it('drains two overlapping pauses only once, and still needs one resume for each', async () => {
    const gate = createWriteGate(() => new Date('2026-11-23T10:00:00.000Z'));
    const release = gate.admit();
    const first = gate.pause();
    const second = gate.pause();
    let answered = 0;
    void first.then(() => {
      answered += 1;
    });
    void second.then(() => {
      answered += 1;
    });
    await settle();
    expect(answered).toBe(0);
    expect(gate.state()).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
    release();
    expect(await first).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
    expect(await second).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
    expect(gate.paused()).toBe(true);
    expect(gate.resume()).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
    expect(gate.resume()).toEqual({ paused: false });
    expect(gate.paused()).toBe(false);
  });

  it('counts one release for each write it admitted, however often a release is called', async () => {
    const gate = createWriteGate(() => new Date('2026-11-23T10:00:00.000Z'));
    const first = gate.admit();
    const second = gate.admit();
    first();
    first();
    const paused = gate.pause();
    let answered = false;
    void paused.then(() => {
      answered = true;
    });
    await settle();
    expect(answered).toBe(false);
    second();
    expect(await paused).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
  });
});

describe('the control endpoints', () => {
  let fixture: Fixture;

  const start = async (gate: boolean): Promise<void> => {
    fixture = await startFixture({ label: 'control', allowWrites: true, seed: true, gate });
  };

  it('answers a pause to the token the server was started with', async () => {
    await start(true);
    try {
      const paused = await control(fixture.url, '/control/pause', fixture.token);
      expect(paused.status).toBe(200);
      expect(paused.body).toMatchObject({ paused: true });
      expect(fixture.gate?.paused()).toBe(true);
      const resumed = await control(fixture.url, '/control/resume', fixture.token);
      expect(resumed).toEqual({ status: 200, body: { paused: false } });
      expect(fixture.gate?.paused()).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('refuses a control call with no token, and takes POST only', async () => {
    await start(true);
    try {
      expect((await control(fixture.url, '/control/pause', undefined)).status).toBe(401);
      expect((await control(fixture.url, '/control/pause', 'not-the-token')).status).toBe(401);
      expect(fixture.gate?.paused()).toBe(false);
      expect((await control(fixture.url, '/control/pause', fixture.token, 'GET')).status).toBe(405);
      expect(fixture.gate?.paused()).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('says nothing is coordinating a save on a server no app started', async () => {
    await start(false);
    try {
      const answer = await control(fixture.url, '/control/pause', fixture.token);
      expect(answer.status).toBe(404);
      expect(String(answer.body['error'])).toMatch(/not started by Caotang for desktop/);
    } finally {
      await fixture.close();
    }
  });

  it('refuses a write while paused and lets a read through, then takes the write after a resume', async () => {
    await start(true);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const write = (): Promise<unknown> => client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } });
      // The project's own manifest is the check, because it is what the write lands in.
      const manifest = (): string => readFileSync(join(fixture.root, 'caotang.json'), 'utf8');
      // A read is never refused, whatever the pause says.
      const read = async (): Promise<string> => JSON.stringify(resultJson(await client.callTool({ name: 'doc.read', arguments: { doc: LANDING, response_format: 'detailed' } })));

      expect(await read()).toContain('The ferry was late, as always.');
      const before = manifest();

      await control(fixture.url, '/control/pause', fixture.token);
      const refused = (await write()) as { isError?: boolean; content?: { text?: string }[] };
      expect(refused.isError).toBe(true);
      expect(String(refused.content?.[0]?.text)).toMatch(/Caotang for desktop is saving to this folder/);
      expect(manifest()).toBe(before);
      expect(await read()).toContain('The ferry was late, as always.');

      await control(fixture.url, '/control/resume', fixture.token);
      const written = (await write()) as { isError?: boolean };
      expect(written.isError).toBeUndefined();
      expect(manifest()).not.toBe(before);
    } finally {
      await client.close();
      await fixture.close();
    }
  });
});

describe('a pause waits for the writes already running', () => {
  let fixture: Fixture;

  /** A gate whose admitted writes a test holds the release of, so it can prove what a pause waits for. */
  const holdingGate = (): { gate: WriteGate; held: (() => void)[] } => {
    const inner = createWriteGate(() => new Date('2026-11-23T10:00:00.000Z'));
    const held: (() => void)[] = [];
    return {
      held,
      gate: {
        paused: () => inner.paused(),
        state: () => inner.state(),
        resume: () => inner.resume(),
        pause: () => inner.pause(),
        // The server's own release is a no-op, so the write stays in flight until the test says it finished.
        admit: () => {
          held.push(inner.admit());
          return () => undefined;
        },
      },
    };
  };

  it('answers a pause only once the write the server admitted has finished', async () => {
    const { gate, held } = holdingGate();
    fixture = await startFixture({ label: 'control-drain', allowWrites: true, seed: true, gate });
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const written = (await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } })) as { isError?: boolean };
      expect(written.isError).toBeUndefined();
      // The request path admitted the write it let through, and its release is what a pause waits for.
      expect(held).toHaveLength(1);

      const answer = control(fixture.url, '/control/pause', fixture.token);
      let answered = false;
      void answer.then(
        () => {
          answered = true;
        },
        () => {
          answered = true;
        },
      );
      await until(() => gate.paused());
      await settle();
      expect(answered).toBe(false);

      held[0]?.();
      expect(await answer).toEqual({ status: 200, body: { paused: true, since: '2026-11-23T10:00:00.000Z' } });
      expect(gate.paused()).toBe(true);
      await control(fixture.url, '/control/resume', fixture.token);
      expect(gate.paused()).toBe(false);
    } finally {
      for (const release of held) release();
      await client.close();
      await fixture.close();
    }
  });

  it('admits no write for a read, so a pause during one answers at once', async () => {
    const { gate, held } = holdingGate();
    fixture = await startFixture({ label: 'control-read', allowWrites: true, seed: true, gate });
    const client = await connectClient(fixture.url, fixture.token);
    try {
      expect(await client.callTool({ name: 'doc.read', arguments: { doc: LANDING, response_format: 'detailed' } })).toBeDefined();
      expect(held).toHaveLength(0);
      const paused = await control(fixture.url, '/control/pause', fixture.token);
      expect(paused).toEqual({ status: 200, body: { paused: true, since: '2026-11-23T10:00:00.000Z' } });
      await control(fixture.url, '/control/resume', fixture.token);
    } finally {
      for (const release of held) release();
      await client.close();
      await fixture.close();
    }
  });

  it('lifts a pause whose answer the app gave up on, so the folder is not left paused', async () => {
    const { gate, held } = holdingGate();
    fixture = await startFixture({ label: 'control-abandoned', allowWrites: true, seed: true, gate });
    const client = await connectClient(fixture.url, fixture.token);
    try {
      await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } });
      expect(held).toHaveLength(1);

      // The app's own wait is shorter than a slow write: it drops the connection, saves nothing and sends no resume.
      const controller = new AbortController();
      const answer = control(fixture.url, '/control/pause', fixture.token, 'POST', controller.signal).catch(() => undefined);
      await until(() => gate.paused());
      controller.abort();
      await settle(50);
      held[0]?.();

      // The pause the server could not deliver is lifted, so the folder is free for the next save instead of paused until a restart.
      await until(() => !gate.paused());
      expect(await answer).toBeUndefined();

      // The next save's pause is its own: raised, answered, and lifted by its own resume.
      expect(await control(fixture.url, '/control/pause', fixture.token)).toEqual({
        status: 200,
        body: { paused: true, since: '2026-11-23T10:00:00.000Z' },
      });
      await control(fixture.url, '/control/resume', fixture.token);
      expect(gate.paused()).toBe(false);
    } finally {
      for (const release of held) release();
      await client.close();
      await fixture.close();
    }
  });
});
