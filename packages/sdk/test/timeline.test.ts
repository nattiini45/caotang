/**
 * The timeline accessors a Node host reads (timeline.md §3, §8, §9.2): one canonical `buildTimeline` path shared with the
 * browser, and the CSV rows in the canonical logical order. The folder test proves the session's accessors read the
 * `coherence.json` on disk and write nothing.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { timelineCsv, timelineTable, TIMELINE_COLUMNS } from '@caotang/exporter';
import { emptyCoherenceFile, serializeCoherenceFile, type CoherenceFile, type Finding, type SceneMeta } from '@caotang/coherence';
import { buildTimeline, dayLens, type TimelineModel } from '@caotang/timeline';
import { addDocument, addFolder, createEmptyManifest, createProjectState, writeProject, type ProjectState } from '@caotang/store';
import { afterEach, describe, expect, it } from 'vitest';

import { coherenceFileOf, MCP_VOICE, NodeArtifactFs, openFolder, scopeNodeOf, timelineCsvOf, timelineModelOf } from '../src/folder-api.js';
import { folderBytes, OPENED } from './fixture.js';
import { removeDir, tempDir } from './support.js';

const PROLOGUE_FOLDER = 'n_BEFR000001';
const CHAPTER = 'n_CHAPTR0001';
const PROLOGUE = 'n_DEPART0001';
const OPENING = 'n_BEACH00001';
const MIDDLE = 'n_TEMPEST001';
const LATE = 'n_CARD000001';
const UNDATED = 'n_NDAY000001';
const LOOSE = 'n_FREE000001';
const EPILOGUE = 'n_C0DA000001';

function finding(id: string, checkId: string, docIds: readonly string[], status: Finding['status'] = 'open'): Finding {
  const now = OPENED.toISOString();
  return {
    id,
    runId: 'r_1',
    class: 'deterministic',
    checkId,
    type: checkId.split('.')[1] ?? 'x',
    severity: 'warning',
    status,
    factGroup: `${checkId}|${id}`,
    evidence: docIds.map((docId) => ({ docId, quote: '', from: 0, to: 0 })),
    createdAt: now,
    updatedAt: now,
    message: id,
  } as Finding;
}

/** A project with a declared prologue at a negative day, an overlapping pair in the main story, an after-chain and a loose scene on the shelf, and an epilogue. */
function storyState(): { state: ProjectState; file: CoherenceFile } {
  const manifest = createEmptyManifest('The Lighthouse Keeper', OPENED);
  // Pinned: the default language is the machine's, and a day label groups its digits by it.
  manifest.project.language = 'en';
  const state = createProjectState(manifest);
  addFolder(state, { parentId: 'manuscript', title: 'Before', now: OPENED, id: PROLOGUE_FOLDER });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER });
  addDocument(state, { parentId: PROLOGUE_FOLDER, title: 'The Departure', body: 'She left in the spring.', now: OPENED, id: PROLOGUE });
  addDocument(state, { parentId: CHAPTER, title: 'The Landing', body: 'The ferry was late, as always.', now: OPENED, id: OPENING });
  addDocument(state, { parentId: CHAPTER, title: 'The Storm', body: 'Rain on the glass.', now: OPENED, id: MIDDLE });
  addDocument(state, { parentId: CHAPTER, title: 'The Letter', body: 'A letter, "sealed".', now: OPENED, id: LATE });
  addDocument(state, { parentId: CHAPTER, title: 'Undated', body: 'No day yet.', now: OPENED, id: UNDATED });
  addDocument(state, { parentId: CHAPTER, title: 'Loose, "adrift"', body: 'No day, no chain.', now: OPENED, id: LOOSE });
  addDocument(state, { parentId: 'manuscript', title: 'Coda', body: 'Years later.', now: OPENED, id: EPILOGUE });
  const sceneMeta: Record<string, SceneMeta> = {
    [PROLOGUE_FOLDER]: { storyPart: 'prologue' },
    [PROLOGUE]: { dayOffset: -3650 },
    [OPENING]: { dayOffset: 0, durationDays: 2, pov: 'c_ENA0000001', timelineMode: 'flashback' },
    [MIDDLE]: { dayOffset: 1 },
    [LATE]: { dayOffset: 12, durationDays: 2, after: [MIDDLE] },
    [UNDATED]: { after: [LATE] },
    [EPILOGUE]: { dayOffset: 4400, storyPart: 'epilogue' },
  };
  const file: CoherenceFile = {
    ...emptyCoherenceFile(),
    sceneMeta,
    findings: [finding('f_AAAAAAAAAA', 'timeline.overlap', [OPENING, MIDDLE]), finding('f_BBBBBBBBBB', 'timeline.gap', [OPENING, LATE], 'dismissed')],
  };
  state.coherence = file;
  return { state, file };
}

