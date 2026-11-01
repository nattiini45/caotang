/**
 * The coherence report (the one-source compile's Review row): the Markdown and JSON it writes from the findings file, the grouping by
 * fact, and the way a project with no file or no run reads.
 */

import { describe, expect, it } from 'vitest';

import { createEmptyManifest, createProjectState, emptyCoherenceState, type CoherenceFindingState, type CoherenceState, type ProjectState } from '@caotang/store';

import {
  coherenceReportJson,
  coherenceReportMarkdown,
  ENGLISH_REPORT_WORDS,
  renderMedia,
  type CoherenceReportInput,
  type CoherenceReportWords,
} from '../src/index.js';

const NOW = new Date('2026-10-08T09:00:00.000Z');
const STORM = 'n_TEMPEST001';

function finding(id: string, extra: Partial<CoherenceFindingState>): CoherenceFindingState {
  return { id, status: 'open', updatedAt: NOW.toISOString(), evidence: [{ docId: STORM, quote: 'the gale arrived', from: 0, to: 16 }], ...extra };
}

function fileWithFindings(): CoherenceState {
  const file = emptyCoherenceState();
  file.runs.push({
    id: 'r_AAAAAAAAAA',
    at: NOW.toISOString(),
    kind: 'deterministic',
    checkIds: ['codex.never-mentioned', 'script.cue-collision'],
    scope: { docIds: [STORM] },
    findingsUpserted: ['f_AAAAAAAAAA', 'f_BBBBBBBBBB', 'f_CCCCCCCCCC'],
    status: 'partial',
    notes: ['mention counts unavailable for 1 document(s); presence and coverage checks skipped for them'],
  });
  file.findings.push(
    finding('f_AAAAAAAAAA', {
      severity: 'error',
      checkId: 'presence.expected',
      type: 'expected-absent',
      factGroup: 'elena|expected-present',
      message: '"Elena" is expected in "The Storm" but is never named there',
      expected: '"Elena" named in the scene',
    }),
    finding('f_BBBBBBBBBB', {
      severity: 'info',
      checkId: 'pov.coverage',
      type: 'pov-not-named',
      factGroup: 'marek|pov-coverage',
      message: 'POV "Marek" is never named in "The Storm"',
      status: 'dismissed',
      dismissedReason: 'deep POV',
    }),
    finding('f_CCCCCCCCCC', {
      severity: 'info',
      checkId: 'script.cue-collision',
      type: 'cue-unmatched',
      factGroup: 'bob|cue-unmatched',
      message: 'The cue "BOB" in "The Storm" matches no codex entry',
      status: 'fixed',
      note: 'added to the codex',
    }),
  );
  return file;
}

const docTitle = (docId: string): string => (docId === STORM ? 'The Storm' : 'a document that is no longer in the project');

function input(file: CoherenceState | undefined): CoherenceReportInput {
  return { title: 'The Lighthouse Keeper', date: '2026-10-08', file, docTitle };
}

describe('the Markdown report (the Review row of the one-source compile)', () => {
  it('summarises the file, then lists the findings by severity with their quotes and their verdicts, then the runs', () => {
    const text = coherenceReportMarkdown(input(fileWithFindings()));
    expect(text.startsWith('# Coherence report: The Lighthouse Keeper\n\nDated 2026-10-08.\n')).toBe(true);
    expect(text).toContain('- 1 open finding, 1 dismissed, 1 marked fixed.');
    expect(text).toContain('- 1 run recorded; the latest is 2026-10-08T09:00:00.000Z (partial).');
    const errors = text.indexOf('## Errors');
    const notes = text.indexOf('## Notes');
    const history = text.indexOf('## Run history');
    expect(errors).toBeGreaterThan(0);
    expect(notes).toBeGreaterThan(errors);
    expect(history).toBeGreaterThan(notes);
    expect(text).toContain('> “the gale arrived” (The Storm)');
    expect(text).toContain('Expected: "Elena" named in the scene');
    expect(text).toContain('Dismissed as: deep POV');
    expect(text).toContain('Note: added to the codex');
    expect(text).toContain('mention counts unavailable for 1 document(s)');
  });

  it('names each check and each dismissal reason in the writer’s words, and prints no check or reason id', () => {
    const file = fileWithFindings();
    const dismissed = file.findings.find((finding) => finding.id === 'f_BBBBBBBBBB');
    if (dismissed !== undefined) dismissed.dismissedReason = 'in-world-lie';
    const text = coherenceReportMarkdown(input(file));
    expect(text).toContain('Dismissed as: In-world lie');
    expect(text).toContain('· A character expected in a scene is never named there');
    expect(text).toContain('· A declared point of view is never named in its scene');
    // The run's checks are named by their labels, separated by semicolons, so each label reads whole.
    expect(text).toContain('A codex entry is never named in the manuscript; A screenplay character cue matches no codex entry');
    expect(text).not.toContain('presence.expected');
    expect(text).not.toContain('in-world-lie');
    expect(text).not.toContain('`');
  });

  it('writes one heading per fact, so two findings about one fact are one problem with two citations', () => {
    const file = fileWithFindings();
    const twin = finding('f_DDDDDDDDDD', {
      severity: 'error',
      checkId: 'presence.expected',
      type: 'expected-absent',
      factGroup: 'elena|expected-present',
      message: '"Elena" is expected in "The Storm" but is never named there',
      evidence: [{ docId: 'n_OTHER00001', quote: 'The letter.', from: 0, to: 11 }],
    });
    file.findings.push(twin);
    const text = coherenceReportMarkdown(input(file));
    const heading = '### "Elena" is expected in "The Storm" but is never named there';
    expect(text.split(heading)).toHaveLength(2);
    expect(text).toContain('(a document that is no longer in the project)');
  });

  it('names each run’s kind in the writer’s words, a quick scan or a model review, and never by its stored kind', () => {
    const file = fileWithFindings();
    file.runs.push({ ...file.runs[0]!, id: 'r_BBBBBBBBBB', kind: 'llm', checkIds: ['llm:tone'] });
    const text = coherenceReportMarkdown(input(file));
    expect(text).toContain('· Quick scan · partial · 3 findings ·');
    expect(text).toContain('· Model review · partial · 3 findings ·');
    expect(text).not.toContain('· deterministic ·');
    expect(text).not.toContain('· llm ·');
  });

  it('says a project that never ran a check has no findings, rather than printing empty sections', () => {
    const text = coherenceReportMarkdown(input(undefined));
    expect(text).toContain('No check has run on this project yet, so there are no findings to report.');
    expect(text).not.toContain('## Errors');
  });
});

