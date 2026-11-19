/**
 * Dismisses the dialogs the shell's windows raise as they appear. A session with words still being written warns before the
 * window unloads (`Workspace`'s `beforeunload` guard), and Playwright's own handling of that dialog races the window going away:
 * it calls `Page.handleJavaScriptDialog` for a dialog that is already gone, fails the test with "No dialog is showing", and can
 * leave the worker teardown waiting. Dismissing from a listener of the spec's own makes the teardown deterministic without
 * changing anything a test asserts — the warning is the app's, not a check.
 */

import type { Dialog, ElectronApplication, Page } from '@playwright/test';

/** Every window the application has, and every one it opens later. */
export function dismissDialogs(electron: ElectronApplication): void {
  const watch = (page: Page): void => {
    page.on('dialog', (dialog: Dialog) => void dialog.dismiss().catch(() => undefined));
  };
  for (const page of electron.windows()) watch(page);
  electron.on('window', watch);
}
