import { expect, test } from '@playwright/test';

import { EMPTY_BUDGET_USE, headerLineOf, type AgentEvent, type PlanCardView, type PlanStepView, type StatusCard, type TurnReport } from '../../packages/harness/src/index.js';
import { DOCUMENT, resolveNode } from '../../packages/harness/src/resolve.js';
import { addDocument } from '../../packages/store/src/index.js';

import {
  STREAM_TAIL_CHARS,
  askBackOptions,
  delegationViewOf,
  documentIdFor,
  draftCheckOf,
  elapsedOf,
  newTurnView,
  phaseLabel,
  proposedByWords,
  reduceTurn,
  spendLine,
  stepMenuOf,
  type GhostView,
} from '../../apps/desktop/src/app/agent-model.js';
import { activityMarkdown } from '../../apps/desktop/src/app/activity-model.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';

/**
 * The agent panel's view of a turn: the harness's events folded in order (agent-harness §8). Each event is checked against
 * the view it should leave, and the events of another turn are checked to leave it alone.
 */

const TURN = 'sess.turn-1';

function card(id: string, status: StatusCard['status'], extra: Partial<StatusCard> = {}): StatusCard {
  return { id, turnId: TURN, callId: id, tool: 'scene.draft', risk: 'write-confirm', status, args: {}, ...extra };
}

function fold(events: readonly AgentEvent[], intent = 'Draft it.') {
  return events.reduce((turn, event) => reduceTurn(turn, event), newTurnView(TURN, intent));
}

test('a turn moves through its phases, and each status card keeps its place as it changes', () => {
  const turn = fold([
    { type: 'turn', turnId: TURN, phase: 'started' },
    { type: 'card', turnId: TURN, card: card('a', 'pending-approval') },
    { type: 'card', turnId: TURN, card: card('b', 'pending-approval', { tool: 'meta.set' }) },
    { type: 'card', turnId: TURN, card: card('a', 'running') },
    { type: 'turn', turnId: TURN, phase: 'running' },
  ]);

  expect(turn.phase).toBe('running');
  expect(turn.cards.map((entry) => [entry.id, entry.status])).toEqual([
    ['a', 'running'],
    ['b', 'pending-approval'],
  ]);
  expect(phaseLabel(turn.phase)).toBe('Applying');
});

test('a plan card is replaced by the next one, and a draft is shown as the ghost until the turn reports', () => {
  const plan = (revision: number): PlanCardView => ({
    id: `${TURN}:card`,
    turnId: TURN,
    kind: 'plan',
    revision,
    previewRevision: revision,
    from: 0,
    steps: [],
    approvable: true,
    canAcceptCut: false,
    cut: false,
  });
  const report: TurnReport = {
    turnId: TURN,
    status: 'applied',
    summary: 'Applied: drafted “The Friend” (7 words).',
    steps: [],
    cards: [],
    trace: [],
    undoGroupId: 'grp_9',
    tokens: { promptTokens: 10, completionTokens: 5, requests: 2 },
    dropped: [],
    modelCalls: 2,
    mode: 'ask',
    budgetUse: EMPTY_BUDGET_USE,
  };
  const turn = fold([
    { type: 'plan', turnId: TURN, card: plan(0) },
    { type: 'plan', turnId: TURN, card: plan(1) },
    { type: 'ghost', turnId: TURN, callId: 'c1', docTitle: 'The Friend', text: 'The ferry came in.', words: 4 },
    { type: 'checkpoint', turnId: TURN, undoGroupId: 'grp_9', label: 'restore to before this turn', mode: 'ask' },
    { type: 'report', turnId: TURN, report },
  ]);

  expect(turn.plan?.revision).toBe(1);
  expect(turn.ghost).toBeNull();
  expect(turn.checkpoint).toEqual({ undoGroupId: 'grp_9', label: 'restore to before this turn', mode: 'ask' });
  expect(turn.report?.status).toBe('applied');
});

