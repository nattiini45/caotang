/**
 * A project folder for the SDK's tests: the three scenes the demo provider's intents name (The Landing, The Storm, The Friend), a
 * codex entry for each of two names, written by the store into a temporary folder. Nothing is mocked: the SDK opens it as a person's.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { addDocument, addFolder, createEmptyManifest, createProjectState, writeProject } from '@caotang/store';

import { NodeArtifactFs } from '../src/folder-api.js';

export const OPENED = new Date('2026-10-08T09:00:00.000Z');
export const CHAPTER_ONE = 'n_CHAPTR0001';
export const CHAPTER_TWO = 'n_CHAPTR0002';
export const LANDING = 'n_BEACH00001';
export const STORM = 'n_TEMPEST001';
export const FRIEND = 'n_BRAVE00001';

export async function seedProject(root: string): Promise<void> {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER_ONE });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 2', now: OPENED, id: CHAPTER_TWO });
  addDocument(state, { parentId: CHAPTER_ONE, title: 'The Landing', body: 'The ferry was late, as always.', now: OPENED, id: LANDING });
  addDocument(state, { parentId: CHAPTER_ONE, title: 'The Storm', body: 'Rain.\n\n***\n\nThe lamp failed.', now: OPENED, id: STORM });
  addDocument(state, { parentId: CHAPTER_TWO, title: 'The Friend', now: OPENED, id: FRIEND });
  state.manifest.codex?.push({
    id: 'c_HANNE00001',
    name: 'Elena',
    aliases: [],
    type: 'character',
    description: 'The keeper.',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
  });
  await writeProject(new NodeArtifactFs(root), state, { now: OPENED });
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
