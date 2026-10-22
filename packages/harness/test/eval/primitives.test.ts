/**
 * The allowlisted bus primitives in a whole turn (agent-harness §3, "Primitives as deferred tools"): the mock-provider scenarios for
 * adding a status and using it, saving a filter, setting a goal and replacing notes. Each deferred row is reached the way the
 * scenario says, and each write goes through the card its class asks for.
 */

import { describe, expect, it } from 'vitest';

import { evaluate, type Scenario } from '../../src/agent/eval.js';
import { CHAPTER_ONE, LANDING, makeState } from '../fixtures.js';
import { mockGateway } from '../agent/gateway.js';
import { steps, transcript } from '../agent/scripts.js';

const landing = (state: ReturnType<typeof makeState>) => state.manifest.tree.find((node) => node.id === LANDING);

const scenarios: Scenario[] = [
  {
    name: 'add a status and apply it: one approved plan adds In Review and sets it on The Landing',
    category: 'multi-step',
    intent: 'Add an In Review status and put The Landing in it.',
    project: makeState,
    gateway: () =>
      mockGateway([
        transcript('Add an In Review status and put The Landing in it.', [
          steps(
            { tool: 'vocabulary.upsert', params: { kind: 'status', name: 'In Review', color: '#3fa66a' }, expect: 'the status In Review exists' },
            { tool: 'meta.set', params: { targets: [LANDING], status: 'in-review' }, expect: 'The Landing is In Review' },
          ),
        ]),
      ]),
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'plan', tools: ['vocabulary.upsert', 'meta.set'], decision: 'approved' }] },
      trace: {
        matcher: 'strict',
        calls: [
          { tool: 'vocabulary.upsert', outcome: 'ok', params: { name: 'In Review' } },
          { tool: 'meta.set', outcome: 'ok' },
        ],
      },
      reached: { 'vocabulary.upsert': 'preflight' },
      state: (state) => (landing(state)?.status === 'in-review' ? [] : [`The Landing is ${JSON.stringify(landing(state)?.status)}`]),
    },
  },
  {
    name: 'save a filter: the planner loads filter.save by a search, and it applies at once, behind no card',
    category: 'single-op',
    intent: 'Save a filter for scenes I have not finished.',
    project: makeState,
    gateway: () =>
      mockGateway([
        transcript('Save a filter for scenes I have not finished.', [
          steps({ tool: 'tool.search', params: { query: 'filter saved search' }, expect: 'the filter tool is loaded' }),
          steps({ tool: 'filter.save', params: { name: 'Unfinished', root: 'manuscript', criteria: { statusId: 'draft' } }, expect: 'a filter for drafts is saved' }),
        ]),
      ]),
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'auto', tools: ['filter.save'], decision: 'auto' }] },
      trace: {
        matcher: 'strict',
        calls: [
          { tool: 'tool.search', outcome: 'ok' },
          { tool: 'filter.save', outcome: 'ok', params: { name: 'Unfinished' } },
        ],
      },
      reached: { 'filter.save': 'search' },
      state: (state) => {
        const saved = state.manifest.filters?.[0];
        return saved?.name === 'Unfinished' && saved.criteria.statusId === 'draft' ? [] : [`the saved filters are ${JSON.stringify(state.manifest.filters)}`];
      },
    },
  },
  {
    name: 'set a goal: goal.save is preloaded for the turn, and a goal on Chapter 1 applies at once',
    category: 'single-op',
    intent: 'Set a goal of 3000 words for Chapter 1.',
    project: makeState,
    preload: ['goal.save'],
    gateway: () =>
      mockGateway([
        transcript('Set a goal of 3000 words for Chapter 1.', [
          steps({ tool: 'goal.save', params: { node: 'Chapter 1', comparator: 'at-least', target: 3000 }, expect: 'Chapter 1 has a goal of 3000 words' }),
        ]),
      ]),
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'auto', tools: ['goal.save'], decision: 'auto' }] },
      trace: { matcher: 'strict', calls: [{ tool: 'goal.save', outcome: 'ok', params: { target: 3000 } }] },
      reached: { 'goal.save': 'preload' },
      state: (state) => {
        const goal = state.manifest.goals?.[0];
        return goal?.nodeId === CHAPTER_ONE && goal.target === 3000 ? [] : [`the goals are ${JSON.stringify(state.manifest.goals)}`];
      },
    },
  },
  {
    name: 'replace notes: the planner loads notes.replace, the writer confirms the card, and the notes are replaced',
    category: 'permission',
    intent: 'Rewrite the notes of The Landing.',
    project: makeState,
    gateway: () =>
      mockGateway([
        transcript('Rewrite the notes of The Landing.', [
          steps({ tool: 'tool.search', params: { query: 'rewrite notes' }, expect: 'the notes tool is loaded' }),
          steps({ tool: 'notes.replace', params: { doc: 'The Landing', notes: 'Pacing fixed.\n\nCheck the ferry timetable.' }, expect: 'the notes of The Landing are rewritten' }),
        ]),
      ]),
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['notes.replace'], decision: 'approved' }] },
      trace: {
        matcher: 'strict',
        calls: [
          { tool: 'tool.search', outcome: 'ok' },
          { tool: 'notes.replace', outcome: 'ok' },
        ],
      },
      reached: { 'notes.replace': 'search' },
      summaryIncludes: ['replaced the notes of "The Landing"'],
      // The turn is reversed after it ran, and the notes come back to the byte (the state is read from the restored project).
      restores: true,
      state: (state) => (landing(state)?.notes === 'Fix pacing in the last three paragraphs.' ? [] : [`the restored notes are ${JSON.stringify(landing(state)?.notes)}`]),
    },
  },
  {
    name: 'replace notes: a cancelled card writes nothing',
    category: 'permission',
    intent: 'Clear the notes of The Landing.',
    project: makeState,
    gateway: () =>
      mockGateway([
        transcript('Clear the notes of The Landing.', [
          steps({ tool: 'notes.replace', params: { doc: 'The Landing', notes: '' }, expect: 'the notes are cleared' }),
        ]),
      ]),
    decisions: [{ action: 'cancel' }],
    expect: {
      status: 'cancelled',
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['notes.replace'], decision: 'cancelled' }] },
      trace: { matcher: 'strict', calls: [] },
      state: (state) => (landing(state)?.notes === 'Fix pacing in the last three paragraphs.' ? [] : ['the notes changed although the card was cancelled']),
    },
  },
];

describe('the allowlisted bus primitives in a turn', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const result = await evaluate(scenario);
      expect(result.failures).toEqual([]);
    });
  }
});
