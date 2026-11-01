import { expect, test } from '@playwright/test';

import {
  NO_FILTERS,
  PICTURE_DRAG_TYPE,
  bytesText,
  canAttachToParagraph,
  dragKindOf,
  entriesOf,
  filterChoicesOf,
  filterEntries,
  filtersActive,
  importSummary,
  largePhotoQuestionOf,
  liveSelection,
  meterSentence,
  nodeChoicesOf,
  parseTags,
  pickerLabelOf,
  pictureLabelOf,
  pixelsText,
  sizeMeterOf,
  sourceLabelOf,
  toggledSelection,
  usedInLines,
  withTags,
  type ImportReport,
} from '../../apps/desktop/src/media/picture-board-model.js';
import { foldText } from '../../packages/furniture/src/index.js';
import { addDocument, addFolder, createEmptyManifest, createProjectState, type ProjectState } from '../../packages/store/src/index.js';
import type { AssetLink, ReadAssetLink, ReadAssetRecord, AssetRecord } from '../../packages/pictures/src/index.js';

/**
 * What the picture board, the Inspector's strip and the corkboard read of a project (pictures.md §5): the filters, the batch selection,
 * the size meter and the import summary, without a renderer.
 */

const NOW = new Date('2026-10-01T09:00:00.000Z');
const HASH = 'a'.repeat(64);

/** A record as the manifest stores it: the read type, which also carries the fields a newer build may have written. */
function record(id: string, patch: Partial<AssetRecord> = {}): ReadAssetRecord {
  return { id, file: `${id}.png`, mime: 'image/png', sha256: HASH, bytes: 1000, createdAt: '2026-10-01T09:00:00.000Z', ...patch };
}

function link(id: string, assetId: string, target: AssetLink['target'], role: AssetLink['role'] = 'reference'): ReadAssetLink {
  return { id, assetId, target, role, order: 10 };
}

function project(records: ReadAssetRecord[], links: ReadAssetLink[] = []): ProjectState {
  const state = createProjectState(createEmptyManifest('Board', NOW, { locale: 'en-US' }), { now: NOW });
  addFolder(state, { id: 'ch1', parentId: 'manuscript', title: 'Chapter 1', now: NOW });
  addDocument(state, { id: 'sc1', parentId: 'ch1', title: 'The Lamp', body: 'One.\n\nTwo.', now: NOW });
  state.manifest.assets = records;
  state.manifest.assetLinks = links;
  return state;
}

test.describe('naming a picture', () => {
  test('the caption wins, then the alt text, then the file the writer chose, then the stored file', () => {
    const base = record('a_AAAAAAAAAA', { source: { kind: 'import', label: 'IMG_0042.jpg' } });
    expect(pictureLabelOf({ ...base, caption: 'Lamp', alt: 'A lamp' })).toBe('Lamp');
    expect(pictureLabelOf({ ...base, caption: '  ', alt: 'A lamp' })).toBe('A lamp');
    expect(pictureLabelOf(base)).toBe('IMG_0042.jpg');
    expect(pictureLabelOf(record('a_BBBBBBBBBB'))).toBe('a_BBBBBBBBBB.png');
  });

  test('a picker names a registered picture by its label and an unregistered file by its file name', () => {
    const state = project([record('a_AAAAAAAAAA', { caption: 'Lamp' })]);
    expect(pickerLabelOf(state, 'a_AAAAAAAAAA', 'a_AAAAAAAAAA.png')).toBe('Lamp');
    expect(pickerLabelOf(state, 'a_ZZZZZZZZZZ', 'a_ZZZZZZZZZZ.jpg')).toBe('a_ZZZZZZZZZZ.jpg');
  });

  test('a source reads as a short phrase', () => {
    expect(sourceLabelOf('import')).toBe('Imported');
    expect(sourceLabelOf('paste')).toBe('Pasted');
    expect(sourceLabelOf('mcp')).toBe('From a tool');
  });
});

