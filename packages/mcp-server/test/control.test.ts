/**
 * The pause a desktop app asks for while it saves (gate.ts, desktop.md §The project's own MCP server): what the gate says, and
 * what the two control endpoints answer with and without the token.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readProject, writeProject } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { NodeArtifactFs, createWriteGate } from '../src/index.js';
import { connectClient, LANDING, LANDING_BODY, OPENED, resultJson, startFixture, type Fixture } from './support.js';

/** The text the app's own save writes into the landing document, after the server opened it. */
const APP_SAVED_BODY = 'The ferry was early, for once.';

/** One control call, as the app makes it: a POST with the token, and the answer read as JSON. */async function control(url: string, path: string, token: string | undefined, method = 'POST'): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = url.replace(/\/mcp$/, '');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('createWriteGate', () => {
  it('is not paused until asked, and says when a pause began', () => {
    const gate = createWriteGate(() => new Date('2026-11-23T10:00:00.000Z'));
    expect(gate.paused()).toBe(false);
    expect(gate.state()).toEqual({ paused: false });
    expect(gate.pause()).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
    expect(gate.paused()).toBe(true);
    expect(gate.resume()).toEqual({ paused: false });
    expect(gate.paused()).toBe(false);
  });

  it('keeps the first instant when asked twice, and lifts only when the second resume arrives', () => {
    let now = new Date('2026-11-23T10:00:00.000Z');
    const gate = createWriteGate(() => now);
    gate.pause();
    now = new Date('2026-11-23T10:00:05.000Z');
    expect(gate.pause().since).toBe('2026-11-23T10:00:00.000Z');
    // Two saves overlap: the first one finishing must not let a write start under the second.
    expect(gate.resume()).toEqual({ paused: true, since: '2026-11-23T10:00:00.000Z' });
    expect(gate.paused()).toBe(true);
    expect(gate.resume()).toEqual({ paused: false });
    expect(gate.paused()).toBe(false);
    // A resume with nothing paused answers what the gate already says, and the next pause starts its own clock.
    expect(gate.resume()).toEqual({ paused: false });
    expect(gate.pause().since).toBe('2026-11-23T10:00:05.000Z');
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

  it('answers from what the app saved while the server ran, once the save has resumed it', async () => {
    await start(true);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const read = async (): Promise<string> =>
        JSON.stringify(resultJson(await client.callTool({ name: 'doc.read', arguments: { doc: LANDING, response_format: 'detailed' } })));
      expect(await read()).toContain(LANDING_BODY);

      // A save as the app makes it: the pause first, the folder written through the store, the resume after the last file. The
      // server holds the project open the whole time, so what it answers afterwards is what this save must have reached it.
      await control(fixture.url, '/control/pause', fixture.token);
      const fs = new NodeArtifactFs(fixture.root);
      const loaded = await readProject(fs, { now: OPENED });
      const landing = loaded.state.documents.get(LANDING);
      if (landing === undefined) throw new Error('the fixture project holds no landing document');
      landing.body = APP_SAVED_BODY;
      await writeProject(fs, loaded.state, { now: new Date(OPENED.getTime() + 60_000) });
      await control(fixture.url, '/control/resume', fixture.token);

      expect(await read()).toContain(APP_SAVED_BODY);
      // And the save does not stop the server's own writes: they check against the folder the app left, not the one it opened.
      const written = (await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } })) as { isError?: boolean };
      expect(written.isError).toBeUndefined();
    } finally {
      await client.close();
      await fixture.close();
    }
  });
});
