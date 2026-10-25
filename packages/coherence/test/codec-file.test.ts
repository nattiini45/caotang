import { MemoryArtifactFs, addDocument } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import {
  COHERENCE_FILE,
  CoherenceError,
  corruptCoherenceFile,
  emptyCoherenceFile,
  loadCoherence,
  parseCoherenceFile,
  reconcileCoherence,
  saveCoherence,
  serializeCoherenceFile,
  type CoherenceFile,
  type CoherenceRun,
  type Finding,
} from '../src/index.js';

import { LATER, NOW, buildState, entry } from './fixtures.js';

const EVIDENCE = { docId: 'sA', quote: 'Elena returned.', from: 0, to: 15 };

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f_7K2QX9M4A1',
    runId: 'r_3W8RN2TQ6C',
    class: 'deterministic',
    checkId: 'presence.expected',
    type: 'expected-absent',
    severity: 'error',
    status: 'open',
    factGroup: 'c_5h8qk2m9rt|expected-present',
    message: 'Elena is expected in "A" but is never named there',
    expected: 'Elena named in the scene',
    evidence: [EVIDENCE],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function run(overrides: Partial<CoherenceRun> = {}): CoherenceRun {
  return {
    id: 'r_3W8RN2TQ6C',
    at: NOW.toISOString(),
    kind: 'deterministic',
    checkIds: ['presence.expected'],
    scope: { docIds: ['sA'] },
    findingsUpserted: ['f_7K2QX9M4A1'],
    status: 'complete',
    notes: ['1 empty document(s) skipped: Empty'],
    ...overrides,
  };
}

