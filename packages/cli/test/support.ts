/** Shared helpers for the CLI's tests: a project folder, a captured process, and a folder's bytes. */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NodeArtifactFs } from '@caotang/sdk/folder';
import { addDocument, addFolder, createEmptyManifest, createProjectState, writeProject, type ProjectState } from '@caotang/store';

import type { AgentIo } from '../src/run-agent.js';

export const OPENED = new Date('2026-10-08T09:00:00.000Z');
export const CHAPTER_ONE = 'n_CHAPTR0001';
export const CHAPTER_TWO = 'n_CHAPTR0002';
export const LANDING = 'n_BEACH00001';
export const STORM = 'n_TEMPEST001';
export const FRIEND = 'n_BRAVE00001';

export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `caotang-cli-${label}-`));
}

/** Removes a folder the tests made. Retries cover Windows holding a file handle for a moment after close. */
export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** A project with the three scenes the demo provider's intents name (The Landing, The Storm, The Friend), written by the store. */
export async function seedProject(root: string, shotAction?: string, shotImage?: string): Promise<void> {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER_ONE });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 2', now: OPENED, id: CHAPTER_TWO });
  addDocument(state, { parentId: CHAPTER_ONE, title: 'The Landing', body: 'The ferry was late, as always.', now: OPENED, id: LANDING });
  addDocument(state, { parentId: CHAPTER_ONE, title: 'The Storm', body: 'Rain.\n\n***\n\nThe lamp failed.', now: OPENED, id: STORM });
  addDocument(state, { parentId: CHAPTER_TWO, title: 'The Friend', now: OPENED, id: FRIEND });
  if (shotAction !== undefined) addShot(state, shotAction, shotImage);
  mkdirSync(root, { recursive: true });
  await writeProject(new NodeArtifactFs(root), state, { now: OPENED });
}

export const SHOTS_FOLDER = 'n_SH0TS00001';

/** A storyboard folder holding one shot, as the storyboard package writes them (storyboard.md 2.1), written by hand so these tests do not depend on that package. */
function addShot(state: ProjectState, action: string, image?: string): void {
  const folder = addFolder(state, { parentId: 'manuscript', title: 'Shots', now: OPENED, id: SHOTS_FOLDER });
  Object.assign(folder, { kind: 'storyboard' });
  const stamp = OPENED.toISOString();
  const shot = {
    id: 'n_SH0T0NE001',
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

/** Every file under a folder, relative and sorted, with its bytes: the whole observable state of the folder. */
export function folderBytes(root: string, dir = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, folderBytes(root, rel));
    else out[rel] = readFileSync(join(root, rel)).toString('base64');
  }
  return out;
}

export interface Captured extends AgentIo {
  /** Everything written to stdout, in order, as the chunks the command wrote. */
  readonly out: string[];
  readonly err: string[];
}

/** An `AgentIo` that records what the command writes, with the environment and stdin a test gives it. */
export function capture(over: { env?: NodeJS.ProcessEnv; stdin?: string; cwd?: string } & Partial<AgentIo> = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const { env, stdin, cwd, ...rest } = over;
  return {
    env: env ?? {},
    cwd: cwd ?? process.cwd(),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(stdin ?? ''),
    out,
    err,
    ...rest,
  };
}

/** The lines of a stream, each parsed on its own. Throws when the stream does not end with a newline or a line is not JSON. */
export function jsonLines(chunks: readonly string[]): Record<string, unknown>[] {
  const text = chunks.join('');
  if (text !== '' && !text.endsWith('\n')) throw new Error('stdout does not end with a newline');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
