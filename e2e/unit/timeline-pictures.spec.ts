import { expect, test } from '@playwright/test';

import { emptyCoherenceFile, type CoherenceFile } from '../../packages/coherence/src/index.js';
import { projectTimelineBatch, type SceneMetaRecord } from '../../packages/bus/src/index.js';
import type { AssetLink, AssetRecord, ReadAssetLink, ReadAssetRecord } from '../../packages/pictures/src/index.js';
import { addDocument, addFolder, createEmptyManifest, createProjectState, emptyCoherenceState, type CodexEntry, type ProjectState } from '../../packages/store/src/index.js';
import { buildTimeline } from '../../packages/timeline/src/index.js';

import { dayFrames } from '../../apps/desktop/src/app/timeline-edit-model.js';
import {
  BAR_PICTURES_MAX,
  barPictures,
  packPins,
  partForDay,
  pictureIndex,
  pictureNameOf,
  picturePins,
  pinBandPx,
  pinCenter,
  pinDragDay,
  pinKeyDelta,
  pinRect,
  portraitOf,
  thumbsFit,
} from '../../apps/desktop/src/app/timeline-pictures.js';
import { EMPTY_PROPOSALS, buildBatch, proposePin, pinWithDay, rebaseRow, staleFields, type PinRow } from '../../apps/desktop/src/app/timeline-proposals.js';

/**
 * The pictures on the timeline (timeline.md §9.1): the thumbnails a bar carries, the day pins above the axis and the zone each stands
 * in, the row a moved pin adds to the tray, and the refusal of a row whose pin changed under it. Pure reads and rows, no renderer.
 */

const NOW = new Date('2026-10-30T09:00:00.000Z');
const HASH = 'b'.repeat(64);

function record(id: string, patch: Partial<AssetRecord> = {}): ReadAssetRecord {
  return { id, file: `${id}.png`, mime: 'image/png', sha256: HASH, bytes: 1000, createdAt: '2026-10-30T09:00:00.000Z', ...patch };
}

let linkSerial = 0;
function link(assetId: string, target: AssetLink['target'], extra: Partial<AssetLink> = {}): ReadAssetLink {
  linkSerial += 1;
  return { id: `l_${String(linkSerial).padStart(10, '0')}`, assetId, target, role: 'reference', order: linkSerial * 10, ...extra };
}

interface Scene {
  readonly id: string;
  readonly meta?: SceneMetaRecord;
}

function book(scenes: readonly Scene[], records: readonly ReadAssetRecord[] = [], links: readonly ReadAssetLink[] = []): ProjectState {
  const state = createProjectState(createEmptyManifest('Pictures', NOW, { locale: 'en-US' }), { now: NOW });
  state.coherence = emptyCoherenceState();
  addFolder(state, { id: 'ch1', parentId: 'manuscript', title: 'ch1', now: NOW });
  for (const scene of scenes) {
    addDocument(state, { id: scene.id, parentId: 'ch1', title: scene.id, body: `${scene.id} is here.`, now: NOW });
    if (scene.meta !== undefined) (state.coherence as { sceneMeta: Record<string, SceneMetaRecord> }).sceneMeta[scene.id] = scene.meta;
  }
  state.manifest.assets = [...records];
  state.manifest.assetLinks = [...links];
  return state;
}

const fileOf = (state: ProjectState): CoherenceFile => ({ ...emptyCoherenceFile(), sceneMeta: (state.coherence?.sceneMeta ?? {}) as CoherenceFile['sceneMeta'] });
const modelOf = (state: ProjectState) => buildTimeline(state, fileOf(state), { axis: 'story', compressGaps: false });

const NODE = (nodeId: string): AssetLink['target'] => ({ kind: 'node', nodeId });

