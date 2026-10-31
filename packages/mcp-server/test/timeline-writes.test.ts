/**
 * `timeline.edit` over MCP — [timeline.md §9.2](../../../docs/architecture/timeline.md), T12.
 *
 * A timeline batch changes `caotang.json` (a move) and `coherence.json` (a scene's declaration), and the folder writes them one after
 * the other. So the tool is listed only with `--allow-writes`, asks the writer in the host's own dialog before anything runs, and
 * answers with a **typed outcome** and a read-back of what the folder holds: `persisted`, `conflict`, `partial`, or the harness's own
 * refusal. These tests drive the real server over HTTP, including a second writer that edits the same scene while the dialog is open.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CoherenceFile } from '@caotang/coherence';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acceptConfirm,
  connectClient,
  declineConfirm,
  resultJson,
  startFixture,
  LANDING,
  type Answer,
  type Fixture,
} from './support.js';

/** `coherence.json` as the folder holds it. */
function coherenceOnDisk(root: string): CoherenceFile {
  return JSON.parse(readFileSync(join(root, 'coherence.json'), 'utf8')) as CoherenceFile;
}

/** A batch that dates one scene. */
function dateTheLanding(dayOffset: number): Record<string, unknown> {
  return { ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset } }], label: 'Date the landing' };
}

const started: Fixture[] = [];

afterEach(async () => {
  for (const fixture of started.splice(0)) await fixture.close();
});

async function fixture(label: string): Promise<Fixture> {
  const made = await startFixture({ label, allowWrites: true, seed: true });
  started.push(made);
  return made;
}

