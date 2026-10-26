/**
 * Shared fixtures for the server's tests: a seeded project in a temporary folder, an
 * in-process server on an ephemeral loopback port, and a real MCP client over
 * Streamable HTTP. Nothing here is mocked: the project is written by the store, the
 * server is the one `caotang-mcp` runs, and the client is the SDK's own.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ElicitRequestParams, ElicitResult } from '@modelcontextprotocol/client';
import { loadCoherence, parseCoherenceFile, saveCoherence, type CoherenceFile } from '@caotang/coherence';
import { addDocument, addFolder, createEmptyManifest, createProjectState, readProject, writeProject, type ExportRecipe, type ProjectState } from '@caotang/store';

import {
  NodeArtifactFs,
  createToolRuntime,
  openProject,
  openProjectOrOffer,
  startHttpServer,
  type DegradedSession,
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
  options: { readonly shot?: boolean; readonly shotAction?: string; readonly shotImage?: string; readonly dialogue?: boolean } = {},
): Promise<void> {
  mkdirSync(root, { recursive: true });
  const fs = new NodeArtifactFs(root);
  const state = createProjectState(createEmptyManifest(name, OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER_ONE });
  addDocument(state, { parentId: CHAPTER_ONE, title: 'The Landing', body: LANDING_BODY, now: OPENED, id: LANDING, synopsis: 'Elena returns.' });
  if (options.shot === true) addShot(state, options.shotAction, options.shotImage);
  if (options.dialogue === true) {
    addDocument(state, { parentId: 'manuscript', title: 'The Tavern', type: 'dialogue', body: TAVERN_INK, now: OPENED, id: TAVERN });
  }
  await writeProject(fs, state, { now: OPENED });
}

export const TAVERN = 'n_TAVERN0001';
const TAVERN_INK = ['-> tavern', '=== tavern ===', 'Innkeeper: Ah, a traveller.', '* [Order an ale] -> END', '* [Leave] -> END', ''].join('\n');

export const SHOTS_FOLDER = 'n_SH0TS00001';
export const SHOT_ONE = 'n_SH0T0NE001';

/**
 * A storyboard folder holding one shot, as the storyboard package writes them (storyboard.md 2.1): a folder of kind `storyboard`, and
 * a node of type `shot` carrying its stored metadata. Written by hand here, so this package's tests do not depend on the storyboard's.
 */
