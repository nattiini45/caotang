/**
 * Ending a shell spec’s application (#788). A spec that is finished with the app is not a writer being asked whether to keep their
 * words, but `electron.close()` goes through the window's unload, where the app's `beforeunload` guard asks exactly that question
 * whenever the session has not finished saving. Chromium raises the warning, the answer races Playwright's own teardown of the page,
 * and a warning answered with "stay" cancels the unload: the window stays up, the application never quits, and the test spends its
 * whole budget waiting for a close that cannot finish.
 *
 * Asking the main process to exit ends the app without an unload at all, so the teardown has one outcome and no timeout of its own.
 */

import type { ElectronApplication } from '@playwright/test';

/** Ends the application now, and resolves once it has gone. */
export async function closeShell(electron: ElectronApplication): Promise<void> {
  const closed = electron.waitForEvent('close');
  void electron.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await closed;
}