test.describe('entries and "used in"', () => {
  const records = [
    record('a_AAAAAAAAAA', { caption: 'Lamp', tags: ['lamp', 'dusk'], source: { kind: 'import' } }),
    record('a_BBBBBBBBBB', { source: { kind: 'paste' } }),
    record('a_CCCCCCCCCC', { transcription: { text: 'Ahoy', source: 'writer' } as never }),
  ];
  const links = [link('l_0000000001', 'a_AAAAAAAAAA', { kind: 'node', nodeId: 'sc1' }, 'card'), link('l_0000000002', 'a_BBBBBBBBBB', { kind: 'project' })];

  test('an entry says where a picture is placed, whether it is used, and whether its file is missing', () => {
    const state = project(records, links);
    const entries = entriesOf(state, new Set(['a_AAAAAAAAAA', 'a_BBBBBBBBBB']));
    expect(entries.map((entry) => [entry.id, entry.unused, entry.missing, entry.nodeIds])).toEqual([
      ['a_AAAAAAAAAA', false, false, ['sc1']],
      ['a_BBBBBBBBBB', false, false, []],
      ['a_CCCCCCCCCC', true, true, []],
    ]);
  });

  test('before the files are listed nothing is called missing', () => {
    const entries = entriesOf(project(records, links), null);
    expect(entries.every((entry) => !entry.missing)).toBe(true);
  });

  test('"used in" names each use in the writer’s binder titles', () => {
    const state = project(records, links);
    const all = entriesOf(state, null);
    const lines = usedInLines(state, all[0]?.uses ?? []).map((line) => line.text);
    expect(lines).toEqual(['The card picture of “The Lamp”']);
    expect(usedInLines(state, all[1]?.uses ?? []).map((line) => line.text)).toEqual(['Placed on the project']);
  });
});

test.describe('filters', () => {
  const records = [
    record('a_AAAAAAAAAA', { tags: ['lamp'], source: { kind: 'import' } }),
    record('a_BBBBBBBBBB', { tags: ['sea'], source: { kind: 'paste' } }),
    record('a_CCCCCCCCCC'),
  ];
  const links = [link('l_0000000001', 'a_AAAAAAAAAA', { kind: 'node', nodeId: 'sc1' }), link('l_0000000002', 'a_BBBBBBBBBB', { kind: 'project' })];
  const state = project(records, links);
  const entries = entriesOf(state, null);
  const ids = (found: readonly { id: string }[]): string[] => found.map((entry) => entry.id);

  test('no filter keeps every picture, and says it is off', () => {
    expect(ids(filterEntries(entries, NO_FILTERS))).toHaveLength(3);
    expect(filtersActive(NO_FILTERS)).toBe(false);
  });

  test('a tag, a target, a source and unused each narrow the board, and they combine', () => {
    expect(ids(filterEntries(entries, { ...NO_FILTERS, tag: 'lamp' }))).toEqual(['a_AAAAAAAAAA']);
    expect(ids(filterEntries(entries, { ...NO_FILTERS, target: 'sc1' }))).toEqual(['a_AAAAAAAAAA']);
    expect(ids(filterEntries(entries, { ...NO_FILTERS, target: 'project' }))).toEqual(['a_BBBBBBBBBB']);
    expect(ids(filterEntries(entries, { ...NO_FILTERS, source: 'paste' }))).toEqual(['a_BBBBBBBBBB']);
    expect(ids(filterEntries(entries, { ...NO_FILTERS, unused: true }))).toEqual(['a_CCCCCCCCCC']);
    expect(ids(filterEntries(entries, { ...NO_FILTERS, tag: 'lamp', source: 'paste' }))).toEqual([]);
    expect(filtersActive({ ...NO_FILTERS, tag: 'lamp' })).toBe(true);
  });

  test('the choices come from the whole registry, sorted, and the transcription filter exists only when a picture has one', () => {
    const choices = filterChoicesOf(state, entries);
    expect(choices.tags).toEqual(['lamp', 'sea']);
    expect(choices.sources).toEqual(['import', 'paste']);
    expect(choices.targets).toEqual([{ id: 'sc1', title: 'The Lamp' }]);
    expect(choices.project).toBe(true);
    expect(choices.transcriptions).toBe(false);

    const transcribed = project([record('a_DDDDDDDDDD', { transcription: { text: 'x', source: 'writer' } as never })]);
    expect(filterChoicesOf(transcribed, entriesOf(transcribed, null)).transcriptions).toBe(true);
  });

  test('the binder items a picture can go on come in binder order with their depth, under the sections and not the hidden root', () => {
    expect(nodeChoicesOf(state).map((choice) => [choice.title, choice.depth])).toEqual([
      ['Manuscript', 0],
      ['Chapter 1', 1],
      ['The Lamp', 2],
      ['Research', 0],
    ]);
  });
});