test('a turn carries the mode it started in, whether its plan card was approved by the mode, and the mode it ended in (agent-harness §4)', () => {
  const card: PlanCardView = { id: 'p', turnId: TURN, kind: 'plan', revision: 0, previewRevision: 0, from: 0, steps: [], approvable: true, canAcceptCut: false, cut: false };
  const started = fold([{ type: 'turn', turnId: TURN, phase: 'started', mode: 'accept-edits' }]);
  expect(started.mode).toBe('accept-edits');
  expect(started.planAuto).toBe(false);
  // A phase change that names no mode keeps the one the turn has.
  expect(reduceTurn(started, { type: 'turn', turnId: TURN, phase: 'planning' }).mode).toBe('accept-edits');
  const shown = reduceTurn(started, { type: 'plan', turnId: TURN, card, auto: true });
  expect(shown.planAuto).toBe(true);
  // The next card is the writer's again unless it says otherwise.
  expect(reduceTurn(shown, { type: 'plan', turnId: TURN, card }).planAuto).toBe(false);
  const report: TurnReport = {
    turnId: TURN,
    status: 'applied',
    summary: 'Applied.',
    steps: [],
    cards: [],
    trace: [],
    tokens: { promptTokens: 0, completionTokens: 0, requests: 0 },
    dropped: [],
    modelCalls: 1,
    mode: 'ask',
    budgetUse: EMPTY_BUDGET_USE,
  };
  expect(reduceTurn(shown, { type: 'report', turnId: TURN, report }).mode).toBe('ask');
});

test('the streamed text keeps only its tail, and clears when a card or the report arrives', () => {
  const long = 'x'.repeat(STREAM_TAIL_CHARS + 50);
  const streaming = fold([
    { type: 'model.delta', turnId: TURN, delta: long },
    { type: 'model.delta', turnId: TURN, delta: 'END' },
  ]);
  expect(streaming.streamed.length).toBe(STREAM_TAIL_CHARS);
  expect(streaming.streamed.endsWith('END')).toBe(true);

  const cleared = reduceTurn(streaming, {
    type: 'plan',
    turnId: TURN,
    card: { id: 'p', turnId: TURN, kind: 'confirm', revision: 0, previewRevision: 0, from: 0, steps: [], approvable: true, canAcceptCut: false, cut: false },
  });
  expect(cleared.streamed).toBe('');
});

test('an event of another turn leaves this one exactly as it was', () => {
  const turn = fold([{ type: 'turn', turnId: TURN, phase: 'planning' }]);
  const other = reduceTurn(turn, { type: 'turn', turnId: 'other.turn-1', phase: 'done' });
  expect(other).toBe(turn);
});

test('an ask-back offers only the options that have words in them', () => {
  expect(askBackOptions({ code: 'anchor_unresolvable', reason: 'moved', options: ['re-select in editor', '  ', ''] })).toEqual([
    're-select in editor',
  ]);
});

test('the activity export is a Markdown file: the turns, then one table row per change, with views left out', () => {
  const markdown = activityMarkdown({
    title: 'The Lighthouse Keeper',
    now: Date.UTC(2026, 9, 8),
    turns: [],
    entries: [
      { at: Date.UTC(2026, 9, 8, 9), command: 'binder.create', issuedBy: 'user', source: 'native', affected: [], summary: 'created “The Friend”' },
      { at: Date.UTC(2026, 9, 8, 9, 1), command: 'view.setSelection', issuedBy: 'user', source: 'native', affected: [], summary: 'selected' },
      { at: Date.UTC(2026, 9, 8, 9, 2), command: 'doc.write', issuedBy: 'user', source: 'native', affected: [], summary: 'a | b', undoGroupId: 'grp_1' },
    ],
  });

  expect(markdown.startsWith('# Activity: The Lighthouse Keeper')).toBe(true);
  expect(markdown).toContain('| 1 | 2026-10-08T09:00:00.000Z | New item | created “The Friend” | You | Native |');
  expect(markdown).toContain('a \\| b');
  expect(markdown).not.toContain('Selection changed');
  expect(markdown).toContain('| 2 | 2026-10-08T09:02:00.000Z | Text saved |');
});

