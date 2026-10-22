import { describe, expect, it } from 'vitest';

import {
  assembleInput,
  dismissFinding,
  emptyCoherenceFile,
  leakVerdict,
  lessonsOf,
  runChecks,
  runDeterministic,
  storyOrder,
  type CoherenceFile,
  type KnowledgeFact,
  type KnowledgeLink,
  type LedgerScene,
  type SceneMeta,
} from '../src/index.js';

import { LATER, NOW, buildState, detect, entry } from './fixtures.js';

const CHECK = ['knowledge.leak'] as const;
const ANNA = 'c_ANNA000001';
const BEN = 'c_BEN0000001';
const HEIR = 'k_SECRET0001';
const MAP = 'k_MAP0000001';

const facts: KnowledgeFact[] = [
  { id: HEIR, text: 'Mara is the heir', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
  { id: MAP, text: 'The map is a forgery', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
];

const learns = (entryId: string, factId: string): KnowledgeLink[] => [{ entryId, factId }];

function fileWith(sceneMeta: Record<string, SceneMeta>, knowledge: KnowledgeFact[] = facts): CoherenceFile {
  return { ...emptyCoherenceFile(), sceneMeta, knowledge };
}

/** Three scenes in binder order, and a flashback that sits last in the binder. */
function book(body = 'Anna crossed the yard.'): ReturnType<typeof buildState> {
  return buildState({
    entries: [entry(ANNA, 'Anna'), entry(BEN, 'Ben')],
    scenes: [
      { id: 's3', title: 'Scene 3', body },
      { id: 's5', title: 'Scene 5', body: 'Ben waited.' },
      { id: 's7', title: 'Scene 7', body: 'The letter came.' },
      { id: 'fb', title: 'Year one', body: 'The old nurse told her.' },
    ],
  });
}

function scan(sceneMeta: Record<string, SceneMeta>, state = book()): ReturnType<typeof runChecks> {
  return runChecks(assembleInput(state, fileWith(sceneMeta), { detector: detect }).input, CHECK);
}

describe('knowledge.leak (coherence.md §4.4)', () => {
  it('finds a character who knows a fact in a scene before the scene that teaches it, naming both scenes', () => {
    const out = scan({ s3: { knows: learns(ANNA, HEIR) }, s7: { learns: learns(ANNA, HEIR) } });
    expect(out.drafts).toHaveLength(1);
    const [finding] = out.drafts;
    expect(finding).toMatchObject({ checkId: 'knowledge.leak', type: 'knows-before-learns', severity: 'error' });
    expect(finding?.message).toBe('Anna knows that "Mara is the heir" in "Scene 3", but learns it only in "Scene 7"');
    expect(finding?.evidence.map((passage) => passage.docId)).toEqual(['s3', 's7']);
    expect(finding?.factGroup).toBe(`${ANNA}|knows:${HEIR}`.toLowerCase());
  });

  it('raises nothing when the scene that teaches the fact comes first, or is the scene that uses it', () => {
    expect(scan({ s3: { learns: learns(ANNA, HEIR) }, s7: { knows: learns(ANNA, HEIR) } }).drafts).toEqual([]);
    expect(scan({ s5: { learns: learns(ANNA, HEIR), knows: learns(ANNA, HEIR) } }).drafts).toEqual([]);
  });

  it('finds a fact nobody teaches the character, with its own message', () => {
    const out = scan({ s3: { knows: learns(ANNA, HEIR) } });
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]).toMatchObject({ type: 'never-learns', severity: 'error' });
    expect(out.drafts[0]?.message).toBe('Anna knows that "Mara is the heir" in "Scene 3", but never learns it');
    expect(out.drafts[0]?.evidence.map((passage) => passage.docId)).toEqual(['s3']);
  });

  it('keeps the characters and the facts apart: another character lesson, or another fact, does not teach', () => {
    const other = scan({ s3: { learns: learns(BEN, HEIR), knows: learns(ANNA, HEIR) } });
    expect(other.drafts).toHaveLength(1);
    expect(other.drafts[0]?.type).toBe('never-learns');
    const wrongFact = scan({ s3: { learns: learns(ANNA, MAP), knows: learns(ANNA, HEIR) } });
    expect(wrongFact.drafts).toHaveLength(1);
  });

  it('counts a learning flashback ahead of the knowing scene when its dayOffset is earlier, and exempts it without a dayOffset', () => {
    const positive = scan({
      s3: { dayOffset: 100, knows: learns(ANNA, HEIR) },
      fb: { dayOffset: 1, timelineMode: 'flashback', learns: learns(ANNA, HEIR) },
    });
    expect(positive.drafts).toEqual([]);

    const undated = scan({ s3: { knows: learns(ANNA, HEIR) }, fb: { timelineMode: 'flashback', learns: learns(ANNA, HEIR) } });
    expect(undated.drafts).toEqual([]);
    expect(undated.notes.join('\n')).toContain('1 declaration(s) of what a character knows not compared');
  });

  it('finds a learning flashback that the days put after the knowing scene', () => {
    const out = scan({
      s3: { dayOffset: 10, knows: learns(ANNA, HEIR) },
      fb: { dayOffset: 50, timelineMode: 'flashback', learns: learns(ANNA, HEIR) },
    });
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]?.message).toContain('learns it only in "Year one"');
  });

  it('does not count a dream as learning, and does not check what a dream shows a character know', () => {
    const dreamTeaches = scan({ s3: { knows: learns(ANNA, HEIR) }, s5: { timelineMode: 'dream', learns: learns(ANNA, HEIR) } });
    expect(dreamTeaches.drafts).toHaveLength(1);
    expect(dreamTeaches.drafts[0]?.type).toBe('never-learns');
    for (const timelineMode of ['dream', 'mythic'] as const) {
      expect(scan({ s3: { timelineMode, knows: learns(ANNA, HEIR) } }).drafts).toEqual([]);
    }
  });

  it('orders parallel scenes within their strand and leaves a strand against the main line unknown', () => {
    const within = scan({
      s3: { timelineMode: 'parallel', knows: learns(ANNA, HEIR) },
      s7: { timelineMode: 'parallel', learns: learns(ANNA, HEIR) },
    });
    expect(within.drafts).toHaveLength(1);
    const across = scan({ s3: { knows: learns(ANNA, HEIR) }, s7: { timelineMode: 'parallel', learns: learns(ANNA, HEIR) } });
    expect(across.drafts).toEqual([]);
  });

  it('raises a finding per knowing scene under one fact group, so they share a card', () => {
    const out = scan({ s3: { knows: learns(ANNA, HEIR) }, s5: { knows: learns(ANNA, HEIR) } });
    expect(out.drafts.map((draft) => draft.evidence[0]?.docId)).toEqual(['s3', 's5']);
    expect(new Set(out.drafts.map((draft) => draft.factGroup)).size).toBe(1);
  });

  it('notes a declaration whose character or fact is gone instead of comparing it', () => {
    const out = scan({ s3: { knows: [{ entryId: 'c_GONE000001', factId: HEIR }, { entryId: ANNA, factId: 'k_GONE000001' }] } });
    expect(out.drafts).toEqual([]);
    expect(out.notes).toContain('2 declaration(s) of what a character knows name a character or fact that is gone; not compared');
  });

  it('says how many scenes declare what a character knows, and says nothing in a project with no fact', () => {
    expect(scan({ s3: { knows: learns(ANNA, HEIR) } }).notes[0]).toBe('1 of 4 scene(s) declare what a character knows; the rest are not compared');
    const bare = runChecks(assembleInput(book(), emptyCoherenceFile(), { detector: detect }).input, CHECK);
    expect(bare).toEqual({ drafts: [], notes: [] });
  });

  it('updates one finding across runs and lets it be dismissed with a reason that stands', () => {
    const file = fileWith({ s3: { knows: learns(ANNA, HEIR) }, s7: { learns: learns(ANNA, HEIR) } });
    const first = runDeterministic(book(), file, { scope: { mode: 'full' }, checks: [...CHECK], now: NOW, detector: detect });
    const found = first.file.findings.filter((finding) => finding.checkId === 'knowledge.leak');
    expect(found).toHaveLength(1);
    const id = found[0]?.id ?? '';

    const edited = runDeterministic(book('Anna crossed the yard, and the gate shut.'), first.file, {
      scope: { mode: 'full' },
      checks: [...CHECK],
      now: LATER,
      detector: detect,
    });
    expect(edited.file.findings.map((finding) => finding.id)).toEqual([id]);

    const dismissed = dismissFinding(edited.file, id, { reason: 'intentional', note: 'she guessed' }, LATER);
    const again = runDeterministic(book(), dismissed, { scope: { mode: 'full' }, checks: [...CHECK], now: LATER, detector: detect });
    expect(again.file.findings).toHaveLength(1);
    expect(again.file.findings[0]).toMatchObject({ id, status: 'dismissed', dismissedReason: 'intentional' });
  });

  it('clears the finding when the order is fixed', () => {
    const wrong = fileWith({ s3: { knows: learns(ANNA, HEIR) }, s7: { learns: learns(ANNA, HEIR) } });
    const first = runDeterministic(book(), wrong, { scope: { mode: 'full' }, checks: [...CHECK], now: NOW, detector: detect });
    expect(first.file.findings).toHaveLength(1);
    const fixed: CoherenceFile = { ...first.file, sceneMeta: { s3: { learns: learns(ANNA, HEIR) }, s7: { knows: learns(ANNA, HEIR) } } };
    const second = runDeterministic(book(), fixed, { scope: { mode: 'full' }, checks: [...CHECK], now: LATER, detector: detect });
    expect(second.file.findings).toEqual([]);
  });
});