describe('timeline.edit over MCP (timeline.md §9.2)', () => {
  it('asks the writer first, in words that name the scene and the field', async () => {
    const project = await fixture('timeline-ask');
    const asked: string[] = [];
    const answer: Answer = (params) => {
      asked.push(params.message);
      return { action: 'accept', content: { confirmed: true } };
    };
    const client = await connectClient(project.url, project.token, answer);
    try {
      const result = await client.callTool({ name: 'timeline.edit', arguments: dateTheLanding(3) });
      expect(result.isError).not.toBe(true);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('change the timeline in 1 edit');
      expect(asked[0]).toContain('change day of "The Landing"');
      expect(asked[0]).toContain('Nothing changes unless you accept.');
    } finally {
      await client.close();
    }
  });

  it('answers a clean write with persisted and a read-back of the folder, and the write is on disk', async () => {
    const project = await fixture('timeline-persist');
    const client = await connectClient(project.url, project.token, acceptConfirm);
    try {
      const result = await client.callTool({ name: 'timeline.edit', arguments: dateTheLanding(3) });
      expect(result.isError).not.toBe(true);
      const body = resultJson(result) as Record<string, unknown>;
      expect(body['status']).toBe('persisted');
      expect(body['written']).toBe(true);
      expect(body['tool']).toBe('timeline.edit');
      expect(body['files']).toEqual(['coherence.json']);
      // The read-back is what the folder holds, by title, with the effective story part.
      expect(body['readback']).toEqual({
        scenes: [{ nodeId: LANDING, title: 'The Landing', dayOffset: 3, durationDays: null, timelineMode: 'linear', pov: null, storyPart: 'main' }],
        moved: [],
      });
      expect(coherenceOnDisk(project.root).sceneMeta[LANDING]?.dayOffset).toBe(3);
    } finally {
      await client.close();
    }
  });

  it('writes nothing when the writer declines, and says the project did not change', async () => {
    const project = await fixture('timeline-decline');
    const client = await connectClient(project.url, project.token, declineConfirm);
    try {
      const before = readFileSync(join(project.root, 'caotang.json'), 'utf8');
      const result = await client.callTool({ name: 'timeline.edit', arguments: dateTheLanding(3) });
      // A decline is the call completed, not an error, and the answer is one plain sentence: the project did not change.
      expect(result.isError).not.toBe(true);
      expect((result.content[0] as { text: string }).text).toBe('timeline.edit was declined: nothing was written.');
      expect(readFileSync(join(project.root, 'caotang.json'), 'utf8')).toBe(before);
      expect(project.session.state.coherence?.sceneMeta[LANDING]).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('refuses with conflict when another program changed the same scene while the dialog was open, and writes nothing', async () => {
    const project = await fixture('timeline-conflict');
    // The first batch puts day 3 on the folder, so this host holds 3 and the app is about to disagree with it.
    const first = await connectClient(project.url, project.token, acceptConfirm);
    try {
      const written = await first.callTool({ name: 'timeline.edit', arguments: dateTheLanding(3) });
      expect((resultJson(written) as Record<string, unknown>)['status']).toBe('persisted');
    } finally {
      await first.close();
    }
    const before = readFileSync(join(project.root, 'caotang.json'), 'utf8');
    // The other writer, while the host's dialog is open: it sets the same scene's day to 5.
    const answer: Answer = () => {
      const file = coherenceOnDisk(project.root);
      file.sceneMeta[LANDING] = { dayOffset: 5 };
      writeFileSync(join(project.root, 'coherence.json'), JSON.stringify(file, null, 2));
      return { action: 'accept', content: { confirmed: true } };
    };
    const client = await connectClient(project.url, project.token, answer);
    try {
      const result = await client.callTool({ name: 'timeline.edit', arguments: dateTheLanding(9) });
      expect(result.isError).toBe(true);
      const body = resultJson(result) as Record<string, unknown>;
      expect(body['status']).toBe('conflict');
      expect(body['written']).toBe(false);
      expect(body['scenes']).toEqual([{ nodeId: LANDING, title: 'The Landing', field: 'dayOffset', expected: 'day 3', current: 'day 5' }]);
      const error = body['error'] as { code: string; message: string; correctiveHint: string };
      expect(error.code).toBe('revision-conflict');
      expect(error.message).toContain('‘The Landing’');
      expect(error.message).toContain('Nothing was written');
      expect(error.correctiveHint).toContain('read the timeline again');
      // The app's value is the folder's, and this host wrote neither file.
      expect(coherenceOnDisk(project.root).sceneMeta[LANDING]?.dayOffset).toBe(5);
      expect(readFileSync(join(project.root, 'caotang.json'), 'utf8')).toBe(before);
    } finally {
      await client.close();
    }
  });

  it('keeps two open questions for identical arguments apart: the one that lands first does not let the other re-base over it', async () => {
    const project = await fixture('timeline-identical');
    // Both dialogs are open before either answers, so each check has staged its values against the same folder.
    let asked = 0;
    let release!: () => void;
    const bothAsked = new Promise<void>((done) => {
      release = done;
    });
    const waitForBoth: Answer = async () => {
      asked += 1;
      if (asked === 2) release();
      await bothAsked;
      return { action: 'accept', content: { confirmed: true } };
    };
    const first = await connectClient(project.url, project.token, waitForBoth);
    const second = await connectClient(project.url, project.token, waitForBoth);
    try {
      const calls = [
        first.callTool({ name: 'timeline.edit', arguments: dateTheLanding(3) }),
        second.callTool({ name: 'timeline.edit', arguments: dateTheLanding(3) }),
      ];
      const results = await Promise.all(calls);
      expect(asked).toBe(2);
      const statuses = results.map((result) => (resultJson(result) as Record<string, unknown>)['status']).sort();
      // One lands. The other keeps the values it was asked about, which the first has changed, so it is refused and not re-based.
      expect(statuses.filter((status) => status === 'persisted')).toHaveLength(1);
      expect(results.filter((result) => result.isError === true)).toHaveLength(1);
      expect(coherenceOnDisk(project.root).sceneMeta[LANDING]?.dayOffset).toBe(3);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('answers partial, never success, when coherence.json cannot be written, and stops the writes that follow', async () => {
    const project = await fixture('timeline-partial');
    const fs = project.session.fs;
    const writeAtomic = fs.writeAtomic.bind(fs);
    let failing = true;
    fs.writeAtomic = async (path: string, text: string) => {
      if (failing && path === 'coherence.json') throw Object.assign(new Error('the disk is full'), { code: 'ENOSPC' });
      return writeAtomic(path, text);
    };
    const client = await connectClient(project.url, project.token, acceptConfirm);
    try {
      const result = await client.callTool({ name: 'timeline.edit', arguments: dateTheLanding(3) });
      expect(result.isError).toBe(true);
      const body = resultJson(result) as Record<string, unknown>;
      expect(body['status']).toBe('partial');
      expect(body['written']).toBe(false);
      // The batch changed only declarations, and none of them reached the folder.
      expect(body['files']).toEqual([]);
      expect(body['unwritten']).toEqual(['coherence.json']);
      const error = body['error'] as { code: string; message: string };
      expect(error.code).toBe('io-error');
      expect(error.message).toContain('scene declarations are not on disk');
      expect(error.message).toContain('coherence.json could not be written (ENOSPC)');
      // The folder holds no coherence.json at all, so the declaration is nowhere on disk.
      expect(existsSync(join(project.root, 'coherence.json'))).toBe(false);

      // The folder and this host's copy may not agree now, so nothing more is written: the refusal comes before the question, and the
      // next write is not run rather than run over a folder that may not hold this host's copy.
      failing = false;
      const after = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } });
      expect(after.isError).toBe(true);
      const refusal = (resultJson(after) as { error: { message: string; correctiveHint: string } }).error;
      expect(refusal.message).toContain('was not made');
      expect(refusal.message).toContain('an earlier timeline batch was only partly saved');
      expect(refusal.correctiveHint).toContain('restart caotang-mcp');
    } finally {
      await client.close();
    }
  });

  it('reports the manifest written and the declarations not when the manifest lands and coherence.json fails', async () => {
    const project = await fixture('timeline-partial-move');
    const fs = project.session.fs;
    const writeAtomic = fs.writeAtomic.bind(fs);
    fs.writeAtomic = async (path: string, text: string) => {
      if (path === 'coherence.json') throw Object.assign(new Error('the disk is full'), { code: 'ENOSPC' });
      return writeAtomic(path, text);
    };
    const client = await connectClient(project.url, project.token, acceptConfirm);
    try {
      // A batch that both moves a node (the manifest) and dates it (the coherence file).
      const result = await client.callTool({
        name: 'timeline.edit',
        arguments: { ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 3 } }, { op: 'move', nodeId: LANDING, newParentId: 'manuscript', index: 0 }] },
      });
      expect(result.isError).toBe(true);
      const body = resultJson(result) as Record<string, unknown>;
      expect(body['status']).toBe('partial');
      expect(body['files']).toEqual(['caotang.json']);
      expect(body['unwritten']).toEqual(['coherence.json']);
      // The read-back says what the folder holds now: the move, and no declaration.
      expect((body['readback'] as { moved: { parentId: string }[] }).moved.map((move) => move.parentId)).toEqual(['manuscript']);
      const after = JSON.parse(readFileSync(join(project.root, 'caotang.json'), 'utf8')) as { tree: { id: string; parentId: string }[] };
      expect(after.tree.find((node) => node.id === LANDING)?.parentId).toBe('manuscript');
    } finally {
      await client.close();
    }
  });
});
