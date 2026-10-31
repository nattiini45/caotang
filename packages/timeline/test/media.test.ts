import { describe, expect, it } from 'vitest';

import {
  COMIC_GLYPH,
  DIALOGUE_GLYPH,
  PRESENCE_DEFAULT_LIMIT,
  STORYBOARD_GLYPH,
  WORDS_PER_UNIT,
  adapterFor,
  buildTimeline,
  mediaEntriesOf,
  unattachedStrips,
  type TimelineItem,
  type TimelineModel,
} from '../src/index.js';

import { coherence, entry, project } from './fixtures.js';
import { INK, addComicBook, addDialogue, addShots, removeNode } from './media-fixtures.js';

const SHOTS = ' \u2014 Shots';

const stripsOf = (model: TimelineModel, kind: TimelineItem['kind']): TimelineItem[] => model.strips.filter((strip) => strip.kind === kind);

describe('the storyboard adapter (§9.3)', () => {
  const build = (): { model: TimelineModel; state: ReturnType<typeof project> } => {
    const state = project({
      folders: [{ id: 'pro', title: 'Prologue folder' }],
      scenes: [
        { id: 'storm', title: 'Storm', parent: 'pro', kind: 'screenplay' },
        { id: 'calm', title: 'Calm' },
      ],
    });
    addShots(state, {
      id: 'storm-shots',
      title: `Storm${SHOTS}`,
      parent: 'pro',
      shots: [
        { id: 'sh1', title: 'Wide', image: 'a_AAAAAAAAAA', durationSec: 4 },
        { id: 'sh2', title: 'Close', durationSec: 2.5 },
        { id: 'sh3', title: 'Cutaway' },
      ],
    });
    const model = buildTimeline(
      state,
      coherence({ pro: { storyPart: 'prologue' }, storm: { dayOffset: -3, durationDays: 2, timelineMode: 'flashback', pov: 'anna' }, calm: { dayOffset: 5 } }),
      { axis: 'story' },
    );
    return { model, state };
  };

  it('hangs a shot strip under its scene, with the scene\'s day, part and slot, and keeps it out of items', () => {
    const { model } = build();
    expect(model.items.map((item) => item.nodeId).sort()).toEqual(['calm', 'storm']);
    expect(model.strips).toHaveLength(1);
    const strip = model.strips[0] as TimelineItem;
    const host = model.items.find((item) => item.nodeId === 'storm') as TimelineItem;
    expect(strip).toMatchObject({
      kind: 'shot-strip',
      medium: 'storyboard',
      nodeId: 'storm',
      hostId: 'storm',
      sourceId: 'storm-shots',
      part: 'prologue',
      start: -3,
      end: -1,
      dayOffset: -3,
      durationDays: 2,
      mode: 'flashback',
      lane: host.lane,
      readingIndex: host.readingIndex,
      mediumGlyph: STORYBOARD_GLYPH,
      measure: 3,
      measureUnit: 'shots',
      open: 'storm-shots',
    });
    expect(strip.glyph).toEqual(host.glyph);
    expect(strip.key).toBe(`${host.key}:shot-strip`);
  });

  it('numbers the cards from their sibling order and totals the seconds of the shots that have one', () => {
    const strip = build().model.strips[0] as TimelineItem;
    expect(strip.cells).toEqual([
      { nodeId: 'sh1', number: 1, title: 'Wide', assetId: 'a_AAAAAAAAAA', durationSec: 4 },
      { nodeId: 'sh2', number: 2, title: 'Close', durationSec: 2.5 },
      { nodeId: 'sh3', number: 3, title: 'Cutaway' },
    ]);
    expect(strip.runtimeSec).toBe(6.5);
    expect(strip.unmeasured).toBe(1);
  });

  it('leaves a malformed duration out of the total, as the animatic does', () => {
    const state = project({ scenes: [{ id: 's', title: 'S' }] });
    addShots(state, { id: 'b', title: `S${SHOTS}`, shots: [{ id: 'a', durationSec: -1 }, { id: 'b2', durationSec: '3' }, { id: 'c', durationSec: Number.NaN }, { id: 'd', durationSec: 0 }, { id: 'e', durationSec: 1.25 }] });
    const strip = buildTimeline(state, coherence({ s: { dayOffset: 1 } }), { axis: 'story' }).strips[0] as TimelineItem;
    expect(strip.runtimeSec).toBe(1.25);
    expect(strip.unmeasured).toBe(3);
  });

  it('an undated scene has an undated strip, and an explicit main part is the strip\'s part too', () => {
    const state = project({ folders: [{ id: 'pro' }], scenes: [{ id: 's', title: 'S', parent: 'pro' }] });
    addShots(state, { id: 'b', title: `S${SHOTS}`, parent: 'pro', shots: [{ id: 'a' }] });
    const model = buildTimeline(state, coherence({ pro: { storyPart: 'prologue' }, s: { storyPart: 'main' } }), { axis: 'story' });
    expect(model.strips[0]).toMatchObject({ part: 'main', partOverride: true });
    expect(model.strips[0]?.start).toBeUndefined();
    expect(model.strips[0]?.glyph.pattern).toBe('dashed');
  });

  it('draws one strip for a scene that sits in several lanes, in its first lane', () => {
    const state = project({ scenes: [{ id: 's', title: 'S' }], entries: [entry('ben', 'Ben'), entry('cy', 'Cy')] });
    addShots(state, { id: 'b', title: `S${SHOTS}`, shots: [{ id: 'a' }] });
    const model = buildTimeline(state, coherence({ s: { dayOffset: 1, expectedPresent: ['ben', 'cy'] } }), { axis: 'story', groupBy: 'character' });
    expect(model.items).toHaveLength(2);
    expect(model.strips).toHaveLength(1);
    expect(model.strips[0]?.lane).toBe(model.items[0]?.lane);
  });

  it('keeps an empty shots folder as a strip that opens the board, and ignores a folder that is not a storyboard or has no scene', () => {
    const state = project({ scenes: [{ id: 's', title: 'S' }, { id: 't', title: 'T' }] });
    addShots(state, { id: 'empty', title: `S${SHOTS}` });
    addShots(state, { id: 'plain', title: `T${SHOTS}`, kind: null, shots: [{ id: 'x' }] });
    addShots(state, { id: 'orphan', title: `Nobody${SHOTS}`, shots: [{ id: 'y' }] });
    const model = buildTimeline(state, coherence({}), { axis: 'narrative' });
    expect(model.strips.map((strip) => [strip.sourceId, strip.cells?.length, strip.open])).toEqual([['empty', 0, 'empty']]);
  });

  it('is matched by the folder\'s place and name beside the scene, never by a scene elsewhere with the same title', () => {
    const state = project({ folders: [{ id: 'ch1' }, { id: 'ch2' }], scenes: [{ id: 'a', title: 'Storm', parent: 'ch1' }, { id: 'b', title: 'Storm', parent: 'ch2' }] });
    addShots(state, { id: 'shots-b', title: `Storm${SHOTS}`, parent: 'ch2', shots: [{ id: 'x' }] });
    const model = buildTimeline(state, coherence({}), { axis: 'narrative' });
    expect(model.strips.map((strip) => strip.hostId)).toEqual(['b']);
  });

  it('routes the media nodes to the storyboard adapter', () => {
    const state = project({ scenes: [{ id: 's', title: 'S' }] });
    const folder = addShots(state, { id: 'b', title: `S${SHOTS}`, shots: [{ id: 'a' }, { id: 'c' }] });
    const shot = state.manifest.tree.find((node) => node.id === 'a') as (typeof state.manifest.tree)[number];
    expect(adapterFor(folder).medium).toBe('storyboard');
    expect(adapterFor(shot).medium).toBe('storyboard');
    expect(adapterFor(folder).measure(folder, state)).toBe(2);
  });
});

