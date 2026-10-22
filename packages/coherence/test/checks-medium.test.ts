/**
 * `medium.speaker-parity` (coherence.md §5.1): a screenplay scene and the dialogue container the writer paired it with name
 * the same speakers. Each case is a positive or a negative fixture (§10); the scope rules are the branch checks' own.
 */

import type { CodexEntry, ProjectState } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import {
  assembleInput,
  dismissFinding,
  emptyCoherenceFile,
  runChecks,
  runDeterministic,
  setFindingStatusForAgent,
  type CoherenceFile,
  type DialogueFacts,
  type DialogueSpeaker,
  type SceneMeta,
} from '../src/index.js';

import { LATER, NOW, buildState, detect, entry } from './fixtures.js';

const CHECK = ['medium.speaker-parity'] as const;
const SCENE = 'sHall';
const COURT = 'dCourt';
const MARISOL = 'c_MARISOL01';
const VEGA = 'c_VEGA000001';
const BEN = 'c_BEN0000001';

const HALL = 'INT. HALL - DAY\n\nMARISOL\nThe door is open.\n';

/** A screenplay scene, marked with the screenplay kind the way the binder marks one. */
function stateOf(body: string, entries: readonly CodexEntry[], kind: string | null = 'screenplay'): ProjectState {
  const state = buildState({ scenes: [{ id: SCENE, title: 'The hall', body }], entries });
  const node = state.manifest.tree.find((candidate) => candidate.id === SCENE);
  if (node !== undefined && kind !== null) Object.assign(node, { kind });
  return state;
}

function factsOf(speakers: Record<string, readonly DialogueSpeaker[]>): DialogueFacts {
  return { findings: [], containerIds: Object.keys(speakers), speakersByContainer: new Map(Object.entries(speakers)) };
}

function fileLinking(container: string | null = COURT): CoherenceFile {
  const meta: SceneMeta = container === null ? {} : { dialogueContainer: container };
  return { ...emptyCoherenceFile(), sceneMeta: { [SCENE]: meta } };
}

function scan(state: ProjectState, file: CoherenceFile, dialogue: DialogueFacts | undefined) {
  const { input } = assembleInput(state, file, { detector: detect, ...(dialogue === undefined ? {} : { dialogue }) });
  return runChecks(input, CHECK);
}

