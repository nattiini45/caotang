/**
 * The server neither reads nor writes `tasks.json` (agent-harness.md §12): recurring tasks are the writer's, made in the app, and a client
 * of the server has no way to list, make or run one. A folder that holds the file is served as it was, on either posture.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectClient, removeDir, seedProject, startOver, tempDir, type Fixture } from './support.js';

const FILE = 'tasks.json';
const TASKS = `${JSON.stringify(
  {
    formatVersion: 1,
    tasks: [
      {
        id: 't_AAAAAAAAAA',
        name: 'Weekly scan',
        enabled: true,
        schedule: { kind: 'weekly', day: 'mon', at: '08:00' },
        whenDue: 'run',
        body: { kind: 'intent', text: 'Rewrite every scene.' },
        permission: 'ask',
        maxModelCalls: 99,
      },
    ],
  },
  null,
  2,
)}\n`;

const roots: string[] = [];
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const root of roots.splice(0)) removeDir(root);
});

describe.each([false, true])('a folder that holds tasks.json (allow writes: %s)', (allowWrites) => {
  it('is served with no task tool, resource or prompt, and the file is not read into the session', async () => {
    const root = tempDir('tasks-file');
    roots.push(root);
    await seedProject(root, 'The Lighthouse Keeper');
    writeFileSync(join(root, FILE), TASKS);
    const fixture = await startOver(root, allowWrites);
    fixtures.push(fixture);

    const client = await connectClient(fixture.url, fixture.token);
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools.filter((name) => /task|schedul|recurr/i.test(name))).toEqual([]);
      const resources = (await client.listResources()).resources.map((resource) => `${resource.name} ${resource.uri}`);
      expect(resources.filter((entry) => /tasks?\.json|task/i.test(entry))).toEqual([]);
      await client.callTool({ name: 'coherence.scan', arguments: {} });
    } finally {
      await client.close();
    }
    expect(JSON.stringify([...fixture.session.state.documents.keys(), fixture.session.state.manifest])).not.toContain('Weekly scan');
  });

  it('leaves the file byte for byte as it was, and makes no copy, snapshot or kept copy of it', async () => {
    const root = tempDir('tasks-file-bytes');
    roots.push(root);
    await seedProject(root, 'The Lighthouse Keeper');
    writeFileSync(join(root, FILE), TASKS);
    const fixture = await startOver(root, allowWrites);
    fixtures.push(fixture);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      await client.callTool({ name: 'coherence.scan', arguments: {} });
    } finally {
      await client.close();
    }
    await fixture.stop();
    fixtures.splice(fixtures.indexOf(fixture), 1);

    expect(readFileSync(join(root, FILE), 'utf8')).toBe(TASKS);
    expect(readdirSync(root).filter((name) => name.startsWith(FILE))).toEqual([FILE]);
    expect(existsSync(join(root, `${FILE}.bak.1`))).toBe(false);
  });

  it('does not repair a tasks.json that cannot be read', async () => {
    const root = tempDir('tasks-file-corrupt');
    roots.push(root);
    await seedProject(root, 'The Lighthouse Keeper');
    writeFileSync(join(root, FILE), '{ not json');
    const fixture = await startOver(root, allowWrites);
    fixtures.push(fixture);
    await fixture.stop();
    fixtures.splice(fixtures.indexOf(fixture), 1);

    expect(readFileSync(join(root, FILE), 'utf8')).toBe('{ not json');
    expect(readdirSync(root).filter((name) => name.startsWith(FILE))).toEqual([FILE]);
  });
});