describe('the dialogue adapter (§9.3)', () => {
  const linked = (extra: { day?: number; part?: 'prologue' } = {}) => {
    const state = project({ folders: [{ id: 'pro' }], scenes: [{ id: 'duel', title: 'Duel', parent: extra.part === 'prologue' ? 'pro' : undefined, kind: 'screenplay' }, { id: 'prose', title: 'Prose' }] });
    addDialogue(state, { id: 'court', title: 'Courtroom' });
    const sceneMeta = { ...(extra.part === 'prologue' ? { pro: { storyPart: 'prologue' as const } } : {}), duel: { dayOffset: extra.day ?? 12, durationDays: 1, dialogueContainer: 'court' }, prose: { dayOffset: 1 } };
    return { state, model: buildTimeline(state, coherence(sceneMeta), { axis: 'story' }) };
  };

  it('gives the scene that declares a container its branch glyph, link and branch facts', () => {
    const { model } = linked();
    const item = model.items.find((candidate) => candidate.nodeId === 'duel') as TimelineItem;
    expect(item.mediumGlyph).toBe(DIALOGUE_GLYPH);
    expect(item.links).toEqual([{ medium: 'dialogue', nodeId: 'court', ref: 'court', title: 'Courtroom', branches: { beats: 2, choices: 2, links: 2 } }]);
    expect(model.items.find((candidate) => candidate.nodeId === 'prose')?.mediumGlyph).toBeUndefined();
    expect(model.stats.mediums).toEqual(['prose', 'screenplay', 'dialogue']);
  });

  it('takes the declaring scene\'s day and part as that scene\'s prose does, and the container is not an item of its own', () => {
    const { model } = linked({ day: -20, part: 'prologue' });
    const item = model.items.find((candidate) => candidate.nodeId === 'duel') as TimelineItem;
    expect(item).toMatchObject({ part: 'prologue', start: -20, end: -19, medium: 'screenplay' });
    expect(model.items.some((candidate) => candidate.nodeId === 'court')).toBe(false);
    expect(model.zones.map((zone) => zone.part)).toEqual(['prologue', 'main']);
  });

  it('a container no scene declares is not on the timeline: nothing says when it happens', () => {
    const state = project({ scenes: [{ id: 's' }] });
    addDialogue(state, { id: 'loose' });
    const model = buildTimeline(state, coherence({ s: { dayOffset: 1 } }), { axis: 'story' });
    expect(model.items.map((item) => item.nodeId)).toEqual(['s']);
    expect(model.stats.mediums).toEqual(['prose']);
  });

  it('keeps the scene when its container is deleted, with no link target and the id it named', () => {
    const { state } = linked();
    removeNode(state, 'court');
    const model = buildTimeline(state, coherence({ duel: { dayOffset: 12, dialogueContainer: 'court' }, prose: { dayOffset: 1 } }), { axis: 'story' });
    const item = model.items.find((candidate) => candidate.nodeId === 'duel') as TimelineItem;
    expect(item.links).toEqual([{ medium: 'dialogue', ref: 'court', broken: true }]);
    expect(item.mediumGlyph).toBeUndefined();
    expect(item.start).toBe(12);
    expect(model.stats.mediums).not.toContain('dialogue');
    expect(mediaEntriesOf(model, 'duel')).toEqual([{ kind: 'dialogue', medium: 'dialogue', title: '', glyph: DIALOGUE_GLYPH, ref: 'court' }]);
  });

  it('a link to a node that is no longer a dialogue container is just as broken', () => {
    const state = project({ scenes: [{ id: 'duel' }, { id: 'other' }] });
    const model = buildTimeline(state, coherence({ duel: { dayOffset: 1, dialogueContainer: 'other' } }), { axis: 'story' });
    expect(model.items.find((item) => item.nodeId === 'duel')?.links).toEqual([{ medium: 'dialogue', ref: 'other', broken: true }]);
  });

  it('reads the branch facts again when the Ink changes', () => {
    const state = project({ scenes: [{ id: 'duel' }] });
    addDialogue(state, { id: 'court' });
    const meta = coherence({ duel: { dayOffset: 1, dialogueContainer: 'court' } });
    const first = buildTimeline(state, meta, { axis: 'story' }).items[0]?.links?.[0]?.branches;
    state.documents.set('court', { ...(state.documents.get('court') as NonNullable<ReturnType<typeof state.documents.get>>), body: `${INK}=== third ===\n-> start\n` });
    const second = buildTimeline(state, meta, { axis: 'story' }).items[0]?.links?.[0]?.branches;
    expect(first).toEqual({ beats: 2, choices: 2, links: 2 });
    expect(second).toEqual({ beats: 3, choices: 2, links: 3 });
  });
});

