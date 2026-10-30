import { expect, test } from '@playwright/test';
import { emptyCoherenceFile, type CoherenceFile, type Finding } from '../../packages/coherence/src/index.js';

import {
  dismissalLabelOf,
  dismissalReasons,
  docTitleOf,
  fixPlanFor,
  nextOpenFindingId,
  openFindingCount,
  povCandidates,
  afterCandidates,
  dialogueContainerChoices,
  dayLabel,
  inheritedStoryPart,
  STORY_PART_CHOICES,
  modeLabel,
  sceneMetaOf,
  severitySections,
} from '../../apps/desktop/src/app/findings-model.js';
import { addDocument, type CodexEntry, type ProjectState } from '../../packages/store/src/index.js';
import { IDS, project } from './fixtures.js';

const NOW = '2026-10-08T09:00:00.000Z';

function finding(overrides: Partial<Finding> & Pick<Finding, 'id' | 'severity' | 'status'>): Finding {
  return {
    runId: 'r_AAAAAAAAAA',
    class: 'deterministic',
    checkId: 'codex.never-mentioned',
    type: 'never-mentioned',
    factGroup: `g|${overrides.id}`,
    evidence: [],
    message: `Finding ${overrides.id}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fileWith(findings: Finding[], sceneMeta: CoherenceFile['sceneMeta'] = {}): CoherenceFile {
  return { ...emptyCoherenceFile(), findings, sceneMeta };
}

test.describe('the findings tab model (coherence.md §6.3, §8)', () => {
  const quoted = finding({
    id: 'f_QUOTE00001',
    severity: 'error',
    status: 'open',
    evidence: [{ docId: IDS.sceneA, quote: 'the lamp went out', from: 4, to: 20 }],
  });
  const noted = finding({ id: 'f_NOTE000001', severity: 'info', status: 'open' });
  const dismissed = finding({ id: 'f_DISMISS001', severity: 'warning', status: 'dismissed', dismissedReason: 'intentional' });
  const gone = finding({ id: 'f_GONE000001', severity: 'warning', status: 'open', evidence: [{ docId: 'n_MISSING000', quote: 'x', from: 0, to: 1 }] });

  test('open findings are grouped by severity, most severe first, and a status filter narrows them', () => {
    const state = project();
    const file = fileWith([noted, dismissed, quoted, gone]);

    const open = severitySections(state, file, 'open');
    expect(open.map((section) => section.label)).toEqual(['Errors', 'Warnings', 'Notes']);
    expect(open.map((section) => section.findings.map((view) => view.id))).toEqual([['f_QUOTE00001'], ['f_GONE000001'], ['f_NOTE000001']]);

    expect(severitySections(state, file, 'dismissed').flatMap((section) => section.findings.map((view) => view.id))).toEqual(['f_DISMISS001']);
    expect(severitySections(state, file, 'all').flatMap((section) => section.findings).length).toBe(4);
    expect(severitySections(state, undefined, 'all')).toEqual([]);
  });

  test('a quoted passage names its document, and a passage in a document that is gone says so', () => {
    const state = project();
    const open = severitySections(state, fileWith([quoted, gone]), 'open');
    const [errors, warnings] = open;
    expect(errors?.findings[0]?.quotes[0]).toEqual({
      docId: IDS.sceneA,
      docTitle: 'Scene A',
      quote: 'the lamp went out',
      from: 4,
      to: 20,
    });
    expect(warnings?.findings[0]?.quotes[0]?.docTitle).toBe('a document that is no longer in the project');
    expect(docTitleOf(state, IDS.sceneB)).toBe('Scene B');
  });

  test('the badge counts open findings only', () => {
    expect(openFindingCount(fileWith([quoted, dismissed, noted]))).toBe(2);
    expect(openFindingCount(undefined)).toBe(0);
  });

  test('the dismissal picker offers the five reasons, and only the technique reasons cross-link to a mode', () => {
    const reasons = dismissalReasons();
    expect(reasons.map((reason) => reason.id)).toEqual(['flashback', 'in-world-lie', 'unreliable-narrator', 'intentional', 'false-positive']);
    expect(reasons.find((reason) => reason.id === 'in-world-lie')?.tooltip).toBe('In-story deception between characters.');
    expect(reasons.find((reason) => reason.id === 'unreliable-narrator')?.tooltip).toBe('Narration-level deception.');
    expect(reasons.find((reason) => reason.id === 'intentional')?.tooltip).toBeUndefined();
    expect(reasons.filter((reason) => reason.crossLink !== undefined).map((reason) => reason.id)).toEqual([
      'flashback',
      'in-world-lie',
      'unreliable-narrator',
    ]);
    expect(reasons[0]?.crossLink).toBe('Declare this as a scene mode instead.');
  });

  test('a dismissal reason is shown by its picker label, and a reason the picker does not hold as it was written', () => {
    expect(dismissalLabelOf('in-world-lie')).toBe('In-world lie');
    expect(dismissalLabelOf('false-positive')).toBe('False positive');
    expect(dismissalLabelOf('deep POV')).toBe('deep POV');
  });

  test('after a dismissal focus goes to the next open finding in the order the tab shows, else the one before it, else to none', () => {
    const state = project();
    // Open, in the tab's order: the quoted error, the warning, then the note.
    const sections = severitySections(state, fileWith([quoted, gone, noted]), 'open');
    expect(nextOpenFindingId(sections, 'f_QUOTE00001')).toBe('f_GONE000001');
    expect(nextOpenFindingId(sections, 'f_NOTE000001')).toBe('f_GONE000001');
    expect(nextOpenFindingId(severitySections(state, fileWith([noted]), 'open'), 'f_NOTE000001')).toBeUndefined();
  });
});

test.describe('Fix with agent is offered where the agent drafts a scene (coherence.md §6.3)', () => {
  const DIALOGUE = 'n_DIALOG0001';
  const SCREENPLAY = 'n_SCRIPT0001';

  /** The sample project, with a dialogue container and a screenplay scene in its first chapter. */
  function withDialogueAndScreenplay(): ProjectState {
    const state = project();
    const now = new Date(NOW);
    addDocument(state, { parentId: IDS.chapterOne, title: 'Harbour talk', id: DIALOGUE, type: 'dialogue', body: '=== harbour ===\nMara: Hi.\n-> END', now });
    addDocument(state, { parentId: IDS.chapterOne, title: 'The Lamp', id: SCREENPLAY, kind: 'screenplay', body: 'INT. LIGHTHOUSE - NIGHT', now });
    return state;
  }

  const onProse = finding({ id: 'f_SCENE00001', severity: 'error', status: 'open', evidence: [{ docId: IDS.sceneA, quote: 'Four little', from: 0, to: 11 }] });
  const onDialogue = finding({ id: 'f_DIALOG0001', severity: 'error', status: 'open', evidence: [{ docId: DIALOGUE, quote: 'Mara: Hi.', from: 13, to: 22 }] });
  const onScreenplay = finding({ id: 'f_SCRIPT0001', severity: 'error', status: 'open', evidence: [{ docId: SCREENPLAY, quote: 'INT. LIGHTHOUSE', from: 0, to: 15 }] });

  test('a prose or screenplay passage can be fixed, and a dialogue passage is not offered a fix, with its reason in words', () => {
    const state = withDialogueAndScreenplay();
    const file = fileWith([onProse, onDialogue, onScreenplay]);

    const views = severitySections(state, file, 'open').flatMap((section) => section.findings);
    expect(Object.fromEntries(views.map((view) => [view.id, view.fixable]))).toEqual({
      f_SCENE00001: true,
      f_DIALOG0001: false,
      f_SCRIPT0001: true,
    });

    const plan = fixPlanFor(state, file, 'f_SCENE00001');
    expect(typeof plan).toBe('object');
    if (typeof plan === 'string') return;
    expect(plan.plan.steps[0]).toMatchObject({ tool: 'scene.draft', params: { doc: IDS.sceneA, mode: 'rewrite_selection' } });

    // Planning a fix for a dialogue passage is refused before any turn starts, in words that name no id and no command.
    const refused = fixPlanFor(state, file, 'f_DIALOG0001');
    expect(refused).toBe('Fix with agent drafts prose and screenplay scenes, not dialogue. Edit this passage in the dialogue’s Ink text.');
    expect(String(refused)).not.toMatch(/n_[A-Z0-9]{6,}|scene\.draft/);
  });

  test('the fix rewrites the quote first in binder order, whatever order the finding lists its quotes in', () => {
    // The sample's binder: Scene A, then Scene B, before Scene D. The finding lists Scene B first, and the fix still takes Scene A.
    const state = project();
    const across = finding({
      id: 'f_SPLIT00001',
      severity: 'error',
      status: 'open',
      evidence: [
        { docId: IDS.sceneB, quote: 'Two words', from: 0, to: 9 },
        { docId: IDS.sceneA, quote: 'Four little', from: 0, to: 11 },
      ],
    });
    const acrossFile = fileWith([across]);
    expect(severitySections(state, acrossFile, 'open').flatMap((section) => section.findings)[0]?.fixable).toBe(true);
    expect(fixPlanFor(state, acrossFile, 'f_SPLIT00001')).toMatchObject({ plan: { steps: [{ params: { doc: IDS.sceneA } }] } });

    // Within one document, the quote earlier in the text is the primary one.
    const within = finding({
      id: 'f_SPLIT00002',
      severity: 'error',
      status: 'open',
      evidence: [
        { docId: IDS.sceneA, quote: 'words here', from: 12, to: 22 },
        { docId: IDS.sceneA, quote: 'Four little', from: 0, to: 11 },
      ],
    });
    const plan = fixPlanFor(state, fileWith([within]), 'f_SPLIT00002');
    expect(typeof plan).toBe('object');
    if (typeof plan === 'string') return;
    expect(plan.plan.steps[0]?.params['selection']).toMatchObject({ exact: 'Four little' });
  });

  test('a dialogue container ranks by its binder position, so a finding whose first quote is dialogue offers no fix', () => {
    // The dialogue container sits at the end of Chapter 1, so it comes before Scene D in Chapter 2 and after Scene A in Chapter 1.
    const state = withDialogueAndScreenplay();
    const dialogueFirst = finding({
      id: 'f_MIXED00001',
      severity: 'error',
      status: 'open',
      evidence: [
        { docId: IDS.sceneD, quote: 'Scene D', from: 0, to: 7 },
        { docId: DIALOGUE, quote: 'Mara: Hi.', from: 13, to: 22 },
      ],
    });
    const proseFirst = finding({
      id: 'f_MIXED00002',
      severity: 'error',
      status: 'open',
      evidence: [
        { docId: DIALOGUE, quote: 'Mara: Hi.', from: 13, to: 22 },
        { docId: IDS.sceneA, quote: 'Four little', from: 0, to: 11 },
      ],
    });
    const file = fileWith([dialogueFirst, proseFirst]);

    const views = severitySections(state, file, 'open').flatMap((section) => section.findings);
    expect(Object.fromEntries(views.map((view) => [view.id, view.fixable]))).toEqual({ f_MIXED00001: false, f_MIXED00002: true });
    expect(fixPlanFor(state, file, 'f_MIXED00001')).toBe('Fix with agent drafts prose and screenplay scenes, not dialogue. Edit this passage in the dialogue’s Ink text.');
    expect(fixPlanFor(state, file, 'f_MIXED00002')).toMatchObject({ plan: { steps: [{ params: { doc: IDS.sceneA } }] } });
  });

  test('a passage in a node the agent does not draft gets no scene.draft plan, so the plan check and the Fix button agree', () => {
    // The button is gated on `fixable`, which is the same predicate fixPlanFor now refuses on. A folder is not a scene the agent drafts.
    const state = withDialogueAndScreenplay();
    const onFolder = finding({ id: 'f_FOLDER0001', severity: 'error', status: 'open', evidence: [{ docId: IDS.chapterOne, quote: 'Chapter', from: 0, to: 7 }] });
    const file = fileWith([onFolder]);

    const views = severitySections(state, file, 'open').flatMap((section) => section.findings);
    expect(views.find((view) => view.id === 'f_FOLDER0001')?.fixable).toBe(false);
    expect(fixPlanFor(state, file, 'f_FOLDER0001')).toBe('Fix with agent drafts prose and screenplay scenes. Edit this passage by hand.');
  });
});

test.describe('the scene declarations model (coherence.md §5.2, §8)', () => {
  const ada: CodexEntry = {
    id: 'c_ADAAAAAAAA',
    name: 'Ada',
    aliases: [],
    type: 'character',
    description: 'A keeper.',
    includePolicy: 'detected',
    attachments: [],
    keywords: [],
    origin: 'manual',
    caseSensitive: false,
    exclude: [],
    sources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const abbey: CodexEntry = { ...ada, id: 'c_ABBEYAAAAA', name: 'Abbey', type: 'location' };
  const zed: CodexEntry = { ...ada, id: 'c_ZEDAAAAAAA', name: 'Zed' };

  test('a scene with no declarations reads as empty, and a declared one reads back as declared', () => {
    const file = fileWith([], { [IDS.sceneA]: { dayOffset: 3, timelineMode: 'flashback' } });
    expect(sceneMetaOf(file, IDS.sceneA)).toEqual({ dayOffset: 3, timelineMode: 'flashback' });
    expect(sceneMetaOf(file, IDS.sceneB)).toEqual({});
    expect(sceneMetaOf(undefined, IDS.sceneB)).toEqual({});
  });

  test('a point of view is offered characters first, then the rest by name', () => {
    expect(povCandidates([abbey, zed, ada]).map((entry) => entry.name)).toEqual(['Ada', 'Zed', 'Abbey']);
  });

  test('a scene may only follow another document, never itself and never a folder', () => {
    const after = afterCandidates(project(), IDS.sceneA).map((candidate) => candidate.title);
    expect(after).not.toContain('Scene A');
    expect(after).toEqual(expect.arrayContaining(['Scene B', 'Scene D']));
    expect(after).not.toContain('Chapter 1');
  });

  test('a scene may be compared with a dialogue container a scan reads, and a link to any other is missing', () => {
    const state = project();
    for (const [id, status, parentId] of [['d_COURT00001', null, 'manuscript'], ['d_OLD0000001', 'archived', 'manuscript'], ['d_NOTE000001', null, 'research']] as const) {
      addDocument(state, { parentId, title: `Dialogue ${id}`, id, body: 'Zed: hi', now: new Date(NOW) });
      const node = state.manifest.tree.find((candidate) => candidate.id === id);
      if (node !== undefined) Object.assign(node, { type: 'dialogue', status });
    }
    expect(dialogueContainerChoices(state, undefined)).toEqual({ containers: [{ id: 'd_COURT00001', title: 'Dialogue d_COURT00001' }], missing: false });
    expect(dialogueContainerChoices(state, 'd_COURT00001').missing).toBe(false);
    expect(dialogueContainerChoices(state, 'd_OLD0000001').missing).toBe(true);
    expect(dialogueContainerChoices(state, 'd_NOTE000001').missing).toBe(true);
    expect(dialogueContainerChoices(state, 'n_GONE000000').missing).toBe(true);
  });

  test('a story part is inherited from the nearest folder that declares one, and a day before day 0 reads with a minus sign (§5.2.2)', () => {
    const state = project();
    const file: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta: { [IDS.chapterOne]: { storyPart: 'epilogue' }, [IDS.deep]: { storyPart: 'prologue' } } };
    expect(inheritedStoryPart(state, file, IDS.sceneA)).toEqual({ part: 'epilogue', folderTitle: 'Chapter 1' });
    expect(inheritedStoryPart(state, file, IDS.deepScene)).toEqual({ part: 'prologue', folderTitle: 'Deep' });
    expect(inheritedStoryPart(state, file, IDS.deep)).toEqual({ part: 'epilogue', folderTitle: 'Chapter 1' });
    expect(inheritedStoryPart(state, file, IDS.sceneD)).toBeUndefined();
    expect(inheritedStoryPart(state, undefined, IDS.sceneA)).toBeUndefined();
    expect(STORY_PART_CHOICES.map((choice) => choice.label)).toEqual(['Main story', 'Prologue', 'Epilogue']);
    expect(dayLabel(-14)).toBe('Day \u221214');
    expect(dayLabel(0)).toBe('Day 0');
    expect(dayLabel(12)).toBe('Day 12');
  });

  test('timeline modes read in words, and linear is the default', () => {
    expect(modeLabel(undefined)).toBe('Linear (the default)');
    expect(modeLabel('linear')).toBe('Linear (the default)');
    expect(modeLabel('flash-forward')).toBe('Flash forward');
  });
});