function addShot(state: ProjectState, action = 'The harbour, empty.', image?: string): void {
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
    shot: { shotSize: 'WS', action, durationSec: 6, ...(image === undefined ? {} : { image }) },
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
  /** With `seed`: the richer project of `seedWriting` (prose, a screenplay scene, a dialogue container, notes and a codex), in place of the plain one. */
  readonly writing?: boolean;
  /** With `shot`: the shot's action, in place of "The harbour, empty." */
  readonly shotAction?: string;
  /** With `shot`: the asset id of the shot's picture. The file is the test's to write into `assets/`. */
  readonly shotImage?: string;
  /** With `seed`: export recipes saved in the project before it is opened. */
  readonly recipes?: readonly ExportRecipe[];
}): Promise<Fixture> {
  const root = tempDir(options.label);
  if (options.seed === true && options.writing === true) {
    await seedWriting(root);
  } else if (options.seed === true) {
    await seedProject(root, 'The Lighthouse Keeper', {
      shot: options.shot === true,
      ...(options.shotAction === undefined ? {} : { shotAction: options.shotAction }),
      ...(options.shotImage === undefined ? {} : { shotImage: options.shotImage }),
    });
  }
  if (options.seed === true && options.recipes !== undefined) {
    const fs = new NodeArtifactFs(root);
    const { state } = await readProject(fs, { now: OPENED });
    state.manifest.recipes = [...options.recipes];
    await writeProject(fs, state, { now: OPENED });
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

/** A running server over a folder that already holds a project, as a restart would open it. `close` stops it and leaves the folder. */
export async function startOver(root: string, allowWrites: boolean, report?: (line: string) => void): Promise<Fixture> {
  const session = await openProject({ root, allowWrites, ...(report === undefined ? {} : { report }) });
  const token = testToken();
  const server = await startHttpServer(createToolRuntime(session), { port: 0, token });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await server.close();
    await session.close();
  };
  return { root, session, server, token, url: server.url, stop, close: stop };
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

/** The codex entry `seedCodexEntry` adds: a character the one scene never names, so `codex.never-mentioned` has a finding. */
export const UNNAMED_CHARACTER = 'Marguerite';

/** Adds a codex entry that no document mentions to a project that is not open, through the store's own read and write. */
export async function seedCodexEntry(root: string): Promise<void> {
  const fs = new NodeArtifactFs(root);
  const { state } = await readProject(fs, { now: OPENED });
  const stamp = OPENED.toISOString();
  (state.manifest.codex ??= []).push({
    id: 'c_MAG0A00001',
    name: UNNAMED_CHARACTER,
    aliases: [],
    type: 'character',
    description: 'The keeper’s sister.',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    createdAt: stamp,
    updatedAt: stamp,
  });
  await writeProject(fs, state, { now: OPENED });
}

/**
 * What the app leaves in a folder: a `coherence.json` that holds a scan's findings and run, saved through the coherence module's own
 * `saveCoherence`. A scan on a throwaway read-only server makes the file, so its ids are the engine's. Returns the file as saved.
 */
export async function saveAppFindings(root: string): Promise<CoherenceFile> {
  const session = await openProject({ root, allowWrites: false });
  try {
    session.harness.external.call({ name: 'coherence.scan', callId: 'app-scan', params: {} }, { turnId: 'app-turn' });
    const file = session.state.coherence as CoherenceFile;
    await saveCoherence(session.fs, await loadCoherence(session.fs), file);
    return file;
  } finally {
    await session.close();
  }
}

/** Reads `coherence.json` from a folder as the coherence module parses it. */
export function coherenceOnDisk(root: string): CoherenceFile {
  const outcome = parseCoherenceFile(readFileSync(join(root, 'coherence.json'), 'utf8'));
  if (outcome.kind !== 'ok') throw new Error(`coherence.json in ${root} is ${outcome.kind}`);
  return outcome.file;
}

/** Text a corrupt `caotang.json` carries, so a test can tell whether the unreadable bytes were shown to a caller or kept. */
export const CORRUPT_MARKER = 'CORRUPT-MANIFEST-MARKER';

/** A manifest that was cut off by a partial write: it carries the marker and does not parse. */
export const CORRUPT_MANIFEST = `{"app":"caotang","note":"${CORRUPT_MARKER}","tree":[`;

/**
 * A project folder whose `caotang.json` no longer parses, in the three states the ladder tells apart. `snapshot`: the project was saved
 * twice, so `caotang.json.bak.1` holds the first save (the project under its first name). `rebuild`: one save, so there is no snapshot and
 * the documents are all there is. `bare`: nothing but the broken manifest. `codex` adds a codex entry before the manifest breaks.
 */
export async function brokenFolder(label: string, kind: 'snapshot' | 'rebuild' | 'bare', options: { readonly codex?: boolean } = {}): Promise<string> {
  const root = tempDir(label);
  if (kind !== 'bare') {
    await seedProject(root, 'The Lighthouse Keeper');
    if (options.codex === true) await seedCodexEntry(root);
    if (kind === 'snapshot') {
      const fs = new NodeArtifactFs(root);
      const { state } = await readProject(fs, { now: OPENED });
      state.manifest.project.name = 'The Lighthouse Keeper, second save';
      await writeProject(fs, state, { now: new Date(OPENED.getTime() + 60_000) });
    }
  }
  writeFileSync(join(root, 'caotang.json'), CORRUPT_MANIFEST);
  return root;
}

export interface DegradedFixture {
  readonly root: string;
  readonly session: DegradedSession;
  readonly server: RunningHttpServer;
  readonly token: string;
  readonly url: string;
  /** The lines the session reported to the operator. */
  readonly reports: string[];
  /** Stops the server and releases the folder, and leaves it for a later open. */
  stop(): Promise<void>;
}

/** A running server over a folder whose manifest will not load, as `caotang-mcp serve` starts it. */
export async function startDegraded(root: string, allowWrites: boolean): Promise<DegradedFixture> {
  const reports: string[] = [];
  const session = await openProjectOrOffer({ root, allowWrites, report: (line) => reports.push(line) });
  if (!('degraded' in session)) throw new Error('the folder opened as a project; it was meant to be unreadable');
  const token = testToken();
  const server = await startHttpServer(createToolRuntime(session), { port: 0, token });
  let stopped = false;
  return {
    root,
    session,
    server,
    token,
    url: server.url,
    reports,
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.close();
      await session.close();
    },
  };
}

export const STORM = 'n_STRM000001';
export const CHAPTER_TWO = 'n_CHAPTR0002';
export const HARBOUR = 'n_HARBR00001';
export const FERRYMAN = 'n_FERRY00001';
export const ELENA = 'c_ENA0000001';
export const KESTREL = 'c_KSTR000001';
export const LANDING_NOTES = 'Fix the pacing in the last three paragraphs.';
export const STORM_BODY = 'Rain on the glass.\n\n***\n\nThe lamp failed.';
export const HARBOUR_BODY = 'INT. HARBOUR - NIGHT\n\nELENA waits.\n\nELENA\nIs it still running?\n';
export const FERRYMAN_BODY = '=== start ===\nThe ferryman nods.\n-> END\n';

/**
 * A project a writer could have: prose, a screenplay scene and a dialogue container across two chapters, notes and keywords on a
 * document, and two codex entries. Binder order is Chapter 1 (The Landing, The Storm), Chapter 2 (Harbour, Ferryman).
 */
export async function seedWriting(root: string): Promise<void> {
  mkdirSync(root, { recursive: true });
  const fs = new NodeArtifactFs(root);
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER_ONE });
  addDocument(state, {
    parentId: CHAPTER_ONE,
    title: 'The Landing',
    body: LANDING_BODY,
    now: OPENED,
    id: LANDING,
    synopsis: 'Elena returns.',
    notes: LANDING_NOTES,
    keywords: ['sea', 'grief'],
  });
  addDocument(state, { parentId: CHAPTER_ONE, title: 'The Storm', body: STORM_BODY, now: OPENED, id: STORM });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 2', now: OPENED, id: CHAPTER_TWO });
  addDocument(state, { parentId: CHAPTER_TWO, title: 'Harbour', body: HARBOUR_BODY, now: OPENED, id: HARBOUR, kind: 'screenplay' });
  addDocument(state, { parentId: CHAPTER_TWO, title: 'Ferryman', body: FERRYMAN_BODY, now: OPENED, id: FERRYMAN, type: 'dialogue', kind: 'branching' });
  const stamp = OPENED.toISOString();
  const entry = (id: string, name: string, type: string, description: string, aliases: string[]) => ({
    id,
    name,
    aliases,
    type,
    description,
    includePolicy: 'detected' as const,
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual' as const,
    sources: [],
    createdAt: stamp,
    updatedAt: stamp,
  });
  (state.manifest.codex ??= []).push(
    entry(KESTREL, 'Kestrel', 'other', 'The bird on the rail.', []),
    entry(ELENA, 'Elena', 'character', 'The keeper’s daughter, back after ten years.', ['Lena']),
  );
  await writeProject(fs, state, { now: OPENED });
}
