import { expect, test } from '@playwright/test';
import type * as ModalModule from '../apps/desktop/src/components/modal-stack.js';

import { createProject } from './support.js';

for (const shell of ['classic', 'modern'] as const) {
  test(`${shell}: an arriving Settings dialog covers Skills without losing its input, and Escape returns focus in stack order`, async ({ page }) => {
    await page.addInitScript((chosen) => localStorage.setItem('caotang.interface', chosen), shell);
    await createProject(page, 'Modal drafts');
    if (shell === 'modern') {
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Skills', exact: true }).click();
    } else await page.getByRole('button', { name: 'Skills', exact: true }).click();
    const skills = page.getByRole('dialog', { name: 'Skills', includeHidden: true });
    await skills.getByRole('button', { name: 'New skill…' }).click();
    const name = skills.getByRole('textbox', { name: /^Name/ });
    await name.fill('a-draft-to-keep');
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.className = 'confirm';
      dialog.id = 'arriving-confirmation';
      dialog.setAttribute('aria-label', 'An arriving confirmation');
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.autofocus = true;
      cancel.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => dialog.remove());
      dialog.append(cancel);
      document.body.append(dialog);
      dialog.showModal();
    });
    const confirmation = page.locator('#arriving-confirmation');
    await expect(confirmation).toHaveAttribute('data-modal-state', 'top');
    await page.evaluate(async () => {
      const path = '/src/components/modal-stack.ts';
      const { modalStack } = await import(path) as typeof ModalModule;
      modalStack.write('settings', 'writing');
    });
    const settings = page.getByTestId('settings');
    await expect(settings).toHaveAttribute('data-modal-state', 'covered');
    await expect(confirmation).toHaveAttribute('data-modal-state', 'top');
    await expect(page.getByTestId('modal-stack')).toHaveAttribute('data-depth', '3');
    await page.keyboard.press('Escape');
    await expect(confirmation).toHaveCount(0);
    await expect(settings).toHaveAttribute('data-modal-state', 'top');
    await expect(skills).toHaveAttribute('data-modal-state', 'covered');
    await expect(page.getByTestId('modal-stack')).toHaveAttribute('data-depth', '2');
    await expect(name).toHaveValue('a-draft-to-keep');
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await expect(skills).toHaveAttribute('data-modal-state', 'top');
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('a-draft-to-keep');
    await page.keyboard.press('Escape');
    await expect(skills.getByRole('button', { name: 'New skill…' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('modal-stack')).toHaveAttribute('data-state', 'empty');
    await expect(page.getByRole('button', { name: shell === 'modern' ? 'More' : 'Skills', exact: true })).toBeFocused();
  });
}

test('Modern notices stay current while covered, announce a new import failure inside the modal, and reappear on close', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
  await createProject(page, 'Modal notices');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Skills', exact: true }).click();
  const notices = page.getByTestId('modern-notices');
  await expect(notices).toHaveAttribute('data-state', 'covered');
  await expect(notices).toHaveAttribute('inert', '');
  await expect(notices).toHaveCSS('opacity', '0');
  await page.locator('input[aria-label="Skill zip"]').setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  const announcement = page.getByTestId('modal-notice-alert');
  await expect(announcement).toContainText(/zip|import/i);
  await expect(announcement).toHaveAttribute('aria-live', 'assertive');
  await expect(announcement.locator('xpath=ancestor::dialog')).toHaveAttribute('data-modal-state', 'top');
  const status = notices.locator('[role="alert"]');
  const message = await status.textContent();
  await page.keyboard.press('Escape');
  await expect(notices).toHaveAttribute('data-state', 'visible');
  await expect(notices).not.toHaveAttribute('inert', '');
  await expect(status).toHaveText(message ?? '');
  await expect(status).toBeVisible();
});