describe('the comic adapter (§9.4)', () => {
  const pages = [
    { id: 'p1', title: 'Page 1', panels: [{}, { assetId: 'a_PANEL00001' }, { assetId: 'a_PANEL00002' }] },
    { id: 'p2', title: 'Page 2', panels: [{ assetId: 'a_PANEL00003' }] },
    { id: 'p3', title: 'Page 3', panels: [] },
  ];

  it('script first: the page strip hangs under the linked script and takes its day and part', () => {
    const state = project({ folders: [{ id: 'epi' }], scenes: [{ id: 'script', title: 'Issue 1 script', kind: 'comic-script', parent: 'epi', body: 'PAGE ONE\nPanel 1\nA door.' }] });
    addComicBook(state, { id: 'book', title: 'Issue 1', parent: 'epi', scriptDocId: 'script', readingDirection: 'rtl', pages });
    const model = buildTimeline(state, coherence({ epi: { storyPart: 'epilogue' }, script: { dayOffset: 4000, durationDays: 3 } }), { axis: 'story' });
    const host = model.items[0] as TimelineItem;
    expect(host).toMatchObject({ nodeId: 'script', medium: 'comic', mediumGlyph: COMIC_GLYPH, measure: 3, measureUnit: 'pages', part: 'epilogue', start: 4000, end: 4003 });
    expect(host.links).toEqual([{ medium: 'comic', nodeId: 'book', ref: 'script', title: 'Issue 1' }]);
    expect(model.strips).toHaveLength(1);
    const strip = model.strips[0] as TimelineItem;
    expect(strip).toMatchObject({ kind: 'page-strip', medium: 'comic', hostId: 'script', sourceId: 'book', part: 'epilogue', start: 4000, end: 4003, measure: 3, measureUnit: 'pages', direction: 'rtl', open: 'p1', mediumGlyph: COMIC_GLYPH });
    expect(strip.cells).toEqual([
      { nodeId: 'p1', number: 1, title: 'Page 1', panels: 3, assetId: 'a_PANEL00001' },
      { nodeId: 'p2', number: 2, title: 'Page 2', panels: 1, assetId: 'a_PANEL00003' },
      { nodeId: 'p3', number: 3, title: 'Page 3', panels: 0 },
    ]);
    expect(unattachedStrips(model)).toEqual([]);
  });

  it('a script with no pages yet is measured in words and has no strip', () => {
    const state = project({ scenes: [{ id: 'script', kind: 'comic-script', body: 'one two three four' }] });
    addComicBook(state, { id: 'book', scriptDocId: 'script' });
    const model = buildTimeline(state, coherence({ script: { dayOffset: 1 } }), { axis: 'story' });
    expect(model.items[0]).toMatchObject({ measure: 4, measureUnit: 'words' });
    expect(model.strips).toEqual([]);
  });

  it('pages first, with no script: a strip under the book with its own span and part, and no invented text or scene', () => {
    const state = project({ folders: [{ id: 'pro' }] });
    addComicBook(state, { id: 'book', title: 'Sketchbook', parent: 'pro', pages });
    const spanned = buildTimeline(state, coherence({ pro: { storyPart: 'prologue' }, book: { dayOffset: -30, durationDays: 4 } }), { axis: 'story' });
    expect(spanned.items).toEqual([]);
    expect(spanned.stats.scenes).toBe(0);
    expect(spanned.strips).toHaveLength(1);
    expect(spanned.strips[0]).toMatchObject({ kind: 'page-strip', nodeId: 'book', hostId: 'book', label: 'Sketchbook', part: 'prologue', start: -30, end: -26, lane: '', readingIndex: -1, open: 'p1', measure: 3 });
    expect(spanned.strips[0]?.links).toBeUndefined();
    expect(unattachedStrips(spanned)).toEqual(spanned.strips);
    const bare = buildTimeline(state, coherence({}), { axis: 'story' });
    expect(bare.strips[0]?.start).toBeUndefined();
    expect(bare.strips[0]?.part).toBe('main');
    expect(bare.strips[0]?.glyph.pattern).toBe('dashed');
    expect(bare.zones).toEqual([]);
  });

  it('a script that is gone leaves the pages under the book, and says what the book names', () => {
    const state = project({});
    addComicBook(state, { id: 'book', title: 'Orphaned', scriptDocId: 'script-gone', pages });
    const model = buildTimeline(state, coherence({}), { axis: 'story' });
    expect(model.strips[0]).toMatchObject({ hostId: 'book', links: [{ medium: 'comic', ref: 'script-gone', broken: true }] });
    expect(mediaEntriesOf(model, 'book')).toMatchObject([{ kind: 'pages', open: 'p1', ref: 'script-gone' }]);
  });

  it('never finds a script by its title: a document named like the book, or not a comic script, is not the link', () => {
    const state = project({ scenes: [{ id: 'same', title: 'Issue 1', kind: 'comic-script' }, { id: 'prose', title: 'Notes' }] });
    addComicBook(state, { id: 'book', title: 'Issue 1', scriptDocId: 'prose', pages });
    const model = buildTimeline(state, coherence({ same: { dayOffset: 1 } }), { axis: 'story' });
    const script = model.items.find((item) => item.nodeId === 'same') as TimelineItem;
    expect(script.links).toBeUndefined();
    expect(model.strips.map((strip) => strip.hostId)).toEqual(['book']);
    expect(model.strips[0]?.links).toEqual([{ medium: 'comic', ref: 'prose', broken: true }]);
  });

  it('a live script that is not on the timeline (archived) carries the strip, so the book does not draw it', () => {
    const state = project({ scenes: [{ id: 'script', kind: 'comic-script', status: 'archived' }] });
    addComicBook(state, { id: 'book', scriptDocId: 'script', pages });
    expect(buildTimeline(state, coherence({}), { axis: 'story' }).strips).toEqual([]);
  });

  it('gives a script to the first book that declares it, marks the second link broken, and draws no strip for a book with no pages', () => {
    const state = project({ scenes: [{ id: 'script', kind: 'comic-script' }] });
    addComicBook(state, { id: 'first', scriptDocId: 'script', pages: [pages[0] as (typeof pages)[number]] });
    addComicBook(state, { id: 'second', scriptDocId: 'script', pages: [{ id: 'q1' }] });
    addComicBook(state, { id: 'empty' });
    const model = buildTimeline(state, coherence({}), { axis: 'story' });
    expect(model.strips.map((strip) => [strip.hostId, strip.sourceId])).toEqual([['script', 'first'], ['second', 'second']]);
    expect(model.strips[1]?.links).toEqual([{ medium: 'comic', ref: 'script', broken: true }]);
  });

  it('treats a malformed scriptDocId as no link', () => {
    const state = project({});
    addComicBook(state, { id: 'book', scriptDocId: 7, pages });
    const model = buildTimeline(state, coherence({}), { axis: 'story' });
    expect(model.strips[0]?.links).toBeUndefined();
  });

  it('routes the comic nodes to the comic adapter and counts a page in panels', () => {
    const state = project({ scenes: [{ id: 'script', kind: 'comic-script' }] });
    const book = addComicBook(state, { id: 'book', scriptDocId: 'script', pages });
    const page = state.manifest.tree.find((node) => node.id === 'p1') as (typeof state.manifest.tree)[number];
    expect(adapterFor(page).medium).toBe('comic');
    expect(adapterFor(page).measure(page, state)).toBe(3);
    expect(adapterFor(book).measure(book, state)).toBe(3);
  });
});