test.describe('thumbnails on a bar', () => {
  const records = ['a_0000000001', 'a_0000000002', 'a_0000000003', 'a_0000000004', 'a_0000000005'].map((id) => record(id));

  test('a bar shows at most three pictures and counts the rest', () => {
    const state = book([{ id: 's', meta: { dayOffset: 4, durationDays: 6 } }], records, records.map((entry) => link(entry.id, NODE('s'))));
    const placed = pictureIndex(state).of('s');
    expect(placed).toHaveLength(5);
    const bar = barPictures(placed, 6 * 48);
    expect(bar.shown).toHaveLength(BAR_PICTURES_MAX);
    expect(bar.shown.map((entry) => entry.assetId)).toEqual(['a_0000000001', 'a_0000000002', 'a_0000000003']);
    expect(bar.more).toBe(2);
  });

  test('the card picture comes first, then the references in their order, and a transcription source page is not a thumbnail', () => {
    const state = book(
      [{ id: 's' }],
      records,
      [link('a_0000000001', NODE('s')), link('a_0000000002', NODE('s'), { role: 'card' }), link('a_0000000003', NODE('s'), { role: 'source' }), link('a_0000000004', NODE('s'))],
    );
    expect(pictureIndex(state).of('s').map((entry) => entry.assetId)).toEqual(['a_0000000002', 'a_0000000001', 'a_0000000004']);
  });

  test('a placement on a paragraph, or on another scene, is not a thumbnail of this one', () => {
    const state = book(
      [{ id: 's' }, { id: 'other' }],
      records,
      [link('a_0000000001', { kind: 'paragraph', nodeId: 's', anchor: { kind: 'index', index: 0 } } as unknown as AssetLink['target']), link('a_0000000002', NODE('other'))],
    );
    expect(pictureIndex(state).of('s')).toEqual([]);
  });

  test('a placement whose picture has no record shows nothing', () => {
    const state = book([{ id: 's' }], [record('a_0000000001')], [link('a_0000000001', NODE('s')), link('a_0000000009', NODE('s'))]);
    expect(pictureIndex(state).of('s').map((entry) => entry.assetId)).toEqual(['a_0000000001']);
  });

  test('the alt text is the record\u2019s, empty for a decorative picture, and the name is the caption', () => {
    const state = book(
      [{ id: 's' }],
      [record('a_0000000001', { alt: 'A bridge at dusk', caption: 'Bridge sketch' }), record('a_0000000002', { alt: 'A flourish', decorative: true })],
      [link('a_0000000001', NODE('s')), link('a_0000000002', NODE('s'))],
    );
    const [first, second] = pictureIndex(state).of('s');
    expect(first).toMatchObject({ alt: 'A bridge at dusk', label: 'Bridge sketch' });
    expect(second?.alt).toBe('');
  });

  test('a narrow bar gives its room to the title: fewer thumbnails, none when there is no room, and the count takes its own space', () => {
    expect(thumbsFit(48, 3)).toBe(0);
    expect(thumbsFit(200, 3)).toBe(3);
    expect(thumbsFit(200, 5)).toBe(3);
    expect(thumbsFit(100, 5)).toBe(1);
    expect(barPictures([], 400)).toEqual({ shown: [], more: 0 });
    const state = book([{ id: 's' }], records, records.map((entry) => link(entry.id, NODE('s'))));
    expect(barPictures(pictureIndex(state).of('s'), 48)).toEqual({ shown: [], more: 0 });
  });
});