describe('the canonical timeline model (timeline.md §3)', () => {
  it('is exactly what buildTimeline builds from the same state and file, as the browser view builds it', () => {
    const { state, file } = storyState();
    const model = timelineModelOf(state);
    expect(model).toEqual(buildTimeline(state, file, { axis: 'story', groupBy: 'none', findings: 'open', lens: dayLens }));
  });

  it('reads the parts, a negative day, the shelf and the open findings only', () => {
    const { state } = storyState();
    const model = timelineModelOf(state);
    expect(model.zones.map((zone) => [zone.part, zone.startDay, zone.endDay, zone.count])).toEqual([
      ['prologue', -3650, -3649, 1],
      ['main', 0, 14, 5],
      ['epilogue', 4400, 4401, 1],
    ]);
    const byNode = new Map(model.items.map((item) => [item.nodeId, item]));
    expect(byNode.get(PROLOGUE)).toMatchObject({ part: 'prologue', start: -3650, end: -3649, dayOffset: -3650 });
    expect(byNode.get(OPENING)).toMatchObject({ part: 'main', mode: 'flashback', findings: [{ checkId: 'timeline.overlap' }] });
    expect(byNode.get(LATE)?.findings).toEqual([]);
    // The dismissed gap finding is not attached under the default 'open'; the overlap is, on both scenes of the pair.
    expect(model.items.flatMap((item) => item.findings.map((entry) => entry.checkId)).sort()).toEqual(['timeline.overlap', 'timeline.overlap']);
    expect(timelineModelOf(state, { findings: 'none' }).items.every((item) => item.findings.length === 0)).toBe(true);
    // The shelf: the undated scene chains after the dated one with its day hint; the loose scene stands alone.
    expect(model.unscheduled.sequenced.map((chain) => [chain.part, chain.steps.map((step) => [step.item.nodeId, step.anchor?.hint])])).toEqual([
      ['main', [[UNDATED, 'after Day 14']]],
    ]);
    expect(model.unscheduled.loose.map((item) => item.nodeId)).toEqual([LOOSE]);
    // A scope names only the scenes under it.
    const scoped = timelineModelOf(state, { scope: CHAPTER });
    expect(scoped.items.map((item) => item.nodeId).sort()).toEqual([LATE, LOOSE, MIDDLE, OPENING, UNDATED].sort());
    expect(scopeNodeOf(state, CHAPTER)?.id).toBe(CHAPTER);
    expect(scopeNodeOf(state, 'root')).toBeUndefined();
    expect(scopeNodeOf(state, 'n_missing')).toBeUndefined();
  });

  it('labels days through the day lens, with the real minus sign and the long form’s grouping', () => {
    const { state } = storyState();
    const model = timelineModelOf(state);
    const prologue = model.items.find((item) => item.nodeId === PROLOGUE);
    expect(dayLens.label(prologue?.dayOffset ?? 0, 'long')).toBe('Day −3,650');
    expect(dayLens.label(prologue?.dayOffset ?? 0, 'short')).toBe('Day −3650');
    expect(model.axis.folds.map((fold) => [fold.fromPart, fold.toPart, fold.label])).toEqual([
      ['prologue', 'main', 'Prologue · about 10 years before Day 0'],
      ['main', 'epilogue', 'Epilogue · about 12 years later'],
    ]);
  });
});

