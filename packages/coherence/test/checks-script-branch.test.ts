/**
 * The screenplay, storyboard and dialogue checks (screenplay.md §4, storyboard.md §5, dialogue-narrative.md §5), each with
 * a positive and a negative fixture (coherence.md §10), and the scope rules the branch checks run under.
 */

import { describe, expect, it } from 'vitest';

import {
  assembleInput,
  dismissFinding,
  emptyCoherenceFile,
  runChecks,
  runDeterministic,
  type CoherenceFile,
  type DialogueFacts,
  type DraftFinding,
} from '../src/index.js';
import { compileCodex, countMentions, type DocumentTerm } from '@caotang/codex';
import type { CodexEntry, ProjectState } from '@caotang/store';

import { LATER, NOW, addShot, buildState, detect, entry, type Anchor } from './fixtures.js';

const SCRIPT = 'sScript';
const ALICE = 'c_ALICE00001';
const BOB = 'c_BOB0000001';

/** A screenplay document: the node is marked with the screenplay kind, which is how the parse is chosen (screenplay.md §2.1). */
function screenplayState(
  docs: readonly { readonly id: string; readonly body: string; readonly kind?: string }[],
  entries = [entry(ALICE, 'Alice')],
): ProjectState {
  const state = buildState({
    scenes: docs.map((doc) => ({ id: doc.id, title: doc.id, body: doc.body })),
    entries,
  });
  for (const doc of docs) {
    const node = state.manifest.tree.find((candidate) => candidate.id === doc.id);
    if (node !== undefined && doc.kind !== undefined) Object.assign(node, { kind: doc.kind });
    else if (node !== undefined) Object.assign(node, { kind: 'screenplay' });
  }
  return state;
}

function anchorOver(body: string, needle: string): Anchor {
  const from = body.indexOf(needle);
  if (from < 0) throw new Error(`fixture: "${needle}" is not in the body`);
  return { from, to: from + needle.length, exact: needle, prefix: '', suffix: '', capturedRevision: 1 };
}

/** The anchor a shot captures for a passage: the exact text, with up to 32 characters of context either side (edit-anchors §2). */
function capturedOver(body: string, passage: string): Anchor {
  const from = body.indexOf(passage);
  if (from < 0) throw new Error(`fixture: "${passage}" is not in the body`);
  const to = from + passage.length;
  return { from, to, exact: passage, prefix: body.slice(Math.max(0, from - 32), from), suffix: body.slice(to, to + 32), capturedRevision: 1 };
}

function run(state: ProjectState, file: CoherenceFile, ids: Parameters<typeof runChecks>[1]) {
  const { input } = assembleInput(state, file, { detector: detect });
  return runChecks(input, ids);
}

function scriptFindings(drafts: readonly DraftFinding[]): DraftFinding[] {
  return drafts.filter((draft) => draft.checkId.startsWith('script.'));
}

const CUE_BODY = 'INT. HALL - DAY\n\nBOB\nWhere were you?\n';

describe('script.cue-collision (screenplay.md §4)', () => {
  it('flags a character cue that names no codex entry, quoting the cue at its own offsets', () => {
    const state = screenplayState([{ id: SCRIPT, body: CUE_BODY }]);
    const out = run(state, emptyCoherenceFile(), ['script.cue-collision']);
    expect(out.drafts).toHaveLength(1);
    const [finding] = out.drafts;
    expect(finding).toMatchObject({ checkId: 'script.cue-collision', type: 'cue-unmatched', severity: 'info', factGroup: 'bob|cue-unmatched' });
    expect(finding?.evidence).toEqual([{ docId: SCRIPT, quote: 'BOB', from: CUE_BODY.indexOf('BOB'), to: CUE_BODY.indexOf('BOB') + 3 }]);
    expect(finding?.message).toBe('The cue "BOB" in "sScript" matches no codex entry');
  });

  it('is silent when a codex entry holds the cue as a term', () => {
    const state = screenplayState([{ id: SCRIPT, body: CUE_BODY }], [entry(BOB, 'Bob')]);
    expect(run(state, emptyCoherenceFile(), ['script.cue-collision']).drafts).toEqual([]);
  });

  it('matches a cue to an entry when punctuation and case differ, so MR SMITH answers to Mr. Smith', () => {
    const state = screenplayState([{ id: SCRIPT, body: 'INT. HALL - DAY\n\nMR SMITH\nHello.\n' }], [entry('c_SMITH00001', 'Mr. Smith')]);
    expect(run(state, emptyCoherenceFile(), ['script.cue-collision']).drafts).toEqual([]);
  });

  it('reads only screenplay documents, so a prose document with a cue-shaped line is not a finding', () => {
    const state = screenplayState([{ id: SCRIPT, body: CUE_BODY, kind: 'prose' }]);
    expect(run(state, emptyCoherenceFile(), ['script.cue-collision']).drafts).toEqual([]);
  });
});