function populated(): CoherenceFile {
  return {
    formatVersion: 1,
    findings: [
      finding({
        redetections: [{ runId: 'r_3W8RN2TQ6C', at: NOW.toISOString(), evidence: [EVIDENCE] }],
        note: 'deep POV',
        createdByRunId: 'r_3W8RN2TQ6C',
        touchedAt: LATER.toISOString(),
      }),
      finding({
        id: 'f_5H8QK2M9RT',
        class: 'llm',
        checkId: 'llm:characterization',
        type: 'characterization',
        severity: 'warning',
        status: 'dismissed',
        dismissedReason: 'intentional',
        factGroup: 'c_5h8qk2m9rt|age',
        evidence: [EVIDENCE, { docId: 'sB', quote: 'Elena is forty.', from: 3, to: 17 }],
        reasoning: 'Thirty-four against forty.',
        modelMeta: { model: 'fake-1', promptTokens: 120, completionTokens: 40 },
      }),
    ],
    runs: [run()],
    sceneMeta: {
      sB: { dayOffset: 7, durationDays: 2, after: ['sA'], expectedPresent: ['c_5h8qk2m9rt'], pov: 'c_5h8qk2m9rt', timelineMode: 'flashback', threads: [{ id: 'the lamp', payoff: 'sA', note: 'it is lit again' }, { id: 'the map', payoff: 'sA' }] },
      sA: { dayOffset: 1, learns: [{ entryId: 'c_5h8qk2m9rt', factId: 'k_SECRET0001' }], knows: [{ entryId: 'c_5h8qk2m9rt', factId: 'k_SECRET0001' }] },
    },
    knowledge: [
      { id: 'k_SECRET0001', text: 'Mara is the heir', ruleId: 'w_9Q8WRN2TQ6', entryId: 'c_5h8qk2m9rt', createdAt: NOW.toISOString(), updatedAt: LATER.toISOString() },
      { id: 'k_MAP0000001', text: 'The map is a forgery', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
    ],
    worldRules: [
      { id: 'w_9Q8WRN2TQ6', text: 'The bridge is out after chapter four.', origin: 'manual', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
      {
        id: 'w_1A2B3C4D5E',
        text: 'Magic costs a memory.',
        origin: 'found',
        source: EVIDENCE,
        verified: true,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ],
    reviewState: { sB: { lastReviewedRevision: 3, lastReviewedAt: NOW.toISOString() }, sA: { lastReviewedRevision: 1, lastReviewedAt: NOW.toISOString() } },
  };
}

describe('coherence.json codec', () => {
  it('round-trips a deterministic finding’s messageRef, values included', () => {
    const ref = {
      id: 'coherence.presence.expectedAbsent',
      message: '"{entry}" is expected in "{sceneTitle}" but is never named there',
      values: { entry: 'Elena', sceneTitle: 'A' },
    };
    const file = { ...populated(), findings: [finding({ messageRef: ref })] };
    const outcome = parseCoherenceFile(serializeCoherenceFile(file));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.findings[0]?.messageRef).toEqual(ref);
    expect(outcome.file.findings[0]?.message).toBe('Elena is expected in "A" but is never named there');
  });

  it('loads a file written before messageRefs, keeping every finding and its English message as written', () => {
    const before = populated();
    const old = {
      ...before,
      findings: before.findings.map(({ messageRef: _ignored, ...rest }) => rest),
    };
    const outcome = parseCoherenceFile(JSON.stringify(old));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.notices).toEqual([]);
    expect(outcome.file.findings).toHaveLength(2);
    expect(outcome.file.findings[0]?.message).toBe('Elena is expected in "A" but is never named there');
    expect(outcome.file.findings[0]?.messageRef).toBeUndefined();
  });

  it('ignores a malformed ref rather than losing the finding, and never gives a model-authored finding a ref', () => {
    const deterministic = finding({ messageRef: { id: '', message: 'broken' } });
    const llm = finding({
      id: 'f_5H8QK2M9RT',
      class: 'llm',
      checkId: 'llm:characterization',
      type: 'characterization',
      status: 'dismissed',
      dismissedReason: 'intentional',
      evidence: [EVIDENCE, { docId: 'sB', quote: 'Elena is forty.', from: 3, to: 17 }],
      reasoning: 'Thirty-four against forty.',
      modelMeta: { model: 'fake-1', promptTokens: 120, completionTokens: 40 },
      messageRef: { id: 'coherence.shouldNeverRender', message: 'Model prose' },
    });
    const outcome = parseCoherenceFile(serializeCoherenceFile({ ...populated(), findings: [deterministic, llm] }));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.findings).toHaveLength(2);
    expect(outcome.file.findings[0]?.messageRef).toBeUndefined();
    expect(outcome.file.findings[1]?.messageRef).toBeUndefined();
    expect(outcome.file.findings[1]?.message).toBe('Elena is expected in "A" but is never named there');
  });

  it('round-trips a populated file without loss', () => {
    const file = populated();
    const outcome = parseCoherenceFile(serializeCoherenceFile(file));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.notices).toEqual([]);
    expect(outcome.file).toEqual(file);
  });

  it('keeps the scope a run covered, so "Run again" can scan it, and reads a run kept before scopes were recorded without one', () => {
    const file = { ...populated(), runs: [run({ scope: { docIds: ['sA', 'sB'], mode: 'changed' } }), run({ id: 'r_9ZK4M2QXRB', scope: { docIds: ['sA'] } })] };
    const outcome = parseCoherenceFile(serializeCoherenceFile(file));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.runs[0]?.scope).toEqual({ docIds: ['sA', 'sB'], mode: 'changed' });
    expect(outcome.file.runs[1]?.scope).toEqual({ docIds: ['sA'] });
  });

  it('drops an unknown scope mode on read and keeps the run, which is not a reason to lose its history', () => {
    const text = serializeCoherenceFile({ ...populated(), runs: [run({ scope: { docIds: ['sA'], mode: 'full' } })] }).replace('"full"', '"everything"');
    const outcome = parseCoherenceFile(text);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.runs).toHaveLength(1);
    expect(outcome.file.runs[0]?.scope).toEqual({ docIds: ['sA'] });
  });

  it('writes keys in the spec order and sorts map keys, so diffs stay small', () => {
    const text = serializeCoherenceFile(populated());
    expect(text.startsWith('{\n  "formatVersion": 1,\n  "findings": [\n')).toBe(true);
    expect(text.indexOf('"sA"')).toBeLessThan(text.indexOf('"sB"'));
    expect(serializeCoherenceFile(populated())).toBe(text);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('drops an unknown top-level field with a notice, and does not write it back', () => {
    const raw = { ...JSON.parse(serializeCoherenceFile(emptyCoherenceFile())), futureField: { x: 1 } };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind === 'ok' && outcome.notices.map((n) => n.code)).toEqual(['unknown-field']);
    if (outcome.kind !== 'ok') return;
    expect(serializeCoherenceFile(outcome.file)).not.toContain('futureField');
  });

  it('drops a finding that fails its field contract and keeps the rest', () => {
    const good = finding();
    const badSeverity = { ...finding({ id: 'f_AAAAAAAAAA' }), severity: 'critical' };
    const raw = { formatVersion: 1, findings: [good, badSeverity], runs: [], sceneMeta: {}, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.findings.map((f) => f.id)).toEqual([good.id]);
    expect(outcome.notices.map((n) => n.code)).toEqual(['dropped-finding']);
  });

  it('keeps a note at the limit through serialize and parse, counting code points as the harness does', () => {
    for (const note of ['x'.repeat(500), '😀'.repeat(300)]) {
      const file: CoherenceFile = { ...emptyCoherenceFile(), findings: [finding({ status: 'fixed', note })] };
      const outcome = parseCoherenceFile(serializeCoherenceFile(file));
      expect(outcome.kind === 'ok' && outcome.notices).toEqual([]);
      expect(outcome.kind === 'ok' && outcome.file.findings.map((f) => f.note)).toEqual([note]);
    }
  });

  it('drops a note past the limit on read, with a notice, rather than keeping a finding it cannot hold', () => {
    const over = { ...finding({ status: 'fixed' }), note: '😀'.repeat(501) };
    const raw = { formatVersion: 1, findings: [over], runs: [], sceneMeta: {}, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind === 'ok' && outcome.file.findings).toEqual([]);
    expect(outcome.kind === 'ok' && outcome.notices.map((n) => n.code)).toEqual(['dropped-finding']);
  });

  it('counts a quote in code points, so 300 emoji are a quote and 301 are not', () => {
    const fits = finding({ evidence: [{ docId: 'sA', quote: '😀'.repeat(300), from: 0, to: 600 }] });
    const over = finding({ id: 'f_BBBBBBBBBB', evidence: [{ docId: 'sA', quote: '😀'.repeat(301), from: 0, to: 602 }] });
    const raw = { formatVersion: 1, findings: [fits, over], runs: [], sceneMeta: {}, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind === 'ok' && outcome.file.findings.map((f) => f.id)).toEqual([fits.id]);
  });

  it('reads the creating run and the writer’s last touch, and drops a finding whose touch is not a time', () => {
    const good = finding({ createdByRunId: 'r_3W8RN2TQ6C', touchedAt: NOW.toISOString() });
    const bad = { ...finding({ id: 'f_BBBBBBBBBB' }), touchedAt: 'yesterday' };
    const raw = { formatVersion: 1, findings: [good, bad], runs: [], sceneMeta: {}, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind === 'ok' && outcome.file.findings).toEqual([good]);
  });

  it('refuses a dismissed finding that carries no reason', () => {
    const raw = { formatVersion: 1, findings: [{ ...finding(), status: 'dismissed' }], runs: [], sceneMeta: {}, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind === 'ok' && outcome.file.findings).toEqual([]);
  });

  it('drops a finding whose quote is longer than 300 characters', () => {
    const long = finding({ evidence: [{ docId: 'sA', quote: 'x'.repeat(301), from: 0, to: 301 }] });
    const raw = { formatVersion: 1, findings: [long], runs: [], sceneMeta: {}, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind === 'ok' && outcome.file.findings).toEqual([]);
  });

  it('refuses a deterministic finding that names an llm check, and an llm one with a bogus category', () => {
    const mismatched = { ...finding(), class: 'deterministic', checkId: 'llm:factual' };
    const bogus = { ...finding({ id: 'f_BBBBBBBBBB' }), class: 'llm', checkId: 'llm:horoscope' };
    const raw = { formatVersion: 1, findings: [mismatched, bogus], runs: [], sceneMeta: {}, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind === 'ok' && outcome.file.findings).toEqual([]);
  });

  it('reads an unknown timeline mode as linear, with one notice that names it', () => {
    const raw = {
      formatVersion: 1,
      findings: [],
      runs: [],
      knowledge: [],
      sceneMeta: { sA: { dayOffset: 2, timelineMode: 'montage' }, sB: { timelineMode: 'montage' } },
      worldRules: [],
      reviewState: {},
    };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.sceneMeta['sA']).toEqual({ dayOffset: 2 });
    const modeNotices = outcome.notices.filter((n) => n.code === 'unknown-timeline-mode');
    expect(modeNotices).toHaveLength(1);
    expect(modeNotices[0]?.message).toContain('"montage"');
  });

  it('loads a file written before threads existed unchanged, and reads an empty list as none', () => {
    const before = { formatVersion: 1, findings: [], runs: [], sceneMeta: { sA: { dayOffset: 2, pov: 'c_5h8qk2m9rt' }, sB: { threads: [] } }, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(before));
    expect(outcome.kind === 'ok' && outcome.file.sceneMeta).toEqual({ sA: { dayOffset: 2, pov: 'c_5h8qk2m9rt' }, sB: {} });
    expect(outcome.kind === 'ok' && outcome.notices).toEqual([]);
  });

  it('keeps the good threads of a scene, and says which were dropped and why', () => {
    const threads = [
      { id: ' the lamp ', payoff: 'sA', note: '  lit  ' },
      { id: 'THE LAMP', payoff: 'sB' },
      { id: '  ', payoff: 'sA' },
      { id: 'no payoff' },
      'a string',
      { id: 'the map', payoff: 'sA', colour: 'red' },
    ];
    const raw = { formatVersion: 1, findings: [], runs: [], sceneMeta: { sC: { threads }, sD: { threads: 'the lamp' } }, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.sceneMeta['sC']?.threads).toEqual([{ id: 'the lamp', payoff: 'sA', note: 'lit' }, { id: 'the map', payoff: 'sA' }]);
    expect(outcome.file.sceneMeta['sD']).toEqual({});
    const messages = outcome.notices.map((n) => n.message);
    expect(messages.filter((m) => m.includes('is malformed and was dropped'))).toHaveLength(4);
    expect(messages).toContain('The thread "THE LAMP" is declared twice on "sC"; the second was dropped.');
    expect(messages.some((m) => m.includes('("colour")'))).toBe(true);
  });

  it('round-trips a scene’s dialogue container, loads a file without one unchanged, and drops a malformed id with a notice', () => {
    const linked = { ...emptyCoherenceFile(), sceneMeta: { sA: { dayOffset: 1, dialogueContainer: 'dCourt' } } };
    const outcome = parseCoherenceFile(serializeCoherenceFile(linked));
    expect(outcome.kind === 'ok' && outcome.file).toEqual(linked);
    expect(outcome.kind === 'ok' && outcome.notices).toEqual([]);
    expect(serializeCoherenceFile({ ...emptyCoherenceFile(), sceneMeta: { sA: { dayOffset: 1 } } })).not.toContain('dialogueContainer');

    const raw = { formatVersion: 1, findings: [], runs: [], sceneMeta: { sA: { dialogueContainer: 7 }, sB: { dialogueContainer: '' } }, worldRules: [], reviewState: {} };
    const bad = parseCoherenceFile(JSON.stringify(raw));
    expect(bad.kind === 'ok' && bad.file.sceneMeta).toEqual({ sA: {}, sB: {} });
    expect(bad.kind === 'ok' && bad.notices.map((n) => n.message)).toEqual([
      'The "dialogueContainer" declaration for "sA" is malformed and was dropped.',
      'The "dialogueContainer" declaration for "sB" is malformed and was dropped.',
    ]);
  });

  it('loads a file written before knowledge existed unchanged, as none and with no notice, and writes no key for an empty list', () => {
    const before = { formatVersion: 1, findings: [], runs: [], sceneMeta: { sA: { dayOffset: 2 } }, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(before));
    expect(outcome.kind === 'ok' && outcome.file.knowledge).toEqual([]);
    expect(outcome.kind === 'ok' && outcome.notices).toEqual([]);
    if (outcome.kind !== 'ok') return;
    expect(serializeCoherenceFile(outcome.file)).not.toContain('knowledge');
    expect(serializeCoherenceFile({ ...outcome.file, knowledge: populated().knowledge })).toContain('"knowledge": [');
  });

  it('keeps the good facts, and names the ones it drops and why', () => {
    const good = { id: 'k_SECRET0001', text: 'Mara is the heir', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
    const raw = {
      formatVersion: 1,
      findings: [],
      runs: [],
      sceneMeta: {},
      worldRules: [],
      knowledge: [
        good,
        { ...good },
        { ...good, id: 'f_SECRET0001', text: 'wrong prefix' },
        { ...good, id: 'k_BLANK00001', text: '   ' },
        { ...good, id: 'k_LONG000001', text: 'x'.repeat(301) },
        { ...good, id: 'k_NODATE0001', createdAt: 'yesterday' },
        'a string',
      ],
      reviewState: {},
    };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.knowledge).toEqual([good]);
    const messages = outcome.notices.filter((n) => n.code === 'dropped-knowledge').map((n) => n.message);
    expect(messages).toHaveLength(6);
    expect(messages[0]).toBe('The knowledge fact "Mara is the heir" appears twice in coherence.json; the second copy was dropped.');
    expect(messages.join(' ')).toContain('wrong prefix');
  });

  it('keeps the good pairs of a scene, and says which were dropped', () => {
    const pair = { entryId: 'c_5h8qk2m9rt', factId: 'k_SECRET0001' };
    const raw = {
      formatVersion: 1,
      findings: [],
      runs: [],
      sceneMeta: { sA: { learns: [pair, { ...pair }, { entryId: 'c_5h8qk2m9rt' }, 'x'], knows: 'everyone' }, sB: { knows: [] } },
      worldRules: [],
      reviewState: {},
    };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.sceneMeta['sA']).toEqual({ learns: [pair] });
    expect(outcome.file.sceneMeta['sB']).toEqual({});
    expect(outcome.notices.filter((n) => n.code === 'dropped-scene-meta')).toHaveLength(4);
  });

  it('drops one malformed declaration field and keeps the others', () => {
    const raw = { formatVersion: 1, findings: [], runs: [], sceneMeta: { sA: { dayOffset: -1, durationDays: 3 } }, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind === 'ok' && outcome.file.sceneMeta['sA']).toEqual({ durationDays: 3 });
    expect(outcome.kind === 'ok' && outcome.notices.map((n) => n.code)).toEqual(['dropped-scene-meta']);
  });

  it('keeps the first of two findings that share an id', () => {
    const raw = { formatVersion: 1, findings: [finding(), finding({ message: 'second copy' })], runs: [], sceneMeta: {}, worldRules: [], reviewState: {} };
    const outcome = parseCoherenceFile(JSON.stringify(raw));
    expect(outcome.kind === 'ok' && outcome.file.findings.map((f) => f.message)).toEqual([finding().message]);
  });

  it('classifies unparseable text as corrupt, and a newer format as newer', () => {
    expect(parseCoherenceFile('{not json').kind).toBe('corrupt');
    expect(parseCoherenceFile('[1, 2]').kind).toBe('corrupt');
    expect(parseCoherenceFile('{"findings": []}').kind).toBe('corrupt');
    expect(parseCoherenceFile('{"formatVersion": 2, "findings": []}')).toEqual({ kind: 'newer', formatVersion: 2 });
  });
});