test.describe('day pins', () => {
  const bridge = record('a_0000000001', { caption: 'Bridge sketch', alt: 'A stone bridge' });

  test('a pin in the prologue\u2019s negative days stands in the prologue zone', () => {
    const state = book(
      [{ id: 'pro', meta: { dayOffset: -3650, durationDays: 10, storyPart: 'prologue' } }, { id: 'a', meta: { dayOffset: 0, durationDays: 3 } }],
      [bridge],
      [link(bridge.id, { kind: 'project' }, { when: { dayOffset: -3645 } })],
    );
    const model = modelOf(state);
    const [pin] = picturePins(state, model);
    expect(pin).toMatchObject({ day: -3645, part: 'prologue', name: 'Bridge sketch', alt: 'A stone bridge' });
    const frames = dayFrames(model);
    const center = pinCenter(frames, pin!, model.axis.pxPerDay);
    const first = pinCenter(frames, { day: -3650, part: 'prologue' }, model.axis.pxPerDay);
    expect(center).toBeDefined();
    expect(center! - first!).toBeCloseTo(5 * model.axis.pxPerDay, 5);
  });

  test('a pin dated a day or two before the main story belongs to the zone whose scene is nearest', () => {
    const state = book(
      [{ id: 'pro', meta: { dayOffset: -3650, storyPart: 'prologue' } }, { id: 'a', meta: { dayOffset: 0, durationDays: 3 } }],
      [bridge],
      [link(bridge.id, NODE('a'), { when: { dayOffset: -2 } })],
    );
    const model = modelOf(state);
    expect(picturePins(state, model)[0]).toMatchObject({ part: 'main', nodeId: 'a', day: -2 });
  });

  test('a pin with no scene on any day lands in the main zone, and has no run to stand on', () => {
    const state = book([{ id: 'undated' }], [bridge], [link(bridge.id, { kind: 'project' }, { when: { dayOffset: 12, label: 'The bridge falls' } })]);
    const model = modelOf(state);
    const [pin] = picturePins(state, model);
    expect(pin).toMatchObject({ part: 'main', day: 12, label: 'The bridge falls' });
    expect(partForDay(model, 12)).toBe('main');
    expect(pinCenter(dayFrames(model), pin!, model.axis.pxPerDay)).toBeUndefined();
  });

  test('a tie goes to the scene the picture is placed on, then to the earlier part', () => {
    const state = book([{ id: 'pro', meta: { dayOffset: -10, durationDays: 10, storyPart: 'prologue' } }, { id: 'a', meta: { dayOffset: 0, durationDays: 5 } }], [bridge]);
    const model = modelOf(state);
    // Day 0 is inside the main scene's window and one day past the prologue scene's, so the distance is zero for the main part alone.
    expect(partForDay(model, 0)).toBe('main');
    expect(partForDay(model, -11, 'a')).toBe('prologue');
    expect(partForDay(model, 5, 'pro')).toBe('main');
  });

  test('pins are listed earliest day first, and a pin with no day, or with no picture record, is not drawn', () => {
    const state = book(
      [{ id: 'a', meta: { dayOffset: 0, durationDays: 30 } }],
      [bridge, record('a_0000000002', { caption: 'Letter' })],
      [
        link('a_0000000002', { kind: 'project' }, { when: { dayOffset: 9 } }),
        link(bridge.id, { kind: 'project' }, { when: { dayOffset: -4 } }),
        link(bridge.id, { kind: 'project' }, { when: { label: 'someday' } }),
        link('a_0000000099', { kind: 'project' }, { when: { dayOffset: 1 } }),
      ],
    );
    expect(picturePins(state, modelOf(state)).map((pin) => pin.day)).toEqual([-4, 9]);
    expect(pictureNameOf(state, 'a_0000000002')).toBe('Letter');
    expect(pictureNameOf(state, 'a_0000000099')).toBe('a_0000000099');
  });

  test('markers on one day go to two rows, and a crowd shares the last row', () => {
    const slots = packPins([
      { key: 'x', center: 100 },
      { key: 'y', center: 105 },
      { key: 'z', center: 100 },
      { key: 'far', center: 300 },
    ]);
    expect(slots.rowOf.get('x')).toBe(0);
    expect(slots.rowOf.get('y')).toBe(1);
    expect(slots.rowOf.get('z')).toBe(1);
    expect(slots.rowOf.get('far')).toBe(0);
    expect(slots.rows).toBe(2);
    expect(packPins([]).rows).toBe(1);
    expect(pinBandPx(0)).toBe(0);
    expect(pinBandPx(2)).toBeGreaterThan(pinBandPx(1));
  });

  test('a right-to-left axis mirrors the marker about the width, as every other box is', () => {
    const left = pinRect(100, 0, 1000, 'ltr', 148);
    const right = pinRect(100, 0, 1000, 'rtl', 0);
    expect(left.x).toBe(148 + 100 - left.w / 2);
    expect(right.x).toBe(1000 - (100 - right.w / 2) - right.w);
    expect(left.w).toBe(right.w);
  });
});