describe('mixed media scopes (§9.3)', () => {
  const mixed = () => {
    const state = project({
      folders: [{ id: 'act1' }, { id: 'act2' }],
      scenes: [
        { id: 'prose', title: 'Prose', parent: 'act1', body: 'one two three four five six seven eight nine ten' },
        { id: 'film', title: 'Film', parent: 'act1', kind: 'screenplay' },
        { id: 'duel', title: 'Duel', parent: 'act2', kind: 'screenplay' },
        { id: 'script', title: 'Script', parent: 'act2', kind: 'comic-script' },
      ],
    });
    addShots(state, { id: 'film-shots', title: `Film${SHOTS}`, parent: 'act1', shots: [{ id: 'sh', durationSec: 3 }] });
    addDialogue(state, { id: 'court', parent: 'act2' });
    addComicBook(state, { id: 'book', parent: 'act2', scriptDocId: 'script', pages: [{ id: 'p1' }, { id: 'p2' }] });
    addComicBook(state, { id: 'sketch', parent: 'act1', pages: [{ id: 's1' }] });
    const file = coherence({ prose: { dayOffset: 1 }, film: { dayOffset: 2 }, duel: { dayOffset: 3, dialogueContainer: 'court' }, script: { dayOffset: 4 } });
    return { state, file };
  };

  it('shows every medium in the scope, in a fixed order, with each strip under its own host', () => {
    const { state, file } = mixed();
    const model = buildTimeline(state, file, { axis: 'story' });
    expect(model.stats.mediums).toEqual(['prose', 'screenplay', 'dialogue', 'storyboard', 'comic']);
    expect(model.items.map((item) => [item.nodeId, item.medium])).toEqual([['prose', 'prose'], ['film', 'screenplay'], ['duel', 'screenplay'], ['script', 'comic']]);
    expect(model.strips.map((strip) => [strip.kind, strip.hostId])).toEqual([['shot-strip', 'film'], ['page-strip', 'script'], ['page-strip', 'sketch']]);
    expect(stripsOf(model, 'shot-strip')).toHaveLength(1);
  });

  it('puts the slots of a scope that counts words and pages on one scale, and leaves a one-unit scope alone', () => {
    const { state, file } = mixed();
    const model = buildTimeline(state, file, { axis: 'narrative' });
    expect(model.axis.measureUnit).toBe('words-equivalent');
    const native = model.items.map((item) => item.measure);
    expect(model.axis.measures).toEqual(model.items.map((item, at) => (native[at] as number) * WORDS_PER_UNIT[item.measureUnit ?? 'words']));
    expect(model.items.find((item) => item.nodeId === 'prose')).toMatchObject({ measure: 10, measureUnit: 'words' });
    expect(model.items.find((item) => item.nodeId === 'script')).toMatchObject({ measure: 2, measureUnit: 'pages' });

    const prose = buildTimeline(project({ scenes: [{ id: 'a', body: 'one two' }, { id: 'b', body: 'one' }] }), coherence({}), { axis: 'narrative' });
    expect(prose.axis.measureUnit).toBe('words');
    expect(prose.axis.measures).toEqual([2, 1]);
  });

  it('narrows items, strips and book strips together to a folder scope', () => {
    const { state, file } = mixed();
    const act1 = buildTimeline(state, file, { axis: 'story', scope: 'act1' });
    expect(act1.items.map((item) => item.nodeId)).toEqual(['prose', 'film']);
    expect(act1.strips.map((strip) => strip.hostId)).toEqual(['film', 'sketch']);
    expect(act1.stats.mediums).toEqual(['prose', 'screenplay', 'storyboard', 'comic']);
    const act2 = buildTimeline(state, file, { axis: 'story', scope: 'act2' });
    expect(act2.items.map((item) => item.nodeId)).toEqual(['duel', 'script']);
    expect(act2.strips.map((strip) => strip.hostId)).toEqual(['script']);
    expect(buildTimeline(state, file, { axis: 'story', scope: 'film' }).strips.map((strip) => strip.hostId)).toEqual(['film']);
  });

  it('does not count a strip or a container as a scene or as scheduled', () => {
    const { state, file } = mixed();
    const model = buildTimeline(state, file, { axis: 'story' });
    expect(model.stats).toMatchObject({ scenes: 4, scheduled: 4, share: 1 });
    expect(model.blocks).toEqual([]);
  });
});

