/**
 * **Import captions…** (issue #287): an SRT or WebVTT file chosen in the binder opens in the shared import preview as one AV script
 * episode in a show folder, the writer's choices re-plan it, and Import writes it as one `binder.importTree`. Cancel writes nothing.
 * Every wait is on published state (`data-state`, the dialog's own live regions), never a sleep or a retry.
 */

import { expect, test, type Page } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

const VTT = [
  'WEBVTT - The Lighthouse Keeper',
  '',
  'NOTE Recorded on the pier',
  '',
  '00:00:01.000 --> 00:00:04.000',
  '<v Ada>We lit the lamp.</v>',
  '',
  '00:00:04.500 --> 00:00:06.000',
  '<v Bob>And then we waited.</v>',
  '',
  '00:00:20.000 --> 00:00:22.000',
  '<v Ada>Much later.</v>',
  '',
].join('\n');

const SRT = ['1', '00:00:01,000 --> 00:00:04,000', 'Ada: We lit the lamp.', '', '2', '00:00:04,500 --> 00:00:06,000', 'And then we waited.', ''].join('\r\n');

async function choose(page: Page, name: string, text: string): Promise<void> {
  await page.locator('input[type="file"][aria-label="Captions file"]').setInputFiles({ name, mimeType: 'text/vtt', buffer: Buffer.from(text, 'utf8') });
}

test('a WebVTT file opens as one episode, and Import writes the show and the episode as one step', async ({ page }) => {
  await createProject(page, 'Keeper Captions');
  await choose(page, 'episode-12.vtt', VTT);

  const dialog = page.getByRole('dialog', { name: 'Import captions?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-preview-detected')).toContainText('1 part · 0 chapters · 1 scene');
  const report = dialog.getByRole('list', { name: 'What the import does' });
  await expect(report).toContainText('3 cues become 3 speech lines in 2 segments');
  await expect(report).toContainText('Every duration comes from the file');

  // Cancel writes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');

  await choose(page, 'episode-12.vtt', VTT);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import the episode' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const tree = await treeOf(page);
  const show = tree.find((node) => node.title === 'The Lighthouse Keeper' && node.type === 'folder');
  expect(show?.kind).toBe('show');
  const episode = tree.find((node) => node.parentId === show?.id && node.type === 'document');
  expect(episode?.kind).toBe('av-script');
  const body = await bodyOf(page, episode?.id ?? '');
  expect(body).toContain('## Segment 1 (0:01)');
  expect(body).toContain('Ada: We lit the lamp. [3.5s]');
  expect(body).toContain('> Recorded on the pier');
  expect(body).toContain('## Segment 2 (0:20)');

  // One Undo takes the whole import back.
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await waitForSaved(page);
  const after = await treeOf(page);
  expect(after.some((node) => node.title === 'The Lighthouse Keeper')).toBe(false);
});

test('the choices re-plan the episode: no merge keeps the cues apart, and leaving silence out shortens it', async ({ page }) => {
  await createProject(page, 'Keeper Choices');
  const merged = ['WEBVTT', '', '00:00.000 --> 00:02.000', '<v Ada>One sentence</v>', '', '00:02.100 --> 00:04.000', '<v Ada>that keeps going.</v>', ''].join('\n');
  await choose(page, 'take.vtt', merged);

  const dialog = page.getByRole('dialog', { name: 'Import captions?' });
  await expect(dialog).toBeVisible();
  const report = dialog.getByRole('list', { name: 'What the import does' });
  await expect(report).toContainText('2 cues become 1 speech line in 1 segment');
  await expect(report).toContainText('joined an earlier line');

  await dialog.getByRole('checkbox', { name: 'Merge consecutive cues of one speaker' }).uncheck();
  await expect(report).toContainText('2 cues become 2 speech lines in 1 segment');

  await dialog.getByRole('combobox', { name: 'Silence between lines' }).selectOption('leave');
  await expect(report).toContainText('is left out, so the episode is shorter than the recording');

  await dialog.getByRole('checkbox', { name: /Put the episode in a show folder/ }).uncheck();
  await expect(dialog.locator('.import-preview-detected')).toContainText('0 chapters · 1 scene');
  await expect(dialog.locator('.import-preview-detected')).not.toContainText('1 part');

  await dialog.getByRole('button', { name: 'Import the episode' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);
  const tree = await treeOf(page);
  expect(tree.some((node) => node.kind === 'show')).toBe(false);
  const episode = tree.find((node) => node.kind === 'av-script');
  expect(episode).toBeDefined();
  const body = await bodyOf(page, episode?.id ?? '');
  expect(body).not.toBeNull();
  expect((body ?? '').split('\n').filter((line) => line.startsWith('Ada: '))).toHaveLength(2);
});

test('an SRT file with a speaker prefix imports the same way, and a file with no cue is refused in the dialog', async ({ page }) => {
  await createProject(page, 'Keeper SRT');
  await choose(page, 'take.srt', SRT);
  const dialog = page.getByRole('dialog', { name: 'Import captions?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'What the import does' })).toContainText('2 cues become 2 speech lines');
  await dialog.getByRole('button', { name: 'Import the episode' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);
  const episode = (await treeOf(page)).find((node) => node.kind === 'av-script');
  const body = await bodyOf(page, episode?.id ?? '');
  expect(body).toContain('Ada: We lit the lamp.');
  expect(body).toContain('NARRATION: And then we waited.');

  // A file with no timed cue fails the read: the dialog says why, offers no Import, and nothing is written.
  await choose(page, 'notes.srt', 'Just words, with no timings at all.\n');
  const refused = page.getByRole('dialog', { name: 'Import captions?' });
  await expect(refused).toHaveAttribute('data-state', 'failed');
  await expect(refused.getByRole('alert')).toContainText('holds no timed cue');
  await expect(refused.getByRole('button', { name: 'Import the episode' })).toHaveCount(0);
  await refused.getByRole('button', { name: 'Cancel' }).click();
  await expect(refused).toBeHidden();
  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
});
