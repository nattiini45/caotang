/**
 * The story timeline over MCP, read-only (timeline.md §9.2, T9): `timeline.read` is listed with a read-only hint in every mode,
 * `caotang://timeline` carries the whole model as JSON (parts, zones and the unscheduled shelf), `caotang://timeline.csv` is the
 * exporter's own table, and neither reads nor a permitted write's refresh leave anything but the changed project in the folder.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { emptyCoherenceFile, serializeCoherenceFile, type CoherenceFile, type SceneMeta } from '@caotang/coherence';
import { timelineCsv, timelineTable, TIMELINE_COLUMNS } from '@caotang/exporter';
import { addDocument, addFolder, createEmptyManifest, createProjectState, writeProject } from '@caotang/store';

import { timelineReadDataOf } from '@caotang/harness';

import { TIMELINE_CSV_URI, TIMELINE_URI } from '../src/uris.js';
import { NodeArtifactFs } from '../src/index.js';
import { OPENED, acceptConfirm, connectClient, folderBytes, removeDir, resultJson, startOver, tempDir, type Fixture } from './support.js';

const TIMELINE_READ = 'timeline.read';
const BEFORE_FOLDER = 'n_BEFR000001';
const CHAPTER = 'n_CHAPTR0001';
const DEPARTURE = 'n_DEPART0001';
const LANDING = 'n_BEACH00001';
const STORM = 'n_TEMPEST001';
const UNDATED = 'n_NDAY000001';
const LOOSE = 'n_FREE000001';
const CODA = 'n_C0DA000001';

const SERVER_FIXTURE_TIMEOUT = 30_000;

const roots: string[] = [];
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const root of roots.splice(0)) removeDir(root);
});

/** A folder holding a prologue at a negative day, a main story with an after-chain and a loose scene on the shelf, and an epilogue. */
async function timelineFolder(label: string): Promise<string> {
  const root = tempDir(label);
  roots.push(root);
  const manifest = createEmptyManifest('The Lighthouse Keeper', OPENED);
  // Pinned: the default language is the machine's, and a day label groups its digits by it.
  manifest.project.language = 'en';
  const state = createProjectState(manifest);
  addFolder(state, { parentId: 'manuscript', title: 'Before', now: OPENED, id: BEFORE_FOLDER });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER });
  addDocument(state, { parentId: BEFORE_FOLDER, title: 'The Departure', body: 'She left in the spring.', now: OPENED, id: DEPARTURE });
  addDocument(state, { parentId: CHAPTER, title: 'The Landing', body: 'The ferry was late, as always.', now: OPENED, id: LANDING });
  addDocument(state, { parentId: CHAPTER, title: 'The Storm', body: 'Rain on the glass.', now: OPENED, id: STORM });
  addDocument(state, { parentId: CHAPTER, title: 'Undated', body: 'No day yet.', now: OPENED, id: UNDATED });
  addDocument(state, { parentId: CHAPTER, title: 'Adrift', body: 'No day, no chain.', now: OPENED, id: LOOSE });
  addDocument(state, { parentId: 'manuscript', title: 'Coda', body: 'Years later.', now: OPENED, id: CODA });
  await writeProject(new NodeArtifactFs(root), state, { now: OPENED });
  const sceneMeta: Record<string, SceneMeta> = {
    [BEFORE_FOLDER]: { storyPart: 'prologue' },
    [DEPARTURE]: { dayOffset: -3650 },
    [LANDING]: { dayOffset: 0, durationDays: 2 },
    [STORM]: { dayOffset: 5 },
    [UNDATED]: { after: [STORM] },
    [CODA]: { dayOffset: 4400, storyPart: 'epilogue' },
  };
  const file: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta };
  writeFileSync(join(root, 'coherence.json'), serializeCoherenceFile(file));
  return root;
}

async function open(root: string, allowWrites: boolean): Promise<Fixture> {
  const fixture = await startOver(root, allowWrites);
  fixtures.push(fixture);
  return fixture;
}

async function textOf(client: Client, uri: string): Promise<{ text: string; mimeType?: string }> {
  const { contents } = await client.readResource({ uri });
  const [first] = contents;
  if (first === undefined || !('text' in first)) throw new Error(`no text for ${uri}`);
  return first.mimeType === undefined ? { text: first.text } : { text: first.text, mimeType: first.mimeType };
}

