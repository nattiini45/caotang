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
  type CallParams,
  type TaskItem,
  type TaskList,
} from '@caotang/harness';

import { renderRef } from '../src/i18n/render-ref.js';

/** One value for every param a phrase reads, so both the bare and the named forms are covered. */
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

describe('the task list’s English and its references', () => {
  it('renders each phrase’s reference to the English line the checklist shows', () => {
    for (const tool of TOOL_NAMES) {
      for (const params of [{}, SAMPLE]) {
        const where = `${tool} ${JSON.stringify(params)}`;
        const phrase = TASK_PHRASES[tool](params);
        expect(phrase.contentRef, where).toBeDefined();
        expect(phrase.activeFormRef, where).toBeDefined();
        expect(renderRef(phrase.contentRef!), where).toBe(phrase.content);
        expect(renderRef(phrase.activeFormRef!), where).toBe(phrase.activeForm);
      }
    }
  });

  it('renders the header reference to the header line for a step and for a waiting card', () => {
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
  });
});