test.describe('searching the transcriptions', () => {
  const records = [
    record('a_AAAAAAAAAA', { caption: 'Lamp', transcription: { at: '2026-10-01T09:00:00.000Z', text: 'A red lamp — the keeper’s glow at dusk' } }),
    // The é is decomposed on purpose: NFC canonicalises it, so a composed needle still finds it.
    record('a_BBBBBBBBBB', { caption: 'Harbour', transcription: { at: '2026-10-01T09:00:00.000Z', text: 'cafe\u0301 au lait at the harbour' } }),
    record('a_CCCCCCCCCC', { caption: 'Plain' }),
    record('a_DDDDDDDDDD', { transcription: { at: '2026-10-01T09:00:00.000Z' } }),
  ];
  const entries = entriesOf(project(records), null);
  const ids = (found: readonly { id: string }[]): string[] => found.map((entry) => entry.id);

  test('an exact substring of the transcription narrows the board and counts as active', () => {
    expect(ids(filterEntries(entries, { ...NO_FILTERS, text: 'glow at dusk' }))).toEqual(['a_AAAAAAAAAA']);
    expect(ids(filterEntries(entries, { ...NO_FILTERS, text: 'harbour' }))).toEqual(['a_BBBBBBBBBB']);
    expect(filtersActive({ ...NO_FILTERS, text: 'harbour' })).toBe(true);
  });

  test('the match is the binder’s foldText on both sides: case, canonical form and apostrophes', () => {
    for (const needle of ['LAMP', 'Café', 'cafe\u0301', 'HARBOUR', 'au lait', "keeper's glow"]) {
      const folded = foldText(needle);
      const expected = entries
        .filter((entry) => entry.record.transcription?.text !== undefined && foldText(entry.record.transcription.text).includes(folded))
        .map((entry) => entry.id);
      expect(ids(filterEntries(entries, { ...NO_FILTERS, text: needle })), needle).toEqual(expected);
    }
    expect(ids(filterEntries(entries, { ...NO_FILTERS, text: 'Café' }))).toEqual(['a_BBBBBBBBBB']);
    expect(ids(filterEntries(entries, { ...NO_FILTERS, text: "keeper's glow" }))).toEqual(['a_AAAAAAAAAA']);
  });

  test('a needle nothing contains hides every picture', () => {
    expect(ids(filterEntries(entries, { ...NO_FILTERS, text: 'zzz' }))).toEqual([]);
  });

  test('an empty needle keeps every picture, untranscribed ones included, and is not active', () => {
    expect(ids(filterEntries(entries, { ...NO_FILTERS, text: '' }))).toHaveLength(4);
    expect(filtersActive({ ...NO_FILTERS, text: '' })).toBe(false);
  });

  test('the text combines with the transcribed filter, and a transcription without text does not match', () => {
    expect(ids(filterEntries(entries, { ...NO_FILTERS, text: 'a' }))).toEqual(['a_AAAAAAAAAA', 'a_BBBBBBBBBB']);
    expect(ids(filterEntries(entries, { ...NO_FILTERS, text: 'lamp', transcribed: true }))).toEqual(['a_AAAAAAAAAA']);
  });
});

test.describe('selection', () => {
  const entries = entriesOf(project([record('a_AAAAAAAAAA'), record('a_BBBBBBBBBB')]), null);

  test('toggling adds and removes one picture and does not touch the old set', () => {
    const none = new Set<string>();
    const one = toggledSelection(none, 'a_AAAAAAAAAA');
    expect([...one]).toEqual(['a_AAAAAAAAAA']);
    expect(none.size).toBe(0);
    expect(toggledSelection(one, 'a_AAAAAAAAAA').size).toBe(0);
  });

  test('a picture that has gone drops out of the selection', () => {
    expect([...liveSelection(new Set(['a_AAAAAAAAAA', 'a_GONE000000']), entries)]).toEqual(['a_AAAAAAAAAA']);
  });
});

test.describe('tags', () => {
  test('a typed line splits on commas, trimmed, without blanks or repeats', () => {
    expect(parseTags(' lamp, dusk ,, lamp ,sea ')).toEqual(['lamp', 'dusk', 'sea']);
    expect(parseTags('   ')).toEqual([]);
  });

  test('tags are added after the existing ones, and the limits are named', () => {
    expect(withTags(['lamp'], ['dusk', 'lamp'])).toEqual({ ok: true, tags: ['lamp', 'dusk'] });
    const tooLong = withTags([], ['x'.repeat(65)]);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.reason).toContain('64');
    const tooMany = withTags(Array.from({ length: 32 }, (_, index) => `t${index}`), ['one more']);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.reason).toContain('32');
  });
});

