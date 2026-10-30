/**
 * Negative day offsets and declared prologue and epilogue parts — coherence.md §5.2.2 and timeline.md §2.2–§2.4, §10
 * (the T1b coherence tests): the codec, the folder rule, the `timeline.gap` part boundary, and every other timeline check
 * and `knowledge.leak` reading negative days exactly as positive ones.
 */

import { describe, expect, it } from 'vitest';

import {
  DAY_OFFSET_LIMIT,
  STORY_PARTS,
  assembleInput,
  effectiveStoryPart,
  emptyCoherenceFile,
  parseCoherenceFile,
  runChecks,
  serializeCoherenceFile,
  type CoherenceFile,
  type DeterministicCheckId,
  type DraftFinding,
  type KnowledgeFact,
  type SceneMeta,
} from '../src/index.js';
import { DAY_OFFSET_LIMIT as BUS_DAY_OFFSET_LIMIT, STORY_PARTS as BUS_STORY_PARTS } from '@caotang/bus';

import { NOW, buildState, detect, entry } from './fixtures.js';

function withMeta(sceneMeta: Record<string, SceneMeta>, knowledge: KnowledgeFact[] = []): CoherenceFile {
  return { ...emptyCoherenceFile(), sceneMeta, knowledge };
}

function run(state: ReturnType<typeof buildState>, file: CoherenceFile, ids: readonly DeterministicCheckId[]): DraftFinding[] {
  return runChecks(assembleInput(state, file, { detector: detect }).input, ids).drafts;
}

const GAP = ['timeline.gap'] as const;

describe('the shared vocabulary (§5.2.2)', () => {
  it('holds the same parts and day range in the bus and the model', () => {
    expect([...BUS_STORY_PARTS]).toEqual([...STORY_PARTS]);
    expect(BUS_DAY_OFFSET_LIMIT).toBe(DAY_OFFSET_LIMIT);
    expect(DAY_OFFSET_LIMIT).toBe(10_000_000);
  });
});

describe('the coherence.json codec with negative days and parts (§5.2.2)', () => {
  const fileOf = (sceneMeta: Record<string, unknown>): string =>
    JSON.stringify({ formatVersion: 1, findings: [], runs: [], sceneMeta, worldRules: [], knowledge: [], reviewState: {} });

  it('loads a negative day offset, down to the limit, without a notice', () => {
    const outcome = parseCoherenceFile(fileOf({ a: { dayOffset: -14 }, b: { dayOffset: -3650 }, c: { dayOffset: -10_000_000 } }));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.sceneMeta).toEqual({ a: { dayOffset: -14 }, b: { dayOffset: -3650 }, c: { dayOffset: -10_000_000 } });
    expect(outcome.notices).toEqual([]);
  });

  it('drops a day offset out of range or not whole with the malformed notice, keeping the other fields', () => {
    const outcome = parseCoherenceFile(fileOf({ a: { dayOffset: -10_000_001, durationDays: 2 }, b: { dayOffset: '-3' } }));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.sceneMeta).toEqual({ a: { durationDays: 2 }, b: {} });
    expect(outcome.notices.map((notice) => notice.code)).toEqual(['dropped-scene-meta', 'dropped-scene-meta']);
  });

  it('still drops a negative duration', () => {
    const outcome = parseCoherenceFile(fileOf({ a: { dayOffset: -3, durationDays: -1 } }));
    expect(outcome.kind === 'ok' && outcome.file.sceneMeta['a']).toEqual({ dayOffset: -3 });
  });

  it('round-trips a story part and a negative day through save and load', () => {
    const file = withMeta({ pro: { dayOffset: -3650, storyPart: 'prologue', timelineMode: 'backstory' }, epi: { storyPart: 'epilogue' } });
    const text = serializeCoherenceFile(file);
    const outcome = parseCoherenceFile(text);
    expect(outcome.kind === 'ok' && outcome.file.sceneMeta).toEqual(file.sceneMeta);
    expect(outcome.kind === 'ok' && outcome.notices).toEqual([]);
    // The part is written after the fields an older build knows, so a file without parts serializes as it always did.
    const pro = JSON.stringify(JSON.parse(text).sceneMeta.pro);
    expect(pro.indexOf('"storyPart"')).toBeGreaterThan(pro.indexOf('"timelineMode"'));
  });

  it('reads an unknown part as the main story and names every unknown value once', () => {
    const outcome = parseCoherenceFile(fileOf({ a: { storyPart: 'coda', dayOffset: 1 }, b: { storyPart: 'coda' }, c: { storyPart: 7 } }));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.sceneMeta).toEqual({ a: { dayOffset: 1 }, b: {}, c: {} });
    const notices = outcome.notices.filter((notice) => notice.code === 'unknown-story-part');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toBe('Unknown story parts "coda", "7" read as the main story. The parts are prologue and epilogue.');
  });

  it('loads a file written before the change unchanged, and saves it byte for byte', () => {
    const old = withMeta({ s1: { dayOffset: 0, durationDays: 2, timelineMode: 'flashback' }, s2: { dayOffset: 40, after: ['s1'] } });
    const text = serializeCoherenceFile(old);
    const outcome = parseCoherenceFile(text);
    expect(outcome.kind === 'ok' && outcome.file.sceneMeta).toEqual(old.sceneMeta);
    expect(outcome.kind === 'ok' && outcome.notices).toEqual([]);
    if (outcome.kind === 'ok') expect(serializeCoherenceFile(outcome.file)).toBe(text);
  });
});

