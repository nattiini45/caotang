/**
 * The checklist of a turn (agent-harness §8): the steps it has run and has still to run, one in progress at a time, with the
 * count of model calls it has made against its bound. It is derived from the turn's events, so it cannot claim work that did not
 * run. Open while the turn runs, folded when it settles, and kept in the turn's block as its record.
 */

import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import type { ReactNode } from 'react';
import { budgetLevelOf, type TaskItem, type TaskList, type TaskState } from '@caotang/harness';

import { renderRef, WRITER_VALUE_KEYS } from '../i18n/render-ref.js';

/* lingui-set comment="Interpolated values: done, limit, total, used" */

function itemText(item: TaskItem): string {
  return item.contentRef === undefined ? item.content : renderRef(item.contentRef, { userValues: WRITER_VALUE_KEYS });
}

/** The state in words, so it does not rest on colour or the glyph alone (WCAG 1.4.1). */
const STATE_WORDS = {
  pending: msg`Queued`,
  waiting: msg`Waiting for you`,
  in_progress: msg`In progress`,
  done: msg`Done`,
  skipped: msg`Skipped`,
  failed: msg`Failed`,
} satisfies Readonly<Record<TaskState, MessageDescriptor>>;

const STATE_GLYPHS: Readonly<Record<TaskState, string>> = {
  pending: '○',
  waiting: '◔',
  in_progress: '▶',
  done: '✓',
  skipped: '–',
  failed: '✕',
};

/** Whether the turn has anything to list beyond the planner row. A turn that only answers shows no checklist. */
export function hasTasks(list: TaskList): boolean {
  return list.items.some((item) => item.key !== 'plan');
}

export function TaskChecklist({ list, settled }: { list: TaskList; settled: boolean }): ReactNode {
  if (!hasTasks(list)) return null;
  const steps = list.items.filter((item) => item.state !== 'skipped');
  const done = steps.filter((item) => item.state === 'done').length;
  const level = budgetLevelOf(list.modelCalls);
  const { used, limit } = list.modelCalls;
  const total = steps.length;
  const calls =
    level === 'near'
      ? t`Model calls: ${{ used }} of ${{ limit }} · one call left`
      : level === 'limit'
        ? t`Model calls: ${{ used }} of ${{ limit }} · limit reached`
        : t`Model calls: ${{ used }} of ${{ limit }}`;
  return (
    <div className="agent-tasks" data-testid="agent-tasks">
      {/* Open while the turn runs and folded once it settles. The attribute follows `settled` and nothing else, so the writer's own toggle holds. */}
      <details open={!settled}>
        <summary>{t`Task list · ${{ done }} of ${{ total }} done`}</summary>
        <ol className="task-list" aria-label={t`Task list`}>
          {list.items.map((item) => (
            <li key={item.key} className={`task-item is-${item.state}`} data-state={item.state} data-key={item.key}>
              <span className="task-glyph" aria-hidden="true">
                {STATE_GLYPHS[item.state]}
              </span>
              <span className="task-content">{itemText(item)}</span>
              <span className="task-state">{i18n._(STATE_WORDS[item.state])}</span>
              {item.reason !== undefined ? <span className="task-reason">{item.reason}</span> : null}
            </li>
          ))}
        </ol>
      </details>
      {used > 0 ? (
        <p className={`task-calls is-${level}`} data-level={level}>
          <span>{calls}</span>
        </p>
      ) : null}
    </div>
  );
}
