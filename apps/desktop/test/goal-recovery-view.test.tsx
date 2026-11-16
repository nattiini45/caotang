import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { AgentController, GoalRecoveryView } from '../src/app/agent.js';
import { GoalRecovery } from '../src/components/GoalRecovery.js';

const goal: GoalRecoveryView = {
  goalId: 'g_7QK4M2N8RT', intent: 'Keep every scene as it is.', status: 'interrupted', nextIteration: 2,
  turns: 0, reason: null, unreadable: false, resumable: true, note: null, createdAt: 100, updatedAt: 200,
};

function render(change: Partial<GoalRecoveryView>, unavailable: string | null = 'Web Locks are unavailable.'): string {
  const agent = {} as AgentController;
  return renderToStaticMarkup(<I18nProvider i18n={i18n}><GoalRecovery agent={agent} goals={[{ ...goal, ...change }]} unavailable={unavailable} /></I18nProvider>);
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

it('keeps an inactive running record discardable when its interruption could not be saved', () => {
  const html = render({ status: 'running', resumable: false, note: 'The interruption could not be saved.' }, null);
  expect(html).toContain('The interruption could not be saved.');
  expect(html).toContain('Discard the goal record');
  expect(html).not.toContain('Resume the goal');
});