describe('script.cue-consistency (screenplay.md §4)', () => {
  it('warns when one character is cued in two spellings, naming both, once for each scene that cues the character', () => {
    const state = screenplayState([
      { id: 'sOne', body: 'INT. HALL - DAY\n\nBOB\nHi.\n' },
      { id: 'sTwo', body: 'INT. YARD - DAY\n\n@Bob\nHey.\n' },
    ]);
    const out = run(state, emptyCoherenceFile(), ['script.cue-consistency']);
    expect(out.drafts).toHaveLength(2);
    for (const draft of out.drafts) {
      expect(draft).toMatchObject({ checkId: 'script.cue-consistency', type: 'cue-spelling', severity: 'warning', factGroup: 'bob|cue-spelling' });
      expect(draft.message).toContain('"BOB" and "Bob"');
    }
    expect(out.drafts.map((draft) => draft.evidence[0]?.docId).sort()).toEqual(['sOne', 'sTwo']);
  });

  it('tells each scene only the spelling it uses, so a scene that cues one spelling is not said to use both', () => {
    const state = screenplayState([
      { id: 'sOne', body: 'INT. HALL - DAY\n\nBOB\nHi.\n' },
      { id: 'sTwo', body: 'INT. YARD - DAY\n\n@Bob\nHey.\n' },
    ]);
    const messages = new Map(
      run(state, emptyCoherenceFile(), ['script.cue-consistency']).drafts.map((draft): [string | undefined, string] => [draft.evidence[0]?.docId, draft.message]),
    );
    expect(messages.get('sOne')).toBe('"BOB" and "Bob" are cued as one character; "sOne" cues "BOB"');
    expect(messages.get('sTwo')).toBe('"BOB" and "Bob" are cued as one character; "sTwo" cues "Bob"');
    expect(messages.get('sOne')).not.toContain('more than one');
  });

  it('is silent when every cue of the character uses one spelling', () => {
    const state = screenplayState([
      { id: 'sOne', body: 'INT. HALL - DAY\n\nBOB\nHi.\n' },
      { id: 'sTwo', body: 'INT. YARD - DAY\n\nBOB\nHey.\n' },
    ]);
    expect(run(state, emptyCoherenceFile(), ['script.cue-consistency']).drafts).toEqual([]);
  });
});

