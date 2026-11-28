/**
 * **Import Plottr…** (#290): a `.pltr` outline opens in the shared preview through the real reader Worker, imports cards,
 * plotlines, codex rows, notes and an embedded picture in one `binder.importTree`, and one Undo takes it back.
 */
import { expect, test } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const file = {
  series: { name: 'Fixture' },
  beats: [
    { id: 1, title: 'Act 1', position: 0 },
    { id: 2, title: 'Act 2', position: 1 },
  ],
  lines: [{ id: 1, bookId: 1, title: 'Main plot', position: 0 }],
  cards: [
    { id: 10, lineId: 1, beatId: 1, title: 'Opening', positionWithinLine: 0, position: 0, description: [{ type: 'paragraph', children: [{ text: 'The ferry leaves.' }] }], tags: [1], characters: [1], places: [1], imageId: '1' },
    { id: 11, lineId: 1, beatId: 1, title: 'Payoff', positionWithinLine: 1, position: 1, description: 'The harbour answer.' },
  ],
  tags: [{ id: 1, title: 'Quest' }],
  characters: [{ id: 1, name: 'Ada', description: 'The navigator', notes: [{ type: 'paragraph', children: [{ text: 'Knows the tides.' }] }], tags: [1], imageId: '1', Role: 'Protagonist' }],
  places: [{ id: 1, name: 'Harbour', description: 'The old pier' }],
  notes: [{ id: 1, title: 'Research note', content: [{ type: 'paragraph', children: [{ text: 'Read the tide tables.' }] }], tags: [], characters: [1], places: [1] }],
  images: { '1': { id: 1, name: 'Harbour picture', data: `data:image/png;base64,${png}` } },
};

async function sceneMetaOf(page: Parameters<typeof treeOf>[0]): Promise<Record<string, { expectedPresent?: string[]; locations?: string[]; threads?: { id: string; payoff: string }[] }>> {
  return page.evaluate(() => (globalThis as unknown as { __caotang?: { sceneMeta(): Record<string, never> } }).__caotang?.sceneMeta() ?? {});
}

test('a Plottr outline imports as synopsis scenes, codex rows, research notes and one undo step', async ({ page }) => {
  await createProject(page, 'Plottr Import');
  await page.locator('input[type="file"][aria-label="Plottr file"]').setInputFiles({ name: 'fixture.pltr', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file), 'utf8') });

  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Plottr outlines contain scene cards');
  await expect(dialog).toContainText('Opening');
  await expect(dialog.getByRole('button', { name: /Import .*scenes/ })).toBeVisible();
  await dialog.getByRole('button', { name: /Import .*scenes/ }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);
  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);

  const tree = await treeOf(page);
  const act = tree.find((node) => node.title === 'Act 1');
  const opening = tree.find((node) => node.title === 'Opening' && node.parentId === act?.id);
  const payoff = tree.find((node) => node.title === 'Payoff' && node.parentId === act?.id);
  const note = tree.find((node) => node.title === 'Research note');
  expect(opening).toBeDefined();
  expect(payoff).toBeDefined();
  expect(note).toBeDefined();
  expect(await bodyOf(page, opening?.id ?? '')).toContain('assets/');
  expect(await bodyOf(page, note?.id ?? '')).toContain('Read the tide tables.');

  const codex = await page.evaluate(() => (globalThis as unknown as { __caotang?: { codex(): { id: string; name: string; type: string; attachments?: string[]; visualRefs?: string[] }[] } }).__caotang?.codex() ?? []);
  const ada = codex.find((entry) => entry.name === 'Ada');
  const harbour = codex.find((entry) => entry.name === 'Harbour');
  expect(ada?.type).toBe('character');
  expect(harbour?.type).toBe('location');
  const meta = await sceneMetaOf(page);
  expect(meta[opening?.id ?? '']?.expectedPresent).toEqual([ada?.id]);
  expect(harbour?.attachments).toContain(opening?.id);
  expect(ada?.visualRefs?.length).toBe(1);
  expect(ada?.attachments).toContain(note?.id);
  expect(harbour?.attachments).toContain(note?.id);
  expect(meta[opening?.id ?? '']?.threads?.[0]).toMatchObject({ id: 'Main plot', payoff: payoff?.id });

  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await waitForSaved(page);
  expect((await treeOf(page)).some((node) => node.title === 'Opening')).toBe(false);
  expect((await page.evaluate(() => (globalThis as unknown as { __caotang?: { codex(): unknown[] } }).__caotang?.codex() ?? [])).length).toBe(0);
});