describe('the day labels follow the project language (timeline.md §3.8, §8)', () => {
  it('groups digits as the project language does, so a read here agrees with the compiled timeline-csv', () => {
    const { state } = storyState();
    const labelOf = (): string => timelineModelOf(state).items.find((item) => item.nodeId === EPILOGUE)?.a11yLabel ?? '';
    expect(labelOf()).toContain('Day 4,400');
    state.manifest.project.language = 'de';
    expect(labelOf()).toContain('Day 4.400');
    expect(timelineCsvOf(state)).toContain('Day 4.400');
  });
});

describe('the timeline CSV (timeline.md §8)', () => {
  it('is the exporter’s own table and CSV, so the resource and the compiled timeline-csv file cannot drift', () => {
    const { state } = storyState();
    expect(timelineCsvOf(state)).toBe(timelineCsv(timelineTable({ state, includeRootIds: ['manuscript'] })));
    expect(timelineCsvOf(state, { scope: CHAPTER })).toBe(timelineCsv(timelineTable({ state, includeRootIds: [CHAPTER] })));
  });

  it('writes the exporter’s header and one CRLF record per scene in canonical order — part, day, reading index, undated last per part', () => {
    const { state } = storyState();
    const csv = timelineCsvOf(state);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(TIMELINE_COLUMNS.join(','));
    expect(lines[lines.length - 1]).toBe('');
    const rows = lines.slice(1, -1);
    // Prologue first at its negative day, then the main story by day, the undated scenes last, the epilogue at the end.
    expect(rows.map((line) => line.split(',')[2])).toEqual(['The Departure', 'The Landing', 'The Storm', 'The Letter', 'Undated', '"Loose', 'Coda']);
    // The negative day is a signed decimal with the formula guard; the lens label keeps the real minus sign (its digit grouping follows the project language).
    expect(rows[0]).toContain(",'-3650,");
    expect(rows[0]).toContain('Day −3');
    expect(rows[0]?.startsWith('0,Prologue,The Departure,Before,')).toBe(true);
    expect(rows[6]?.startsWith('6,Epilogue,Coda,,4400,')).toBe(true);
    // The overlap finding is on the scene it names; the dismissed gap finding is nowhere.
    expect(rows[1]).toContain('timeline.overlap');
    expect(csv).not.toContain('timeline.gap');
    // A title with a comma and a quote is one quoted cell, with the quote doubled.
    expect(csv).toContain('"Loose, ""adrift"""');
  });

  it('is not the SDK-only layout it once was: the exporter’s columns, with no node-id column', () => {
    expect(TIMELINE_COLUMNS).toContain('open findings');
    expect(TIMELINE_COLUMNS).not.toContain('nodeId');
  });
});
describe('the folder session’s timeline accessors', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const root of made.splice(0)) removeDir(root);
  });

  it('read the coherence.json on disk, match the pure accessor, and write nothing', async () => {
    const root = tempDir('sdk-timeline');
    made.push(root);
    const { state, file } = storyState();
    const fs = new NodeArtifactFs(root);
    await writeProject(fs, state, { now: OPENED });
    writeFileSync(join(root, 'coherence.json'), serializeCoherenceFile(file));

    const folder = await openFolder({ root, voice: MCP_VOICE, writeCoherence: false, report: () => {} });
    // Taken once the folder is open: the session's own lock file is not a project write.
    const before = folderBytes(root);
    try {
      const model: TimelineModel = folder.timeline();
      expect(model).toEqual(timelineModelOf(folder.state));
      expect(model).toEqual(buildTimeline(folder.state, coherenceFileOf(folder.state), { axis: 'story', groupBy: 'none', findings: 'open', lens: dayLens }));
      expect(model.zones.map((zone) => zone.part)).toEqual(['prologue', 'main', 'epilogue']);
      expect(folder.timelineCsv()).toBe(timelineCsvOf(folder.state));
      expect(coherenceFileOf(folder.state).sceneMeta[PROLOGUE]?.dayOffset).toBe(-3650);
      // A read writes nothing, on either posture.
      expect(folderBytes(root)).toEqual(before);
    } finally {
      await folder.close();
    }
  });
});
