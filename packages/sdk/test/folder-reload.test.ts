/**
 * Reading the folder again after another program saved it — [agent-harness.md §11](../../../docs/architecture/agent-harness.md),
 * [desktop.md §The project's own MCP server](../../../docs/architecture/desktop.md#the-projects-own-mcp-server-406).
 *
 * A session keeps the project it loaded and a digest of every document it read, and refuses every save that would overwrite a change
 * another program made. `reload` is the other half: the app that shares the folder (paused around its save) says it is done, and the
 * session takes what the folder holds, clearing the stop. These tests write the folder through the store, as the app does, and drive
 * the real harness for the reads and for the write after the reload.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createProductHarness, type Harness, type ToolOutcome } from '@caotang/harness';
import { readProject, writeProject } from '@caotang/store';
import { afterEach, describe, expect, it } from 'vitest';

import { FolderChangedError, MCP_VOICE, NodeArtifactFs, openFolder, type OpenFolder } from '../src/folder-api.js';
import { LANDING, OPENED, STORM, seedProject } from './fixture.js';
import { removeDir, tempDir } from './support.js';

const LANDING_BODY = 'The ferry was late, as always.';
const APP_SAVED_LANDING = 'The ferry was early, for once.';
const APP_SAVED_STORM = 'Rain.\n\n***\n\nThe lamp held.';

interface Opened {
  readonly folder: OpenFolder;
  readonly harness: Harness;
  readonly root: string;
}

const made: string[] = [];

afterEach(() => {
  for (const root of made.splice(0)) removeDir(root);
});

/** A project open through the folder session the MCP server and the SDK share, with the model-free harness over it. */
async function opened(label = 'sdk-reload'): Promise<Opened> {
  const root = tempDir(label);
  made.push(root);
  await seedProject(root);
  const folder = await openFolder({ root, voice: MCP_VOICE, writeCoherence: true, report: () => {} });
  const harness = createProductHarness({ state: folder.state, registry: folder.registry, externalWrites: true, ports: 'external' });
  return { folder, harness, root };
}

/** One document's text as the harness answers it, read as an external caller reads it. */
function readText(harness: Harness, doc: string, callId: string): string {
  const outcome = harness.external.call({ name: 'doc.read', callId, params: { doc } }, { turnId: `t_${callId}` });
  harness.external.endTurn(`t_${callId}`);
  if (!outcome.ok) throw new Error(outcome.error.message);
  return String((outcome.value.data as { text?: string }).text);
}

/** A save another program made: the folder read and written through the store, a minute after the session opened it. */
async function saveElsewhere(root: string, bodies: Record<string, string>): Promise<void> {
  const fs = new NodeArtifactFs(root);
  const { state } = await readProject(fs, { now: OPENED });
  for (const [id, body] of Object.entries(bodies)) {
    const record = state.documents.get(id);
    if (record === undefined) throw new Error(`the fixture project holds no document ${id}`);
    record.body = body;
  }
  await writeProject(fs, state, { now: new Date(OPENED.getTime() + 60_000) });
}

describe('reading the folder again after another program saved it', () => {
  it('takes what the folder holds, answers reads from it, and lets the writes start again', async () => {
    const project = await opened();
    expect(readText(project.harness, LANDING, 'before')).toBe(LANDING_BODY);

    await saveElsewhere(project.root, { [LANDING]: APP_SAVED_LANDING });
    // The session still holds the project it loaded, and its own save is refused rather than overwriting that save.
    expect(readText(project.harness, LANDING, 'stale')).toBe(LANDING_BODY);
    await expect(project.folder.persist()).rejects.toBeInstanceOf(FolderChangedError);
    expect(project.folder.changed).toBe(true);
    expect(readFileSync(join(project.root, 'docs', `${LANDING}.md`), 'utf8')).toContain(APP_SAVED_LANDING);

    expect(await project.folder.reload()).toBe(true);
    expect(project.folder.changed).toBe(false);
    expect(project.folder.state.documents.get(LANDING)?.body).toBe(APP_SAVED_LANDING);
    expect(readText(project.harness, LANDING, 'after')).toBe(APP_SAVED_LANDING);
    // The writes are open again, and they check against the folder the other program left.
    await expect(project.folder.persist()).resolves.toBeUndefined();
  });

  it('keeps the other program’s change when this session writes after the reload', async () => {
    const project = await opened('sdk-reload-write');
    await saveElsewhere(project.root, { [STORM]: APP_SAVED_STORM });
    expect(await project.folder.reload()).toBe(true);

    const written: ToolOutcome = project.harness.external.call(
      { name: 'meta.set', callId: 'server-write', params: { targets: [LANDING], status: 'final' } },
      { turnId: 't_server-write' },
    );
    project.harness.external.endTurn('t_server-write');
    expect(written.ok).toBe(true);
    await project.folder.persist();

    const disk = await readProject(new NodeArtifactFs(project.root), { now: OPENED });
    expect(disk.state.documents.get(STORM)?.body).toBe(APP_SAVED_STORM);
    expect(disk.state.documents.get(LANDING)?.body).toBe(LANDING_BODY);
  });

  it('reads nothing again when the folder still holds what this session last wrote', async () => {
    const project = await opened('sdk-reload-unchanged');
    expect(await project.folder.reload()).toBe(false);
    expect(await project.folder.reload()).toBe(false);
  });

  it('leaves the session as it was when the folder can no longer be read, and says so', async () => {
    const root = tempDir('sdk-reload-unreadable');
    made.push(root);
    await seedProject(root);
    const reports: string[] = [];
    const folder = await openFolder({ root, voice: MCP_VOICE, writeCoherence: true, report: (line) => reports.push(line) });
    writeFileSync(join(root, 'caotang.json'), '{"app":"caotang","tree":');

    expect(await folder.reload()).toBe(false);
    expect(folder.state.documents.get(LANDING)?.body).toBe(LANDING_BODY);
    expect(reports.join('\n')).toContain('could not be read again');
  });
});