describe('opening an item in its real media view', () => {
  it('lists, for a scene, its container, its shots and its pages in a fixed order, each with the node the shell opens', () => {
    const state = project({ scenes: [{ id: 'script', title: 'Script', kind: 'comic-script' }, { id: 'film', title: 'Film' }] });
    addShots(state, { id: 'film-shots', title: `Film${SHOTS}`, shots: [{ id: 'sh' }] });
    addDialogue(state, { id: 'court' });
    addComicBook(state, { id: 'book', scriptDocId: 'script', pages: [{ id: 'p1' }] });
    const model = buildTimeline(state, coherence({ script: { dayOffset: 1, dialogueContainer: 'court' }, film: { dayOffset: 2 } }), { axis: 'story' });
    expect(mediaEntriesOf(model, 'script').map((media) => [media.kind, media.open])).toEqual([['dialogue', 'court'], ['book', 'book'], ['pages', 'p1']]);
    expect(mediaEntriesOf(model, 'film').map((media) => [media.kind, media.open])).toEqual([['shots', 'film-shots']]);
    expect(mediaEntriesOf(model, 'nothing')).toEqual([]);
    const cells = mediaEntriesOf(model, 'film')[0]?.strip?.cells;
    expect(cells?.map((cell) => cell.nodeId)).toEqual(['sh']);
  });
});

