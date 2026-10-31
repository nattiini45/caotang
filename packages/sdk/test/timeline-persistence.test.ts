/**
 * The timeline batch's two-file save — [timeline.md §9.2](../../../docs/architecture/timeline.md), T12.
 *
 * A `timeline.edit` batch changes a scene's declaration in `coherence.json` and, for a move, the tree in `caotang.json`. The folder
 * writes them one after the other, with the app's own copy of `coherence.json` merged per scene, and answers with a typed outcome whose
 * `persisted` carries a read-back of what the disk holds. These tests drive the real harness — the tool's own `expect` values, the bus's
 * projection, the store's apply — through the folder's queue, and assert the four outcomes against the files themselves.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { serializeCoherenceFile, emptyCoherenceFile, type CoherenceFile, type Finding, type SceneMeta } from '@caotang/coherence';
import { createProductHarness, type Harness, type ToolOutcome } from '@caotang/harness';
import { readProject } from '@caotang/store';
import { afterEach, describe, expect, it } from 'vitest';

import { FolderChangedError, MCP_VOICE, NodeArtifactFs, openFolder, type OpenFolder } from '../src/folder-api.js';
import { folderBytes, OPENED, seedProject, CHAPTER_TWO, LANDING, STORM } from './fixture.js';
import { removeDir, tempDir } from './support.js';

const ENTRY = 'c_HANNE00001';

/** The finding and the rule the app's own scan left: neither is a timeline batch's to change. */
function finding(id: string, docIds: readonly string[]): Finding {
  const now = OPENED.toISOString();
  return {
    id,
    runId: 'r_AAAAAAAAAA',
    class: 'deterministic',
    checkId: 'timeline.overlap',
    type: 'overlap',
    severity: 'warning',
    status: 'dismissed',
    dismissedReason: 'the two scenes are a dream sequence',
    factGroup: `timeline.overlap|${id}`,
    evidence: docIds.map((docId) => ({ docId, quote: '', from: 0, to: 0 })),
    createdAt: now,
    updatedAt: now,
    message: id,
  } as Finding;
}

/** The coherence.json the app left in the folder: two dated scenes, a dismissal, a world rule and review state. */
function appFile(): CoherenceFile {
  const stamp = OPENED.toISOString();
  const sceneMeta: Record<string, SceneMeta> = {
    [LANDING]: { dayOffset: 3, durationDays: 1 },
    [STORM]: { dayOffset: 4, pov: ENTRY },
  };
  return {
    ...emptyCoherenceFile(),
    sceneMeta,
    findings: [finding('f_AAAAAAAAAA', [LANDING, STORM])],
    worldRules: [{ id: 'w_AAAAAAAAAA', text: 'The lighthouse has no keeper in winter.', origin: 'manual', verified: true, createdAt: stamp, updatedAt: stamp }],
    reviewState: { [LANDING]: { lastReviewedRevision: 4, lastReviewedAt: stamp } },
  };
}

interface Opened {
  readonly folder: OpenFolder;
  readonly harness: Harness;
  readonly root: string;
}

const made: string[] = [];

afterEach(() => {
  for (const root of made.splice(0)) removeDir(root);
});

/** A project folder with the app's coherence.json in it, open through the SDK's own folder session. */
async function opened(label: string): Promise<Opened> {
  const root = tempDir(`sdk-timeline-${label}`);
  made.push(root);
  await seedProject(root);
  writeFileSync(join(root, 'coherence.json'), serializeCoherenceFile(appFile()));
  const folder = await openFolder({ root, voice: MCP_VOICE, writeCoherence: true, report: () => {} });
  const harness = createProductHarness({ state: folder.state, registry: folder.registry, externalWrites: true, ports: 'external' });
  return { folder, harness, root };
}

