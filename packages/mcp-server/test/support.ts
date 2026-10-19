/**
 * Shared fixtures for the server's tests: a seeded project in a temporary folder, an
 * in-process server on an ephemeral loopback port, and a real MCP client over
 * Streamable HTTP. Nothing here is mocked: the project is written by the store, the
 * server is the one `caotang-mcp` runs, and the client is the SDK's own.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ElicitRequestParams, ElicitResult } from '@modelcontextprotocol/client';
import { addDocument, addFolder, createEmptyManifest, createProjectState, writeProject, type ProjectState } from '@caotang/store';

import {
  NodeArtifactFs,
  createToolRuntime,
  openProject,
  startHttpServer,
  type ProjectSession,
  type RunningHttpServer,
} from '../src/index.js';

export const OPENED = new Date('2026-10-08T09:00:00.000Z');
export const CHAPTER_ONE = 'n_CHAPTR0001';
export const LANDING = 'n_BEACH00001';
export const LANDING_BODY = 'The ferry was late, as always.';

/** A document file with an id-shaped name and no manifest entry: the kind a hand-made or lost-manifest folder holds. */
export const HAND_WRITTEN_DOC_NAME = 'n_7K2QX9M4A1.md';
export const HAND_WRITTEN_DOC = '---\nid: n_7K2QX9M4A1\ntitle: Written by hand\n---\n\nA scene nobody has imported.\n';

/** A fresh folder under the system temp directory. The caller removes it. */
export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `caotang-mcp-${label}-`));
}

/** Removes a folder the tests made. Retries cover Windows holding a file handle for a moment after close. */
export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Every file under a folder, relative and sorted, with its bytes: the whole observable state of the folder. */
export function folderBytes(root: string, dir = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, folderBytes(root, rel));
    else out[rel] = readFileSync(join(root, rel), 'utf8');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A bearer token with 128 bits of randomness, as the tests' stand-in for a minted one. */
export function testToken(): string {
  return randomBytes(16).toString('base64url');
}

/** A project with one folder holding one document, written through the store. */
export async function seedProject(
  root: string,
  name: string,
  options: { readonly shot?: boolean; readonly shotAction?: string } = {},
): Promise<void> {
  mkdirSync(root, { recursive: true });
  const fs = new NodeArtifactFs(root);
  const state = createProjectState(createEmptyManifest(name, OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER_ONE });
  addDocument(state, { parentId: CHAPTER_ONE, title: 'The Landing', body: LANDING_BODY, now: OPENED, id: LANDING, synopsis: 'Elena returns.' });
  if (options.shot === true) addShot(state, options.shotAction);
  await writeProject(fs, state, { now: OPENED });
}

export const SHOTS_FOLDER = 'n_SH0TS00001';
export const SHOT_ONE = 'n_SH0T0NE001';

/**
 * A storyboard folder holding one shot, as the storyboard package writes them (storyboard.md 2.1): a folder of kind `storyboard`, and
 * a node of type `shot` carrying its stored metadata. Written by hand here, so this package's tests do not depend on the storyboard's.
 */
function addShot(state: ProjectState, action = 'The harbour, empty.'): void {
  const folder = addFolder(state, { parentId: 'manuscript', title: 'Shots', now: OPENED, id: SHOTS_FOLDER });
  Object.assign(folder, { kind: 'storyboard' });
  const stamp = OPENED.toISOString();
  const shot = {
    id: SHOT_ONE,
    parentId: SHOTS_FOLDER,
    type: 'shot',
    title: 'Shot one',
    order: 0,
    status: null,
    label: null,
    keywords: [],
    synopsis: '',
    notes: '',
    createdAt: stamp,
    updatedAt: stamp,
    shot: { shotSize: 'WS', action, durationSec: 6 },
  };
  state.manifest.tree.push(shot as unknown as (typeof state.manifest.tree)[number]);
}