describe('medium.speaker-parity (coherence.md §5.1)', () => {
  it('raises nothing when the scene and the linked container name the same character', () => {
    const state = stateOf(HALL, [entry(MARISOL, 'Marisol')]);
    const out = scan(state, fileLinking(), factsOf({ [COURT]: [{ name: 'Marisol', entryId: MARISOL }] }));
    expect(out.drafts).toEqual([]);
    expect(out.notes).toEqual(['speaker parity: 1 scene(s) linked, 0 scene(s) have no dialogue container link; they are not compared']);
  });

  it('treats two spellings of one codex character as the same character', () => {
    const state = stateOf('INT. HALL - DAY\n\nMARI\nThe door is open.\n', [entry(MARISOL, 'Marisol', { aliases: ['Mari'] })]);
    const out = scan(state, fileLinking(), factsOf({ [COURT]: [{ name: 'Marisol', entryId: MARISOL }] }));
    expect(out.drafts).toEqual([]);
  });

  it('treats the same unknown spelling on both sides as agreement; the cue and speaker checks own that gap', () => {
    const state = stateOf(HALL, []);
    expect(scan(state, fileLinking(), factsOf({ [COURT]: [{ name: 'Marisol' }] })).drafts).toEqual([]);
  });

  it('raises an info finding naming both media and both spellings when the codex knows only the screenplay spelling', () => {
    const state = stateOf(HALL, [entry(MARISOL, 'Marisol')]);
    const out = scan(state, fileLinking(), factsOf({ [COURT]: [{ name: 'Marisol Vega' }] }));
    expect(out.drafts).toHaveLength(1);
    const [finding] = out.drafts;
    expect(finding).toMatchObject({ checkId: 'medium.speaker-parity', type: 'speaker-differs', severity: 'info' });
    expect(finding?.message).toBe(
      `The screenplay scene "The hall" cues "MARISOL", but its linked dialogue says "Marisol Vega"; the codex knows only the screenplay's spelling. Only speakers are compared, not lines or meaning.`,
    );
    expect(finding?.evidence.map((passage) => [passage.docId, passage.quote])).toEqual([[SCENE, 'MARISOL']]);
  });

  it('raises the same finding when the codex knows only the dialogue spelling', () => {
    const state = stateOf(HALL, [entry(VEGA, 'Marisol Vega')]);
    const out = scan(state, fileLinking(), factsOf({ [COURT]: [{ name: 'Marisol Vega', entryId: VEGA }] }));
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]?.message).toContain("the codex knows only the dialogue's spelling");
  });

  it('raises a finding when the two spellings resolve to two different codex characters', () => {
    const state = stateOf(HALL, [entry(MARISOL, 'Marisol'), entry(VEGA, 'Marisol Vega')]);
    const out = scan(state, fileLinking(), factsOf({ [COURT]: [{ name: 'Marisol Vega', entryId: VEGA }] }));
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]).toMatchObject({ type: 'speaker-differs', severity: 'info' });
    expect(out.drafts[0]?.message).toContain('the codex has them as two characters, "Marisol" and "Marisol Vega"');
  });

  it('raises nothing for a scene with no declared container link, and the run note counts it as not compared', () => {
    const state = stateOf(HALL, [entry(MARISOL, 'Marisol')]);
    const out = scan(state, fileLinking(null), factsOf({ [COURT]: [{ name: 'Marisol Vega' }, { name: 'Ben' }] }));
    expect(out.drafts).toEqual([]);
    expect(out.notes).toEqual(['speaker parity: 0 scene(s) linked, 1 scene(s) have no dialogue container link; they are not compared']);
  });

  it('never compares a container no scene points at', () => {
    const state = stateOf(HALL, [entry(MARISOL, 'Marisol')]);
    const out = scan(state, fileLinking('dElsewhere'), factsOf({ dOrphan: [{ name: 'Ben' }], [COURT]: [{ name: 'Marisol', entryId: MARISOL }] }));
    expect(out.drafts).toEqual([]);
    expect(out.notes[0]).toContain('0 scene(s) linked, 0 scene(s) have no dialogue container link');
  });

  it('treats a link to a container the run did not read as not compared, and the note counts it', () => {
    const state = stateOf(HALL, [entry(MARISOL, 'Marisol')]);
    const out = scan(state, fileLinking('dArchived'), factsOf({ [COURT]: [{ name: 'Ben' }] }));
    expect(out.drafts).toEqual([]);
    expect(out.notes).toEqual([
      'speaker parity: 0 scene(s) linked, 0 scene(s) have no dialogue container link; they are not compared (1 link(s) name a dialogue container that is missing, archived or not read, or sit on a scene that is not a screenplay)',
    ]);
  });

  it('does not compare a scene that is not a screenplay, even when it is linked', () => {
    const state = stateOf('Marisol opened the door.', [entry(MARISOL, 'Marisol')], null);
    const out = scan(state, fileLinking(), factsOf({ [COURT]: [{ name: 'Ben' }] }));
    expect(out.drafts).toEqual([]);
    expect(out.notes[0]).toContain('1 link(s) name a dialogue container');
  });

  it('raises an info finding for a container character the scene does not cue', () => {
    const state = stateOf(HALL, [entry(MARISOL, 'Marisol'), entry(BEN, 'Ben')]);
    const out = scan(
      state,
      fileLinking(),
      factsOf({ [COURT]: [{ name: 'Marisol', entryId: MARISOL }, { name: 'Ben', entryId: BEN }] }),
    );
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]).toMatchObject({ type: 'speaker-dialogue-only', severity: 'info', factGroup: `${SCENE}|${COURT}|dialogue-only:${BEN}`.toLowerCase() });
    expect(out.drafts[0]?.message).toBe(
      'The dialogue linked to the screenplay scene "The hall" has a speaker "Ben" that the scene does not cue. Only speakers are compared, not lines or meaning.',
    );
  });

  it('raises an info finding for a scene character the container does not name', () => {
    const state = stateOf(`${HALL}\nBEN\nWait.\n`, [entry(MARISOL, 'Marisol'), entry(BEN, 'Ben')]);
    const out = scan(state, fileLinking(), factsOf({ [COURT]: [{ name: 'Marisol', entryId: MARISOL }] }));
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]).toMatchObject({ type: 'speaker-screenplay-only', severity: 'info' });
    expect(out.drafts[0]?.message).toContain('cues "BEN", but its linked dialogue has no speaker by that name');
    expect(out.drafts[0]?.evidence.map((passage) => passage.quote)).toEqual(['BEN']);
  });

  it('pairs nothing when a name could belong to two others, and reports each on its own side', () => {
    const state = stateOf('INT. HALL - DAY\n\nANN\nHi.\n', []);
    const out = scan(state, fileLinking(), factsOf({ [COURT]: [{ name: 'Ann Lee' }, { name: 'Ann Ray' }] }));
    expect(out.drafts.map((draft) => draft.type).sort()).toEqual(['speaker-dialogue-only', 'speaker-dialogue-only', 'speaker-screenplay-only']);
  });

  it('is skipped with a note when the app supplied no dialogue speakers', () => {
    const state = stateOf(HALL, [entry(MARISOL, 'Marisol')]);
    for (const dialogue of [undefined, { findings: [], containerIds: [COURT] }]) {
      const out = scan(state, fileLinking(), dialogue);
      expect(out.drafts).toEqual([]);
      expect(out.notes).toEqual(['speaker parity not evaluated: the dialogue speakers were not supplied for this run']);
    }
  });
});