/** One approved `timeline.edit` through the folder's queue, as the MCP server runs it. */
function applyEdit(opened: Opened, params: Record<string, unknown>, callId = 'c_1') {
  return opened.folder.applyTimeline((): { installed: boolean; outcome: ToolOutcome } => {
    const outcome = opened.harness.call({ name: 'timeline.edit', callId, params }, { turnId: `t_${callId}`, permission: { confirmed: true } });
    return { installed: outcome.ok, outcome };
  });
}

/** `coherence.json` as the folder holds it. */
function onDisk(root: string): CoherenceFile {
  return JSON.parse(readFileSync(join(root, 'coherence.json'), 'utf8')) as CoherenceFile;
}

/** The manifest's tree as the folder holds it. */
async function treeOnDisk(root: string): Promise<{ id: string; parentId: string | null; order: number }[]> {
  const { state } = await readProject(new NodeArtifactFs(root), { now: OPENED });
  return state.manifest.tree.map((node) => ({ id: node.id, parentId: node.parentId, order: node.order }));
}

/** After a partial batch every later write is refused and none reaches the folder, whatever caller asks for it. */
async function expectWritesStopped(project: Opened): Promise<void> {
  const held = folderBytes(project.root);
  expect(project.folder.changed).toBe(true);
  await expect(project.folder.persist()).rejects.toBeInstanceOf(FolderChangedError);
  const next = await applyEdit(project, { ops: [{ op: 'meta', nodeId: STORM, patch: { dayOffset: 40 } }] }, 'c_2');
  expect(next.status).toBe('conflict');
  if (next.status === 'conflict') expect(next.conflict.error.message).toContain('Nothing was written.');
  expect(folderBytes(project.root)).toEqual(held);
}