/** A project with two scenes that share a prefix, so a reference can name one of them, both, or none. */
function resolvingProject() {
  const state = sampleProjectState();
  const chapter = state.manifest.tree.find((node) => node.title === 'Chapter 2');
  if (chapter === undefined) throw new Error('the sample has no Chapter 2');
  const now = new Date(Date.UTC(2026, 9, 8));
  addDocument(state, { parentId: chapter.id, title: 'Scene A', body: '', now });
  addDocument(state, { parentId: chapter.id, title: 'Scene B', body: '', now });
  return state;
}

test('a scene reference resolves to the same document as the harness resolves it, for every form of it', () => {
  const state = resolvingProject();
  const idOf = (title: string): string => state.manifest.tree.find((node) => node.title === title)?.id ?? '';
  const refs = [
    'The Friend',
    'the friend',
    '  THE FRIEND  ',
    'the fri',
    idOf('The Friend'),
    'The',
    'Scene',
    'Scene A',
    'scene a',
    'Chapter 1',
    idOf('Chapter 1'),
    'manuscript',
    'nowhere',
    '',
    '   ',
  ];

  for (const ref of refs) {
    const harness = resolveNode(state, ref, DOCUMENT, 'document', 'params.doc');
    expect({ ref, id: documentIdFor(state.manifest.tree, ref) }).toEqual({ ref, id: harness.ok ? harness.value.id : null });
  }
  // The forms that must resolve, and the ones that must name no scene, so the parity above is not vacuous.
  expect(documentIdFor(state.manifest.tree, 'the friend')).toBe(idOf('The Friend'));
  expect(documentIdFor(state.manifest.tree, 'Scene')).toBeNull();
  expect(documentIdFor(state.manifest.tree, 'Chapter 1')).toBeNull();
});

/** A step of a card, as the loop shows it: a scene draft, or any other step. */
function stepOf(index: number, tool: string, params: Record<string, unknown>, status: PlanStepView['status'] = 'ready'): PlanStepView {
  return { index, origin: index, tool, expect: 'it happens', risk: 'write-confirm', params, status, badges: [], stale: false, cut: false };
}

function cardOf(steps: readonly PlanStepView[]): PlanCardView {
  return { id: `${TURN}:card`, turnId: TURN, kind: 'plan', revision: 0, previewRevision: 0, from: 0, steps, approvable: true, canAcceptCut: false, cut: false };
}

function draftOf(docTitle: string, callId: string, docId: string | null): GhostView {
  return { callId, docTitle, docId, text: `Prose for ${docTitle}.`, words: 3, cut: false };
}

test('a drafted scene can be approved only once its draft has been on screen, and the card says which draft is still unseen', () => {
  const card = cardOf([stepOf(0, 'scene.draft', { doc: 'The Friend' })]);
  const friend = draftOf('The Friend', 'c1', 'doc_friend');
  const check = (previewed: boolean, onScreen: boolean) =>
    draftCheckOf({
      card,
      ghosts: [friend],
      sceneOf: (ref) => (ref === 'The Friend' ? { docId: 'doc_friend', title: 'The Friend' } : null),
      onScreen: () => onScreen,
      previewed: () => previewed,
    });

  const unseen = check(false, false);
  expect(unseen.blocked).toBe('Open “The Friend” to read the draft for step 1 before you approve it.');
  expect(unseen.steps[0]).toMatchObject({ docId: 'doc_friend', onScreen: false, previewed: false });
  expect(check(true, false).blocked).toBeNull();
  expect(check(true, true).steps[0]).toMatchObject({ onScreen: true, previewed: true });
});