describe('script.shot-coverage (storyboard.md §5)', () => {
  it('reports an uncovered cue, an uncovered line of dialogue and a shot with no duration, when a shot exists and covers nothing', () => {
    const state = screenplayState([{ id: SCRIPT, body: CUE_BODY }], [entry(ALICE, 'Alice')]);
    addShot(state, 'shotA', {});
    const drafts = scriptFindings(run(state, emptyCoherenceFile(), ['script.shot-coverage']).drafts);
    const uncovered = drafts.filter((draft) => draft.type === 'uncovered');
    expect(uncovered.map((draft) => draft.message)).toEqual([
      'The cue at this point in "sScript" is covered by no shot',
      'The line of dialogue at this point in "sScript" is covered by no shot',
    ]);
    expect(drafts.filter((draft) => draft.type === 'duration-missing')).toEqual([
      expect.objectContaining({ checkId: 'script.shot-coverage', severity: 'info', factGroup: 'shota|duration-missing', evidence: [] }),
    ]);
  });

  it('is silent when a shot covers the cue and its dialogue and declares a duration', () => {
    const state = screenplayState([{ id: SCRIPT, body: CUE_BODY }], [entry(ALICE, 'Alice')]);
    const cover = { from: CUE_BODY.indexOf('BOB'), to: CUE_BODY.length - 1, exact: 'BOB\nWhere were you?', prefix: '', suffix: '', capturedRevision: 1 };
    addShot(state, 'shotA', { durationSec: 4, dialogue: [{ docId: SCRIPT, anchor: cover }] });
    expect(scriptFindings(run(state, emptyCoherenceFile(), ['script.shot-coverage']).drafts)).toEqual([]);
  });

  it('is silent about coverage when the project has no shot at all, since a manuscript with no storyboard is not a gap', () => {
    const state = screenplayState([{ id: SCRIPT, body: CUE_BODY }], [entry(ALICE, 'Alice')]);
    expect(scriptFindings(run(state, emptyCoherenceFile(), ['script.shot-coverage']).drafts)).toEqual([]);
  });

  it('reports an anchor whose text no longer resolves in its scene as drift, and leaves a matching anchor alone', () => {
    const body = CUE_BODY;
    const stale = { from: 0, to: 5, exact: 'WRONG', prefix: '', suffix: '', capturedRevision: 1 };
    const state = screenplayState([{ id: SCRIPT, body }], [entry(ALICE, 'Alice')]);
    addShot(state, 'shotDrift', { durationSec: 2, dialogue: [{ docId: SCRIPT, anchor: stale }] });
    addShot(state, 'shotFine', { durationSec: 2, dialogue: [{ docId: SCRIPT, anchor: anchorOver(body, 'BOB') }] });
    const drift = scriptFindings(run(state, emptyCoherenceFile(), ['script.shot-coverage']).drafts).filter((d) => d.type === 'anchor-drift');
    expect(drift).toEqual([
      expect.objectContaining({ checkId: 'script.shot-coverage', severity: 'info', factGroup: 'shotdrift|anchor-drift|wrong' }),
    ]);
    expect(drift[0]?.message).toBe('A dialogue anchor of "Shot shotDrift" no longer matches the text of "sScript"');
  });

  it('keeps a covered line covered when a line is typed directly above it, so ordinary editing reports nothing', () => {
    const cover = capturedOver(CUE_BODY, 'BOB\nWhere were you?');
    const state = screenplayState([{ id: SCRIPT, body: 'INT. HALL - DAY\n\nNew line.\nBOB\nWhere were you?\n' }], [entry(ALICE, 'Alice')]);
    addShot(state, 'shotA', { durationSec: 4, dialogue: [{ docId: SCRIPT, anchor: cover }] });
    expect(scriptFindings(run(state, emptyCoherenceFile(), ['script.shot-coverage']).drafts)).toEqual([]);
  });

  it('reports drift, and no line, when the covered text itself is deleted', () => {
    const cover = capturedOver(CUE_BODY, 'BOB\nWhere were you?');
    const state = screenplayState([{ id: SCRIPT, body: 'INT. HALL - DAY\n\n' }], [entry(ALICE, 'Alice')]);
    addShot(state, 'shotA', { durationSec: 4, dialogue: [{ docId: SCRIPT, anchor: cover }] });
    const drafts = scriptFindings(run(state, emptyCoherenceFile(), ['script.shot-coverage']).drafts);
    expect(drafts.map((draft) => draft.type)).toEqual(['anchor-drift']);
  });

  it('keeps a covered line covered when only its case has changed, since the search that finds moved text ignores case', () => {
    const cover = capturedOver(CUE_BODY, 'BOB\nWhere were you?');
    const state = screenplayState([{ id: SCRIPT, body: 'INT. HALL - DAY\n\nNew line.\nBOB\nWHERE WERE YOU?\n' }], [entry(ALICE, 'Alice')]);
    addShot(state, 'shotA', { durationSec: 4, dialogue: [{ docId: SCRIPT, anchor: cover }] });
    expect(scriptFindings(run(state, emptyCoherenceFile(), ['script.shot-coverage']).drafts)).toEqual([]);
  });

  it('keeps a covered line covered in a CRLF scene, whose offsets the parse reads one character shorter per line', () => {
    const crlf = `INT. HALL - DAY\r\n${'\r\n'.repeat(20)}BOB\r\nWhere were you?\r\n`;
    const cover = capturedOver(crlf, 'BOB\r\nWhere were you?');
    const state = screenplayState([{ id: SCRIPT, body: crlf }], [entry(ALICE, 'Alice')]);
    addShot(state, 'shotA', { durationSec: 4, dialogue: [{ docId: SCRIPT, anchor: cover }] });
    expect(scriptFindings(run(state, emptyCoherenceFile(), ['script.shot-coverage']).drafts)).toEqual([]);
  });
});