describe('a timeline batch written as its two files (timeline.md §9.2)', () => {
  it('persists a scene declaration and reads it back from the folder', async () => {
    const project = await opened('persist');
    const result = await applyEdit(project, {
      ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 21, durationDays: 2, pov: 'Elena' } }],
      label: 'Move the landing',
    });
    try {
      expect(result.status).toBe('persisted');
      if (result.status !== 'persisted') return;
      expect(result.files).toEqual(['coherence.json']);
      // The read-back is the folder's own file, not what the batch meant: the day, the duration, the resolved point of view and the
      // effective part, by the scene's title.
      expect(result.readback).toEqual({
        scenes: [{ nodeId: LANDING, title: 'The Landing', dayOffset: 21, durationDays: 2, timelineMode: 'linear', pov: ENTRY, storyPart: 'main' }],
        moved: [],
      });
      const file = onDisk(project.root);
      expect(file.sceneMeta[LANDING]).toMatchObject({ dayOffset: 21, durationDays: 2, pov: ENTRY });
    } finally {
      await project.folder.close();
    }
  });

  it('keeps what the app declared elsewhere: other scenes, dismissals, world rules and review state', async () => {
    const project = await opened('merge');
    const result = await applyEdit(project, { ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 30 } }] });
    try {
      expect(result.status).toBe('persisted');
      const file = onDisk(project.root);
      expect(file.sceneMeta[LANDING]?.dayOffset).toBe(30);
      // The scene the batch did not touch is the app's still, and so is everything a batch never writes.
      expect(file.sceneMeta[STORM]).toEqual({ dayOffset: 4, pov: ENTRY });
      expect(file.findings.map((entry) => [entry.id, entry.status])).toEqual([['f_AAAAAAAAAA', 'dismissed']]);
      expect(file.worldRules.map((rule) => rule.id)).toEqual(['w_AAAAAAAAAA']);
      expect(file.reviewState[LANDING]?.lastReviewedRevision).toBe(4);
    } finally {
      await project.folder.close();
    }
  });

  it('refuses when the app changed the same scene while the batch was being confirmed, names it, and takes the batch back out', async () => {
    const project = await opened('conflict');
    const before = folderBytes(project.root);
    // Another program sets the same scene's day while the host's dialog is open. The batch's own `expect` was read before it, from this
    // host's copy, so writing its value would overwrite the app's.
    const raced = appFile();
    raced.sceneMeta[LANDING] = { dayOffset: 5, durationDays: 1 };
    writeFileSync(join(project.root, 'coherence.json'), serializeCoherenceFile(raced));
    const racedBytes = folderBytes(project.root);
    const result = await applyEdit(project, { ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 21 } }] });
    try {
      expect(result.status).toBe('conflict');
      if (result.status !== 'conflict') return;
      expect(result.conflict.scenes).toEqual([
        { nodeId: LANDING, title: 'The Landing', field: 'dayOffset', expected: 'day 3', current: 'day 5' },
      ]);
      expect(result.conflict.error.code).toBe('revision-conflict');
      expect(result.conflict.error.message).toContain('‘The Landing’');
      expect(result.conflict.error.message).toContain('day 3');
      expect(result.conflict.error.message).toContain('day 5');
      // Nothing was written — not the coherence file, and not the manifest the save always rewrites.
      expect(folderBytes(project.root)).toEqual(racedBytes);
      // And the session's copy holds the app's value again, not the batch's: the next read is the folder's.
      expect(project.folder.state.coherence?.sceneMeta[LANDING]?.dayOffset).toBe(3);
      expect(before[`docs/${LANDING}.md`]).toBe(racedBytes[`docs/${LANDING}.md`]);
    } finally {
      await project.folder.close();
    }
  });

  it('merges a disjoint app edit instead of refusing: the day it writes and the point of view it did not', async () => {
    const project = await opened('disjoint');
    const raced = appFile();
    raced.sceneMeta[STORM] = { dayOffset: 4, timelineMode: 'flashback' };
    writeFileSync(join(project.root, 'coherence.json'), serializeCoherenceFile(raced));
    const result = await applyEdit(project, { ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 30 } }] });
    try {
      expect(result.status).toBe('persisted');
      const file = onDisk(project.root);
      expect(file.sceneMeta[LANDING]?.dayOffset).toBe(30);
      expect(file.sceneMeta[STORM]).toEqual({ dayOffset: 4, timelineMode: 'flashback' });
    } finally {
      await project.folder.close();
    }
  });

  it('writes a move to caotang.json, a declaration to coherence.json, and reports both files', async () => {
    const project = await opened('move');
    const result = await applyEdit(project, {
      ops: [
        { op: 'move', nodeId: LANDING, newParentId: CHAPTER_TWO, index: 0 },
        { op: 'meta', nodeId: LANDING, patch: { dayOffset: 12 } },
      ],
    });
    try {
      expect(result.status).toBe('persisted');
      if (result.status !== 'persisted') return;
      expect(result.files).toEqual(['caotang.json', 'coherence.json']);
      expect(result.readback.moved).toEqual([{ nodeId: LANDING, title: 'The Landing', parentId: CHAPTER_TWO, parentTitle: 'Chapter 2', index: 0 }]);
      const tree = await treeOnDisk(project.root);
      expect(tree.find((node) => node.id === LANDING)?.parentId).toBe(CHAPTER_TWO);
      expect(onDisk(project.root).sceneMeta[LANDING]?.dayOffset).toBe(12);
    } finally {
      await project.folder.close();
    }
  });

  it('says partial, never persisted, when coherence.json cannot be written after the manifest was', async () => {
    const project = await opened('partial-coherence');
    const fs = project.folder.fs;
    const writeAtomic = fs.writeAtomic.bind(fs);
    fs.writeAtomic = async (path: string, text: string) => {
      if (path === 'coherence.json') throw Object.assign(new Error('the disk is full'), { code: 'ENOSPC' });
      return writeAtomic(path, text);
    };
    try {
      const result = await applyEdit(project, {
        ops: [
          { op: 'move', nodeId: LANDING, newParentId: CHAPTER_TWO, index: 0 },
          { op: 'meta', nodeId: LANDING, patch: { dayOffset: 12 } },
        ],
      });
      expect(result.status).toBe('partial');
      if (result.status !== 'partial') return;
      expect(result.written).toEqual(['caotang.json']);
      expect(result.unwritten).toEqual(['coherence.json']);
      expect(result.recovery).toContain('coherence.json could not be written (ENOSPC)');
      // The move is on disk and the declaration is not: the answer says exactly that, and the read-back is what the folder holds now.
      const tree = await treeOnDisk(project.root);
      expect(tree.find((node) => node.id === LANDING)?.parentId).toBe(CHAPTER_TWO);
      expect(onDisk(project.root).sceneMeta[LANDING]?.dayOffset).toBe(3);
      expect(result.readback.moved.map((move) => move.parentId)).toEqual([CHAPTER_TWO]);
      fs.writeAtomic = writeAtomic;
      await expectWritesStopped(project);
    } finally {
      await project.folder.close();
    }
  });

  it('says partial when caotang.json stops part way, and names both files as unwritten', async () => {
    const project = await opened('partial-manifest');
    const fs = project.folder.fs;
    const writeAtomic = fs.writeAtomic.bind(fs);
    fs.writeAtomic = async (path: string, text: string) => {
      if (path === 'caotang.json') throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      return writeAtomic(path, text);
    };
    try {
      const result = await applyEdit(project, {
        ops: [
          { op: 'move', nodeId: LANDING, newParentId: CHAPTER_TWO, index: 0 },
          { op: 'meta', nodeId: LANDING, patch: { dayOffset: 12 } },
        ],
      });
      expect(result.status).toBe('partial');
      if (result.status !== 'partial') return;
      expect(result.written).toEqual([]);
      expect(result.unwritten).toEqual(['caotang.json', 'coherence.json']);
      expect(onDisk(project.root).sceneMeta[LANDING]?.dayOffset).toBe(3);
      fs.writeAtomic = writeAtomic;
      await expectWritesStopped(project);
    } finally {
      await project.folder.close();
    }
  });

  it('says partial and stops every later write when the folder does not hold what was written', async () => {
    const project = await opened('partial-readback');
    const fs = project.folder.fs;
    const writeAtomic = fs.writeAtomic.bind(fs);
    fs.writeAtomic = async (path: string, text: string) => {
      await writeAtomic(path, path === 'coherence.json' ? text.replace('"dayOffset": 12', '"dayOffset": 99') : text);
    };
    try {
      const result = await applyEdit(project, { ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 12 } }] });
      expect(result.status).toBe('partial');
      if (result.status !== 'partial') return;
      expect(result.written).toEqual(['coherence.json']);
      expect(result.unwritten).toEqual([]);
      expect(result.readback.scenes[0]?.dayOffset).toBe(99);
      fs.writeAtomic = writeAtomic;
      await expectWritesStopped(project);
    } finally {
      await project.folder.close();
    }
  });

  it('writes nothing for a batch the harness refused, and says so with the bus’s own words', async () => {
    const project = await opened('refused');
    const before = folderBytes(project.root);
    const result = await applyEdit(project, { ops: [{ op: 'move', nodeId: LANDING, newParentId: STORM, index: 0 }] });
    try {
      expect(result.status).toBe('refused');
      if (result.status !== 'refused') return;
      expect(result.outcome.ok).toBe(false);
      expect(folderBytes(project.root)).toEqual(before);
    } finally {
      await project.folder.close();
    }
  });

  it('writes no file for a batch that changes nothing the project holds', async () => {
    const project = await opened('noop');
    const before = folderBytes(project.root);
    const result = await applyEdit(project, { ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 3 } }] });
    try {
      expect(result.status).toBe('persisted');
      if (result.status !== 'persisted') return;
      expect(result.files).toEqual([]);
      expect(result.readback).toEqual({ scenes: [], moved: [] });
      expect(folderBytes(project.root)).toEqual(before);
    } finally {
      await project.folder.close();
    }
  });
});