describe('effectiveStoryPart (§5.2.2)', () => {
  it('takes the scene’s own part, else the nearest folder’s, else the main story', () => {
    expect(effectiveStoryPart(undefined, [])).toBe('main');
    expect(effectiveStoryPart({ dayOffset: -14 }, [])).toBe('main');
    expect(effectiveStoryPart({}, [{ storyPart: 'epilogue' }])).toBe('epilogue');
    expect(effectiveStoryPart({ storyPart: 'prologue' }, [{ storyPart: 'epilogue' }])).toBe('prologue');
    expect(effectiveStoryPart({}, [{ storyPart: 'epilogue' }, undefined, { storyPart: 'prologue' }, {}])).toBe('prologue');
  });
});

describe('timeline.gap across parts (§5.2.2)', () => {
  const pair = (): ReturnType<typeof buildState> =>
    buildState({
      scenes: [
        { id: 'a', title: 'A', body: 'A.' },
        { id: 'b', title: 'B', body: 'B.' },
      ],
    });

  it('skips main → epilogue 4,000 days apart, and reports the same pair with no part (negative control)', () => {
    expect(run(pair(), withMeta({ a: { dayOffset: 10 }, b: { dayOffset: 4010, storyPart: 'epilogue' } }), GAP)).toEqual([]);
    const control = run(pair(), withMeta({ a: { dayOffset: 10 }, b: { dayOffset: 4010 } }), GAP);
    expect(control).toHaveLength(1);
    expect(control[0]?.message).toBe('"B" happens 4000 days after "A"');
  });

  it('skips prologue → main, and reports the same pair with no part', () => {
    expect(run(pair(), withMeta({ a: { dayOffset: -3650, storyPart: 'prologue' }, b: { dayOffset: 0 } }), GAP)).toEqual([]);
    expect(run(pair(), withMeta({ a: { dayOffset: -3650 }, b: { dayOffset: 0 } }), GAP)).toHaveLength(1);
  });

  it('skips prologue → epilogue', () => {
    expect(run(pair(), withMeta({ a: { dayOffset: -50, storyPart: 'prologue' }, b: { dayOffset: 9000, storyPart: 'epilogue' } }), GAP)).toEqual([]);
  });

  it('reports two epilogue scenes 30 days apart, and two prologue scenes too: gaps inside a part are checked as before', () => {
    const epilogue = run(pair(), withMeta({ a: { dayOffset: 4000, storyPart: 'epilogue' }, b: { dayOffset: 4030, storyPart: 'epilogue' } }), GAP);
    expect(epilogue).toHaveLength(1);
    expect(epilogue[0]).toMatchObject({ checkId: 'timeline.gap', type: 'time-gap' });
    expect(epilogue[0]?.message).toBe('"B" happens 30 days after "A"');
    const prologue = run(pair(), withMeta({ a: { dayOffset: -400, storyPart: 'prologue' }, b: { dayOffset: -300, storyPart: 'prologue' } }), GAP);
    expect(prologue).toHaveLength(1);
  });

  it('keeps time-skip exempting a pair inside a part', () => {
    const file = withMeta({ a: { dayOffset: 4000, storyPart: 'epilogue' }, b: { dayOffset: 4030, storyPart: 'epilogue', timelineMode: 'time-skip' } });
    expect(run(pair(), file, GAP)).toEqual([]);
  });

  it('compares the main story across an epilogue scene dated inside it', () => {
    const state = buildState({
      scenes: [
        { id: 'a', title: 'A', body: 'A.' },
        { id: 'b', title: 'B', body: 'B.' },
        { id: 'e', title: 'E', body: 'E.' },
      ],
    });
    const out = run(state, withMeta({ a: { dayOffset: 0 }, b: { dayOffset: 30 }, e: { dayOffset: 15, storyPart: 'epilogue' } }), GAP);
    expect(out.map((finding) => finding.message)).toEqual(['"B" happens 30 days after "A"']);
  });

  describe('a folder’s part covers its scenes, and a scene’s own part wins', () => {
    const state = (): ReturnType<typeof buildState> =>
      buildState({
        folders: [
          { id: 'story', title: 'The story' },
          { id: 'after', title: 'Afterwards' },
        ],
        scenes: [
          { id: 'last', title: 'Last', parent: 'story', body: 'Last.' },
          { id: 'years', title: 'Years later', parent: 'after', body: 'Years.' },
          { id: 'month', title: 'A month on', parent: 'after', body: 'Month.' },
        ],
      });

    it('skips the jump into an epilogue folder and checks the gap inside it', () => {
      const out = run(
        state(),
        withMeta({ after: { storyPart: 'epilogue' }, last: { dayOffset: 100 }, years: { dayOffset: 4100 }, month: { dayOffset: 4130 } }),
        GAP,
      );
      expect(out.map((finding) => finding.message)).toEqual(['"A month on" happens 30 days after "Years later"']);
    });

    it('lets a scene in the folder declare the main story back by its own part… and a different part', () => {
      // `month` declares itself a prologue inside the epilogue folder: it is compared with no one else, so nothing is reported.
      const out = run(
        state(),
        withMeta({ after: { storyPart: 'epilogue' }, last: { dayOffset: 100 }, years: { dayOffset: 4100 }, month: { dayOffset: 4130, storyPart: 'prologue' } }),
        GAP,
      );
      expect(out).toEqual([]);
    });

    it('reports the jump when the folder declares no part (negative control)', () => {
      const out = run(state(), withMeta({ last: { dayOffset: 100 }, years: { dayOffset: 4100 }, month: { dayOffset: 4130 } }), GAP);
      expect(out).toHaveLength(2);
    });
  });
});

