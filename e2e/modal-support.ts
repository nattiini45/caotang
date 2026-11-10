import { expect, type Page } from '@playwright/test';
import { ZIP_ENGINE } from '../packages/store/src/index.js';

export async function openSkillsReview(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Skills', exact: true }).click();
  await importSkillFixture(page);
  await page.getByRole('button', { name: 'Read and approve… close-third' }).click();
  await expect(page.getByRole('heading', { name: /Read.*close-third/ })).toBeVisible();
}

export async function importSkillFixture(page: Page): Promise<void> {
  const { zipSync } = await ZIP_ENGINE.load();
  const text = new TextEncoder();
  const bytes = zipSync({
    'close-third/SKILL.md': text.encode('---\nname: close-third\ndescription: Draft scenes in close third person, past tense.\n---\n\nKeep every sentence in close third person and past tense.\n'),
    'close-third/references/voice.md': text.encode('Stay with the narrator. Never leave the room.\n'),
    'close-third/scripts/check.sh': text.encode('echo "not run by Caotang"\n'),
  });
  await page.locator('input[aria-label="Skill zip"]').setInputFiles({ name: 'close-third.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('button', { name: 'Read and approve… close-third' })).toBeVisible();
}