test('a screenplay scene’s draft counts as previewed where the card shows it, because no prose editor can show it', () => {
  const card = cardOf([stepOf(0, 'scene.draft', { doc: 'The Lamp' })]);
  const lamp = draftOf('The Lamp', 'c1', 'doc_lamp');
  const check = (kind: string | undefined) =>
    draftCheckOf({
      card,
      ghosts: [lamp],
      sceneOf: (ref) => (ref === 'The Lamp' ? { docId: 'doc_lamp', title: 'The Lamp', ...(kind === undefined ? {} : { kind }) } : null),
      onScreen: () => false,
      previewed: () => false,
    });

  // The screenplay draft is not on screen in an editor, yet the card holds it, so the card can be approved.
  const screenplay = check('screenplay');
  expect(screenplay.blocked).toBeNull();
  expect(screenplay.steps[0]).toMatchObject({ docId: 'doc_lamp', onScreen: false, previewed: true });

  // A prose scene that is not on screen still has to be opened, because its ghost is the preview (agent-harness §8).
  expect(check('prose').blocked).toBe('Open “The Lamp” to read the draft for step 1 before you approve it.');
  expect(check(undefined).blocked).toBe('Open “The Lamp” to read the draft for step 1 before you approve it.');
});

test('a draft that names no scene, or that has no draft, holds the card, and a step the card already refuses does not', () => {
  const unknown = draftCheckOf({
    card: cardOf([stepOf(0, 'scene.draft', { doc: 'Nowhere Town' })]),
    ghosts: [draftOf('Nowhere Town', 'c1', null)],
    sceneOf: () => null,
    onScreen: () => false,
    previewed: () => false,
  });
  expect(unknown.blocked).toContain('“Nowhere Town”, which is not a scene in this project');

  const missing = draftCheckOf({
    card: cardOf([stepOf(0, 'scene.draft', { doc: 'The Friend' })]),
    ghosts: [],
    sceneOf: () => ({ docId: 'doc_friend', title: 'The Friend' }),
    onScreen: () => true,
    previewed: () => true,
  });
  expect(missing.blocked).toContain('has no draft to show yet');

  const refused = draftCheckOf({
    card: cardOf([stepOf(0, 'scene.draft', { doc: 'The Friend' }, 'refused')]),
    ghosts: [],
    sceneOf: () => ({ docId: 'doc_friend', title: 'The Friend' }),
    onScreen: () => false,
    previewed: () => false,
  });
  expect(refused.blocked).toBeNull();
});

test('two drafts of one scene hold the card, and a step that has run is not checked at all', () => {
  const twice = draftCheckOf({
    card: cardOf([stepOf(0, 'scene.draft', { doc: 'The Friend' }), stepOf(1, 'scene.draft', { doc: 'the friend' })]),
    ghosts: [draftOf('The Friend', 'c1', 'doc_friend'), draftOf('the friend', 'c2', 'doc_friend')],
    sceneOf: () => ({ docId: 'doc_friend', title: 'The Friend' }),
    onScreen: () => true,
    previewed: () => true,
  });
  expect(twice.blocked).toBe('Steps 1 and 2 both draft “The Friend”. Drop one of them.');

  const ran = draftCheckOf({
    card: cardOf([stepOf(0, 'scene.draft', { doc: 'The Friend' }, 'done')]),
    ghosts: [],
    sceneOf: () => ({ docId: 'doc_friend', title: 'The Friend' }),
    onScreen: () => false,
    previewed: () => false,
  });
  expect(ran.steps).toEqual([]);
  expect(ran.blocked).toBeNull();
});

test('each showing of a plan card is a new plan event, so a card the loop shows again is read afresh', () => {
  const card = cardOf([stepOf(0, 'synopsis.fill', { docs: ['The Storm'] })]);
  const turn = [0, 1, 2].reduce(
    (view, revision) => reduceTurn(view, { type: 'plan', turnId: TURN, card: { ...card, revision } }),
    newTurnView(TURN, 'Fill it.', 'Demo (no key)'),
  );

  expect(turn.planSeq).toBe(3);
  expect(turn.provider).toBe('Demo (no key)');
  expect(newTurnView(TURN, 'Fill it.').provider).toBeNull();
});

