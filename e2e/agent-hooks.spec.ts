import { readFileSync, writeFileSync } from 'node:fs';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';
import { ZIP_ENGINE } from '../packages/store/src/index.js';

/**
 * The writer's hooks (hooks.md) on the demo provider, so no key is needed. A hook lives in the project's `caotang.json` under
 * `agent.hooks` until Settings › Hooks ships, so the spec imports a bundle whose manifest carries one. The demo agent's draft of The
 * Friend mentions a lantern; a hook that looks for "lantern" blocks that draft as a refused step on the card, with the hook's reason
 * beside the disabled Approve, and a hook that only warns leaves the card approvable and says so on the step. A hook that is off, or
 * that is for another tool, says nothing.
 */

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.locator('.agent-report-text').first()).toBeVisible();
}

async function sendIntent(page: Page, intent: string): Promise<void> {
  const field = page.getByRole('combobox', { name: 'Intent' });
  // A project that was just opened has its agent panel closed.
  if ((await field.count()) === 0) await page.getByRole('region', { name: 'Agent' }).getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(field).toBeEnabled();
  await field.fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function bodyOf(page: Page, title: string): Promise<string> {
  return page.evaluate((wanted) => {
    const caotang = (globalThis as unknown as { __caotang?: { tree(): { id: string; title: string }[]; body(id: string): string | null } }).__caotang;
    const id = caotang?.tree().find((row) => row.title === wanted)?.id;
    return (id === undefined ? null : caotang?.body(id)) ?? '';
  }, title);
}

/** The app's own bundle of the open project, as bytes. */
async function exportedBundle(page: Page): Promise<Uint8Array> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export bundle', exact: true }).click()]);
  return new Uint8Array(readFileSync((await download.path()) ?? ''));
}

const LANTERN = {
  id: 'h_7K2QX9M4A1',
  name: 'No lanterns',
  event: 'tool.before',
  matcher: { tools: ['scene.draft'] },
  handler: { kind: 'check', check: { kind: 'pattern', patterns: [{ match: 'lantern', message: 'Say what the light is.' }] } },
  enabled: true,
};

/** The bundle as a writer who edited `caotang.json` by hand would leave it: the same project, with these hooks under `agent`. */
async function bundleWithHooks(testInfo: TestInfo, bytes: Uint8Array, name: string, hooks: readonly Record<string, unknown>[]): Promise<string> {
  const { unzipSync, zipSync } = await ZIP_ENGINE.load();
  const entries = unzipSync(bytes);
  const good = entries['caotang.json'];
  if (good === undefined) throw new Error('the exported bundle has no caotang.json');
  const manifest = JSON.parse(new TextDecoder().decode(good)) as Record<string, unknown>;
  manifest['agent'] = { hooks };
  entries['caotang.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const path = testInfo.outputPath(`${name}.caotang`);
  writeFileSync(path, zipSync(entries));
  return path;
}

async function importAndOpen(page: Page, path: string): Promise<void> {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  await page.getByTestId('bundle-input').setInputFiles(path);
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

test('a hook that blocks refuses the demo agent’s draft on the card, names the hook beside the disabled Approve, and writes nothing', async ({ page }, testInfo) => {
  await openSample(page);
  const bundle = await exportedBundle(page);
  await importAndOpen(page, await bundleWithHooks(testInfo, bundle, 'blocks', [{ ...LANTERN, onBlock: 'block' }]));

  await sendIntent(page, DEMO_INTENTS.draftScene);
  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Approve plan', exact: true }).or(card.getByRole('button', { name: 'Approve', exact: true }))).toBeDisabled();
  await expect(card.locator('.plan-approve-reason')).toContainText('The hook “No lanterns” stopped scene.draft');
  await expect(card.locator('.plan-step-error')).toContainText('“lantern” appears: Say what the light is.');
  expect(await bodyOf(page, 'The Friend')).toBe('');

  await card.getByRole('button', { name: /^Cancel/ }).click();
  expect(await bodyOf(page, 'The Friend')).toBe('');
});

test('a hook that only warns leaves the card approvable, says so on the step, and the draft is written', async ({ page }, testInfo) => {
  await openSample(page);
  const bundle = await exportedBundle(page);
  await importAndOpen(page, await bundleWithHooks(testInfo, bundle, 'warns', [LANTERN]));

  await sendIntent(page, DEMO_INTENTS.draftScene);
  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.plan-step-hook')).toContainText('Hook “No lanterns”: “lantern” appears: Say what the light is.');
  const approve = card.getByRole('button', { name: 'Approve plan', exact: true }).or(card.getByRole('button', { name: 'Approve', exact: true }));
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect.poll(() => bodyOf(page, 'The Friend')).toContain('lantern');
});

test('a hook that is turned off, and a hook for another tool, say nothing', async ({ page }, testInfo) => {
  await openSample(page);
  const bundle = await exportedBundle(page);
  await importAndOpen(
    page,
    await bundleWithHooks(testInfo, bundle, 'quiet', [
      { ...LANTERN, onBlock: 'block', enabled: false },
      { ...LANTERN, id: 'h_ABCDEFGHJK', name: 'Notes only', onBlock: 'block', matcher: { tools: ['notes.append'] } },
    ]),
  );

  await sendIntent(page, DEMO_INTENTS.draftScene);
  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.plan-step-hook')).toHaveCount(0);
  await expect(card.locator('.plan-step-error')).toHaveCount(0);
  await card.getByRole('button', { name: /^Cancel/ }).click();
});
