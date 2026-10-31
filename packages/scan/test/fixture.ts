/**
 * Projects for the scan's tests, written by the store into an in-memory folder, so the scan opens them as a person's folder.
 *
 * Every scene declares that Elena must be named in it (`presence.expected`, an error whose quote starts at the head of the body),
 * so a body that never names her is one open error, placed on the first line after the front matter.
 */

import { createHash } from 'node:crypto';

import { emptyCoherenceFile, serializeCoherenceFile, type CoherenceFile, type SceneMeta } from '@caotang/coherence';
import {
  MemoryArtifactFs,
  addDocument,
  createEmptyManifest,
  createProjectState,
  writeProject,
  type ArtifactFs,
  type ProjectState,
} from '@caotang/store';

export const NOW = new Date('2026-10-20T09:00:00.000Z');
export const ELENA = 'c_5H8QK2M9RT';
export const HARBOUR = 'n_7K2QX9M4A1';
export const SHORE = 'n_8M3RY1N5B2';
export const SCRIPT = 'n_9P4SZ2Q6C3';
export const BRANCHES = 'n_AQ5T03R7D4';

export interface Seeded {
  readonly fs: MemoryArtifactFs;
  readonly state: ProjectState;
}

/** The codex entry the scenes expect. */
function elena(): NonNullable<ProjectState['manifest']['codex']>[number] {
  return {
    id: ELENA,
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
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

export interface SeedOptions {
  /** A body per scene id; an id left out has the default. */
  readonly bodies?: Readonly<Record<string, string>>;
  /** The line ending of the files the store writes. */
  readonly newline?: '\n' | '\r\n';
  /** Scenes that declare Elena as expected. Default: both prose scenes. */
  readonly expecting?: readonly string[];
  /** Declarations merged over the scene's own (a day, a story part), as a writer's `coherence.json` holds them. */
  readonly declare?: Readonly<Record<string, SceneMeta>>;
}

/** A folder with two prose scenes, a screenplay and a dialogue container, and a `coherence.json` that expects Elena in the prose scenes. */
export async function seedProject(options: SeedOptions = {}): Promise<Seeded> {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW), { now: NOW });
  state.manifest.codex = [elena()];
  const body = (id: string, fallback: string): string => options.bodies?.[id] ?? fallback;
  addDocument(state, { id: HARBOUR, parentId: 'manuscript', title: 'The Harbour', body: body(HARBOUR, 'Gulls only.\nThe tide came in.'), now: NOW });
  addDocument(state, { id: SHORE, parentId: 'manuscript', title: 'The Shore', body: body(SHORE, 'Elena watched the sea.'), now: NOW });
  addDocument(state, { id: SCRIPT, parentId: 'manuscript', title: 'The Script', kind: 'screenplay', body: body(SCRIPT, 'INT. LAMP ROOM - NIGHT\n\nThe lamp turns.'), now: NOW });
  addDocument(state, { id: BRANCHES, parentId: 'manuscript', title: 'The Choices', type: 'dialogue', kind: 'branching', body: body(BRANCHES, '=== start ===\nHello.\n-> END\n'), now: NOW });

  const fs = new MemoryArtifactFs();
  await writeProject(fs, state, { now: NOW, newline: options.newline ?? '\n' });

  const file = emptyCoherenceFile();
  for (const id of options.expecting ?? [HARBOUR, SHORE]) file.sceneMeta[id] = { expectedPresent: [ELENA] };
  for (const [id, meta] of Object.entries(options.declare ?? {})) file.sceneMeta[id] = { ...file.sceneMeta[id], ...meta };
  fs.putFile('coherence.json', serializeCoherenceFile(file));
  return { fs, state };
}

/** A sha-256 over every file in the folder, text and binary, with its path: equal before and after means nothing was written. */
export function folderHash(fs: MemoryArtifactFs): string {
  const hash = createHash('sha256');
  const text = fs.snapshot();
  for (const path of Object.keys(text).sort()) hash.update(`T ${path}\0${text[path]}\0`);
  const bytes = fs.snapshotBytes();
  for (const path of Object.keys(bytes).sort()) hash.update(`B ${path}\0`).update(bytes[path] as Uint8Array).update('\0');
  return hash.digest('hex');
}

/** The folder as `coherence.json` holds it, parsed by the coherence module's own reader. */
export async function readFile(fs: ArtifactFs, path: string): Promise<string> {
  return fs.read(path);
}

export type { CoherenceFile };