describe('the ledger (coherence.md §4.4)', () => {
  const scene = (docId: string, binderIndex: number, meta: SceneMeta = {}): LedgerScene => ({ docId, title: docId, binderIndex, meta });

  it('orders by days when both scenes declare them, with binder position breaking a tie', () => {
    expect(storyOrder(scene('a', 5, { dayOffset: 1 }), scene('b', 1, { dayOffset: 9 }))).toBe('before');
    expect(storyOrder(scene('a', 1, { dayOffset: 4 }), scene('b', 5, { dayOffset: 4 }))).toBe('before');
    expect(storyOrder(scene('a', 5, { dayOffset: 4 }), scene('b', 1, { dayOffset: 4 }))).toBe('after');
    expect(storyOrder(scene('a', 1), scene('a', 1))).toBe('same');
  });

  it('orders by binder position only where it is reliable', () => {
    expect(storyOrder(scene('a', 1), scene('b', 2))).toBe('before');
    expect(storyOrder(scene('a', 1, { timelineMode: 'time-skip' }), scene('b', 2, { timelineMode: 'simultaneous' }))).toBe('before');
    expect(storyOrder(scene('a', 1), scene('b', 2, { timelineMode: 'flashback' }))).toBe('unknown');
    expect(storyOrder(scene('a', 1, { timelineMode: 'frame' }), scene('b', 2, { timelineMode: 'frame' }))).toBe('before');
    expect(storyOrder(scene('a', 1, { timelineMode: 'frame' }), scene('b', 2, { timelineMode: 'parallel' }))).toBe('unknown');
    expect(storyOrder(scene('a', 1, { dayOffset: 3 }), scene('b', 2, { timelineMode: 'circular' }))).toBe('unknown');
  });

  it('lists where each character learns a fact in binder order, leaving out the scenes that do not teach', () => {
    const scenes = [
      scene('late', 9, { learns: learns(BEN, HEIR) }),
      scene('early', 2, { learns: learns(ANNA, HEIR) }),
      scene('dreamt', 4, { timelineMode: 'dream', learns: learns(BEN, HEIR) }),
      scene('other', 5, { learns: learns(ANNA, MAP) }),
    ];
    expect(lessonsOf(HEIR, scenes).map((lesson) => [lesson.entryId, lesson.scene.docId])).toEqual([
      [ANNA, 'early'],
      [BEN, 'late'],
    ]);
  });

  it('gives the earliest later teacher in the verdict', () => {
    const scenes = [scene('use', 1), scene('b', 5, { learns: learns(ANNA, HEIR) }), scene('a', 3, { learns: learns(ANNA, HEIR) })];
    const verdict = leakVerdict(ANNA, HEIR, scenes[0] as LedgerScene, scenes);
    expect(verdict).toMatchObject({ kind: 'learns-later', scene: { docId: 'a' } });
  });
});