interface ModelJson {
  readonly zones: readonly { part: string; startDay: number; endDay: number; count: number }[];
  readonly items: readonly { nodeId: string; title: string; part: string }[];
  readonly unscheduled: {
    readonly sequenced: readonly { steps: readonly { item: { nodeId: string } }[] }[];
    readonly loose: readonly { nodeId: string }[];
  };
}

describe('timeline.read in the tool list', () => {
  it.each([false, true])('is listed with a read-only hint and no write posture, with allowWrites %s', async (allowWrites) => {
    const fixture = await open(await timelineFolder('tl-list'), allowWrites);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((candidate) => candidate.name === TIMELINE_READ);
      expect(tool).toBeDefined();
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool?.description).toMatch(/^Read the story's timeline/u);
      expect(tool?.description).not.toMatch(/Requires user confirmation/u);
      // The read is listed in either mode. The write, timeline.edit, is listed only where writes are allowed: a confirmed timeline
      // batch is the only way a declaration reaches the folder (timeline.md §9.2).
      expect(tools.filter((candidate) => candidate.name.startsWith('timeline.')).map((candidate) => candidate.name).sort()).toEqual(
        allowWrites ? ['timeline.edit', TIMELINE_READ] : [TIMELINE_READ],
      );
    } finally {
      await client.close();
    }
  });

  it('answers with the parts, the days, the shelf and a plain-words summary', async () => {
    const fixture = await open(await timelineFolder('tl-call'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const result = await client.callTool({ name: TIMELINE_READ, arguments: {} });
      expect(result.isError).not.toBe(true);
      const body = resultJson(result as { content: readonly unknown[] }) as {
        summary: string;
        data: { zones: { part: string }[]; scenes: { nodeId: string; day?: number }[]; unscheduled: { loose: { nodeId: string }[] }; omitted: unknown };
      };
      expect(body.summary).toContain('The Lighthouse Keeper');
      expect(body.data.zones.map((zone) => zone.part)).toEqual(['prologue', 'main', 'epilogue']);
      expect(body.data.scenes.find((scene) => scene.nodeId === DEPARTURE)?.day).toBe(-3650);
      expect(body.data.unscheduled.loose.map((entry) => entry.nodeId)).toEqual([LOOSE]);
      expect(body.data.omitted).toBeNull();
      // The same answer the pure builder gives from the session's own model.
      expect(body.data).toEqual(JSON.parse(JSON.stringify(timelineReadDataOf(fixture.session.timeline(), {}))));
    } finally {
      await client.close();
    }
  });

  it('refuses a scope that is not a node and a parameter the tool does not have, as tool results', async () => {
    const fixture = await open(await timelineFolder('tl-bad'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      expect((await client.callTool({ name: TIMELINE_READ, arguments: { scope: 'n_missing' } })).isError).toBe(true);
      expect((await client.callTool({ name: TIMELINE_READ, arguments: { colour: 'red' } })).isError).toBe(true);
      const scoped = await client.callTool({ name: TIMELINE_READ, arguments: { scope: CHAPTER } });
      expect(scoped.isError).not.toBe(true);
      const data = (resultJson(scoped as { content: readonly unknown[] }) as { data: { scenes: { nodeId: string }[] } }).data;
      expect(data.scenes.map((scene) => scene.nodeId).sort()).toEqual([LANDING, LOOSE, STORM, UNDATED].sort());
    } finally {
      await client.close();
    }
  });
});

describe('the timeline resources', () => {
  it('serve the model as JSON with the parts, the zones and the unscheduled shelf', async () => {
    const fixture = await open(await timelineFolder('tl-json'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const { text, mimeType } = await textOf(client, TIMELINE_URI);
      expect(mimeType).toBe('application/json');
      const model = JSON.parse(text) as ModelJson;
      expect(model.zones.map((zone) => [zone.part, zone.startDay, zone.endDay, zone.count])).toEqual([
        ['prologue', -3650, -3649, 1],
        ['main', 0, 6, 4],
        ['epilogue', 4400, 4401, 1],
      ]);
      expect(model.items.map((item) => [item.nodeId, item.part]).filter(([id]) => id === DEPARTURE || id === CODA)).toEqual([
        [DEPARTURE, 'prologue'],
        [CODA, 'epilogue'],
      ]);
      expect(model.unscheduled.sequenced.map((chain) => chain.steps.map((step) => step.item.nodeId))).toEqual([[UNDATED]]);
      expect(model.unscheduled.loose.map((entry) => entry.nodeId)).toEqual([LOOSE]);
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('serve the CSV as the compiled timeline-csv file: the exporter’s header, CRLF rows, a guarded negative day', async () => {
    const fixture = await open(await timelineFolder('tl-csv'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const { text, mimeType } = await textOf(client, TIMELINE_CSV_URI);
      expect(mimeType).toBe('text/csv');
      expect(text.split('\r\n')[0]).toBe(TIMELINE_COLUMNS.join(','));
      expect(text).toBe(timelineCsv(timelineTable({ state: fixture.session.state, includeRootIds: ['manuscript'] })));
      const rows = text.split('\r\n').slice(1, -1);
      expect(rows).toHaveLength(6);
      // Prologue first, at its negative day, written as a signed decimal behind the formula guard.
      expect(rows[0]).toContain('The Departure');
      expect(rows[0]).toContain(",'-3650,");
      // Undated scenes follow the dated ones of their part, and the epilogue closes the file.
      expect(rows.map((row) => row.split(',')[2])).toEqual(['The Departure', 'The Landing', 'The Storm', 'Undated', 'Adrift', 'Coda']);
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('are the same data the tool reads: the tool’s scene ids are the JSON resource’s', async () => {
    const fixture = await open(await timelineFolder('tl-same'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const model = JSON.parse((await textOf(client, TIMELINE_URI)).text) as ModelJson;
      const called = resultJson((await client.callTool({ name: TIMELINE_READ, arguments: {} })) as { content: readonly unknown[] }) as {
        data: { scenes: { nodeId: string }[] };
      };
      expect(called.data.scenes.map((scene) => scene.nodeId)).toEqual(model.items.map((item) => item.nodeId));
    } finally {
      await client.close();
    }
  });
});

describe('a read writes nothing', () => {
  it.each([false, true])('leaves every byte of the folder as it was, with allowWrites %s', async (allowWrites) => {
    const fixture = await open(await timelineFolder('tl-nowrite'), allowWrites);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const before = folderBytes(fixture.root);
      const logged = fixture.session.harness.log.length;
      await client.callTool({ name: TIMELINE_READ, arguments: {} });
      await client.callTool({ name: TIMELINE_READ, arguments: { axis: 'braid', groupBy: 'pov', findings: 'none' } });
      await textOf(client, TIMELINE_URI);
      await textOf(client, TIMELINE_CSV_URI);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(folderBytes(fixture.root)).toEqual(before);
      expect(fixture.session.harness.log.length).toBe(logged);
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);
});

describe('after a permitted change', () => {
  it('a subscribed host is told of both timeline resources, and reading them again shows the change', async () => {
    const fixture = await open(await timelineFolder('tl-refresh'), true);
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      const updated: string[] = [];
      client.setNotificationHandler('notifications/resources/updated', (notification) => {
        updated.push(notification.params.uri);
      });
      const subscription = await client.listen({ resourceSubscriptions: [TIMELINE_URI, TIMELINE_CSV_URI] });
      expect((await textOf(client, TIMELINE_URI)).text).not.toContain('The Gale');
      expect((await textOf(client, TIMELINE_CSV_URI)).text).not.toContain('The Gale');

      const renamed = await client.callTool({ name: 'binder.restructure', arguments: { ops: [{ action: 'rename', node: STORM, title: 'The Gale' }] } });
      expect(renamed.isError).not.toBe(true);

      const stop = Date.now() + 5000;
      while (!(updated.includes(TIMELINE_URI) && updated.includes(TIMELINE_CSV_URI))) {
        if (Date.now() > stop) throw new Error(`timed out waiting for the timeline notices; saw ${updated.join(', ')}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await textOf(client, TIMELINE_URI)).text).toContain('The Gale');
      expect((await textOf(client, TIMELINE_CSV_URI)).text).toContain('The Gale');
      await subscription.close();
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);
});