describe('the subway overlay and its default (§3.9)', () => {
  const crowd = (count: number) => {
    const ids = Array.from({ length: count }, (_, at) => `c${at}`);
    const state = project({
      folders: [{ id: 'pro' }],
      scenes: [{ id: 'a', parent: 'pro', kind: 'screenplay' }, { id: 'b' }, { id: 'c', kind: 'comic-script' }],
      entries: ids.map((id) => entry(id, id.toUpperCase())),
    });
    addShots(state, { id: 'sb', title: `B${SHOTS}`, shots: [{ id: 'x' }] });
    const file = coherence({
      pro: { storyPart: 'prologue' },
      a: { dayOffset: -5, expectedPresent: ids },
      b: { dayOffset: 2, expectedPresent: ids.slice(0, 1) },
      c: { dayOffset: 9, expectedPresent: ids.slice(0, 1) },
    });
    return buildTimeline(state, file, { axis: 'story', groupBy: 'character' });
  };

  it('starts on at 30 characters in scope and off at 31, whatever the scenes\' media', () => {
    expect(PRESENCE_DEFAULT_LIMIT).toBe(30);
    expect(crowd(30).stats).toMatchObject({ characters: 30, presenceDefaultOn: true });
    expect(crowd(31).stats).toMatchObject({ characters: 31, presenceDefaultOn: false });
  });

  it('draws one polyline per character through scenes of every medium, across the part fold, and never through a strip', () => {
    const model = crowd(2);
    const lines = model.connectors.filter((connector) => connector.kind === 'presence');
    expect(lines.map((line) => line.characterId)).toEqual(['c0']);
    const path = lines[0]?.path ?? [];
    expect(path.map((key) => key.split('@')[0])).toEqual(['a', 'b', 'c']);
    expect(model.items.filter((item) => path.includes(item.key)).map((item) => item.part)).toEqual(['prologue', 'main', 'main']);
    expect(path.some((key) => key.includes(':shot-strip'))).toBe(false);
  });

  it('keeps the polylines in the model above the limit, so a per-character chip can show one', () => {
    const lines = crowd(31).connectors.filter((connector) => connector.kind === 'presence');
    expect(lines.length).toBeGreaterThan(0);
  });
});
