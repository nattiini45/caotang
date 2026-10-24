import { expect, test } from '@playwright/test';
import { emptyCoherenceFile, type CoherenceFile, type Finding } from '../../packages/coherence/src/index.js';

import { groupsByFact, runTimeLabel, runViewsOf, scanCoverageLine, scopeFor, severitySections, type FindingView } from '../../apps/desktop/src/app/findings-model.js';
import { IDS, project } from './fixtures.js';

const NOW = '2026-10-08T09:00:00.000Z';

function finding(overrides: Partial<Finding> & Pick<Finding, 'id' | 'severity' | 'status'>): Finding {
  return {
    runId: 'r_AAAAAAAAAA',
    class: 'deterministic',
    checkId: 'presence.expected',
    type: 'expected-absent',
    factGroup: `g|${overrides.id}`,
    evidence: [],
    message: `Finding ${overrides.id}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fileWith(findings: Finding[], runs: CoherenceFile['runs'] = []): CoherenceFile {
  return { ...emptyCoherenceFile(), findings, runs };
}

function view(id: string, factGroup: string, message: string): FindingView {
  return {
    id,
    type: 'expected-absent',
    typeLabel: 'Expected character missing',
    severity: 'error',
    status: 'open',
    message,
    expected: undefined,
    note: undefined,
    dismissedReason: undefined,
    quotes: [],
    redetected: 0,
    factGroup,
    checkId: 'presence.expected',
    fixable: false,
  };
}

test.describe('findings grouped by fact (coherence.md §4.2, §8)', () => {
  test('findings that share a fact are one group card, headed by the first finding, and keep their citations in order', () => {
    const groups = groupsByFact(
      [
        view('f_ONE', 'elena|expected-present', 'Elena is expected here'),
        view('f_TWO', 'marek|expected-present', 'Marek is expected there'),
        view('f_THREE', 'elena|expected-present', 'Elena is expected again'),
      ],
      'error',
    );
    expect(groups.map((group) => group.factGroup)).toEqual(['elena|expected-present', 'marek|expected-present']);
    expect(groups[0]?.heading).toBe('Elena is expected here');
    expect(groups[0]?.findings.map((finding) => finding.id)).toEqual(['f_ONE', 'f_THREE']);
    expect(groups[1]?.findings.map((finding) => finding.id)).toEqual(['f_TWO']);
  });

  test('a group with no message heads with its type in the writer’s words, so no card is blank', () => {
    const [group] = groupsByFact([{ ...view('f_BLANK', 'x|y', ''), type: 'alias-collision', typeLabel: 'Shared name' }], 'warning');
    expect(group?.heading).toBe('Shared name');
  });

  test('a card names its type in the writer’s words, and a model subtype with no row in plain words, never as its key', () => {
    const state = project();
    const file = fileWith([
      finding({ id: 'f_A1', severity: 'error', status: 'open' }),
      finding({ id: 'f_L1', severity: 'warning', status: 'open', class: 'llm', checkId: 'llm:timeline-plot', type: 'travel-time' }),
    ]);
    const [errors, warnings] = severitySections(state, file, 'open');
    expect(errors?.findings[0]?.typeLabel).toBe('Expected character missing');
    expect(warnings?.findings[0]?.typeLabel).toBe('Travel time');
  });

  test('each severity section carries its own groups, and the findings the section already listed', () => {
    const state = project();
    const file = fileWith([
      finding({ id: 'f_A1', severity: 'error', status: 'open', factGroup: 'elena|expected-present' }),
      finding({ id: 'f_A2', severity: 'error', status: 'open', factGroup: 'elena|expected-present' }),
      finding({ id: 'f_B1', severity: 'info', status: 'open', factGroup: 'bob|cue-unmatched' }),
    ]);
    const [errors, notes] = severitySections(state, file, 'open');
    expect(errors?.findings.map((item) => item.id)).toEqual(['f_A1', 'f_A2']);
    expect(errors?.groups.map((group) => group.findings.length)).toEqual([2]);
    expect(notes?.groups.map((group) => group.factGroup)).toEqual(['bob|cue-unmatched']);
  });
});

test.describe('the run history (coherence.md §4.1, §8)', () => {
  const at = (hour: number): string => `2026-10-08T0${hour}:00:00.000Z`;

  test('lists the newest run first, with its kind, scope, findings, checks and notes in words', () => {
    const file = fileWith(
      [],
      [
        {
          id: 'r_OLDEST0001',
          at: at(1),
          kind: 'deterministic',
          checkIds: ['codex.never-mentioned', 'script.cue-collision'],
          scope: { docIds: [IDS.sceneA] },
          findingsUpserted: ['f_X'],
          status: 'complete',
          notes: ['2 empty document(s) skipped'],
        },
        {
          id: 'r_NEWEST0002',
          at: at(2),
          kind: 'llm',
          checkIds: ['llm:timeline-plot'],
          scope: { docIds: [IDS.sceneA, IDS.sceneB] },
          findingsUpserted: [],
          status: 'partial',
          tokens: { promptTokens: 1200, completionTokens: 300 },
          model: 'gpt-test',
        },
      ],
    );
    const runs = runViewsOf(file, (docId) => (docId === IDS.sceneA ? 'The Storm' : docId), 'en-US');
    expect(runs.map((run) => run.id)).toEqual(['r_NEWEST0002', 'r_OLDEST0001']);
    expect(runs[0]).toMatchObject({ kind: 'Model review', status: 'partial', scopeLabel: '2 documents', findingCount: 0 });
    expect(runs[0]?.checkLabels).toEqual(['Model: timeline plot']);
    expect(runs[0]?.tokenLine).toBe('1,200 tokens in, 300 out (gpt-test)');
    expect(runs[1]).toMatchObject({ kind: 'Quick scan', scopeLabel: '"The Storm"', findingCount: 1, notes: ['2 empty document(s) skipped'] });
    expect(runs[1]?.checkLabels[1]).toBe('A screenplay character cue matches no codex entry');
  });

  test('a run’s token counts and time are grouped and written in the formatter locale', () => {
    const file = fileWith(
      [],
      [
        {
          id: 'r_NEWEST0002',
          at: '2026-10-08T09:00:00',
          kind: 'llm',
          checkIds: ['llm:timeline-plot'],
          scope: { docIds: [IDS.sceneA] },
          findingsUpserted: [],
          status: 'complete',
          tokens: { promptTokens: 1200, completionTokens: 300 },
          model: 'gpt-test',
        },
      ],
    );
    const [run] = runViewsOf(file, () => 'The Storm', 'de-DE');
    expect(run?.tokenLine).toBe('1.200 tokens in, 300 out (gpt-test)');
    expect(run?.at).toBe('08.10.2026, 09:00');
    // The stamp above is a local one, so its reading does not depend on the machine's timezone.
    expect(runTimeLabel('2026-10-08T09:00:00', 'en-US')).toBe('Oct 8, 2026, 9:00 AM');
    expect(runTimeLabel('not a stamp', 'de-DE')).toBe('not a stamp');
  });

  test('a file with no run has no history, and no file has none either', () => {
    expect(runViewsOf(emptyCoherenceFile(), () => '', 'en-US')).toEqual([]);
    expect(runViewsOf(undefined, () => '', 'en-US')).toEqual([]);
  });
});

test.describe('the scope the Findings tab offers (coherence.md §6.2)', () => {
  test('this document needs a document in view, and names nothing without one', () => {
    expect(scopeFor('doc', undefined)).toBeUndefined();
    expect(scopeFor('doc', IDS.sceneA)).toEqual({ mode: 'doc', docIds: [IDS.sceneA] });
  });

  test('changed and whole-manuscript scopes name no document, so they need no view', () => {
    expect(scopeFor('changed', undefined)).toEqual({ mode: 'changed' });
    expect(scopeFor('full', IDS.sceneA)).toEqual({ mode: 'full' });
  });

  test('the coverage line names the checks that are on, and says what a scan does not read', () => {
    const line = scanCoverageLine(['codex.never-mentioned', 'script.cue-collision']);
    expect(line).toBe(
      'The Findings tab’s quick scan checks for: A codex entry is never named in the manuscript; A screenplay character cue matches no codex entry. ' +
        'It does not read the story for plot or character problems; the model review does that.',
    );
    expect(scanCoverageLine([])).toBe('Every quick check is off in Settings, so this tab’s scan runs nothing. Turn checks on in Settings.');
  });
});