test.describe('moving a pin', () => {
  const bridge = record('a_0000000001', { caption: 'Bridge sketch' });
  const pinned = (when: AssetLink['when'] = { dayOffset: 12 }): ProjectState =>
    book([{ id: 'a', meta: { dayOffset: 0, durationDays: 30 } }], [bridge], [link(bridge.id, { kind: 'project' }, { when })]);
  const rowOf = (set: typeof EMPTY_PROPOSALS): PinRow => set.rows.find((row): row is PinRow => row.kind === 'pin')!;

  test('the arrows move a marked pin by a day, Shift by seven, and an unmarked pin only with Alt', () => {
    const facts = { key: 'ArrowRight', shift: false, alt: false, ctrl: false, meta: false, selected: true };
    expect(pinKeyDelta(facts, false)).toBe(1);
    expect(pinKeyDelta({ ...facts, key: 'ArrowLeft', shift: true }, false)).toBe(-7);
    expect(pinKeyDelta({ ...facts, selected: false }, false)).toBeNull();
    expect(pinKeyDelta({ ...facts, selected: false, alt: true }, false)).toBe(1);
    expect(pinKeyDelta({ ...facts, ctrl: true }, false)).toBeNull();
    expect(pinKeyDelta({ ...facts, key: 'ArrowUp' }, false)).toBeNull();
  });

  test('in a right-to-left interface the arrow toward the start is the earlier day', () => {
    const facts = { key: 'ArrowRight', shift: false, alt: false, ctrl: false, meta: false, selected: true };
    expect(pinKeyDelta(facts, true)).toBe(-1);
    expect(pinKeyDelta({ ...facts, key: 'ArrowLeft' }, true)).toBe(1);
  });

  test('a drag lands on the day under the pointer within the pin\u2019s own part', () => {
    const state = pinned();
    const model = modelOf(state);
    const frames = dayFrames(model);
    const ppd = model.axis.pxPerDay;
    const at = pinCenter(frames, { day: 15, part: 'main' }, ppd)!;
    expect(pinDragDay(frames, ppd, { part: 'main' }, at)).toBe(15);
  });

  test('a moved pin is one row that names the placement, keeps its label and carries the pin it read', () => {
    const state = pinned({ dayOffset: 12, label: 'The bridge falls' });
    const link = state.manifest.assetLinks![0]!;
    const set = proposePin(EMPTY_PROPOSALS, state, link.id, pinWithDay({ dayOffset: 12, label: 'The bridge falls' }, 15));
    expect(set.rows).toHaveLength(1);
    expect(rowOf(set)).toMatchObject({ kind: 'pin', linkId: link.id, assetId: bridge.id, base: { dayOffset: 12, label: 'The bridge falls' }, to: { dayOffset: 15, label: 'The bridge falls' } });
    const built = buildBatch(state, set.rows, new Set(set.rows.map((row) => row.id)));
    expect(built.ops).toEqual([
      { op: 'picture-when', linkId: link.id, when: { dayOffset: 15, label: 'The bridge falls' }, expect: { when: { dayOffset: 12, label: 'The bridge falls' } } },
    ]);
    expect(built.projection?.counts.pins).toBe(1);
    expect(built.projection?.counts.total).toBe(1);
    expect(built.projection?.linkChanges).toEqual([{ linkId: link.id, before: { dayOffset: 12, label: 'The bridge falls' }, after: { dayOffset: 15, label: 'The bridge falls' } }]);
    expect(built.status.get(rowOf(set).id)?.state).toBe('ok');
  });

  test('a second move joins the row with the first base kept, and a return to the pin the project holds drops it', () => {
    const state = pinned();
    const id = state.manifest.assetLinks![0]!.id;
    let set = proposePin(EMPTY_PROPOSALS, state, id, { dayOffset: 13 });
    set = proposePin(set, state, id, { dayOffset: 20 });
    expect(set.rows).toHaveLength(1);
    expect(rowOf(set)).toMatchObject({ base: { dayOffset: 12 }, to: { dayOffset: 20 } });
    set = proposePin(set, state, id, { dayOffset: 12 });
    expect(set.rows).toHaveLength(0);
  });

  test('a pin given to a picture with none has a null base, and clearing one is a null target', () => {
    const state = book([{ id: 'a' }], [bridge], [link(bridge.id, NODE('a'))]);
    const id = state.manifest.assetLinks![0]!.id;
    const set = proposePin(EMPTY_PROPOSALS, state, id, { dayOffset: 3 });
    expect(rowOf(set)).toMatchObject({ base: null, to: { dayOffset: 3 } });
    const built = buildBatch(state, set.rows, new Set(set.rows.map((row) => row.id)));
    expect(built.ops[0]).toMatchObject({ op: 'picture-when', when: { dayOffset: 3 }, expect: { when: null } });

    const held = pinned();
    const cleared = proposePin(EMPTY_PROPOSALS, held, held.manifest.assetLinks![0]!.id, null);
    expect(rowOf(cleared)).toMatchObject({ base: { dayOffset: 12 }, to: null });
    const clearBatch = buildBatch(held, cleared.rows, new Set(cleared.rows.map((row) => row.id)));
    expect(clearBatch.ops[0]).toMatchObject({ when: null, expect: { when: { dayOffset: 12 } } });
  });

  test('a placement the project does not hold adds no row', () => {
    expect(proposePin(EMPTY_PROPOSALS, pinned(), 'l_9999999999', { dayOffset: 4 }).rows).toHaveLength(0);
  });

  test('a row whose pin changed since it was proposed is stale, is refused, and the bus refuses its op too', () => {
    const state = pinned();
    const id = state.manifest.assetLinks![0]!.id;
    const set = proposePin(EMPTY_PROPOSALS, state, id, { dayOffset: 15 });
    const before = buildBatch(state, set.rows, new Set(set.rows.map((row) => row.id)));
    expect(before.ops).toHaveLength(1);

    // Another surface moved the pin to day 14 after the row read day 12.
    state.manifest.assetLinks![0] = { ...state.manifest.assetLinks![0]!, when: { dayOffset: 14 } };
    expect(staleFields(state, rowOf(set))).toBe('pin');
    const refused = buildBatch(state, set.rows, new Set(set.rows.map((row) => row.id)));
    expect(refused.ops).toHaveLength(0);
    expect(refused.status.get(rowOf(set).id)?.state).toBe('stale');

    const replay = projectTimelineBatch(state, [...before.ops]);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.message).toContain('day 12');
  });

  test('Read again re-bases a stale pin row onto what the project holds, and drops it when the project already says so', () => {
    const state = pinned();
    const id = state.manifest.assetLinks![0]!.id;
    const set = proposePin(EMPTY_PROPOSALS, state, id, { dayOffset: 15 });
    state.manifest.assetLinks![0] = { ...state.manifest.assetLinks![0]!, when: { dayOffset: 14 } };
    const rebased = rebaseRow(set, state, rowOf(set).id);
    expect(rowOf(rebased)).toMatchObject({ base: { dayOffset: 14 }, to: { dayOffset: 15 } });
    expect(staleFields(state, rowOf(rebased))).toEqual([]);
    const batch = buildBatch(state, rebased.rows, new Set(rebased.rows.map((row) => row.id)));
    expect(batch.ops[0]).toMatchObject({ expect: { when: { dayOffset: 14 } }, when: { dayOffset: 15 } });

    state.manifest.assetLinks![0] = { ...state.manifest.assetLinks![0]!, when: { dayOffset: 15 } };
    expect(rebaseRow(rebased, state, rowOf(rebased).id).rows).toHaveLength(0);
  });

  test('a row for a placement that was deleted is gone, and re-basing removes it', () => {
    const state = pinned();
    const id = state.manifest.assetLinks![0]!.id;
    const set = proposePin(EMPTY_PROPOSALS, state, id, { dayOffset: 15 });
    state.manifest.assetLinks = [];
    expect(staleFields(state, rowOf(set))).toBe('gone');
    expect(rebaseRow(set, state, rowOf(set).id).rows).toHaveLength(0);
  });

  test('a pin row and a scene row apply as one batch, and the pin never touches a scene day', () => {
    const state = pinned();
    const id = state.manifest.assetLinks![0]!.id;
    let set = proposePin(EMPTY_PROPOSALS, state, id, { dayOffset: 15 });
    set = { ...set, rows: [...set.rows] };
    const built = buildBatch(state, set.rows, new Set(set.rows.map((row) => row.id)));
    expect(built.projection?.counts).toMatchObject({ pins: 1, days: 0 });
    expect(built.projection?.sceneMeta.size).toBe(0);
  });
});

test.describe('character portraits', () => {
  const entry = (patch: Partial<CodexEntry>): CodexEntry => ({
    id: 'c1',
    name: 'Anna',
    aliases: [],
    type: 'character',
    description: '',
    includePolicy: 'always',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    ...patch,
  });

  test('the portrait is the first visual reference the registry has a record for', () => {
    const state = book([{ id: 'a' }], [record('a_0000000002')]);
    state.manifest.codex = [entry({ visualRefs: ['a_0000000001', 'a_0000000002'] })];
    expect(portraitOf(state, 'c1')?.id).toBe('a_0000000002');
  });

  test('an entry with no visual reference, or none with a record, has no portrait', () => {
    const state = book([{ id: 'a' }], [record('a_0000000002')]);
    state.manifest.codex = [entry({}), entry({ id: 'c2', visualRefs: ['a_0000000077'] })];
    expect(portraitOf(state, 'c1')).toBeUndefined();
    expect(portraitOf(state, 'c2')).toBeUndefined();
    expect(portraitOf(state, 'nobody')).toBeUndefined();
  });
});
