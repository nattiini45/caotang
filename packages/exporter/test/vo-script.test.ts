/**
 * The AV script's VO script (av-script.md §5): `vo-script-csv` and `vo-script-xlsx`, one row per speakable
 * line with the spec's columns — `lineId, segment, speaker, text, durationSec, declared` — read from the
 * episode's own parse, so the table says what the script holds and no more.
 */

import { describe, expect, it } from 'vitest';
import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  MemoryArtifactFs,
  type ProjectState,
} from '@caotang/store';
import { createExporter, type ExporterService } from '../src/index.js';
import { MediaRefusedError } from '../src/errors.js';
import { readRows } from './xlsx-read.js';
import { unzipText } from './xml.js';
import { COMPILED_AT, PROJECT_NAME } from './fixture.js';

const OPENED = new Date(COMPILED_AT);

const SHOW_ID = 'n_SHOW000001';
const EPISODE_ID = 'n_EPISODE001';

/** One episode: a narration before the first segment, a declared and an estimated speech line, a text line, and a line still unminted. */
export const EPISODE_BODY = [
  '# Episode 1',
  '',
  'NARRATION: Previously, on the show. [0:08] <!-- lineId: sl_0K3M9T2Q7X -->',
  '',
  '## The interview',
  'HOST_A: Welcome back. [0:15] <!-- lineId: sl_1000000002 -->',
  'GUEST: We lit the lamp. <!-- lineId: sl_1000000003 -->',
  'A note for the editor, not to be read.',
  '',
  '## Outro',
  'HOST_A: See you next week.',
].join('\n');

export function makeShowProject(options: { episode?: string } = {}): ProjectState {
  const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED, { locale: 'en-US' }));
  addFolder(state, { parentId: 'manuscript', title: 'The Show', now: OPENED, id: SHOW_ID });
  const episode = addDocument(state, {
    parentId: SHOW_ID,
    title: 'Episode 1',
    body: options.episode ?? EPISODE_BODY,
    now: OPENED,
    id: EPISODE_ID,
  });
  Object.assign(episode, { kind: 'av-script' });
  return state;
}

function rig(options: { state?: ProjectState } = {}): { readonly exporter: ExporterService } {
  const state = options.state ?? makeShowProject();
  return {
    exporter: createExporter({
      readState: () => state,
      artifacts: new MemoryArtifactFs(),
      clock: { now: () => COMPILED_AT },
      metadata: () => ({ author: 'Ada Lovelace' }),
    }),
  };
}

describe('the VO script', () => {
  it('writes the CSV with the spec columns and one row per speakable line', async () => {
    const result = await rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'vo-script-csv');
    const file = result.files[0];
    expect(result.files.length).toBe(1);
    expect(file?.fileName).toContain('VO script');
    expect(file?.mimeType).toBe('text/csv;charset=utf-8');
    const text = await file!.blob.text();
    const lines = text.trimEnd().split('\r\n');
    expect(lines[0]).toBe('lineId,segment,speaker,text,durationSec,declared');
    // The narration before the first heading sits in segment-0, whose title is empty.
    expect(lines[1]).toBe('sl_0K3M9T2Q7X,,NARRATION,"Previously, on the show.",8,true');
    expect(lines[2]).toBe('sl_1000000002,The interview,HOST_A,Welcome back.,15,true');
    // Four words at the 150 wpm narration rate estimate 1.6 s; declared is false for an estimate.
    expect(lines[3]).toBe('sl_1000000003,The interview,GUEST,We lit the lamp.,1.6,false');
    // The text line takes no row; the unminted line carries its session-local id.
    expect(lines.length).toBe(5);
    expect(lines[4]).toMatch(/^~l11,Outro,HOST_A,See you next week\.,1\.6,false$/);
  });

  it('refuses a selection with no episode, and one with no speakable line', async () => {
    const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED, { locale: 'en-US' }));
    await expect(rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vo-script-csv')).rejects.toBeInstanceOf(
      MediaRefusedError,
    );
    const textOnly = makeShowProject({ episode: '## A\nOnly a text line.\n' });
    await expect(rig({ state: textOnly }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vo-script-xlsx')).rejects.toThrow(
      /no speakable line/,
    );
  });

  it('writes the same rows to the spreadsheet, as typed cells', async () => {
    const result = await rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'vo-script-xlsx');
    const file = result.files[0];
    expect(file?.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const parts = unzipText(new Uint8Array(await file!.blob.arrayBuffer()));
    const rows = readRows(parts['xl/worksheets/sheet1.xml'] ?? '', 6);
    expect(rows[0]).toEqual(['lineId', 'segment', 'speaker', 'text', 'durationSec', 'declared']);
    expect(rows[1]).toEqual(['sl_0K3M9T2Q7X', '', 'NARRATION', 'Previously, on the show.', 8, 'true']);
    expect(rows[3]).toEqual(['sl_1000000003', 'The interview', 'GUEST', 'We lit the lamp.', 1.6, 'false']);
    expect(rows.length).toBe(5);
  });

  it('limits the table to the selected show, so a second show stays out', async () => {
    const state = makeShowProject();
    const other = addFolder(state, { parentId: 'manuscript', title: 'Another show', now: OPENED, id: 'n_OTHER00001' });
    const ep = addDocument(state, {
      parentId: other.id,
      title: 'Other episode',
      body: '## A\nGUEST: Not in the selection. <!-- lineId: sl_1000000009 -->',
      now: OPENED,
      id: 'n_OTHEREPO001',
    });
    Object.assign(ep, { kind: 'av-script' });
    const result = await rig({ state }).exporter.compile({ includeRootIds: [SHOW_ID] }, 'vo-script-csv');
    const text = await result.files[0]!.blob.text();
    expect(text).not.toContain('Not in the selection');
    expect(text.trimEnd().split('\r\n').length).toBe(5);
  });
});
