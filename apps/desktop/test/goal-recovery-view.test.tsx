import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { AgentController, GoalRecoveryView } from '../src/app/agent.js';
import { GoalRecovery } from '../src/components/GoalRecovery.js';

const goal: GoalRecoveryView = {
  goalId: 'g_7QK4M2N8RT', intent: 'Keep every scene as it is.', status: 'interrupted', nextIteration: 2,
  turns: 0, reason: null, unreadable: false, resumable: true, note: null, createdAt: 100, updatedAt: 200,
  watch: null, outcome: null,
};

function render(change: Partial<GoalRecoveryView>, unavailable: string | null = 'Web Locks are unavailable.', activeGoalId: string | null = null): string {
  const agent = {} as AgentController;
  return renderToStaticMarkup(<I18nProvider i18n={i18n}><GoalRecovery agent={agent} goals={[{ ...goal, ...change }]} unavailable={unavailable} activeGoalId={activeGoalId} /></I18nProvider>);
}

it.each([
  { status: 'settled' as const, resumable: false },
  { unreadable: true, resumable: false },
  { resumable: false, note: 'The conversation is no longer saved.' },
])('omits the Web Locks reason when no Resume control is offered: %j', (change) => {
  const html = render(change);
  expect(html).not.toContain('Web Locks are unavailable.');
  expect(html).not.toContain('Resume the goal');
  expect(html).toContain('Discard the goal record');
});

it('keeps an unavailable running goal readable with a described, focusable disabled Resume', () => {
  const html = render({ status: 'running', resumable: false });
  expect(html).toContain('Web Locks are unavailable.');
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain('aria-describedby=');
  expect(html).toContain('Resume the goal');
  expect(html).not.toContain('Goal run finished');
});

it('shows the conservative usage note and isolates writer text', () => {
  const html = render({ note: 'Unrecorded usage is treated as spent.' }, null);
  expect(html).toContain('Unrecorded usage is treated as spent.');
  expect(html).toContain('<bdi dir="auto">Keep every scene as it is.</bdi>');
});

it('retains the saved terminal reason alongside the finished watch', () => {
  const html = render({ status: 'settled', outcome: 'passed', resumable: false, reason: 'passed: All checks passed.' }, null);
  expect(html).toContain('passed: All checks passed.');
  expect(html).toContain('Discard the goal record');
});

it('keeps an inactive running record discardable when its interruption could not be saved', () => {
  const html = render({ status: 'running', resumable: false, note: 'The interruption could not be saved.' }, null);
  expect(html).toContain('The interruption could not be saved.');
  expect(html).toContain('Discard the goal record');
  expect(html).not.toContain('Resume the goal');
});

it('shows the owned running goal without claiming an unmeasured check has passed', () => {
  const html = render({ status: 'running', resumable: false, watch: {
    nextIteration: 1, completedIterations: 0, maxIterations: 10, limits: { maxModelCalls: 8 },
    spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 },
    checks: [{ key: 'synopsis', kind: 'synopsis.filled', pass: null, distance: null, history: [], failures: [], skipped: 0 }],
  } }, null, goal.goalId);
  expect(html).toContain('Goal run in progress');
  expect(html).toContain('Goal progress');
  expect(html).toContain('Passing checks: 0 of 1');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('>Passed<');
  expect(html).not.toContain('another tab');
});

it('keeps an unmeasured refused checkpoint distinct from a passed check', () => {
  const html = render({ status: 'settled', outcome: 'refused', resumable: false, watch: {
    nextIteration: 1, completedIterations: 0, maxIterations: 10, limits: { maxModelCalls: 8 },
    spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 },
    checks: [{ key: 'synopsis', kind: 'synopsis.filled', pass: null, distance: null, history: [], failures: [], skipped: 0 }],
  } }, null);
  expect(html).toContain('Not measured');
  expect(html).not.toContain('>Passed<');
});

it('renders recorded distances and an unpriced spend without inventing a trend or a zero cost', () => {
  const html = render({ status: 'settled', outcome: 'passed', resumable: false, watch: {
    nextIteration: 3, completedIterations: 2, maxIterations: 10, limits: { maxModelCalls: 8 },
    spend: { modelCalls: 2, promptTokens: 100, completionTokens: 50, estimatedTokens: 0, steps: 2, activeMs: 1000 },
    checks: [{ key: 'synopsis', kind: 'synopsis.filled', pass: true, distance: 0, history: [3, 1, 0], failures: [], skipped: 0 }],
  } }, null);
  expect(html).toContain('data-status="passed"');
  expect(html).toContain('3 → 1 → 0');
  expect(html).toContain('Not priced');
  expect(html).toContain('scope="row"');
});