describe('coherence.json on disk', () => {
  it('reports an absent file without writing one', async () => {
    const fs = new MemoryArtifactFs();
    const load = await loadCoherence(fs);
    expect(load.status).toBe('absent');
    expect(load.writable).toBe(true);
    expect(await fs.exists(COHERENCE_FILE)).toBe(false);
  });

  it('saves atomically and loads what it saved', async () => {
    const fs = new MemoryArtifactFs();
    const load = await loadCoherence(fs);
    await saveCoherence(fs, load, populated());
    const again = await loadCoherence(fs);
    expect(again.status).toBe('loaded');
    expect(again.file).toEqual(populated());
    expect(Object.keys(fs.snapshot())).toEqual([COHERENCE_FILE]);
  });

  it('keeps an unreadable file under a timestamped name and replaces it with an empty one', async () => {
    const fs = new MemoryArtifactFs();
    const damaged = '{"formatVersion": 1, "findings": [';
    fs.putFile(COHERENCE_FILE, damaged);
    const load = await loadCoherence(fs, { now: NOW });
    expect(load.status).toBe('recovered');
    expect(load.preservedAs).toBe(corruptCoherenceFile(NOW));
    expect(load.preservedAs).toMatch(/^coherence\.json\.corrupt-2026-10-01T09-00-00-000Z$/);
    expect(fs.snapshot()[load.preservedAs ?? '']).toBe(damaged);
    expect(parseCoherenceFile(fs.snapshot()[COHERENCE_FILE] ?? '').kind).toBe('ok');
    const notice = load.notices.find((n) => n.code === 'corrupt-file');
    expect(notice?.message).toContain('Dismissal decisions are lost');
    expect(notice?.message).toContain('Scene declarations, manual world rules and knowledge facts');
  });

  it('never overwrites a file a newer Caotang wrote', async () => {
    const fs = new MemoryArtifactFs();
    const newer = '{"formatVersion": 2, "findings": []}';
    fs.putFile(COHERENCE_FILE, newer);
    const load = await loadCoherence(fs);
    expect(load.status).toBe('read-only');
    expect(load.writable).toBe(false);
    await expect(saveCoherence(fs, load, emptyCoherenceFile())).rejects.toBeInstanceOf(CoherenceError);
    expect(fs.snapshot()[COHERENCE_FILE]).toBe(newer);
  });

  it('names the corrupt-file copy with no colons or dots in the stamp', () => {
    expect(corruptCoherenceFile(NOW)).toBe('coherence.json.corrupt-2026-10-01T09-00-00-000Z');
  });
});