describe('medium.speaker-parity in a scan', () => {
  const dialogue = factsOf({ [COURT]: [{ name: 'Marisol', entryId: MARISOL }, { name: 'Ben', entryId: BEN }] });
  const entries = [entry(MARISOL, 'Marisol'), entry(BEN, 'Ben')];
  const scanFull = (state: ProjectState, file: CoherenceFile, now = NOW) =>
    runDeterministic(state, file, { scope: { mode: 'full' }, now, detector: detect, dialogue });

  it('keeps a dismissal when the text around the cue changes, because the group is the character and not the position', () => {
    const found = scanFull(stateOf(HALL, entries), fileLinking());
    const card = found.file.findings.find((finding) => finding.checkId === 'medium.speaker-parity');
    if (card === undefined) throw new Error('fixture: the scan raised no parity finding');
    expect(found.run.checkIds).toContain('medium.speaker-parity');
    const dismissed = dismissFinding(found.file, card.id, { reason: 'intentional' }, NOW);

    const edited = stateOf(`INT. HALL - DAY\n\nRain on the glass for a long while.\n\nMARISOL\nThe door is open.\n`, entries);
    const again = scanFull(edited, dismissed, LATER);
    expect(again.file.findings.find((finding) => finding.id === card.id)).toMatchObject({ status: 'dismissed' });
    expect(again.file.findings.filter((finding) => finding.status === 'open' && finding.checkId === 'medium.speaker-parity')).toEqual([]);
  });

  it('clears a finding once the speakers agree, and runs only on a full scan', () => {
    const found = scanFull(stateOf(HALL, entries), fileLinking());
    expect(found.file.findings.filter((finding) => finding.checkId === 'medium.speaker-parity' && finding.status === 'open')).toHaveLength(1);

    const partial = runDeterministic(stateOf(HALL, entries), found.file, { scope: { mode: 'doc', docIds: [SCENE] }, now: LATER, detector: detect, dialogue });
    expect(partial.run.checkIds).not.toContain('medium.speaker-parity');
    expect(partial.run.notes).toContain('speaker parity not run: it runs on a full scan');
    expect(partial.file.findings.filter((finding) => finding.checkId === 'medium.speaker-parity' && finding.status === 'open')).toHaveLength(1);

    const agreed = stateOf(`${HALL}\nBEN\nWait.\n`, entries);
    const cleared = scanFull(agreed, found.file, LATER);
    expect(cleared.file.findings.filter((finding) => finding.checkId === 'medium.speaker-parity' && finding.status === 'open')).toEqual([]);
    expect(cleared.run.notes).toContain('speaker parity: 1 scene(s) linked, 0 scene(s) have no dialogue container link; they are not compared');
  });

  it('lets the agent mark a finding fixed only when the speakers now agree, and cannot verify without them', () => {
    const state = stateOf(HALL, entries);
    const found = scanFull(state, fileLinking());
    const card = found.file.findings.find((finding) => finding.checkId === 'medium.speaker-parity');
    if (card === undefined) throw new Error('fixture: the scan raised no parity finding');
    const request = { findingId: card.id, status: 'fixed' };

    const still = setFindingStatusForAgent(state, found.file, request, { now: LATER, detector: detect, dialogue });
    expect(!still.ok && still.refusal).toBe('evidence-still-present');
    const blind = setFindingStatusForAgent(state, found.file, request, { now: LATER, detector: detect });
    expect(!blind.ok && blind.refusal).toBe('cannot-verify');

    const agreed = stateOf(`${HALL}
BEN
Wait.
`, entries);
    const fixed = setFindingStatusForAgent(agreed, found.file, request, { now: LATER, detector: detect, dialogue });
    expect(fixed.ok).toBe(true);
  });

  it('leaves the open findings alone when a full scan was given no dialogue speakers', () => {
    const found = scanFull(stateOf(HALL, entries), fileLinking());
    const blind = runDeterministic(stateOf(HALL, entries), found.file, { scope: { mode: 'full' }, now: LATER, detector: detect });
    expect(blind.run.checkIds).not.toContain('medium.speaker-parity');
    expect(blind.run.notes).toContain('speaker parity not run: the dialogue speakers were not read for this run');
    expect(blind.file.findings.filter((finding) => finding.checkId === 'medium.speaker-parity' && finding.status === 'open')).toHaveLength(1);
  });
});