describe('the JSON report (the Review row of the one-source compile)', () => {
  it('carries the findings and runs exactly as the file holds them, with the summary counts', () => {
    const file = fileWithFindings();
    const parsed = JSON.parse(coherenceReportJson(input(file))) as { summary: Record<string, number>; findings: unknown; runs: unknown };
    expect(parsed.summary).toEqual({ open: 1, dismissed: 1, fixed: 1, runs: 1 });
    expect(parsed.findings).toEqual(file.findings);
    expect(parsed.runs).toEqual(file.runs);
  });

  it('is an empty record of a project with no file, not an error', () => {
    const parsed = JSON.parse(coherenceReportJson(input(undefined))) as { summary: Record<string, number>; findings: unknown[] };
    expect(parsed.summary).toEqual({ open: 0, dismissed: 0, fixed: 0, runs: 0 });
    expect(parsed.findings).toEqual([]);
  });
});

describe('the report through the media compile (renderMedia)', () => {
  function stateWith(file: CoherenceState | undefined): ProjectState {
    const manifest = createEmptyManifest('The Lighthouse Keeper', NOW);
    const state = createProjectState(manifest);
    if (file !== undefined) state.coherence = file;
    return state;
  }

  it('writes one Markdown file named for the recipe, and one JSON file for the JSON format, whatever the selection', () => {
    const state = stateWith(fileWithFindings());
    const base = { state, includeRootIds: ['manuscript'], title: 'The Lighthouse Keeper', author: '', date: '2026-10-08', titlePage: false, base: 'Keeper', assets: new Map() };
    const md = renderMedia({ ...base, format: 'coherence-md' });
    expect(md.files).toEqual([
      expect.objectContaining({ name: 'Keeper (coherence report).md', mimeType: 'text/markdown;charset=utf-8' }),
    ]);
    expect(md.files[0]?.text).toContain('# Coherence report: The Lighthouse Keeper');
    const json = renderMedia({ ...base, format: 'coherence-json', includeRootIds: [] });
    expect(json.files).toEqual([expect.objectContaining({ name: 'Keeper (coherence report).json', mimeType: 'application/json' })]);
    expect(JSON.parse(json.files[0]?.text ?? '{}')).toMatchObject({ summary: { open: 1 } });
  });
});

describe('the Markdown report in another language (i18n.md §7.1)', () => {
  const german: CoherenceReportWords = {
    ...ENGLISH_REPORT_WORDS,
    heading: (title) => `Kohärenzbericht: ${title}`,
    summaryHeading: 'Zusammenfassung',
    severity: { error: 'Fehler', warning: 'Warnungen', info: 'Hinweise' },
    status: { open: 'Offen', dismissed: 'Verworfen', fixed: 'Als behoben markiert' },
    runHistoryHeading: 'Verlauf der Läufe',
    dismissedAs: (reason) => `Verworfen als: ${reason}`,
  };

  it('uses the supplied words for the headings, statuses and labels, and leaves the writer’s own text as written', () => {
    const text = coherenceReportMarkdown({ ...input(fileWithFindings()), words: german });
    expect(text.startsWith('# Kohärenzbericht: The Lighthouse Keeper\n')).toBe(true);
    expect(text).toContain('## Zusammenfassung');
    expect(text).toContain('## Fehler');
    expect(text).toContain('## Verlauf der Läufe');
    expect(text).toContain('- Offen');
    expect(text).toContain('Verworfen als: deep POV');
    expect(text).toContain('> “the gale arrived” (The Storm)');
  });

  it('leaves the JSON report, a machine format, unchanged by the words', () => {
    const file = fileWithFindings();
    expect(coherenceReportJson({ ...input(file), words: german })).toBe(coherenceReportJson(input(file)));
  });

  it('writes the supplied words through a media compile', () => {
    const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW));
    state.coherence = fileWithFindings();
    const base = { state, includeRootIds: ['manuscript'], title: 'The Lighthouse Keeper', author: '', date: '2026-10-08', titlePage: false, base: 'Keeper', assets: new Map() };
    const md = renderMedia({ ...base, format: 'coherence-md', reportWords: german });
    expect(md.files[0]?.text).toContain('# Kohärenzbericht: The Lighthouse Keeper');
  });
});