describe('script.shot-coverage findings keep their identity across edits (coherence.md §6.1)', () => {
  it('a dismissed uncovered cue stays dismissed when text is typed earlier in the scene, and no open card replaces it', () => {
    const first = screenplayState([{ id: SCRIPT, body: CUE_BODY }], [entry(ALICE, 'Alice')]);
    addShot(first, 'shotA', { durationSec: 4 });
    const found = runDeterministic(first, emptyCoherenceFile(), { scope: { mode: 'full' }, now: NOW, detector: detect });
    const cueCard = found.file.findings.find(
      (finding) => finding.checkId === 'script.shot-coverage' && finding.message.startsWith('The cue at this point'),
    );
    if (cueCard === undefined) throw new Error('fixture: the scan made no uncovered cue card');
    const dismissed = dismissFinding(found.file, cueCard.id, { reason: 'intentional' }, NOW);

    const edited = screenplayState([{ id: SCRIPT, body: 'INT. HALL - DAY\n\nRain on the glass.\n\nBOB\nWhere were you?\n' }], [entry(ALICE, 'Alice')]);
    addShot(edited, 'shotA', { durationSec: 4 });
    const again = runDeterministic(edited, dismissed, { scope: { mode: 'full' }, now: LATER, detector: detect });

    expect(again.file.findings.find((finding) => finding.id === cueCard.id)).toMatchObject({ status: 'dismissed' });
    expect(again.file.findings.filter((finding) => finding.status === 'open' && finding.message.startsWith('The cue at this point'))).toEqual([]);
    expect(again.file.findings.filter((finding) => finding.status === 'open' && finding.message.startsWith('The line of dialogue'))).toHaveLength(1);
  });

  it('an anchor-drift card stays dismissed when an earlier anchor of the same shot is removed, so its position does not matter', () => {
    const gone = { from: 0, to: 4, exact: 'GONE', prefix: '', suffix: '', capturedRevision: 1 };
    const kept = { from: 0, to: 5, exact: 'WRONG', prefix: '', suffix: '', capturedRevision: 1 };
    const first = screenplayState([{ id: SCRIPT, body: CUE_BODY }], [entry(ALICE, 'Alice')]);
    addShot(first, 'shotX', { durationSec: 2, dialogue: [{ docId: SCRIPT, anchor: gone }, { docId: SCRIPT, anchor: kept }] });
    const found = runDeterministic(first, emptyCoherenceFile(), { scope: { mode: 'full' }, now: NOW, detector: detect });
    const keptCard = found.file.findings.find((finding) => finding.factGroup === 'shotx|anchor-drift|wrong');
    if (keptCard === undefined) throw new Error('fixture: the scan made no drift card for the second anchor');
    const dismissed = dismissFinding(found.file, keptCard.id, { reason: 'intentional' }, NOW);

    const reordered = screenplayState([{ id: SCRIPT, body: CUE_BODY }], [entry(ALICE, 'Alice')]);
    addShot(reordered, 'shotX', { durationSec: 2, dialogue: [{ docId: SCRIPT, anchor: kept }] });
    const again = runDeterministic(reordered, dismissed, { scope: { mode: 'full' }, now: LATER, detector: detect });

    expect(again.file.findings.find((finding) => finding.id === keptCard.id)).toMatchObject({ status: 'dismissed' });
    expect(again.file.findings.filter((finding) => finding.status === 'open' && finding.checkId === 'script.shot-coverage' && finding.type === 'anchor-drift')).toEqual([]);
  });
});

