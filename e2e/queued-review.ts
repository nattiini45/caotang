import { expect, type Page } from '@playwright/test';
import type * as TaskStoreModule from '../apps/desktop/src/app/task-store.js';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint as configureFakeEndpoint, type FakeReply, type FakeRequest } from './endpoint.js';
import { createProject, firstChapter, waitForSaved } from './support.js';

export const REVIEW_SCENES = [
  { title: 'East ferry', body: 'The ferry left at noon.' },
  { title: 'West ferry', body: 'The ferry left at midnight.' },
] as const;

export function reviewReply(request: FakeRequest): string | undefined {
  if (request.system.includes('continuity extractor')) {
    const docId = /docId: ([^)]+)\)/.exec(request.user)?.[1];
    const body = request.user.split('--- BEGIN DOCUMENT ---\n')[1]?.split('\n--- END DOCUMENT ---')[0] ?? '';
    return JSON.stringify({ spans: [{ docId, from: 0, to: body.length, quote: body, category: 'timeline-plot', note: '' }] });
  }
  if (!request.system.startsWith('You judge whether two passages')) return undefined;
  const pairs = [...request.user.matchAll(/\[pair (p\d+)\]/g)];
  return JSON.stringify({ verdicts: pairs.map((pair) => ({
    pairId: pair[1], verdict: 'contradictory', reasoning: 'The ferry leaves at two different times.',
    factGroup: { entity: 'ferry', attribute: 'departure' },
  })) });
}

export async function queuedReviewProject(page: Page, plan?: unknown): Promise<{ readonly requests: FakeRequest[]; readonly models: string[] }> {
  const requests: FakeRequest[] = [];
  const models: string[] = [];
  const planner: FakeReply = planThenAnswer(plan ?? { reply: 'Done.' });
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/chat/completions')) return;
    const body = request.postDataJSON() as { stream?: boolean; model?: string; messages?: { role: string; content?: string }[] };
    if (body.stream === false || !body.messages?.some((message) => message.content?.includes('continuity extractor') || message.content?.startsWith('You judge whether two passages'))) return;
    models.push(body.model ?? '');
  });
  await fakeEndpoint(page, (request) => {
    const reply = reviewReply(request);
    if (reply === undefined) return planner(request);
    requests.push(request);
    return reply;
  });
  await configureFakeEndpoint(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="providers"]').click();
  await settings.getByLabel('Background profile').selectOption({ label: 'Fake endpoint' });
  await settings.getByLabel('Background model', { exact: true }).fill('other-model');
  await settings.getByRole('button', { name: 'Save task roles' }).click();
  await expect(settings.getByText('Saved the task roles.')).toBeVisible();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await createProject(page, 'Ferry Notebook');
  const modern = (await page.getByTestId('modern-stage').count()) > 0;
  if (modern) {
    await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true }).click();
    await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
  }
  await firstChapter(page);
  for (const scene of REVIEW_SCENES) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene.title);
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Document text' }).fill(scene.body);
    await waitForSaved(page);
  }
  if (modern) {
    await page.mouse.move(700, 450);
    await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'closed');
  }
  return { requests, models };
}

export async function openReviewInbox(page: Page, buttonName?: string): Promise<void> {
  if (await page.getByTestId('review-inbox').isVisible()) return;
  const queued = page.getByRole('status').filter({ hasText: 'The review is queued.' });
  if (await queued.isVisible()) await queued.getByRole('button', { name: 'Dismiss' }).click();
  const modern = await page.getByTestId('modern-binder-bar').isVisible();
  await page.getByRole('button', { name: buttonName ?? (modern ? 'Ask' : 'Agent'), exact: true }).click();
  await expect(page.getByTestId('review-inbox')).toBeVisible();
}

export async function storedReviewTasks(page: Page): Promise<readonly TaskStoreModule.TaskRecord[]> {
  return page.evaluate(async () => {
    const path = '/src/app/task-store.ts';
    const { TaskStore } = await import(path) as typeof TaskStoreModule;
    const id = (window as Window & { __caotang?: { projectId(): string | null } }).__caotang?.projectId();
    return id === null || id === undefined ? [] : new TaskStore().list(id);
  });
}