describe('reconcileCoherence', () => {
  it('drops a dialogue container link that names no dialogue node, with a notice, and keeps one to an archived container', () => {
    const state = buildState({
      scenes: [
        { id: 'sA', title: 'Scene A', body: 'Elena returned.' },
        { id: 'sB', title: 'Scene B', body: 'Ben left.' },
        { id: 'sC', title: 'Scene C', body: 'Mara slept.' },
        { id: 'dOld', title: 'Old court', body: 'Zed: hi' },
      ],
    });
    const court = state.manifest.tree.find((node) => node.id === 'dOld');
    if (court !== undefined) Object.assign(court, { type: 'dialogue', status: 'archived' });
    const file: CoherenceFile = {
      ...emptyCoherenceFile(),
      sceneMeta: { sA: { dialogueContainer: 'dGone' }, sB: { dialogueContainer: 'sC' }, sC: { dialogueContainer: 'dOld', dayOffset: 2 } },
    };
    const { file: next, notices } = reconcileCoherence(file, state);
    expect(next.sceneMeta).toEqual({ sC: { dialogueContainer: 'dOld', dayOffset: 2 } });
    expect(notices.map((n) => n.message)).toEqual([
      'The dialogue container linked to "Scene A" no longer exists or is not a dialogue container, so that link was dropped.',
      'The dialogue container linked to "Scene B" no longer exists or is not a dialogue container, so that link was dropped.',
    ]);
  });

  it('drops the pairs whose character or fact is gone, and the links of a fact whose entry or rule is gone, with a notice each', () => {
    const state = buildState({
      scenes: [{ id: 'sA', title: 'Scene A', body: 'Elena returned.' }, { id: 'sB', title: 'Scene B', body: 'Ben left.' }],
      entries: [entry('c_5H8QK2M9RT', 'Elena')],
    });
    const stamp = NOW.toISOString();
    const file: CoherenceFile = {
      ...populated(),
      findings: [],
      runs: [],
      worldRules: [],
      reviewState: {},
      knowledge: [
        { id: 'k_SECRET0001', text: 'Mara is the heir', ruleId: 'w_GONE000001', entryId: 'c_GONE000001', createdAt: stamp, updatedAt: stamp },
        { id: 'k_MAP0000001', text: 'The map is a forgery', createdAt: stamp, updatedAt: stamp },
      ],
      sceneMeta: {
        sA: { learns: [{ entryId: 'c_5H8QK2M9RT', factId: 'k_SECRET0001' }, { entryId: 'c_GONE000001', factId: 'k_SECRET0001' }], knows: [{ entryId: 'c_5H8QK2M9RT', factId: 'k_GONE000001' }] },
        sB: { knows: [{ entryId: 'c_GONE000001', factId: 'k_MAP0000001' }] },
      },
    };
    const { file: next, notices } = reconcileCoherence(file, state);
    expect(next.sceneMeta).toEqual({ sA: { learns: [{ entryId: 'c_5H8QK2M9RT', factId: 'k_SECRET0001' }] } });
    expect(next.knowledge.map((fact) => [fact.id, fact.ruleId, fact.entryId])).toEqual([['k_SECRET0001', undefined, undefined], ['k_MAP0000001', undefined, undefined]]);
    expect(notices.map((n) => n.code)).toEqual(['dangling-knowledge', 'dangling-knowledge', 'dangling-knowledge', 'dangling-knowledge', 'dangling-knowledge']);
    expect(notices.map((n) => n.message).join(' ')).toContain('A "knows" declaration on "Scene A" named Elena and a knowledge fact that no longer exists, and was dropped.');
    expect(notices.map((n) => n.message).join(' ')).not.toMatch(/[ck]_[0-9A-Z]{10}/);
    expect(file.sceneMeta['sB']).toBeDefined();
  });

  it('drops declarations on deleted nodes, findings quoting deleted documents, and dangling sources', () => {
    const state = buildState({
      scenes: [{ id: 'sA', title: 'A', body: 'Elena returned.' }],
      entries: [entry('c_5H8QK2M9RT', 'Elena')],
    });
    const file: CoherenceFile = {
      formatVersion: 1,
      findings: [
        finding({ id: 'f_AAAAAAAAAA', evidence: [{ docId: 'sGone', quote: 'x', from: 0, to: 1 }] }),
        finding({ id: 'f_BBBBBBBBBB', evidence: [EVIDENCE] }),
      ],
      runs: [],
      knowledge: [],
      sceneMeta: { sA: { dayOffset: 1 }, sGone: { dayOffset: 2 } },
      worldRules: [
        { id: 'w_9Q8WRN2TQ6', text: 'Rule.', origin: 'found', source: { docId: 'sGone', quote: 'x', from: 0, to: 1 }, verified: true, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
      ],
      reviewState: { sA: { lastReviewedRevision: 1, lastReviewedAt: NOW.toISOString() }, sGone: { lastReviewedRevision: 1, lastReviewedAt: NOW.toISOString() } },
    };
    const { file: next, notices } = reconcileCoherence(file, state);
    expect(next.sceneMeta).toEqual({ sA: { dayOffset: 1 } });
    expect(next.findings.map((f) => f.id)).toEqual(['f_BBBBBBBBBB']);
    expect(next.worldRules[0]?.source).toBeUndefined();
    expect(next.worldRules[0]?.verified).toBeUndefined();
    expect(next.reviewState).toEqual({ sA: { lastReviewedRevision: 1, lastReviewedAt: NOW.toISOString() } });
    expect(notices.map((n) => n.code).sort()).toEqual(['dangling-finding', 'dangling-scene-meta', 'dangling-world-rule-source']);
    // The load notices are shown as they are, so none names a node id.
    expect(notices.map((n) => n.message).join(' ')).not.toContain('sGone');
    expect(file.sceneMeta['sGone']).toBeDefined();
  });

  it('keeps a dismissed branch finding on a dialogue container and its world-rule source, with no notice', () => {
    const state = buildState({ scenes: [{ id: 'sA', title: 'A', body: 'Elena returned.' }] });
    addDocument(state, { id: 'dTavern', parentId: 'manuscript', title: 'Tavern', type: 'dialogue', kind: 'branching', body: '* Hello\n', now: NOW });
    const loose = finding({
      id: 'f_DLGDISMISS1',
      checkId: 'branch.loose-end',
      type: 'loose-end',
      status: 'dismissed',
      dismissedReason: 'in-world-lie',
      evidence: [{ docId: 'dTavern', quote: 'Hello', from: 2, to: 7 }],
    });
    const file: CoherenceFile = {
      formatVersion: 1,
      findings: [loose],
      runs: [],
      knowledge: [],
      sceneMeta: {},
      worldRules: [
        {
          id: 'w_9Q8WRN2TQ6',
          text: 'Rule.',
          origin: 'manual',
          source: { docId: 'dTavern', quote: 'Hello', from: 2, to: 7 },
          verified: true,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
      reviewState: {},
    };
    const { file: next, notices } = reconcileCoherence(file, state);
    expect(next.findings).toEqual([loose]);
    expect(next.worldRules[0]?.source).toEqual({ docId: 'dTavern', quote: 'Hello', from: 2, to: 7 });
    expect(next.worldRules[0]?.verified).toBe(true);
    expect(notices).toEqual([]);
  });

  it('drops a finding that quotes a deleted dialogue container, with the dangling-finding notice a deleted document gets', () => {
    const state = buildState({ scenes: [{ id: 'sA', title: 'A', body: 'Elena returned.' }] });
    const file: CoherenceFile = {
      formatVersion: 1,
      findings: [finding({ id: 'f_DLGGONE01', checkId: 'branch.loose-end', type: 'loose-end', evidence: [{ docId: 'dGone', quote: 'Hello', from: 2, to: 7 }] })],
      runs: [],
      knowledge: [],
      sceneMeta: {},
      worldRules: [],
      reviewState: {},
    };
    const { file: next, notices } = reconcileCoherence(file, state);
    expect(next.findings).toEqual([]);
    expect(notices.map((n) => n.code)).toEqual(['dangling-finding']);
    // The notice is shown as it is, so it names the finding by its statement and never by its id.
    expect(notices[0]?.message).toBe(`A finding quotes a document that no longer exists and was removed: “${file.findings[0]?.message ?? ''}”.`);
    expect(notices[0]?.message).not.toContain('f_DLGGONE01');
  });
});