describe('negative days in the other checks behave as positive ones (§5.2.2)', () => {
  const ANNA = 'c_ANNA000001';
  const HEIR = 'k_SECRET0001';
  const facts: KnowledgeFact[] = [{ id: HEIR, text: 'Mara is the heir', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }];

  const book = (): ReturnType<typeof buildState> =>
    buildState({
      entries: [entry(ANNA, 'Anna')],
      folders: [{ id: 'act', title: 'Act' }],
      scenes: [
        { id: 's1', title: 'One', parent: 'act', body: 'Anna arrived.' },
        { id: 's2', title: 'Two', parent: 'act', body: 'Anna left.' },
        { id: 's3', title: 'Three', parent: 'act', body: 'Anna waited.' },
        { id: 's4', title: 'Four', parent: 'act', body: 'Anna slept.' },
      ],
    });

  const CHECKS: readonly DeterministicCheckId[] = [
    'timeline.order-drift',
    'timeline.relation',
    'timeline.window',
    'timeline.overlap',
    'timeline.gap',
    'knowledge.leak',
  ];

  /**
   * Every check fires on this story: order-drift (Two before Three in the binder, after it in days), relation (Three follows
   * Two but happens first), window (Two and Four outside the act), overlap (One and Three), gap (Two → Four) and leak.
   */
  const story = (shift: number, extra: Partial<Record<string, SceneMeta>> = {}): CoherenceFile =>
    withMeta(
      {
        act: { dayOffset: shift + 0, durationDays: 20 },
        s1: { dayOffset: shift + 0, durationDays: 3, knows: [{ entryId: ANNA, factId: HEIR }] },
        s2: { dayOffset: shift + 30 },
        s3: { dayOffset: shift + 1, after: ['s2'], learns: [{ entryId: ANNA, factId: HEIR }] },
        s4: { dayOffset: shift + 60 },
        ...extra,
      } as Record<string, SceneMeta>,
      facts,
    );

  const shape = (drafts: readonly DraftFinding[]): string[] =>
    drafts.map((d) => `${d.checkId}|${d.type}|${d.factGroup}|${d.evidence.map((e) => e.docId).join(',')}`).sort();

  it('raises each check on a story wholly before day 0', () => {
    const out = run(book(), story(-1000), CHECKS);
    expect(new Set(out.map((d) => d.checkId))).toEqual(new Set(CHECKS));
    expect(out.find((d) => d.checkId === 'timeline.window')?.message).toBe('"Two" falls outside "Act", which spans days -1000 to -981');
    expect(out.find((d) => d.checkId === 'timeline.relation')?.message).toContain('on day -999, before day -970');
  });

  it.each([-1000, -15, -1, 7, 5000, -DAY_OFFSET_LIMIT + 10, DAY_OFFSET_LIMIT - 40])(
    'finds the same findings after shifting every day by %i, across day 0 (shift invariance)',
    (shift) => {
      expect(shape(run(book(), story(shift), CHECKS))).toEqual(shape(run(book(), story(0), CHECKS)));
    },
  );

  it('keeps parts out of every check but the gap', () => {
    const parted = story(-1000, {
      s1: { dayOffset: -1000, durationDays: 3, knows: [{ entryId: ANNA, factId: HEIR }], storyPart: 'prologue' },
      s2: { dayOffset: -970, storyPart: 'epilogue' },
    });
    const withoutGap = (lines: string[]): string[] => lines.filter((line) => !line.startsWith('timeline.gap'));
    expect(withoutGap(shape(run(book(), parted, CHECKS)))).toEqual(withoutGap(shape(run(book(), story(-1000), CHECKS))));
  });
});