test('the task list is folded with the turn, shows documents by their titles, and ignores the events of another turn', () => {
  const draft = stepOf(0, 'scene.draft', { doc: 'doc_landing' });
  const titles = new Map([['doc_landing', 'The Landing']]);
  const nameOf = (ref: string): string => titles.get(ref) ?? ref;
  const events: AgentEvent[] = [
    { type: 'turn', turnId: TURN, phase: 'started' },
    { type: 'turn', turnId: TURN, phase: 'planning' },
    { type: 'model.call', turnId: TURN, used: 1, limit: 8 },
    { type: 'card', turnId: TURN, card: card(`${TURN}:p1.0`, 'pending-approval', { args: { doc: 'doc_landing' } }) },
    { type: 'plan', turnId: TURN, card: cardOf([draft]) },
    { type: 'turn', turnId: TURN, phase: 'awaiting-approval' },
  ];
  const turn = events.reduce((view, event) => reduceTurn(view, event, nameOf), newTurnView(TURN, 'Draft it.'));

  expect(turn.tasks.items.map((item) => [item.content, item.state])).toEqual([
    ['Plan', 'done'],
    ['Draft “The Landing”', 'waiting'],
  ]);
  expect(turn.tasks.modelCalls).toEqual({ used: 1, limit: 8 });
  expect(headerLineOf(turn.tasks)).toBe('Waiting for you · Plan, 1 step');

  const other = reduceTurn(turn, { type: 'turn', turnId: 'sess.turn-2', phase: 'running' }, nameOf);
  expect(other).toBe(turn);
  expect(other.tasks).toBe(turn.tasks);
});

test('a delegated agent’s call shows its agent, its reserved calls, how it stands in words, and its own rows, as its card is updated in place', () => {
  const id = `${TURN}:r1`;
  const path = `${TURN}/reader#1`;
  const args = { agent: 'reader', brief: 'Who knows the lamp failed?', scope: ['The Storm'] };
  const running = card(id, 'running', {
    tool: 'agent.delegate',
    risk: 'read',
    args,
    startedAt: 10,
    delegation: { agent: 'reader', agentPath: path, reserved: 3, outcome: 'running', trace: [] },
  });
  const read = { tool: 'doc.read', callId: `${path}:r1`, outcome: 'ok' as const, params: { doc: 'The Storm' }, agentPath: path };
  const refused = { tool: 'agent.delegate', callId: `${path}:r2`, outcome: 'refused' as const, params: {}, agentPath: path };
  const staged = { tool: 'codex.write', callId: `${path}:r3`, outcome: 'not-run' as const, params: {}, agentPath: path };
  const done = card(id, 'done', {
    tool: 'agent.delegate',
    risk: 'read',
    args,
    startedAt: 10,
    finishedAt: 4_010,
    summary: 'The reader agent read 1 document.',
    delegation: { agent: 'reader', agentPath: path, reserved: 3, outcome: 'done', result: 'Only the keeper knows.', proposed: 2, trace: [read, refused, staged] },
  });

  const turn = fold([
    { type: 'card', turnId: TURN, card: running },
    { type: 'card', turnId: TURN, card: done },
  ]);
  // One card, replaced in place: the call keeps its place and carries the agent's latest view.
  expect(turn.cards).toHaveLength(1);
  const live = delegationViewOf(running);
  expect(live).toMatchObject({ title: 'Reader agent', reserved: '3 model calls reserved', standing: 'Working', brief: 'Who knows the lamp failed?', scope: ['The Storm'], trace: [] });
  expect(live?.result).toBeUndefined();

  const finished = delegationViewOf(turn.cards[0] as StatusCard);
  expect(finished?.standing).toBe('Finished');
  expect(finished?.result).toBe('Only the keeper knows.');
  // The state is in words, and a proposal says plainly that it has not run.
  expect(finished?.proposed).toBe('2 steps proposed. None has run: a step only runs if it is in a plan you approve.');
  expect(finished?.trace.map((row) => row.text)).toEqual(['Read “The Storm” — done', 'Hand work to a helper agent — refused', 'Write codex entries — proposed, not run']);
  expect(new Set(finished?.trace.map((row) => row.key)).size).toBe(3);
  expect(elapsedOf(turn.cards[0] as StatusCard, 99_999)).toBe(4_000);
});