export interface Fixture {
  readonly root: string;
  readonly session: ProjectSession;
  readonly server: RunningHttpServer;
  readonly token: string;
  readonly url: string;
  /** Stops the server and closes the project, and leaves the folder for a later open. */
  stop(): Promise<void>;
  /** Stops, and removes the folder. */
  close(): Promise<void>;
}

/**
 * A running server over a project. `seed` writes a project before it is opened;
 * without it the folder is created empty with `createName`.
 */
export async function startFixture(options: {
  readonly label: string;
  readonly allowWrites: boolean;
  readonly seed?: boolean;
  /** With `seed`: the project also holds a storyboard folder with one shot. */
  readonly shot?: boolean;
  /** With `shot`: the shot's action, in place of "The harbour, empty." */
  readonly shotAction?: string;
}): Promise<Fixture> {
  const root = tempDir(options.label);
  if (options.seed === true) {
    await seedProject(root, 'The Lighthouse Keeper', {
      shot: options.shot === true,
      ...(options.shotAction === undefined ? {} : { shotAction: options.shotAction }),
    });
  }
  const session = await openProject({
    root,
    ...(options.seed === true ? {} : { create: 'The Lighthouse Keeper' }),
    allowWrites: options.allowWrites,
  });
  const token = testToken();
  const server = await startHttpServer(createToolRuntime(session), { port: 0, token });
  return {
    root,
    session,
    server,
    token,
    url: server.url,
    async stop() {
      await server.close();
      await session.close();
    },
    async close() {
      await server.close();
      await session.close();
      removeDir(root);
    },
  };
}

/** Answers an elicitation from the host's side. `accept` with `confirmed` set as given, or `decline` / `cancel`. */
export type Answer = (params: ElicitRequestParams) => ElicitResult | Promise<ElicitResult>;

export const acceptConfirm: Answer = () => ({ action: 'accept', content: { confirmed: true } });
export const declineConfirm: Answer = () => ({ action: 'decline' });
export const cancelConfirm: Answer = () => ({ action: 'cancel' });

/** One HTTP exchange the client made, as it was sent: enough to send it again byte for byte. */
export interface Exchange {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A fetch that records every POST the client makes, and otherwise behaves as the platform's. */
export function recordingFetch(into: Exchange[]): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
      into.push({ url: String(input), headers, body: init.body });
    }
    return globalThis.fetch(input, init);
  };
}

/** The JSON-RPC message in a response, whether the server answered with one JSON body or one SSE event. */
export async function jsonRpcOf(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').find((line) => line.startsWith('data: '));
    if (data === undefined) throw new Error(`no data event in ${text}`);
    return JSON.parse(data.slice('data: '.length)) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Sends one recorded exchange again, unchanged or with its body replaced, and returns the JSON-RPC answer. */
export async function resend(exchange: Exchange, body: string = exchange.body): Promise<Record<string, unknown>> {
  const response = await fetch(exchange.url, { method: 'POST', headers: exchange.headers, body });
  return jsonRpcOf(response);
}

/**
 * A real MCP client on the 2026-07-28 revision, the stateless one this server serves.
 * With `answer`, it declares elicitation and fulfils embedded requests through it; without,
 * it declares nothing, so a write-confirm tool has to refuse it. `exchanges`, when given,
 * records the POSTs it sends.
 */
export async function connectClient(url: string, token: string, answer?: Answer, exchanges?: Exchange[]): Promise<Client> {
  const client = new Client(
    { name: 'caotang-mcp-test-client', version: '0.0.0' },
    {
      capabilities: answer === undefined ? {} : { elicitation: {} },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );
  if (answer !== undefined) {
    client.setRequestHandler('elicitation/create', (request) => answer(request.params));
  }
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    ...(exchanges === undefined ? {} : { fetch: recordingFetch(exchanges) }),
  });
  await client.connect(transport);
  return client;
}

/** The text of a tool result's first content block, parsed as JSON. */
export function resultJson(result: { content: readonly unknown[] }): Record<string, unknown> {
  const first = result.content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') throw new Error('expected a text content block');
  return JSON.parse(first.text) as Record<string, unknown>;
}
