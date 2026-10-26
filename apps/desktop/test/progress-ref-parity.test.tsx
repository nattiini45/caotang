/**
 * The task list's English lines and their references cannot drift (i18n.md §6.1; I7). Each phrase's
 * reference, rendered with its own values, is exactly the English the checklist and header show;
 * the permission hints are instead single-sourced beside their references in
 * `packages/bus/src/permission.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  TASK_PHRASES,
  TOOL_NAMES,
  emptyTaskList,
  headerLineOf,
  headerRefOf,
  reduceTaskList,
  type AgentEvent,
  type CallParams,
  type StatusState,
  type TaskItem,
  type TaskList,
} from '@caotang/harness';

import { renderRef } from '../src/i18n/render-ref.js';

/**
 * Every shape a phrase can branch on, not just one named and one bare form:
 * - `targets` of two reaches `meta.set`'s many form; a one-element non-string array reaches its
 *   plural `one` branch (the string case is the `one` sentence of its own).
 * - `docs` of two reaches `synopsis.fill`'s many form; a one-element non-string array reaches its
 *   plural `one` branch.
 * - `ops` of one and `entries` of one reach the plural `one` branches; the SAMPLE two reach `other`.
 * - `kind` without `name` reaches `vocabulary.upsert`'s kind form, with and without a non-default kind.
 */
const SAMPLE: CallParams = {
  doc: 'The Landing',
  docs: ['The Landing'],
  title: 'The Landing',
  query: 'Mara',
  name: 'Mara',
  node: 'The Landing',
  targets: ['Mara'],
  ops: [{}, {}],
  format: 'epub',
  entries: [{}, {}],
  agent: 'researcher',
  kind: 'status',
};

const SHAPES: readonly CallParams[] = [
  {},
  SAMPLE,
  { targets: ['Mara', 'The Landing'] },
  { targets: [{}] },
  { docs: ['A', 'B'] },
  { docs: [{}] },
  { ops: [{}] },
  { entries: [{}] },
  { kind: 'label' },
  { name: 'Mara', kind: 'label' },
];

function expectPair(where: string, ref: TaskItem['contentRef'] | TaskItem['activeFormRef'], english: string): void {
  expect(ref, where).toBeDefined();
  expect(renderRef(ref!), where).toBe(english);
}

function expectItem(list: TaskList, key: string, content: string, activeForm: string): void {
  const item = list.items.find((candidate) => candidate.key === key);
  expect(item, key).toBeDefined();
  expect(item?.content, key).toBe(content);
  expect(item?.activeForm, key).toBe(activeForm);
  expectPair(`${key}: content`, item?.contentRef, content);
  expectPair(`${key}: active form`, item?.activeFormRef, activeForm);
}

describe('the task list’s English and its references', () => {
  it('renders every phrase’s reference to its English line for every branch shape', () => {
    for (const tool of TOOL_NAMES) {
      for (const params of SHAPES) {
        const where = `${tool} ${JSON.stringify(params)}`;
        const phrase = TASK_PHRASES[tool](params);
        expectPair(`${where}: content`, phrase.contentRef, phrase.content);
        expectPair(`${where}: active form`, phrase.activeFormRef, phrase.activeForm);
      }
    }
  });

  it('renders the planner row’s reference to its English in all three states', () => {
    const planning = reduceTaskList(emptyTaskList('t1'), { type: 'turn', turnId: 't1', phase: 'planning' });
    expectItem(planning, 'plan', 'Plan', 'Planning');

    const retrying = reduceTaskList({ ...planning, phase: 'retrying' }, { type: 'turn', turnId: 't1', phase: 'retrying' });
    expectItem(retrying, 'plan', 'Plan', 'Trying again');

    const drafting = reduceTaskList(
      { ...retrying, phase: 'planning' },
      { type: 'draft.delta', turnId: 't1', docTitle: 'The Landing', delta: '', start: true },
    );
    expectItem(drafting, 'plan', 'Plan', 'Drafting “The Landing”');
  });

  it('renders a reads item’s reference to its English for one read and for several', () => {
    const card = (id: string, status: StatusState): AgentEvent => ({
      type: 'card',
      turnId: 't1',
      card: { id, turnId: 't1', callId: id, tool: 'doc.read', risk: 'read', status, args: {} },
    });
    const one = reduceTaskList(emptyTaskList('t1'), card('t1:r1', 'running'));
    expectItem(one, 'reads:0', 'Read the project', 'Reading the project');

    const many = reduceTaskList(one, card('t1:r2', 'running'));
    expectItem(many, 'reads:0', 'Read the project (2 reads)', 'Reading the project (2 reads)');
  });

  it('renders the header reference to the header line for a step, a waiting card and both plan counts', () => {
    const items: readonly TaskItem[] = [
      { key: 'plan', content: 'Plan', activeForm: 'Planning', state: 'done' },
      { key: '0:1', content: 'Draft “The Landing”', activeForm: 'Drafting “The Landing”', state: 'in_progress' },
    ];
    const running: TaskList = { ...emptyTaskList('t1'), phase: 'running', items };
    expect(renderRef(headerRefOf(running)!)).toBe(headerLineOf(running));

    const waiting: TaskList = {
      ...emptyTaskList('t2'),
      phase: 'awaiting-approval',
      track: {
        ...emptyTaskList('t2').track,
        awaiting: { kind: 'confirm', steps: 1, content: 'Draft “The Landing”' },
      },
    };
    expect(renderRef(headerRefOf(waiting)!)).toBe(headerLineOf(waiting));

    for (const steps of [1, 3]) {
      const plan: TaskList = {
        ...emptyTaskList(`t${String(steps)}`),
        phase: 'awaiting-approval',
        track: {
          ...emptyTaskList(`t${String(steps)}`).track,
          awaiting: { kind: 'plan', steps, content: 'Plan' },
        },
      };
      expect(renderRef(headerRefOf(plan)!)).toBe(headerLineOf(plan));
    }
  });
});