test('an agent that ended early or failed says so, one call is not “calls”, and an ordinary call has no delegation view', () => {
  const base = { agent: 'general' as const, agentPath: `${TURN}/general#1`, reserved: 1, trace: [] };
  const withOutcome = (outcome: 'partial' | 'failed') => card('x', 'done', { tool: 'agent.delegate', args: {}, delegation: { ...base, outcome } });
  expect(delegationViewOf(withOutcome('partial'))?.standing).toBe('Stopped before it finished');
  expect(delegationViewOf(withOutcome('failed'))?.standing).toBe('Failed');
  expect(delegationViewOf(withOutcome('partial'))?.reserved).toBe('1 model call reserved');
  expect(delegationViewOf(withOutcome('partial'))?.proposed).toBeUndefined();
  expect(delegationViewOf(card('y', 'done'))).toBeUndefined();
});

test('a plan step names the agent that proposed it, and a step without one says nothing', () => {
  const proposed = { ...stepOf(0, 'codex.write', {}), proposedBy: 'general' };
  expect(proposedByWords(proposed)).toBe('Proposed by the general agent');
  expect(proposedByWords(stepOf(1, 'codex.write', {}))).toBeUndefined();
});

test('a budget event is the turn’s run, and its spend line reads against the limits the writer set', () => {
  const turn = newTurnView(TURN, 'Tag the storm.');
  expect(turn.run).toBeNull();
  expect(spendLine(turn.run)).toBeUndefined();
  const spend = { modelCalls: 2, promptTokens: 3_000, completionTokens: 120, estimatedTokens: 0, steps: 1, activeMs: 83_000 };
  const after = reduceTurn(turn, { type: 'budget', turnId: TURN, spend, limits: { maxTokens: 50_000, maxActiveMs: 600_000 } });
  expect(after.run).toEqual({ spend, limits: { maxTokens: 50_000, maxActiveMs: 600_000 } });
  expect(spendLine(after.run)).toBe('3,120 of 50,000 tokens · 1:23 of 10:00 worked');
  // A cost figure and a step limit join the line when they are set; without limits the figures stand alone.
  const priced = { ...spend, costUsd: 0.0123 };
  expect(spendLine({ spend: priced, limits: { maxCostUsd: 0.5, maxSteps: 4 } })).toBe('3,120 tokens · $0.0123 of $0.5000 · 1 of 4 steps · 1:23 worked');
  // Another turn's spend is not this turn's.
  expect(reduceTurn(turn, { type: 'budget', turnId: 'other.turn-9', spend, limits: {} })).toBe(turn);
});

test('a step of a finished turn gets a rewind menu when its restore would take something back, and an outside tool’s step says its effects stay', () => {
  expect(stepMenuOf({ tool: 'meta.set', status: 'done' }, true)).toEqual({ show: true });
  expect(stepMenuOf({ tool: 'doc.read', status: 'done' }, false)).toEqual({ show: false });
  const external = stepMenuOf({ tool: 'mcp__s_STORYB0002__write_note', status: 'done' }, false);
  expect(external.show).toBe(true);
  expect(external.note).toContain('External side effects are not reversible');
  // A call that did not finish made no external change to speak of.
  expect(stepMenuOf({ tool: 'mcp__s_STORYB0002__write_note', status: 'failed' }, false)).toEqual({ show: false });
  // The note rides with the restorable menu of an outside step that also registered a Caotang change.
  expect(stepMenuOf({ tool: 'mcp__s_STORYB0002__write_note', status: 'done' }, true).show).toBe(true);
});