test.describe('the size meter', () => {
  test('it totals bytes and pixels and lists the ten heaviest, heaviest first, equal sizes in registry order', () => {
    const many = Array.from({ length: 12 }, (_, index) => record(`a_${String(index).padStart(10, '0')}`, { bytes: 100 * (index + 1), width: 100, height: 50 }));
    const meter = sizeMeterOf(entriesOf(project(many), null));
    expect(meter.count).toBe(12);
    expect(meter.totalBytes).toBe(100 * 78);
    expect(meter.totalPixels).toBe(12 * 5000);
    expect(meter.largest).toHaveLength(10);
    expect(meter.largest[0]?.record.bytes).toBe(1200);
    expect(meter.largest[9]?.record.bytes).toBe(300);

    const ties = sizeMeterOf(entriesOf(project([record('a_AAAAAAAAAA', { bytes: 5 }), record('a_BBBBBBBBBB', { bytes: 5 })]), null));
    expect(ties.largest.map((entry) => entry.id)).toEqual(['a_AAAAAAAAAA', 'a_BBBBBBBBBB']);
  });

  test('sizes read as a person reads them, in the formatter locale', () => {
    expect(bytesText(812, 'en')).toBe('812 bytes');
    expect(bytesText(1536, 'en')).toBe('1.5 KB');
    expect(bytesText(4.2 * 1024 * 1024, 'en')).toBe('4.2 MB');
    expect(bytesText(1536, 'de')).toBe('1,5 KB');
    expect(pixelsText({ width: 4032, height: 3024 }, 'en')).toBe('4,032 × 3,024 px (12.2 MP)');
    expect(pixelsText({}, 'en')).toBeUndefined();
  });

  test('the sentence counts the pictures and totals their weight', () => {
    const meter = sizeMeterOf(entriesOf(project([record('a_AAAAAAAAAA', { bytes: 1536 })]), null));
    expect(meterSentence(meter, 'en')).toBe('1 picture, 1.5 KB in all.');
    const two = sizeMeterOf(entriesOf(project([record('a_AAAAAAAAAA'), record('a_BBBBBBBBBB')]), null));
    expect(meterSentence(two, 'en')).toBe('2 pictures, 2 KB in all.');
  });
});

test.describe('drags and the import', () => {
  test('a drag is a picture from this app, files from the desktop, or something else', () => {
    expect(dragKindOf([PICTURE_DRAG_TYPE, 'text/plain'])).toBe('picture');
    expect(dragKindOf(['Files'])).toBe('files');
    expect(dragKindOf(['text/plain'])).toBeNull();
  });

  const none: Omit<ImportReport, 'status'> = { created: 0, reused: 0, assetIds: [], skipped: [] };

  test('the summary is whole sentences for what was made, what was already there and what was left out', () => {
    expect(importSummary({ ...none, status: 'imported', created: 2 })).toEqual({ text: 'Imported 2 pictures.', tone: 'info' });
    expect(importSummary({ ...none, status: 'imported', created: 1, reused: 2, skipped: [{ name: 'a.txt', reason: 'no' }] }).text).toBe(
      'Imported 1 picture. 2 pictures were already in the project. 1 file was left out.',
    );
    expect(importSummary({ ...none, status: 'cancelled' })).toEqual({ text: 'Nothing was imported.', tone: 'info' });
    expect(importSummary({ ...none, status: 'failed', message: 'The disk is full.' })).toEqual({ text: 'The disk is full.', tone: 'error' });
    expect(importSummary({ ...none, status: 'nothing', skipped: [{ name: 'a.txt', reason: 'no' }] }).tone).toBe('error');
  });

  test('the large-photo question is read off the refusal that asks it, and a refusal that does not ask is not one', () => {
    expect(largePhotoQuestionOf({ largePhotoPrompt: true, items: [0, 2], because: ['pixels', 'bytes'] })).toEqual({ count: 2, because: ['pixels', 'bytes'] });
    expect(largePhotoQuestionOf({ kept: true })).toBeNull();
    expect(largePhotoQuestionOf(undefined)).toBeNull();
  });
});

test.describe('attaching a picture to the paragraph the caret is in', () => {
  const scene = { id: 'n_7K2QX9M4A1', type: 'document' };
  const folder = { id: 'n_7K2QX9M4A1', type: 'folder' };
  const caret = { docId: scene.id, from: 4, to: 12, dirty: false };

  test('a range in this document, with the text saved, is an attach', () => {
    expect(canAttachToParagraph(caret, scene)).toBe(true);
  });

  test('a bare caret, another document, a folder, and unsaved text are each not', () => {
    expect(canAttachToParagraph({ ...caret, from: 12, to: 12 }, scene)).toBe(false);
    expect(canAttachToParagraph({ ...caret, docId: 'n_3W8RN2TQ6C' }, scene)).toBe(false);
    expect(canAttachToParagraph(caret, folder)).toBe(false);
    // Unsaved text has no body to capture against: the store is what the anchor's offsets must describe.
    expect(canAttachToParagraph({ ...caret, dirty: true }, scene)).toBe(false);
    expect(canAttachToParagraph(null, scene)).toBe(false);
  });
});
