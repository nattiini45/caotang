import { expect, type Page } from '@playwright/test';
import type * as ProvidersModule from '../apps/desktop/src/app/providers.js';
import type { ChatMessage } from '../packages/gateway/src/index.js';
import { fakeEndpoint, useFakeEndpoint as configureFakeEndpoint } from './endpoint.js';
import { createProject, firstChapter, waitForSaved } from './support.js';

export interface ReviewWindow {
  reviewCalls: number;
  releaseReviewCall: () => void;
}

export async function planHeldReview(page: Page): Promise<void> {
  await fakeEndpoint(page, () => '{"spans":[]}');
  await configureFakeEndpoint(page);
  await createProject(page, 'Review Book');
  await firstChapter(page);
  for (const title of ['Scene A', 'Scene B']) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(title);
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Document text' }).fill('The ferry arrived.');
    await waitForSaved(page);
  }
  await page.evaluate(async () => {
    const path = '/src/app/providers.ts';
    const { ProviderService } = await import(path) as typeof ProvidersModule;
    const resolve = ProviderService.prototype.resolveForRole;
    const patched = new WeakSet<object>();
    const held = window as unknown as ReviewWindow;
    held.reviewCalls = 0;
    ProviderService.prototype.resolveForRole = function (role) {
      if (!patched.has(this.gateway)) {
        patched.add(this.gateway);
        this.gateway.completeOnce = (_request, signal) => {
          held.reviewCalls += 1;
          return new Promise<ChatMessage>((done, reject) => {
            const aborted = () => reject(new Error('Review stopped.'));
            signal?.addEventListener('abort', aborted, { once: true });
            held.releaseReviewCall = () => {
              signal?.removeEventListener('abort', aborted);
              done({ role: 'assistant', content: '{"spans":[]}' });
            };
          });
        };
      }
      return resolve.call(this, role);
    };
  });
  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Review with agent' }).click();
  await expect(page.getByTestId('review-plan')).toBeVisible();
}

export async function startHeldReview(page: Page): Promise<void> {
  await planHeldReview(page);
  await page.getByRole('button', { name: 'Start the review' }).click();
  await expect(page.getByTestId('findings-panel')).toHaveAttribute('data-state', 'running');
}

export async function stopHeldReview(page: Page) {
  await startHeldReview(page);
  await page.getByTestId('review-running').getByRole('button', { name: 'Stop the review' }).click();
  await expect(page.getByTestId('findings-panel')).toHaveAttribute('data-state', 'cancelled');
  return page.getByTestId('review-outcome');
}