describe('dialogue branch checks (dialogue-narrative.md §5)', () => {
  const CONTAINER = 'dCourt';
  const facts: DialogueFacts = {
    containerIds: [CONTAINER],
    findings: [
      {
        checkId: 'branch.loose-end',
        type: 'loose-end',
        severity: 'warning',
        factGroup: 'court_hall|loose-end',
        evidence: [{ docId: CONTAINER, quote: 'the flow runs', from: 4, to: 17 }],
        message: 'The flow in court_hall runs out at line 3.',
      },
      {
        checkId: 'dialogue.speaker-unknown',
        type: 'speaker-unknown',
        severity: 'info',
        factGroup: 'zed|speaker-unknown',
        evidence: [{ docId: CONTAINER, quote: 'Zed: hi', from: 0, to: 7 }],
        message: '"Zed" is not a codex entry.',
      },
    ],
  };

  it('takes the branch findings the dialogue module computed into a full scan, in the inbox, with their group keys', () => {
    const state = screenplayState([{ id: SCRIPT, body: CUE_BODY }], [entry(ALICE, 'Alice')]);
    const result = runDeterministic(state, emptyCoherenceFile(), { scope: { mode: 'full' }, now: NOW, detector: detect, dialogue: facts });
    const branch = result.file.findings.filter((finding) => finding.checkId.startsWith('branch.') || finding.checkId.startsWith('dialogue.'));
    expect(branch.map((finding) => [finding.checkId, finding.factGroup]).sort()).toEqual([
      ['branch.loose-end', 'court_hall|loose-end'],
      ['dialogue.speaker-unknown', 'zed|speaker-unknown'],
    ]);
    expect(result.run.checkIds).toEqual(expect.arrayContaining(['branch.loose-end', 'branch.dead-end', 'dialogue.speaker-unknown']));
  });

  it('does not run on a document scope, and says so in the run report, so the open branch findings are left alone', () => {
    const state = screenplayState([{ id: SCRIPT, body: CUE_BODY }], [entry(ALICE, 'Alice')]);
    const result = runDeterministic(state, emptyCoherenceFile(), { scope: { mode: 'doc', docIds: [SCRIPT] }, now: NOW, detector: detect, dialogue: facts });
    expect(result.file.findings.some((finding) => finding.checkId.startsWith('branch.'))).toBe(false);
    expect(result.run.notes).toContain('dialogue checks not run: they run on a full scan');
    expect(result.run.checkIds.some((id) => id.startsWith('branch.'))).toBe(false);
  });

  it('keeps the open branch findings of an earlier scan when a later full scan has no dialogue facts to read', () => {
    const state = screenplayState([{ id: SCRIPT, body: CUE_BODY }], [entry(ALICE, 'Alice')]);
    const first = runDeterministic(state, emptyCoherenceFile(), { scope: { mode: 'full' }, now: NOW, detector: detect, dialogue: facts });
    const second = runDeterministic(state, first.file, { scope: { mode: 'full' }, now: NOW, detector: detect });
    expect(second.file.findings.filter((finding) => finding.checkId.startsWith('branch.'))).toHaveLength(1);
    expect(second.run.notes).toContain('dialogue checks not run: the dialogue containers were not read for this run');
  });
});

describe('screenplay cues as mentions (screenplay.md §4)', () => {
  it('counts a cue as a mention of the entry it names, so an expected character who speaks is present', () => {
    const body = 'INT. HALL - DAY\n\nMR SMITH\nHello.\n';
    const expected = entry('c_SMITH00001', 'Mr. Smith');
    const state = screenplayState([{ id: SCRIPT, body }], [expected]);
    const sceneMeta = { [SCRIPT]: { expectedPresent: [expected.id] } };
    const file: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta };
    // The detector counts the cue's spelling with the body (codex cueTermsOf), as the app's detector does.
    const counted = (text: string, entries: readonly CodexEntry[], terms?: readonly DocumentTerm[]) => countMentions(text, compileCodex(entries), terms);
    const { input } = assembleInput(state, file, { detector: counted });
    expect(runChecks(input, ['presence.expected']).drafts).toEqual([]);
  });
});
